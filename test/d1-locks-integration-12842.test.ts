/**
 * test/d1-locks-integration-12842.test.ts — merge lock, consumo de concessão
 * e edition-lock sobre o D1 (#12842), com cliente D1 injetado.
 *
 * "Duas máquinas" = dois checkouts (`repoRoot`) com `data/sessions/` próprios
 * e o MESMO D1: é exatamente o caso em que o arquivo sozinho deixa as duas
 * ganharem (#6182).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireMergeLock,
  acquireMergeLockShared,
  isMergeGrantConsumedInD1,
  markMergeGrantConsumedInD1,
  mergeLockPath,
  releaseMergeLockShared,
  renewMergeLockShared,
  sessionsDir,
} from "../scripts/lib/session-registry.ts";
import { acquireEditionLockShared, editionLockPath, releaseEditionLockShared } from "../scripts/lib/edition-lock.ts";
import { D1HttpError, d1ReadLock, mergeLockD1Name } from "../scripts/lib/d1-locks.ts";
import { createFakeD1, failingD1 } from "./_helpers/fake-d1.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function machine(): string {
  const root = mkdtempSync(join(tmpdir(), "d1-int-"));
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

const T0 = Date.parse("2026-11-11T12:00:00.000Z");
const REPO = "vjpixel/diaria-studio";

describe("merge lock compartilhado (session-registry)", () => {
  it("duas máquinas, mesmo D1: só uma adquire (o arquivo sozinho deixaria as duas)", async () => {
    const d1 = createFakeD1();
    const neo = machine();
    const s300 = machine();
    // Controle: só arquivo, as duas ganham — o bug do #6182.
    assert.equal(acquireMergeLock(neo, "ctl-A", T0), true);
    assert.equal(acquireMergeLock(s300, "ctl-B", T0), true);
    rmSync(mergeLockPath(neo));
    rmSync(mergeLockPath(s300));

    const [a, b] = await Promise.all([
      acquireMergeLockShared(neo, "sess-A", REPO, { d1, now: T0, d1Now: T0 }),
      acquireMergeLockShared(s300, "sess-B", REPO, { d1, now: T0, d1Now: T0 }),
    ]);
    assert.equal([a, b].filter((r) => r.ok).length, 1);
    const loser = a.ok ? b : a;
    assert.equal(loser.backend, "d1");
    assert.equal(loser.d1Holder, a.ok ? "sess-A" : "sess-B");
    assert.equal(existsSync(mergeLockPath(a.ok ? s300 : neo)), false, "o perdedor não grava o arquivo");
  });

  it("TTL expirado no D1: a outra máquina assume", async () => {
    const d1 = createFakeD1();
    const neo = machine();
    const s300 = machine();
    assert.ok((await acquireMergeLockShared(neo, "A", REPO, { d1, now: T0, d1Now: T0 })).ok);
    const inside = await acquireMergeLockShared(s300, "B", REPO, { d1, now: T0 + 60_000, d1Now: T0 + 60_000 });
    assert.equal(inside.ok, false);
    const after2 = await acquireMergeLockShared(s300, "B", REPO, { d1, now: T0 + 121_000, d1Now: T0 + 121_000 });
    assert.equal(after2.ok, true);
    assert.equal(after2.backend, "d1");
  });

  it("release por não-dono é recusado e o lock fica", async () => {
    const d1 = createFakeD1();
    const neo = machine();
    const s300 = machine();
    await acquireMergeLockShared(neo, "A", REPO, { d1, now: T0, d1Now: T0 });
    const r = await releaseMergeLockShared(s300, "B", REPO, { d1, d1Now: T0 + 1 });
    assert.equal(r.ok, false);
    assert.equal(r.d1Holder, "A");
    const still = await d1ReadLock(d1, mergeLockD1Name(REPO), { now: T0 + 2 });
    assert.ok(still.ok);
    assert.equal(still.value?.holder, "A");
    const own = await releaseMergeLockShared(neo, "A", REPO, { d1, d1Now: T0 + 3 });
    assert.equal(own.ok, true);
    assert.equal(existsSync(mergeLockPath(neo)), false);
  });

  it("D1 indisponível → fallback para o lock local, com aviso explícito", async () => {
    const neo = machine();
    const warnings: string[] = [];
    const r = await acquireMergeLockShared(neo, "A", REPO, { d1: failingD1(), now: T0, warn: (m) => warnings.push(m) });
    assert.equal(r.ok, true);
    assert.equal(r.backend, "local-fallback");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /D1 indisponível em merge-lock-acquire/);
    assert.match(warnings[0]!, /NÃO exclui entre máquinas/);
    const rel = await releaseMergeLockShared(neo, "A", REPO, { d1: failingD1(), warn: (m) => warnings.push(m) });
    assert.equal(rel.ok, true);
    assert.equal(rel.backend, "local-fallback");
  });

  it("sem D1 (não provisionado): exatamente o comportamento antigo, sem aviso", async () => {
    const neo = machine();
    const warnings: string[] = [];
    const r = await acquireMergeLockShared(neo, "A", REPO, { d1: null, now: T0, warn: (m) => warnings.push(m) });
    assert.deepEqual(r, { ok: true, backend: "local" });
    assert.deepEqual(warnings, []);
  });

  it("D1 concede e o arquivo diz outra sessão: vale o D1, espelho regravado e aviso nomeia o holder antigo", async () => {
    const d1 = createFakeD1();
    const neo = machine();
    // #12967: o holder antigo é uma sessão REGISTRADA (hold de fallback); holder
    // não registrado e fresco recusa — ver d1-locks-review-13007-12967.test.ts.
    writeFileSync(join(sessionsDir(neo), "overnight-261111-fallback-holder.json"), "{}");
    assert.equal(acquireMergeLock(neo, "fallback-holder", T0), true);
    const warnings: string[] = [];
    const r = await acquireMergeLockShared(neo, "B", REPO, {
      d1,
      now: T0 + 1000,
      d1Now: T0 + 1000,
      warn: (m) => warnings.push(m),
    });
    assert.equal(r.ok, true);
    assert.equal(r.backend, "d1");
    const row = await d1ReadLock(d1, mergeLockD1Name(REPO), { now: T0 + 1001 });
    assert.ok(row.ok);
    assert.equal(row.value?.holder, "B");
    assert.equal(JSON.parse(readFileSync(mergeLockPath(neo), "utf8")).heldBy, "B", "espelho local regravado");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /fallback-holder/);
  });

  it("#6334: hold fresco da PRÓPRIA sessão no arquivo segue recusando — e o D1 o adota", async () => {
    const d1 = createFakeD1();
    const neo = machine();
    assert.equal(acquireMergeLock(neo, "A", T0), true);
    const r = await acquireMergeLockShared(neo, "A", REPO, { d1, now: T0 + 1000, d1Now: T0 + 1000 });
    assert.equal(r.ok, false);
    assert.equal(r.d1Holder, "A");
    const row = await d1ReadLock(d1, mergeLockD1Name(REPO), { now: T0 + 1001 });
    assert.ok(row.ok);
    assert.equal(row.value?.holder, "A");
  });

  it("erro permanente do D1 (403): fallback local com aviso de ERRO e evento no run-log", async () => {
    const neo = machine();
    const warnings: string[] = [];
    const forbidden = {
      async query(): Promise<never> {
        throw new D1HttpError("D1 query: HTTP 403 — 10000: Authentication error", 403);
      },
    };
    const r = await acquireMergeLockShared(neo, "A", REPO, { d1: forbidden, now: T0, warn: (m) => warnings.push(m) });
    assert.equal(r.ok, true);
    assert.equal(r.backend, "local-fallback");
    assert.match(warnings[0]!, /ERRO PERMANENTE/);
    const log = readFileSync(join(neo, "data", "run-log.jsonl"), "utf8");
    assert.match(log, /d1_locks_permanent_error/);
  });

  it("erro transitório do D1: só aviso, sem evento de erro no run-log", async () => {
    const neo = machine();
    const warnings: string[] = [];
    await acquireMergeLockShared(neo, "A", REPO, { d1: failingD1(), now: T0, warn: (m) => warnings.push(m) });
    assert.doesNotMatch(warnings[0]!, /ERRO PERMANENTE/);
    assert.equal(existsSync(join(neo, "data", "run-log.jsonl")), false);
  });

  it("renew: hold tomado no fallback é adotado pelo D1 quando ele volta", async () => {
    const d1 = createFakeD1();
    const neo = machine();
    assert.ok((await acquireMergeLockShared(neo, "A", REPO, { d1: failingD1(), now: T0, warn: () => {} })).ok);
    const r = await renewMergeLockShared(neo, "A", REPO, { d1, now: T0 + 10_000, d1Now: T0 + 10_000 });
    assert.equal(r.ok, true);
    assert.equal(r.backend, "d1");
    const row = await d1ReadLock(d1, mergeLockD1Name(REPO), { now: T0 + 10_001 });
    assert.ok(row.ok);
    assert.equal(row.value?.holder, "A");
    const other = await renewMergeLockShared(machine(), "B", REPO, { d1, d1Now: T0 + 10_002 });
    assert.equal(other.ok, false);
  });

  it("merge lock é por repo: lock do studio não segura o do design", async () => {
    const d1 = createFakeD1();
    const neo = machine();
    assert.ok((await acquireMergeLockShared(neo, "A", REPO, { d1, now: T0, d1Now: T0 })).ok);
    const other = await acquireMergeLockShared(machine(), "B", "vjpixel/diaria-design", { d1, now: T0, d1Now: T0 });
    assert.equal(other.ok, true);
  });
});

describe("consumo de concessão no D1", () => {
  it("uso único entre máquinas: a 2ª marca vê 'already'", async () => {
    const d1 = createFakeD1();
    const grant = { grantedBy: "coord", grantedTo: "sess", grantedAt: "2026-11-11T12:00:00.000Z" };
    assert.deepEqual(await isMergeGrantConsumedInD1(d1, grant), { ok: true, value: false });
    assert.deepEqual(await markMergeGrantConsumedInD1(d1, grant, "sess"), { ok: true, value: "claimed" });
    assert.deepEqual(await markMergeGrantConsumedInD1(d1, grant, "sess"), { ok: true, value: "already" });
    assert.deepEqual(await isMergeGrantConsumedInD1(d1, grant), { ok: true, value: true });
    const regrant = { ...grant, grantedAt: "2026-11-11T12:05:00.000Z" };
    assert.deepEqual(await isMergeGrantConsumedInD1(d1, regrant), { ok: true, value: false }, "nova concessão = nova identidade");
  });

  it("D1 ausente: null; D1 sem resposta: ok:false com o erro (o chamador avisa)", async () => {
    const grant = { grantedBy: "c", grantedTo: "s", grantedAt: "2026-11-11T12:00:00.000Z" };
    const mark = await markMergeGrantConsumedInD1(failingD1("offline"), grant, "s");
    assert.equal(mark?.ok, false);
    assert.match(mark && !mark.ok ? mark.error : "", /offline/);
    assert.equal(await markMergeGrantConsumedInD1(null, grant, "s"), null);
    assert.equal(await isMergeGrantConsumedInD1(null, grant), null);
    const read = await isMergeGrantConsumedInD1(failingD1(), grant);
    assert.equal(read?.ok, false);
  });
});

describe("edition-lock compartilhado", () => {
  function editionIn(root: string, edition = "261112"): string {
    const dir = join(root, "data", "editions", edition);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    return dir;
  }

  it("duas máquinas na mesma edição: a 2ª recebe held_by_other pelo D1 e o arquivo dela fica intocado", async () => {
    const d1 = createFakeD1();
    const neo = editionIn(machine());
    const s300 = editionIn(machine());
    const a = await acquireEditionLockShared(neo, { sessionId: "A", stage: 4, now: T0, host: "neo" }, d1, T0);
    assert.equal(a.action, "acquired");
    assert.equal(a.backend, "d1");
    const b = await acquireEditionLockShared(s300, { sessionId: "B", stage: 4, now: T0 + 1000, host: "300" }, d1, T0 + 1000);
    assert.equal(b.action, "held_by_other");
    assert.equal(b.d1Holder, "A");
    assert.equal(b.previous?.host, "neo");
    assert.equal(b.previous?.stage, 4);
    assert.equal(existsSync(editionLockPath(s300)), false);
  });

  it("mesma sessão renova (refreshed) e outra assume depois do TTL", async () => {
    const d1 = createFakeD1();
    const neo = editionIn(machine());
    const s300 = editionIn(machine());
    await acquireEditionLockShared(neo, { sessionId: "A", stage: 4, now: T0, host: "neo" }, d1, T0);
    const again = await acquireEditionLockShared(neo, { sessionId: "A", stage: 4, now: T0 + 1000, host: "neo" }, d1, T0 + 1000);
    assert.equal(again.action, "refreshed");
    const late = T0 + 1000 + 45 * 60 * 1000 + 1;
    const b = await acquireEditionLockShared(s300, { sessionId: "B", stage: 4, now: late, host: "300" }, d1, late);
    assert.equal(b.action, "acquired");
  });

  it("release de outra sessão é recusado pelo D1, sem tocar o arquivo", async () => {
    const d1 = createFakeD1();
    const neo = editionIn(machine());
    const s300 = editionIn(machine());
    await acquireEditionLockShared(neo, { sessionId: "A", stage: 4, now: T0, host: "neo" }, d1, T0);
    const r = await releaseEditionLockShared(s300, { sessionId: "B", now: T0 + 1, host: "300" }, d1, T0 + 1);
    assert.equal(r.result, "held_by_other");
    assert.equal(existsSync(editionLockPath(s300)), false);
    const own = await releaseEditionLockShared(neo, { sessionId: "A", completedStage: 4, now: T0 + 2, host: "neo" }, d1, T0 + 2);
    assert.equal(own.result, "released");
    assert.match(readFileSync(editionLockPath(neo), "utf8"), /completed_stage/);
  });

  it("arquivo recusa (stale_other_host) → o D1 recém-tomado é devolvido", async () => {
    const d1 = createFakeD1();
    const neo = editionIn(machine());
    const stale = new Date(T0 - 60 * 60 * 1000).toISOString();
    writeFileSync(
      editionLockPath(neo),
      JSON.stringify({ session_id: "old", host: "300", stage: 4, acquired_at: stale, heartbeat_at: stale }),
    );
    const r = await acquireEditionLockShared(neo, { sessionId: "A", stage: 4, now: T0, host: "neo" }, d1, T0);
    assert.equal(r.action, "stale_other_host");
    const row = await d1ReadLock(d1, "edition:261112", { now: T0 + 1 });
    assert.ok(row.ok);
    assert.equal(row.value, null);
  });

  it("renovação (refreshed) com o arquivo de outra sessão: o D1 também é devolvido (sem bloqueio mútuo de 45 min)", async () => {
    const d1 = createFakeD1();
    const neo = editionIn(machine());
    await acquireEditionLockShared(neo, { sessionId: "A", stage: 4, now: T0, host: "neo" }, d1, T0);
    // O arquivo desta máquina passou a dizer B (sync trouxe o lock de outra sessão).
    const fresh = new Date(T0 + 500).toISOString();
    writeFileSync(
      editionLockPath(neo),
      JSON.stringify({ session_id: "B", host: "neo", stage: 4, acquired_at: fresh, heartbeat_at: fresh }),
    );
    const again = await acquireEditionLockShared(neo, { sessionId: "A", stage: 4, now: T0 + 1000, host: "neo" }, d1, T0 + 1000);
    assert.equal(again.action, "held_by_other");
    const row = await d1ReadLock(d1, "edition:261112", { now: T0 + 1001 });
    assert.ok(row.ok);
    assert.equal(row.value, null, "o lock renovado no D1 foi devolvido");
  });

  it("held_by_other pelo D1: idade pelo relógio do D1; meta sem stage não vira NaN no JSON", async () => {
    const d1 = createFakeD1();
    const neo = editionIn(machine());
    const s300 = editionIn(machine());
    await acquireEditionLockShared(neo, { sessionId: "A", stage: 4, now: T0, host: "neo" }, d1, T0);
    d1.db.prepare("UPDATE locks SET meta = NULL").run();
    // Relógio local muito à frente: a idade vem do D1 (d1Now = T0 + 2000), não dele.
    const b = await acquireEditionLockShared(s300, { sessionId: "B", stage: 4, now: T0 + 9_999_999, host: "300" }, d1, T0 + 2000);
    assert.equal(b.action, "held_by_other");
    assert.equal(b.previous_age_ms, 2000);
    assert.ok(Number.isNaN(b.previous?.stage));
  });

  it("D1 indisponível → trava local com aviso", async () => {
    const neo = editionIn(machine());
    const r = await acquireEditionLockShared(neo, { sessionId: "A", stage: 4, now: T0, host: "neo" }, failingD1(), T0);
    assert.equal(r.action, "acquired");
    assert.equal(r.backend, "local-fallback");
    assert.match(r.d1Warning ?? "", /D1 indisponível em edition-lock acquire/);
  });
});

/**
 * test/d1-locks-review-13007-12967.test.ts — ajustes do review dos locks no D1.
 *
 * #12967: com o D1 ligado, `acquireMergeLockShared` sobrescrevia o hold
 *   FRESCO do waiter de merge da página do site (que só usa o arquivo e nunca
 *   escreve no D1) — dois merges simultâneos no mesmo repo. Agora holder não
 *   registrado e fresco recusa, e o lock tomado no D1 é devolvido.
 * #13007 item 3: release com falha transitória do D1 tenta de novo e, se
 *   seguir falhando, o aviso diz que a linha pode ter ficado no D1.
 * #13007 item 4: `edition-lock status` lê o D1 além do arquivo.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireMergeLock,
  acquireMergeLockShared,
  isRegisteredSessionId,
  mergeLockPath,
  releaseMergeLockShared,
  sessionsDir,
} from "../scripts/lib/session-registry.ts";
import { acquireEditionLockShared, readEditionLockShared } from "../scripts/lib/edition-lock.ts";
import { d1AcquireLock, d1ReadLock, mergeLockD1Name, type D1Client } from "../scripts/lib/d1-locks.ts";
import { createFakeD1, failingD1 } from "./_helpers/fake-d1.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function machine(): string {
  const root = mkdtempSync(join(tmpdir(), "d1-rev-"));
  roots.push(root);
  mkdirSync(sessionsDir(root), { recursive: true });
  return root;
}

const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const REPO = "vjpixel/diaria-studio";
const WAITER = "site-page-merge-waiter:pr-12345:pid-999";

describe("#12967 merge lock: holder local-only fresco não é sobrescrito", () => {
  it("waiter segura o arquivo; coordenador com D1 livre é recusado e o D1 fica livre", async () => {
    const d1 = createFakeD1();
    const neo = machine();
    writeFileSync(join(sessionsDir(neo), "overnight-261113-coord-1.json"), "{}");
    assert.equal(acquireMergeLock(neo, WAITER, T0), true);

    const warnings: string[] = [];
    const r = await acquireMergeLockShared(neo, "coord-1", REPO, { d1, now: T0 + 5_000, d1Now: T0 + 5_000, warn: (m) => warnings.push(m) });
    assert.equal(r.ok, false, "dois merges simultâneos no mesmo repo");
    assert.equal(JSON.parse(readFileSync(mergeLockPath(neo), "utf8")).heldBy, WAITER, "hold do waiter intacto");
    const row = await d1ReadLock(d1, mergeLockD1Name(REPO), { now: T0 + 5_001 });
    assert.ok(row.ok);
    assert.equal(row.value, null, "o lock tomado no D1 foi devolvido");
    assert.deepEqual(warnings, []);
  });

  it("hold do waiter vencido (TTL): o coordenador adquire normalmente", async () => {
    const d1 = createFakeD1();
    const neo = machine();
    assert.equal(acquireMergeLock(neo, WAITER, T0), true);
    const r = await acquireMergeLockShared(neo, "coord-1", REPO, { d1, now: T0 + 121_000, d1Now: T0 + 121_000 });
    assert.equal(r.ok, true);
    assert.equal(r.backend, "d1");
  });

  it("isRegisteredSessionId: só casa o sufixo -{id}.json em data/sessions/", () => {
    const neo = machine();
    writeFileSync(join(sessionsDir(neo), "develop-261113-abc-123.json"), "{}");
    assert.equal(isRegisteredSessionId(neo, "abc-123"), true);
    assert.equal(isRegisteredSessionId(neo, WAITER), false);
    assert.equal(isRegisteredSessionId(neo, ""), false);
    assert.equal(isRegisteredSessionId(join(neo, "nao-existe"), "abc-123"), false);
  });
});

describe("#13007 release do merge lock com falha transitória", () => {
  it("1ª falha transitória: tenta de novo e solta no D1", async () => {
    const fake = createFakeD1();
    const neo = machine();
    assert.ok((await acquireMergeLockShared(neo, "A", REPO, { d1: fake, now: T0, d1Now: T0 })).ok);
    let failNext = true;
    const flaky: D1Client = {
      async query(sql, params) {
        if (failNext && /^DELETE/i.test(sql)) {
          failNext = false;
          throw new Error("fetch failed (simulado)");
        }
        return fake.query(sql, params);
      },
    };
    const warnings: string[] = [];
    const r = await releaseMergeLockShared(neo, "A", REPO, { d1: flaky, d1Now: T0 + 1, warn: (m) => warnings.push(m) });
    assert.equal(r.ok, true);
    assert.equal(r.backend, "d1");
    const row = await d1ReadLock(fake, mergeLockD1Name(REPO), { now: T0 + 2 });
    assert.ok(row.ok);
    assert.equal(row.value, null);
    assert.deepEqual(warnings, []);
  });

  it("falha persistente: o aviso diz que a linha pode ter ficado no D1 até o TTL", async () => {
    const neo = machine();
    acquireMergeLock(neo, "A", T0);
    const d1 = failingD1();
    const warnings: string[] = [];
    const r = await releaseMergeLockShared(neo, "A", REPO, { d1, warn: (m) => warnings.push(m) });
    assert.equal(r.ok, true, "o arquivo local foi solto");
    assert.equal(r.backend, "local-fallback");
    assert.equal(d1.calls, 2, "uma 2ª tentativa");
    assert.match(warnings.join(""), /pode ter ficado no D1/);
    assert.match(warnings.join(""), /merge-lock:vjpixel\/diaria-studio/);
  });
});

describe("#13007 edition-lock status lê o D1", () => {
  it("arquivo livre, holder de outra máquina no D1: o status mostra o holder", async () => {
    const d1 = createFakeD1();
    const dir = join(machine(), "261114");
    mkdirSync(join(dir, "_internal"), { recursive: true });
    const remote = await acquireEditionLockShared(dir, { sessionId: "sess-300", stage: 4, now: T0, host: "300" }, d1, T0);
    assert.equal(remote.backend, "d1");
    rmSync(join(dir, "_internal", "edition-lock.json"), { force: true }); // o arquivo do 300 ainda não sincronizou

    const s = await readEditionLockShared(dir, d1, T0 + 1000);
    assert.equal(s.lock, null, "o arquivo diz livre");
    assert.equal(s.backend, "d1");
    assert.equal(s.d1?.holder, "sess-300");
    assert.equal(s.d1?.host, "300");
    assert.equal(s.d1?.stage, 4);
  });

  it("D1 sem holder: d1 null; D1 fora do ar: fallback com aviso", async () => {
    const dir = join(machine(), "261115");
    mkdirSync(dir, { recursive: true });
    const free = await readEditionLockShared(dir, createFakeD1(), T0);
    assert.equal(free.d1, null);
    assert.equal(free.backend, "d1");
    const down = await readEditionLockShared(dir, failingD1(), T0);
    assert.equal(down.backend, "local-fallback");
    assert.match(down.d1Warning ?? "", /edition-lock status/);
    const none = await readEditionLockShared(dir, null);
    assert.equal(none.backend, "local");
  });

  it("sanidade do fake: holder gravado direto no D1 aparece no status", async () => {
    const d1 = createFakeD1();
    const dir = join(machine(), "261116");
    mkdirSync(dir, { recursive: true });
    const r = await d1AcquireLock(d1, "edition:261116", "x", 60_000, { now: T0 });
    assert.ok(r.ok && r.value.acquired);
    const s = await readEditionLockShared(dir, d1, T0 + 1);
    assert.equal(s.d1?.holder, "x");
    assert.equal(s.d1?.host, null);
  });
});

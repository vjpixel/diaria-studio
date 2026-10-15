/**
 * test/edition-lock-10309.test.ts (#10309)
 *
 * Regressão do achado da edição 261016: o gate do Stage 4 rodou em duas
 * sessões ao mesmo tempo (original + fork) e nada acusou. A trava por edição
 * tem de devolver `held_by_other` (CLI exit 3) para a 2ª sessão enquanto a
 * 1ª está viva — e o playbook tem de chamá-la antes de escrever.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  EDITION_LOCK_TTL_MS,
  acquireEditionLock,
  decideEditionLock,
  editionLockPath,
  readEditionLock,
  releaseEditionLock,
} from "../scripts/lib/edition-lock.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = Date.parse("2026-10-15T12:00:00Z");

function tmpEdition(): string {
  return mkdtempSync(join(tmpdir(), "edition-lock-"));
}

describe("decideEditionLock (puro)", () => {
  const base = { stage: 4, host: "h", now: T0 };

  it("sem trava → acquired", () => {
    const d = decideEditionLock(null, { ...base, sessionId: "A" });
    assert.equal(d.action, "acquired");
    assert.equal(d.record?.session_id, "A");
  });

  it("trava da própria sessão → refreshed, preserva acquired_at", () => {
    const first = decideEditionLock(null, { ...base, sessionId: "A" }).record!;
    const d = decideEditionLock(first, { ...base, sessionId: "A", now: T0 + 60_000 });
    assert.equal(d.action, "refreshed");
    assert.equal(d.record?.acquired_at, first.acquired_at);
    assert.equal(d.record?.heartbeat_at, new Date(T0 + 60_000).toISOString());
  });

  it("caso da issue: fork (outra sessão) com a original viva → held_by_other, nada a gravar", () => {
    const orig = decideEditionLock(null, { ...base, sessionId: "original" }).record!;
    const d = decideEditionLock(orig, { ...base, sessionId: "fork", now: T0 + 5 * 60_000 });
    assert.equal(d.action, "held_by_other");
    assert.equal(d.record, undefined);
    assert.equal(d.previous?.session_id, "original");
  });

  it("outra sessão com --force → taken_over", () => {
    const orig = decideEditionLock(null, { ...base, sessionId: "original" }).record!;
    const d = decideEditionLock(orig, { ...base, sessionId: "fork", force: true });
    assert.equal(d.action, "taken_over");
    assert.equal(d.record?.session_id, "fork");
  });

  it("heartbeat vencido (> TTL) → took_stale", () => {
    const orig = decideEditionLock(null, { ...base, sessionId: "original" }).record!;
    const d = decideEditionLock(orig, { ...base, sessionId: "fork", now: T0 + EDITION_LOCK_TTL_MS + 1 });
    assert.equal(d.action, "took_stale");
  });

  it("heartbeat ilegível → tratado como vencido", () => {
    const d = decideEditionLock(
      { session_id: "x", host: "h", stage: 4, acquired_at: "", heartbeat_at: "lixo" },
      { ...base, sessionId: "y" },
    );
    assert.equal(d.action, "took_stale");
  });

  it("heartbeat no futuro (relógio adiantado) → vivo, avisa", () => {
    const d = decideEditionLock(
      { session_id: "x", host: "h", stage: 4, acquired_at: "", heartbeat_at: new Date(T0 + 3_600_000).toISOString() },
      { ...base, sessionId: "y" },
    );
    assert.equal(d.action, "held_by_other");
  });
});

describe("acquire/release em disco", () => {
  it("acquire grava em _internal/edition-lock.json; 2ª sessão recebe held_by_other e não sobrescreve", () => {
    const dir = tmpEdition();
    assert.equal(acquireEditionLock(dir, { sessionId: "A", stage: 4, now: T0 }).action, "acquired");
    assert.ok(existsSync(editionLockPath(dir)));
    assert.equal(acquireEditionLock(dir, { sessionId: "B", stage: 4, now: T0 + 1000 }).action, "held_by_other");
    assert.equal(readEditionLock(dir)?.session_id, "A");
  });

  it("arquivo corrompido não trava a edição", () => {
    const dir = tmpEdition();
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(editionLockPath(dir), "{nao json");
    assert.equal(acquireEditionLock(dir, { sessionId: "A", stage: 4, now: T0 }).action, "acquired");
  });

  it("release só remove a trava da própria sessão", () => {
    const dir = tmpEdition();
    acquireEditionLock(dir, { sessionId: "A", stage: 4, now: T0 });
    assert.equal(releaseEditionLock(dir, { sessionId: "B" }), "held_by_other");
    assert.ok(existsSync(editionLockPath(dir)));
    assert.equal(releaseEditionLock(dir, { sessionId: "A" }), "released");
    assert.ok(!existsSync(editionLockPath(dir)));
    assert.equal(releaseEditionLock(dir, { sessionId: "A" }), "not_held");
  });
});

describe("CLI scripts/edition-lock.ts", () => {
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/edition-lock.ts"), ...args], {
      encoding: "utf8",
      cwd: ROOT,
    });

  it("2ª sessão → exit 3; --force → exit 0; sem --session-id → exit 2", () => {
    const dir = tmpEdition();
    const a = cli(["acquire", "--edition-dir", dir, "--stage", "4", "--session-id", "A"]);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(JSON.parse(a.stdout).action, "acquired");

    const b = cli(["acquire", "--edition-dir", dir, "--stage", "4", "--session-id", "B"]);
    assert.equal(b.status, 3, b.stderr);
    assert.match(b.stderr, /outra sessão/);

    const f = cli(["acquire", "--edition-dir", dir, "--stage", "4", "--force", "--session-id", "B"]);
    assert.equal(f.status, 0, f.stderr);
    assert.equal(JSON.parse(readFileSync(editionLockPath(dir), "utf8")).session_id, "B");

    const n = cli(["acquire", "--edition-dir", dir, "--stage", "4"]);
    assert.equal(n.status, 2);
  });
});

describe("playbook Stage 4 arma a trava (#10309)", () => {
  const stage4 = readFileSync(join(ROOT, ".claude/agents/orchestrator-stage-4.md"), "utf8");

  it("§4a chama acquire standalone e trata exit 3", () => {
    assert.match(stage4, /npx tsx scripts\/edition-lock\.ts acquire --edition-dir \{EDITION_DIR\} --stage 4/);
    assert.match(stage4, /edition-lock[\s\S]{0,1500}exit 3/i);
  });

  it("§4e libera a trava", () => {
    assert.match(stage4, /npx tsx scripts\/edition-lock\.ts release --edition-dir \{EDITION_DIR\}/);
  });
});

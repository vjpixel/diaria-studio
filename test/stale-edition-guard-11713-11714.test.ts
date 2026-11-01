/**
 * #11713 — release simples (`editar`/`abortar`/halt) em outro host não pode
 * deixar o guard sem sinal: regrava a trava como tombstone de interrupção.
 * #11714 — `stale-edition-guard --force` registra o override no run-log.
 * (+ #11712, parte de lib: o guard com `--step 3` acusa o Stage 4 de outro host.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INTERRUPTED_TOMBSTONE_WINDOW_MS,
  assessStaleEdition,
  describeSignals,
} from "../scripts/lib/stale-edition-guard.ts";
import { acquireEditionLock, readEditionLock, releaseEditionLock } from "../scripts/lib/edition-lock.ts";
import { runStaleEditionGuard } from "../scripts/stale-edition-guard.ts";

const T0 = Date.parse("2026-10-31T12:00:00Z");

function editionDir(name = "261101"): string {
  const dir = join(mkdtempSync(join(tmpdir(), "stale-11713-")), name);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

describe("#11713 — release simples em outro host", () => {
  it("cenário da issue: `editar` no Neo, Stage 4 no 300 → guard bloqueia (remote_interrupted)", () => {
    const dir = editionDir();
    acquireEditionLock(dir, { sessionId: "neo-sess", stage: 4, host: "neo", now: T0 });
    assert.equal(releaseEditionLock(dir, { sessionId: "neo-sess", host: "neo", now: T0 + 60_000 }), "released");
    const lock = readEditionLock(dir);
    assert.ok(lock, "o release simples não pode apagar o arquivo");
    assert.equal(lock!.interrupted_stage, 4);
    const v = assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3], lock, localHost: "300", now: T0 + 5 * 60_000 });
    assert.equal(v.ok, false);
    assert.equal(v.signals[0].kind, "remote_interrupted");
    assert.match(describeSignals(v.signals), /neo.*sem concluir/);
  });

  it("mesmo host não bloqueia (retomar onde parou)", () => {
    const dir = editionDir();
    acquireEditionLock(dir, { sessionId: "s", stage: 4, host: "300", now: T0 });
    releaseEditionLock(dir, { sessionId: "s", host: "300", now: T0 });
    const v = assessStaleEdition({ step: 4, sentinelSteps: [1, 2, 3], lock: readEditionLock(dir), localHost: "300", now: T0 });
    assert.equal(v.ok, true);
  });

  it("tombstone de interrupção mais velho que a janela deixa de bloquear; stage anterior não bloqueia", () => {
    const tomb = {
      session_id: "s", host: "neo", stage: 4, acquired_at: "", heartbeat_at: "",
      released_at: new Date(T0).toISOString(), interrupted_stage: 4,
    };
    const base = { step: 4, sentinelSteps: [1, 2, 3], localHost: "300" };
    assert.equal(assessStaleEdition({ ...base, lock: tomb, now: T0 + INTERRUPTED_TOMBSTONE_WINDOW_MS }).ok, false);
    assert.equal(assessStaleEdition({ ...base, lock: tomb, now: T0 + INTERRUPTED_TOMBSTONE_WINDOW_MS + 1 }).ok, true);
    assert.equal(assessStaleEdition({ ...base, lock: { ...tomb, interrupted_stage: 3 }, now: T0 }).ok, true);
  });

  it("interrupted_stage/released_at ilegíveis contam como à frente e recentes (fail-closed)", () => {
    const dir = editionDir();
    writeFileSync(
      join(dir, "_internal", "edition-lock.json"),
      JSON.stringify({ session_id: "s", host: "neo", stage: null, heartbeat_at: "x", released_at: "lixo", interrupted_stage: null }),
    );
    const lock = readEditionLock(dir)!;
    assert.ok(Number.isNaN(lock.interrupted_stage));
    const v = assessStaleEdition({ step: 5, sentinelSteps: [1, 2, 3, 4], lock, localHost: "300", now: T0 + 30 * 86_400_000 });
    assert.equal(v.ok, false);
    assert.equal(v.signals[0].kind, "remote_interrupted");
  });

  it("acquire trata o tombstone de interrupção como ausente", () => {
    const dir = editionDir();
    acquireEditionLock(dir, { sessionId: "a", stage: 4, host: "neo", now: T0 });
    releaseEditionLock(dir, { sessionId: "a", host: "neo", now: T0 });
    assert.equal(acquireEditionLock(dir, { sessionId: "b", stage: 4, host: "300", now: T0 + 1 }).action, "acquired");
    const r = readEditionLock(dir)!;
    assert.equal(r.released_at, undefined);
    assert.equal(r.interrupted_stage, undefined);
  });

  it("CLI: tombstone de interrupção de outro host → exit 4", () => {
    const dir = editionDir();
    acquireEditionLock(dir, { sessionId: "a", stage: 4, host: "outro-host-11713" });
    releaseEditionLock(dir, { sessionId: "a", host: "outro-host-11713" });
    const logRoot = mkdtempSync(join(tmpdir(), "stale-log-"));
    assert.equal(runStaleEditionGuard(["check", "--edition-dir", dir, "--step", "4"], { logRoot, host: "300" }), 4);
  });
});

describe("#11712 (lib) — guard com --step 3 enxerga o Stage 4 de outro host", () => {
  it("gate 4 aprovado no Neo, sentinel 3 ainda não chegou no 300 → bloqueia re-rodar a Etapa 3", () => {
    const dir = editionDir();
    acquireEditionLock(dir, { sessionId: "a", stage: 4, host: "neo", now: T0 });
    releaseEditionLock(dir, { sessionId: "a", host: "neo", completedStage: 4, now: T0 });
    const v = assessStaleEdition({ step: 3, sentinelSteps: [1, 2], lock: readEditionLock(dir), localHost: "300" });
    assert.equal(v.ok, false);
    assert.equal(v.signals[0].kind, "remote_completed");
  });
  it("gate 4 em andamento no Neo → bloqueia re-rodar a Etapa 3", () => {
    const lock = { session_id: "a", host: "neo", stage: 4, acquired_at: "", heartbeat_at: new Date(T0).toISOString() };
    assert.equal(assessStaleEdition({ step: 3, sentinelSteps: [1, 2], lock, localHost: "300" }).ok, false);
  });
});

describe("#11714 — --force registra o override no run-log", () => {
  it("grava evento warn com os sinais; sai 0", () => {
    const dir = editionDir("261102");
    writeFileSync(join(dir, "_internal", ".step-5-done.json"), "{}");
    const logRoot = mkdtempSync(join(tmpdir(), "stale-log-"));
    assert.equal(runStaleEditionGuard(["check", "--edition-dir", dir, "--step", "4", "--force"], { logRoot, host: "300" }), 0);
    const logPath = join(logRoot, "data", "run-log.jsonl");
    assert.ok(existsSync(logPath), "o override precisa ir para o run-log");
    const events = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.level, "warn");
    assert.equal(e.message, "stale_edition_guard_forced");
    assert.equal(e.edition, "261102");
    assert.equal(e.stage, 4);
    assert.deepEqual(e.details.signals, [{ kind: "later_sentinel", step: 5 }]);
    assert.equal(e.details.host, "300");
  });

  it("--edition explícito vence o nome do diretório", () => {
    const dir = editionDir("nao-e-data");
    writeFileSync(join(dir, "_internal", ".step-5-done.json"), "{}");
    const logRoot = mkdtempSync(join(tmpdir(), "stale-log-"));
    runStaleEditionGuard(["check", "--edition-dir", dir, "--step", "4", "--force", "--edition", "261103"], { logRoot });
    const e = JSON.parse(readFileSync(join(logRoot, "data", "run-log.jsonl"), "utf8").trim());
    assert.equal(e.edition, "261103");
  });

  it("sem sinais, --force não grava nada (não há override)", () => {
    const dir = editionDir();
    const logRoot = mkdtempSync(join(tmpdir(), "stale-log-"));
    assert.equal(runStaleEditionGuard(["check", "--edition-dir", dir, "--step", "4", "--force"], { logRoot }), 0);
    assert.equal(existsSync(join(logRoot, "data", "run-log.jsonl")), false);
  });

  it("sem --force, com sinais, sai 4 e não grava", () => {
    const dir = editionDir();
    writeFileSync(join(dir, "_internal", ".step-5-done.json"), "{}");
    const logRoot = mkdtempSync(join(tmpdir(), "stale-log-"));
    assert.equal(runStaleEditionGuard(["check", "--edition-dir", dir, "--step", "4"], { logRoot }), 4);
    assert.equal(existsSync(join(logRoot, "data", "run-log.jsonl")), false);
  });
});

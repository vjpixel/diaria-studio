/**
 * test/claude-session-version-drift-alarm.test.ts (#6927)
 *
 * Regressão pura pra `scripts/lib/claude-session-version-drift-alarm.ts`
 * (detector de drift processo≠disco + idempotência) e I/O de
 * `scripts/claude-session-version-drift-alarm.ts` (`loadState`/`saveState`,
 * `listLongLivedClaudeProcesses`, `readExeLink`). Nenhum teste depende de
 * `/proc` real nem de processos `claude` de verdade rodando — os
 * resultados de `ps`/`readlink` entram como fixture via injeção de
 * `SessionDiscoveryOps`, mesma disciplina de `NodeModulesFsOps` em
 * `test/node-modules-loop-alarm.test.ts`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateSessionDrift,
  isSessionDriftPending,
  emptyClaudeSessionDriftAlarmState,
  advanceClaudeSessionDriftAlarmState,
  shouldAlarmClaudeSessionDrift,
  claudeSessionDriftFindingKey,
  buildClaudeSessionDriftAlarmEmail,
  type ClaudeSessionProcess,
  type SessionDriftEvaluation,
} from "../scripts/lib/claude-session-version-drift-alarm.ts";
import {
  loadState,
  saveState,
  listLongLivedClaudeProcesses,
  readExeLink,
  type SessionDiscoveryOps,
} from "../scripts/claude-session-version-drift-alarm.ts";

function session(overrides: Partial<ClaudeSessionProcess> = {}): ClaudeSessionProcess {
  return { pid: 1234, cmd: "claude --model sonnet --remote-control", ageSeconds: 100 * 3600, ...overrides };
}

describe("evaluateSessionDrift (#6927) — detector puro", () => {
  it("processo mais novo que o threshold -> too-young, exe link nem é considerado", () => {
    const r = evaluateSessionDrift(session({ ageSeconds: 2 * 3600 }), "/usr/bin/claude", 24);
    assert.equal(r.status, "too-young");
    assert.equal(r.exeLinkTarget, null);
  });

  it("vida longa + exe link ausente (readlink falhou) -> unresolved, nunca 'ok' por omissão", () => {
    const r = evaluateSessionDrift(session({ ageSeconds: 30 * 3600 }), null, 24);
    assert.equal(r.status, "unresolved");
  });

  it("vida longa + exe link contém '(deleted)' -> drift confirmado", () => {
    const r = evaluateSessionDrift(
      session({ ageSeconds: 36 * 3600 }),
      "/tmp/.claude-code-abc123/bin/claude.exe (deleted)",
      24,
    );
    assert.equal(r.status, "drift");
    assert.match(r.message, /processo != disco/);
  });

  it("vida longa + exe link normal (binário ainda no disco) -> ok", () => {
    const r = evaluateSessionDrift(session({ ageSeconds: 30 * 3600 }), "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", 24);
    assert.equal(r.status, "ok");
  });

  it("threshold exatamente na fronteira (ageHours === thresholdHours) conta como vida longa (>=, não >)", () => {
    const r = evaluateSessionDrift(session({ ageSeconds: 24 * 3600 }), "/x (deleted)", 24);
    assert.equal(r.status, "drift");
  });
});

describe("isSessionDriftPending (#6927)", () => {
  it("drift e unresolved pendem; too-young e ok não", () => {
    const base = { pid: 1, cmd: "x", ageHours: 30 } as Pick<SessionDriftEvaluation, "status">;
    assert.equal(isSessionDriftPending({ ...base, status: "drift" }), true);
    assert.equal(isSessionDriftPending({ ...base, status: "unresolved" }), true);
    assert.equal(isSessionDriftPending({ ...base, status: "too-young" }), false);
    assert.equal(isSessionDriftPending({ ...base, status: "ok" }), false);
  });
});

function evalFixture(overrides: Partial<SessionDriftEvaluation> = {}): SessionDriftEvaluation {
  return {
    pid: 1234,
    cmd: "claude --remote-control",
    ageHours: 30,
    status: "drift",
    exeLinkTarget: "/x (deleted)",
    message: "m",
    ...overrides,
  };
}

describe("claudeSessionDriftFindingKey / idempotência (#6927)", () => {
  it("fingerprint vazio quando nenhuma evaluation está pendente", () => {
    const evaluations = [evalFixture({ status: "ok", exeLinkTarget: "/x" })];
    assert.equal(claudeSessionDriftFindingKey(evaluations), "");
  });

  it("fingerprint estável para o MESMO conjunto de pids em drift, independente da ordem", () => {
    const a = [evalFixture({ pid: 1 }), evalFixture({ pid: 2, status: "unresolved" })];
    const b = [evalFixture({ pid: 2, status: "unresolved" }), evalFixture({ pid: 1 })];
    assert.equal(claudeSessionDriftFindingKey(a), claudeSessionDriftFindingKey(b));
  });

  it("fingerprint muda quando um pid novo entra em drift", () => {
    const a = [evalFixture({ pid: 1 })];
    const b = [evalFixture({ pid: 1 }), evalFixture({ pid: 2 })];
    assert.notEqual(claudeSessionDriftFindingKey(a), claudeSessionDriftFindingKey(b));
  });

  it("shouldAlarm: false quando não há pendente", () => {
    const state = emptyClaudeSessionDriftAlarmState();
    const evaluations = [evalFixture({ status: "ok", exeLinkTarget: "/x" })];
    assert.equal(shouldAlarmClaudeSessionDrift(state, evaluations), false);
  });

  it("shouldAlarm: true na 1ª ocorrência (state vazio) com achado pendente", () => {
    const state = emptyClaudeSessionDriftAlarmState();
    assert.equal(shouldAlarmClaudeSessionDrift(state, [evalFixture()]), true);
  });

  it("shouldAlarm: false quando o MESMO conjunto já foi alarmado (não repete e-mail)", () => {
    const evaluations = [evalFixture({ pid: 5 })];
    const state = advanceClaudeSessionDriftAlarmState(evaluations, new Date("2026-09-01T00:00:00Z"));
    assert.equal(shouldAlarmClaudeSessionDrift(state, evaluations), false);
  });

  it("shouldAlarm: true de novo quando o conjunto pendente MUDA (nova sessão em drift)", () => {
    const first = [evalFixture({ pid: 5 })];
    const state = advanceClaudeSessionDriftAlarmState(first, new Date("2026-09-01T00:00:00Z"));
    const second = [evalFixture({ pid: 5 }), evalFixture({ pid: 6 })];
    assert.equal(shouldAlarmClaudeSessionDrift(state, second), true);
  });

  it("advance com fingerprint vazio quando a checagem resolveu (re-arma pra próxima ocorrência)", () => {
    const cleared = advanceClaudeSessionDriftAlarmState([evalFixture({ status: "ok", exeLinkTarget: "/x" })], new Date());
    assert.equal(cleared.lastAlarmedFingerprint, null);
  });
});

describe("buildClaudeSessionDriftAlarmEmail (#6927)", () => {
  it("assunto cita drift quando há pelo menos 1 drift confirmado", () => {
    const { subject, body } = buildClaudeSessionDriftAlarmEmail([evalFixture()], 24, new Date("2026-09-01T12:00:00Z"));
    assert.match(subject, /binário defasado/);
    assert.match(body, /pid 1234/);
    assert.match(body, /SEM POLÍTICA/);
  });

  it("assunto cita 'sem confirmação' quando só há unresolved (sem drift confirmado)", () => {
    const { subject } = buildClaudeSessionDriftAlarmEmail([evalFixture({ status: "unresolved" })], 24, new Date());
    assert.match(subject, /sem confirmação de versão/);
  });
});

describe("loadState/saveState (#6927) — I/O", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-session-drift-alarm-"));
    statePath = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("statePath ausente -> estado vazio", () => {
    assert.deepEqual(loadState(statePath), emptyClaudeSessionDriftAlarmState());
  });

  it("save + load roundtrip", () => {
    const state = { lastAlarmedFingerprint: "5:drift", lastCheckedAt: "2026-09-01T00:00:00.000Z" };
    saveState(state, statePath);
    assert.ok(existsSync(statePath));
    assert.deepEqual(loadState(statePath), state);
  });

  it("JSON malformado no disco -> estado vazio, nunca lança", () => {
    saveState({ lastAlarmedFingerprint: "x", lastCheckedAt: "y" }, statePath);
    // Corrompe deliberadamente.
    writeFileSync(statePath, "não é json{{{");
    assert.doesNotThrow(() => loadState(statePath));
    assert.deepEqual(loadState(statePath), emptyClaudeSessionDriftAlarmState());
  });
});

function fakeOps(overrides: Partial<SessionDiscoveryOps> = {}): SessionDiscoveryOps {
  return {
    execFileSync: (() => "") as unknown as SessionDiscoveryOps["execFileSync"],
    readlinkSync: (() => {
      throw new Error("não usado neste fixture");
    }) as unknown as SessionDiscoveryOps["readlinkSync"],
    ...overrides,
  };
}

describe("listLongLivedClaudeProcesses (#6927) — I/O", () => {
  it("filtra só linhas com 'claude' E '--remote-control'", () => {
    const psOutput = [
      "1111 100 claude --model sonnet --remote-control",
      "2222 200 /usr/bin/some-other-process --remote-control",
      "3333 300 claude --model opus --effort high",
      "4444 400 claude --model haiku --remote-control",
      "",
    ].join("\n");
    const ops = fakeOps({ execFileSync: (() => psOutput) as unknown as SessionDiscoveryOps["execFileSync"] });
    const result = listLongLivedClaudeProcesses(ops);
    assert.deepEqual(
      result.map((s) => s.pid),
      [1111, 4444],
    );
    assert.equal(result[0].ageSeconds, 100);
  });

  it("`ps` lançando erro -> PROPAGA (nunca vira lista vazia — achado #6953: numa run Linux, `ps` falhar é anomalia real, não 'zero sessões')", () => {
    const ops = fakeOps({
      execFileSync: (() => {
        throw new Error("ps: command not found");
      }) as unknown as SessionDiscoveryOps["execFileSync"],
    });
    assert.throws(() => listLongLivedClaudeProcesses(ops), /ps: command not found/);
  });

  it("linha que não casa o formato pid/etimes/args é ignorada, não derruba o parse das demais", () => {
    const psOutput = ["garbage line without the right shape", "5555 500 claude --remote-control"].join("\n");
    const ops = fakeOps({ execFileSync: (() => psOutput) as unknown as SessionDiscoveryOps["execFileSync"] });
    const result = listLongLivedClaudeProcesses(ops);
    assert.deepEqual(
      result.map((s) => s.pid),
      [5555],
    );
  });
});

describe("readExeLink (#6927) — I/O", () => {
  it("readlink bem-sucedido -> devolve o alvo", () => {
    const ops = fakeOps({
      readlinkSync: (() => "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js") as unknown as SessionDiscoveryOps["readlinkSync"],
    });
    assert.equal(readExeLink(1234, ops), "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js");
  });

  it("readlink lançando (processo morreu, permissão, etc.) -> null, nunca lança", () => {
    const ops = fakeOps();
    assert.doesNotThrow(() => readExeLink(1234, ops));
    assert.equal(readExeLink(1234, ops), null);
  });
});

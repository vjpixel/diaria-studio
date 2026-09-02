/**
 * test/npm-version-drift-alarm.test.ts (#6960)
 *
 * Regressão pura pra `scripts/lib/npm-version-drift-alarm.ts` (detector de
 * defasagem disco↔upstream + cursor `driftSince` + idempotência) e I/O de
 * `scripts/npm-version-drift-alarm.ts` (`loadState`/`saveState`,
 * `readDiskVersion`/`readUpstreamVersion`). Nenhum teste depende de rede
 * real nem de `npm` de verdade — os resultados de `execFileSync`/
 * `readFileSync` entram como fixture via injeção de `VersionCheckOps`,
 * mesma disciplina de `SessionDiscoveryOps` em
 * `test/claude-session-version-drift-alarm.test.ts`.
 *
 * Cobre o caso central da issue: falha de I/O (rede fora, path mudou,
 * package.json ilegível) PROPAGA — nunca vira "sem defasagem" por omissão.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evaluateNpmVersionDrift,
  isNpmVersionDriftPending,
  emptyNpmVersionDriftAlarmState,
  advanceNpmVersionDriftState,
  shouldAlarmNpmVersionDrift,
  markNpmVersionDriftAlarmed,
  npmVersionDriftFindingKey,
  buildNpmVersionDriftAlarmEmail,
  type NpmVersionCheck,
  type NpmVersionDriftAlarmState,
} from "../scripts/lib/npm-version-drift-alarm.ts";
import { loadState, saveState, readDiskVersion, readUpstreamVersion, type VersionCheckOps } from "../scripts/npm-version-drift-alarm.ts";

function check(overrides: Partial<NpmVersionCheck> = {}): NpmVersionCheck {
  return { diskVersion: "2.1.251", upstreamVersion: "2.1.257", ...overrides };
}

describe("evaluateNpmVersionDrift (#6960) — detector puro", () => {
  it("disco == upstream -> in-sync, ageDays 0", () => {
    const r = evaluateNpmVersionDrift(check({ diskVersion: "2.1.257", upstreamVersion: "2.1.257" }), null, new Date(), 7);
    assert.equal(r.status, "in-sync");
    assert.equal(r.ageDays, 0);
  });

  it("drift recém-detectado (driftSince null) -> ageDays ~0, status drift-fresh", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const r = evaluateNpmVersionDrift(check(), null, now, 7);
    assert.equal(r.status, "drift-fresh");
    assert.ok(r.ageDays < 0.01);
  });

  it("drift com driftSince 3 dias atrás, limiar 7 -> drift-fresh (ainda dentro da cadência normal)", () => {
    const now = new Date("2026-09-04T00:00:00Z");
    const since = new Date("2026-09-01T00:00:00Z").toISOString();
    const r = evaluateNpmVersionDrift(check(), since, now, 7);
    assert.equal(r.status, "drift-fresh");
    assert.equal(Math.round(r.ageDays), 3);
  });

  it("drift com driftSince 8 dias atrás, limiar 7 -> drift-stale", () => {
    const now = new Date("2026-09-09T00:00:00Z");
    const since = new Date("2026-09-01T00:00:00Z").toISOString();
    const r = evaluateNpmVersionDrift(check(), since, now, 7);
    assert.equal(r.status, "drift-stale");
    assert.match(r.message, />= limiar/);
  });

  it("fronteira exata (ageDays === thresholdDays) conta como stale (>=, não >)", () => {
    const now = new Date("2026-09-08T00:00:00Z");
    const since = new Date("2026-09-01T00:00:00Z").toISOString();
    const r = evaluateNpmVersionDrift(check(), since, now, 7);
    assert.equal(r.status, "drift-stale");
  });
});

describe("isNpmVersionDriftPending (#6960)", () => {
  it("só drift-stale pende; in-sync e drift-fresh não", () => {
    const of = (status: "in-sync" | "drift-fresh" | "drift-stale") => ({ status });
    assert.equal(isNpmVersionDriftPending(of("drift-stale")), true);
    assert.equal(isNpmVersionDriftPending(of("drift-fresh")), false);
    assert.equal(isNpmVersionDriftPending(of("in-sync")), false);
  });
});

describe("advanceNpmVersionDriftState — cursor driftSince (#6960)", () => {
  it("1ª detecção de drift (prev vazio) -> driftSince = now", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    const next = advanceNpmVersionDriftState(emptyNpmVersionDriftAlarmState(), check(), now);
    assert.equal(next.driftSince, now.toISOString());
  });

  it("drift que já vinha do estado anterior MANTÉM driftSince original (não reinicia a cada execução)", () => {
    const originalSince = "2026-08-25T00:00:00.000Z";
    const prev: NpmVersionDriftAlarmState = { driftSince: originalSince, lastAlarmedFingerprint: null, lastCheckedAt: null };
    const next = advanceNpmVersionDriftState(prev, check(), new Date("2026-09-01T12:00:00Z"));
    assert.equal(next.driftSince, originalSince);
  });

  it("checagem resolveu (disco == upstream) -> driftSince reseta pra null, fingerprint some", () => {
    const prev: NpmVersionDriftAlarmState = {
      driftSince: "2026-08-01T00:00:00.000Z",
      lastAlarmedFingerprint: "2.1.251->2.1.257",
      lastCheckedAt: "2026-08-01T00:00:00.000Z",
    };
    const next = advanceNpmVersionDriftState(prev, check({ diskVersion: "2.1.257" }), new Date());
    assert.equal(next.driftSince, null);
    assert.equal(next.lastAlarmedFingerprint, null);
  });
});

describe("npmVersionDriftFindingKey / shouldAlarmNpmVersionDrift — idempotência (#6960)", () => {
  it("fingerprint vazio quando não pendente (in-sync)", () => {
    const evaluation = evaluateNpmVersionDrift(check({ diskVersion: "2.1.257" }), null, new Date(), 7);
    assert.equal(npmVersionDriftFindingKey(evaluation), "");
  });

  it("fingerprint é o par disco->upstream quando drift-stale", () => {
    const now = new Date("2026-09-10T00:00:00Z");
    const evaluation = evaluateNpmVersionDrift(check(), "2026-09-01T00:00:00.000Z", now, 7);
    assert.equal(npmVersionDriftFindingKey(evaluation), "2.1.251->2.1.257");
  });

  it("shouldAlarm: false quando ainda não é stale", () => {
    const state = emptyNpmVersionDriftAlarmState();
    const now = new Date("2026-09-01T00:01:00Z");
    assert.equal(shouldAlarmNpmVersionDrift(state, check(), now, 7), false);
  });

  it("shouldAlarm: true na 1ª ocorrência stale (state vazio, driftSince já avançado além do limiar)", () => {
    const state: NpmVersionDriftAlarmState = {
      driftSince: "2026-08-01T00:00:00.000Z",
      lastAlarmedFingerprint: null,
      lastCheckedAt: null,
    };
    const now = new Date("2026-09-01T00:00:00Z");
    assert.equal(shouldAlarmNpmVersionDrift(state, check(), now, 7), true);
  });

  it("shouldAlarm: false quando o MESMO par já foi alarmado (não repete e-mail)", () => {
    const state: NpmVersionDriftAlarmState = {
      driftSince: "2026-08-01T00:00:00.000Z",
      lastAlarmedFingerprint: "2.1.251->2.1.257",
      lastCheckedAt: "2026-08-01T00:00:00.000Z",
    };
    const now = new Date("2026-09-01T00:00:00Z");
    assert.equal(shouldAlarmNpmVersionDrift(state, check(), now, 7), false);
  });

  it("shouldAlarm: true de novo quando o UPSTREAM avança (par muda) mesmo com driftSince antigo mantido", () => {
    const state: NpmVersionDriftAlarmState = {
      driftSince: "2026-08-01T00:00:00.000Z",
      lastAlarmedFingerprint: "2.1.251->2.1.257",
      lastCheckedAt: "2026-08-01T00:00:00.000Z",
    };
    const now = new Date("2026-09-01T00:00:00Z");
    assert.equal(shouldAlarmNpmVersionDrift(state, check({ upstreamVersion: "2.1.263" }), now, 7), true);
  });

  it("markNpmVersionDriftAlarmed grava o fingerprint atual", () => {
    const now = new Date("2026-09-10T00:00:00Z");
    const evaluation = evaluateNpmVersionDrift(check(), "2026-09-01T00:00:00.000Z", now, 7);
    const marked = markNpmVersionDriftAlarmed(emptyNpmVersionDriftAlarmState(), evaluation);
    assert.equal(marked.lastAlarmedFingerprint, "2.1.251->2.1.257");
  });
});

describe("buildNpmVersionDriftAlarmEmail (#6960)", () => {
  it("assunto e corpo citam as duas versões e o limiar", () => {
    const now = new Date("2026-09-10T00:00:00Z");
    const evaluation = evaluateNpmVersionDrift(check(), "2026-09-01T00:00:00.000Z", now, 7);
    const { subject, body } = buildNpmVersionDriftAlarmEmail(evaluation, 7, now);
    assert.match(subject, /2\.1\.251/);
    assert.match(subject, /2\.1\.257/);
    assert.match(body, /disco:\s+2\.1\.251/);
    assert.match(body, /upstream:\s+2\.1\.257/);
    assert.match(body, /#6927/);
  });
});

describe("loadState/saveState (#6960) — I/O", () => {
  let dir: string;
  let statePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "npm-version-drift-alarm-"));
    statePath = join(dir, "state.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("statePath ausente -> estado vazio", () => {
    assert.deepEqual(loadState(statePath), emptyNpmVersionDriftAlarmState());
  });

  it("save + load roundtrip", () => {
    const state: NpmVersionDriftAlarmState = {
      driftSince: "2026-09-01T00:00:00.000Z",
      lastAlarmedFingerprint: "2.1.251->2.1.257",
      lastCheckedAt: "2026-09-01T00:00:00.000Z",
    };
    saveState(state, statePath);
    assert.ok(existsSync(statePath));
    assert.deepEqual(loadState(statePath), state);
  });

  it("JSON malformado no disco -> estado vazio, nunca lança", () => {
    writeFileSync(statePath, "não é json{{{");
    assert.doesNotThrow(() => loadState(statePath));
    assert.deepEqual(loadState(statePath), emptyNpmVersionDriftAlarmState());
  });
});

function fakeOps(overrides: Partial<VersionCheckOps> = {}): VersionCheckOps {
  return {
    execFileSync: (() => {
      throw new Error("não usado neste fixture");
    }) as unknown as VersionCheckOps["execFileSync"],
    readFileSync: (() => {
      throw new Error("não usado neste fixture");
    }) as unknown as VersionCheckOps["readFileSync"],
    ...overrides,
  };
}

describe("readDiskVersion (#6960) — I/O, nunca falha em silêncio", () => {
  it("lê npm root -g + package.json com sucesso", () => {
    const ops = fakeOps({
      execFileSync: (() => "/usr/lib/node_modules\n") as unknown as VersionCheckOps["execFileSync"],
      readFileSync: (() => JSON.stringify({ version: "2.1.251" })) as unknown as VersionCheckOps["readFileSync"],
    });
    assert.equal(readDiskVersion(ops), "2.1.251");
  });

  it("`npm root -g` lançando (rede/binário quebrado) -> PROPAGA", () => {
    const ops = fakeOps({
      execFileSync: (() => {
        throw new Error("npm: command not found");
      }) as unknown as VersionCheckOps["execFileSync"],
    });
    assert.throws(() => readDiskVersion(ops), /npm: command not found/);
  });

  it("`npm root -g` devolve string vazia -> PROPAGA (nunca vira caminho vazio silencioso)", () => {
    const ops = fakeOps({
      execFileSync: (() => "   \n") as unknown as VersionCheckOps["execFileSync"],
    });
    assert.throws(() => readDiskVersion(ops), /string vazia/);
  });

  it("package.json ilegível (path mudou de lugar) -> PROPAGA", () => {
    const ops = fakeOps({
      execFileSync: (() => "/usr/lib/node_modules\n") as unknown as VersionCheckOps["execFileSync"],
      readFileSync: (() => {
        throw new Error("ENOENT: no such file or directory");
      }) as unknown as VersionCheckOps["readFileSync"],
    });
    assert.throws(() => readDiskVersion(ops), /ENOENT/);
  });

  it("package.json sem campo version -> PROPAGA (nunca lê como versão vazia)", () => {
    const ops = fakeOps({
      execFileSync: (() => "/usr/lib/node_modules\n") as unknown as VersionCheckOps["execFileSync"],
      readFileSync: (() => JSON.stringify({ name: "@anthropic-ai/claude-code" })) as unknown as VersionCheckOps["readFileSync"],
    });
    assert.throws(() => readDiskVersion(ops), /version.*válido/);
  });

  it("package.json com JSON inválido -> PROPAGA (JSON.parse lança)", () => {
    const ops = fakeOps({
      execFileSync: (() => "/usr/lib/node_modules\n") as unknown as VersionCheckOps["execFileSync"],
      readFileSync: (() => "não é json{{{") as unknown as VersionCheckOps["readFileSync"],
    });
    assert.throws(() => readDiskVersion(ops));
  });
});

describe("readUpstreamVersion (#6960) — I/O, nunca falha em silêncio", () => {
  it("lê npm view com sucesso", () => {
    const ops = fakeOps({ execFileSync: (() => "2.1.257\n") as unknown as VersionCheckOps["execFileSync"] });
    assert.equal(readUpstreamVersion(ops), "2.1.257");
  });

  it("`npm view` lançando (sem rede) -> PROPAGA", () => {
    const ops = fakeOps({
      execFileSync: (() => {
        throw new Error("npm ERR! network request failed");
      }) as unknown as VersionCheckOps["execFileSync"],
    });
    assert.throws(() => readUpstreamVersion(ops), /network request failed/);
  });

  it("`npm view` devolve string vazia -> PROPAGA", () => {
    const ops = fakeOps({ execFileSync: (() => "  \n") as unknown as VersionCheckOps["execFileSync"] });
    assert.throws(() => readUpstreamVersion(ops), /string vazia/);
  });
});

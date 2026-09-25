/**
 * test/tmp-cleanup.test.ts (#8828)
 *
 * Cobre o miolo puro (`scripts/lib/tmp-cleanup.ts`) — nenhum I/O de disco
 * real. Foco nos dois guards invariáveis que a issue #8828 pede
 * explicitamente que sejam testados com um cenário SINTÉTICO: (1) diretório
 * de sessão ATIVA nunca é apagado, mesmo se parecer velho; (2) diretório
 * mais novo que `SESSION_DIR_MIN_AGE_MS` nunca é apagado, mesmo se não
 * estiver na lista de sessões ativas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planTmpCleanup,
  planFreedOutputBytes,
  SESSION_DIR_MIN_AGE_MS,
  OUTPUT_FILE_MIN_AGE_MS,
  OUTPUT_FILE_MIN_SIZE_BYTES,
  type SessionDirCandidate,
  type OutputFileCandidate,
} from "../scripts/lib/tmp-cleanup.ts";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const THREE_DAYS_AGO = NOW - 3 * 24 * 60 * 60 * 1000;
const ONE_HOUR_AGO = NOW - 60 * 60 * 1000;

describe("planTmpCleanup — guard de sessão ATIVA (cenário sintético, #8828)", () => {
  it("diretório de sessão ATIVA nunca é candidato a remoção, mesmo com 3 dias de idade", () => {
    const activeDir: SessionDirCandidate = {
      sessionId: "active-session-1",
      path: "/tmp/claude-1000/proj/active-session-1",
      mtimeMs: THREE_DAYS_AGO, // velho o suficiente pra ser removido SE não fosse ativo
    };
    const endedDir: SessionDirCandidate = {
      sessionId: "ended-session-2",
      path: "/tmp/claude-1000/proj/ended-session-2",
      mtimeMs: THREE_DAYS_AGO, // mesma idade, mas NÃO consta como ativa
    };
    const activeSessionIds = new Set(["active-session-1"]);

    const plan = planTmpCleanup([activeDir, endedDir], [], activeSessionIds, NOW);

    assert.deepEqual(
      plan.sessionDirsSkippedActive.map((d) => d.sessionId),
      ["active-session-1"],
    );
    assert.deepEqual(
      plan.sessionDirsToRemove.map((d) => d.sessionId),
      ["ended-session-2"],
    );
  });

  it("sessão que consta ativa MAS já passou de SESSION_DIR_MIN_AGE_MS continua protegida — ativa vence idade", () => {
    const dir: SessionDirCandidate = {
      sessionId: "s1",
      path: "/tmp/claude-1000/proj/s1",
      mtimeMs: NOW - 10 * 24 * 60 * 60 * 1000, // 10 dias — bem além do guard de idade
    };
    const plan = planTmpCleanup([dir], [], new Set(["s1"]), NOW);
    assert.equal(plan.sessionDirsToRemove.length, 0);
    assert.equal(plan.sessionDirsSkippedActive.length, 1);
  });
});

describe("planTmpCleanup — guard de idade (nunca < SESSION_DIR_MIN_AGE_MS, #8828)", () => {
  it("diretório encerrado há 1 hora (não-ativo) NÃO é candidato — jovem demais", () => {
    const dir: SessionDirCandidate = {
      sessionId: "ended-recent",
      path: "/tmp/claude-1000/proj/ended-recent",
      mtimeMs: ONE_HOUR_AGO,
    };
    const plan = planTmpCleanup([dir], [], new Set(), NOW);
    assert.equal(plan.sessionDirsToRemove.length, 0);
    assert.deepEqual(
      plan.sessionDirsSkippedYoung.map((d) => d.sessionId),
      ["ended-recent"],
    );
  });

  it("diretório exatamente no limiar de SESSION_DIR_MIN_AGE_MS é candidato (inclusivo)", () => {
    const dir: SessionDirCandidate = {
      sessionId: "exact-threshold",
      path: "/tmp/claude-1000/proj/exact-threshold",
      mtimeMs: NOW - SESSION_DIR_MIN_AGE_MS,
    };
    const plan = planTmpCleanup([dir], [], new Set(), NOW);
    assert.deepEqual(
      plan.sessionDirsToRemove.map((d) => d.sessionId),
      ["exact-threshold"],
    );
  });

  it("1ms abaixo do limiar NÃO é candidato", () => {
    const dir: SessionDirCandidate = {
      sessionId: "just-under",
      path: "/tmp/claude-1000/proj/just-under",
      mtimeMs: NOW - SESSION_DIR_MIN_AGE_MS + 1,
    };
    const plan = planTmpCleanup([dir], [], new Set(), NOW);
    assert.equal(plan.sessionDirsToRemove.length, 0);
  });
});

describe("planTmpCleanup — arquivos .output (tamanho E idade, #8828)", () => {
  it("arquivo grande (>50MB) e velho (>1 dia) é candidato", () => {
    const file: OutputFileCandidate = {
      path: "/tmp/claude-1000/proj/s1/tasks/big.output",
      sizeBytes: 60 * 1024 * 1024,
      mtimeMs: NOW - OUTPUT_FILE_MIN_AGE_MS - 1000,
    };
    const plan = planTmpCleanup([], [file], new Set(), NOW);
    assert.deepEqual(plan.outputFilesToRemove.map((f) => f.path), [file.path]);
  });

  it("arquivo grande mas RECENTE (< 1 dia) não é candidato — idade vence tamanho", () => {
    const file: OutputFileCandidate = {
      path: "/tmp/claude-1000/proj/s1/tasks/big-recent.output",
      sizeBytes: 200 * 1024 * 1024,
      mtimeMs: ONE_HOUR_AGO,
    };
    const plan = planTmpCleanup([], [file], new Set(), NOW);
    assert.equal(plan.outputFilesToRemove.length, 0);
    assert.deepEqual(plan.outputFilesSkipped.map((f) => f.path), [file.path]);
  });

  it("arquivo velho mas pequeno (< 50MB) não é candidato — tamanho vence idade", () => {
    const file: OutputFileCandidate = {
      path: "/tmp/claude-1000/proj/s1/tasks/small-old.output",
      sizeBytes: OUTPUT_FILE_MIN_SIZE_BYTES - 1,
      mtimeMs: THREE_DAYS_AGO,
    };
    const plan = planTmpCleanup([], [file], new Set(), NOW);
    assert.equal(plan.outputFilesToRemove.length, 0);
  });

  it("planFreedOutputBytes soma só os candidatos a remoção", () => {
    const removable: OutputFileCandidate = {
      path: "a",
      sizeBytes: 100 * 1024 * 1024,
      mtimeMs: THREE_DAYS_AGO,
    };
    const kept: OutputFileCandidate = {
      path: "b",
      sizeBytes: 200 * 1024 * 1024,
      mtimeMs: ONE_HOUR_AGO,
    };
    const plan = planTmpCleanup([], [removable, kept], new Set(), NOW);
    assert.equal(planFreedOutputBytes(plan), 100 * 1024 * 1024);
  });
});

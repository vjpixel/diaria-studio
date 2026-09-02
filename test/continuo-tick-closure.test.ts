/**
 * test/continuo-tick-closure.test.ts (#7130)
 *
 * Regressão para "contínuo: tick produz trabalho e não fecha o laço" —
 * `git status --porcelain` sujo no checkout compartilhado, sobra de um tick
 * interrompido (sem claim, sem commit, sem PR), agora vira uma branch de
 * rescue commitada em vez de evaporar/contaminar o próximo `git add -A`.
 *
 * Spawner injetado (mesmo padrão de test/git-sync.test.ts, #2699) — nenhum
 * comando git real roda nestes testes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasUncommittedWork,
  planRescueBranch,
  rescueOrphanedWork,
  pushRescueBranch,
  type SpawnFn,
  type SpawnResult,
} from "../scripts/lib/continuo-tick-closure.ts";

function ok(stdout = ""): SpawnResult {
  return { status: 0, stdout, stderr: "" };
}
function fail(stderr = "boom"): SpawnResult {
  return { status: 1, stdout: "", stderr };
}

/** Spawner fake que grava toda chamada e devolve respostas de uma fila
 * por comando (`git <subcomando>`), na ordem em que forem sendo consumidas. */
function makeFakeSpawn(responses: Record<string, SpawnResult[]>): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const cursors: Record<string, number> = {};
  const spawn: SpawnFn = (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = `${cmd} ${args[0]}`;
    const queue = responses[key];
    if (!queue) throw new Error(`fake spawn sem resposta configurada para: ${key}`);
    const i = cursors[key] ?? 0;
    cursors[key] = i + 1;
    const res = queue[Math.min(i, queue.length - 1)];
    if (!res) throw new Error(`fila de respostas esgotada para: ${key}`);
    return res;
  };
  return { spawn, calls };
}

describe("hasUncommittedWork", () => {
  it("false para porcelain vazio", () => {
    assert.equal(hasUncommittedWork(""), false);
    assert.equal(hasUncommittedWork("   \n  "), false);
  });

  it("true para qualquer linha de porcelain", () => {
    assert.equal(hasUncommittedWork(" M scripts/foo.ts\n"), true);
    assert.equal(hasUncommittedWork("?? scripts/novo.ts\n"), true);
  });
});

describe("planRescueBranch", () => {
  it("nome de branch determinístico, prefixo continuo/rescue-, nunca colide com continuo/fix-*", () => {
    const plan = planRescueBranch("2026-09-02T10:15:30.000Z");
    assert.match(plan.branchName, /^continuo\/rescue-\d{8}T\d{6}Z$/);
    assert.doesNotMatch(plan.branchName, /^continuo\/fix-/);
  });

  it("commit message referencia #7130 e avisa contra merge sem revisão", () => {
    const plan = planRescueBranch("2026-09-02T10:15:30.000Z");
    assert.match(plan.commitMessage, /#7130/);
    assert.match(plan.commitMessage, /NÃO mergear sem revisão humana/);
  });
});

describe("rescueOrphanedWork", () => {
  it("árvore limpa → outcome clean, nenhum comando além de status", () => {
    const { spawn, calls } = makeFakeSpawn({ "git status": [ok("")] });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z");
    assert.equal(result.outcome, "clean");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["git", "status", "--porcelain"]);
  });

  it("árvore suja → checkout -b, add -A, commit, checkout master, na ordem certa", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git checkout": [ok(), ok()], // -b {branch}, depois master
      "git add": [ok()],
      "git commit": [ok()],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z");
    assert.equal(result.outcome, "rescued");
    if (result.outcome !== "rescued") throw new Error("unreachable");
    assert.match(result.branch, /^continuo\/rescue-/);
    assert.equal(result.checkoutBackFailed, false);

    assert.deepEqual(calls[0], ["git", "status", "--porcelain"]);
    assert.deepEqual(calls[1], ["git", "checkout", "-b", result.branch]);
    assert.deepEqual(calls[2], ["git", "add", "-A"]);
    assert.deepEqual(calls[3][0], "git");
    assert.deepEqual(calls[3][1], "commit");
    assert.deepEqual(calls[3][2], "-m");
    assert.deepEqual(calls[4], ["git", "checkout", "master"]);
  });

  it("checkout -b falha → rescue_failed, nunca tenta add/commit (trabalho continua sujo, nunca meio-movido)", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git checkout": [fail("já existe uma branch com esse nome")],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z");
    assert.equal(result.outcome, "rescue_failed");
    assert.equal(calls.length, 2);
    assert.equal(calls.some((c) => c[1] === "add"), false);
    assert.equal(calls.some((c) => c[1] === "commit"), false);
  });

  it("git add falha após checkout -b → rescue_failed, nunca commita parcial", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git checkout": [ok()],
      "git add": [fail("disco cheio")],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z");
    assert.equal(result.outcome, "rescue_failed");
    assert.equal(calls.some((c) => c[1] === "commit"), false);
  });

  it("git commit falha → rescue_failed, nunca tenta voltar pra master (evita perder o staged)", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git checkout": [ok()],
      "git add": [ok()],
      "git commit": [fail("nothing to commit — impossível aqui, mas simula falha genérica")],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z");
    assert.equal(result.outcome, "rescue_failed");
    assert.equal(calls.filter((c) => c[1] === "checkout").length, 1);
  });

  it("checkout master pós-commit falha → ainda 'rescued' (trabalho SEGURO, commitado), sinaliza checkoutBackFailed", () => {
    const { spawn } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git checkout": [ok(), fail("conflito ao voltar")],
      "git add": [ok()],
      "git commit": [ok()],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z");
    assert.equal(result.outcome, "rescued");
    if (result.outcome !== "rescued") throw new Error("unreachable");
    assert.equal(result.checkoutBackFailed, true);
    assert.match(result.message, /'git checkout master' pós-rescue falhou/);
  });

  it("git status falha (não é repo/git indisponível) → rescue_failed, nunca confunde com 'clean'", () => {
    const { spawn } = makeFakeSpawn({ "git status": [fail("not a git repository")] });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z");
    assert.equal(result.outcome, "rescue_failed");
  });
});

describe("pushRescueBranch", () => {
  it("push OK → ok:true", () => {
    const { spawn } = makeFakeSpawn({ "git push": [ok()] });
    const result = pushRescueBranch(spawn, "continuo/rescue-20260902-100000Z");
    assert.equal(result.ok, true);
  });

  it("push falha → ok:false, mensagem não sugere que o commit local também se perdeu", () => {
    const { spawn } = makeFakeSpawn({ "git push": [fail("permission denied")] });
    const result = pushRescueBranch(spawn, "continuo/rescue-20260902-100000Z");
    assert.equal(result.ok, false);
    assert.match(result.message, /só existe local/);
  });
});

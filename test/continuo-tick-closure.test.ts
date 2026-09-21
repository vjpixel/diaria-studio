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
  planMasterCommitRescueBranch,
  rescueOrphanedMasterCommits,
  detectConflictMarkers,
  parseConflictMarkerFiles,
  type SpawnFn,
  type SpawnResult,
  type SyncLock,
} from "../scripts/lib/continuo-tick-closure.ts";

function ok(stdout = ""): SpawnResult {
  return { status: 0, stdout, stderr: "" };
}
function fail(stderr = "boom"): SpawnResult {
  return { status: 1, stdout: "", stderr };
}

/** Lock fake que sempre adquire com sucesso — usado pela maioria dos testes,
 * que não exercitam a lógica de lock em si (mesmo padrão de
 * test/git-sync.test.ts NOOP_LOCK). Evita que o default de produção
 * (`createFileLock(undefined, spawn)`, que spawnaria `git rev-parse` via o
 * fake spawn injetado — sem resposta configurada para esse comando nestes
 * testes) seja avaliado. */
const NOOP_LOCK: SyncLock = {
  path: "(noop-lock, teste)",
  acquire: () => true,
  release: () => {},
};

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
  it("nome de branch com discriminador, prefixo continuo/rescue-, nunca colide com continuo/fix-*", () => {
    const plan = planRescueBranch("2026-09-02T10:15:30.000Z");
    assert.match(plan.branchName, /^continuo\/rescue-\d{8}T\d{6}Z-[0-9a-f-]+$/);
    assert.doesNotMatch(plan.branchName, /^continuo\/fix-/);
  });

  it("commit message referencia #7130 e avisa contra merge sem revisão", () => {
    const plan = planRescueBranch("2026-09-02T10:15:30.000Z");
    assert.match(plan.commitMessage, /#7130/);
    assert.match(plan.commitMessage, /NÃO mergear sem revisão humana/);
  });

  it("#7130 review finding 2 — mesmo timestamp (mesmo SEGUNDO) com discriminadores diferentes nunca colide", () => {
    // Dois resgates concorrentes no mesmo segundo (ex: sessão interativa +
    // cron do hermes acordando quase juntos) — sem o discriminador, o nome
    // de branch derivado só do timestamp seria idêntico e o 2º `checkout -b`
    // falharia com "already exists".
    const planA = planRescueBranch("2026-09-02T10:15:30.000Z", "111-aaaa");
    const planB = planRescueBranch("2026-09-02T10:15:30.000Z", "222-bbbb");
    assert.notEqual(planA.branchName, planB.branchName);
    // O timestamp segue sendo o prefixo — nome ainda ordenável por tempo,
    // o discriminador só desempata quando o segundo colide.
    assert.match(planA.branchName, /^continuo\/rescue-20260902T101530Z-111-aaaa$/);
    assert.match(planB.branchName, /^continuo\/rescue-20260902T101530Z-222-bbbb$/);
  });

  it("discriminador default (sem 3º argumento) varia entre chamadas — nunca reusa o mesmo valor", () => {
    const planA = planRescueBranch("2026-09-02T10:15:30.000Z");
    const planB = planRescueBranch("2026-09-02T10:15:30.000Z");
    assert.notEqual(planA.branchName, planB.branchName);
  });
});

describe("rescueOrphanedWork", () => {
  it("árvore limpa → outcome clean, nenhum comando além de status", () => {
    const { spawn, calls } = makeFakeSpawn({ "git status": [ok("")] });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "clean");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["git", "status", "--porcelain"]);
  });

  it("árvore suja → grep de conflito, checkout -b, add -A, commit, checkout master, na ordem certa", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git grep": [fail()], // #8639: status 1 = sem marcador de conflito encontrado
      "git checkout": [ok(), ok()], // -b {branch}, depois master
      "git add": [ok()],
      "git commit": [ok()],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescued");
    if (result.outcome !== "rescued") throw new Error("unreachable");
    assert.match(result.branch, /^continuo\/rescue-/);
    assert.equal(result.checkoutBackFailed, false);

    assert.deepEqual(calls[0], ["git", "status", "--porcelain"]);
    assert.equal(calls[1][1], "grep");
    assert.deepEqual(calls[2], ["git", "checkout", "-b", result.branch]);
    assert.deepEqual(calls[3], ["git", "add", "-A"]);
    assert.deepEqual(calls[4][0], "git");
    assert.deepEqual(calls[4][1], "commit");
    assert.deepEqual(calls[4][2], "-m");
    assert.deepEqual(calls[5], ["git", "checkout", "master"]);
  });

  it("checkout -b falha → rescue_failed, nunca tenta add/commit (trabalho continua sujo, nunca meio-movido)", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git grep": [fail()],
      "git checkout": [fail("já existe uma branch com esse nome")],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescue_failed");
    assert.equal(calls.length, 3);
    assert.equal(calls.some((c) => c[1] === "add"), false);
    assert.equal(calls.some((c) => c[1] === "commit"), false);
  });

  it("git add falha após checkout -b → rescue_failed, nunca commita parcial", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git grep": [fail()],
      "git checkout": [ok()],
      "git add": [fail("disco cheio")],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescue_failed");
    assert.equal(calls.some((c) => c[1] === "commit"), false);
  });

  it("git commit falha → rescue_failed, nunca tenta voltar pra master (evita perder o staged)", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git grep": [fail()],
      "git checkout": [ok()],
      "git add": [ok()],
      "git commit": [fail("nothing to commit — impossível aqui, mas simula falha genérica")],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescue_failed");
    assert.equal(calls.filter((c) => c[1] === "checkout").length, 1);
  });

  it("checkout master pós-commit falha → ainda 'rescued' (trabalho SEGURO, commitado), sinaliza checkoutBackFailed", () => {
    const { spawn } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git grep": [fail()],
      "git checkout": [ok(), fail("conflito ao voltar")],
      "git add": [ok()],
      "git commit": [ok()],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescued");
    if (result.outcome !== "rescued") throw new Error("unreachable");
    assert.equal(result.checkoutBackFailed, true);
    assert.match(result.message, /'git checkout master' pós-rescue falhou/);
  });

  it("git status falha (não é repo/git indisponível) → rescue_failed, nunca confunde com 'clean'", () => {
    const { spawn } = makeFakeSpawn({ "git status": [fail("not a git repository")] });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescue_failed");
  });

  it("#7130 review finding 1 — lock não adquirido → rescue_failed fail-loud, NUNCA roda status/checkout/add/commit", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git checkout": [ok(), ok()],
      "git add": [ok()],
      "git commit": [ok()],
    });
    const busyLock: SyncLock = {
      path: "/fake/.diaria-sync.lock",
      acquire: () => false,
      release: () => {
        throw new Error("release() nunca deve ser chamado — acquire() nunca teve sucesso");
      },
    };
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", busyLock);
    assert.equal(result.outcome, "rescue_failed");
    if (result.outcome !== "rescue_failed") throw new Error("unreachable");
    assert.match(result.message, /lock/i);
    assert.match(result.message, /\/fake\/\.diaria-sync\.lock/);
    // Nenhum comando git rodou — nem sequer o `git status` de leitura, quanto
    // menos a sequência que move trabalho — outra sessão pode estar no meio
    // dela agora.
    assert.equal(calls.length, 0);
  });

  it("#7130 review finding 1 — lock adquirido → release() chamado mesmo com outcome 'clean'", () => {
    const { spawn } = makeFakeSpawn({ "git status": [ok("")] });
    let released = false;
    const trackedLock: SyncLock = {
      path: "/fake/.diaria-sync.lock",
      acquire: () => true,
      release: () => {
        released = true;
      },
    };
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", trackedLock);
    assert.equal(result.outcome, "clean");
    assert.equal(released, true);
  });

  it("#7130 review finding 1 — lock adquirido → release() chamado mesmo quando um passo git falha no meio", () => {
    const { spawn } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git grep": [fail()],
      "git checkout": [fail("já existe uma branch com esse nome")],
    });
    let released = false;
    const trackedLock: SyncLock = {
      path: "/fake/.diaria-sync.lock",
      acquire: () => true,
      release: () => {
        released = true;
      },
    };
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", trackedLock);
    assert.equal(result.outcome, "rescue_failed");
    assert.equal(released, true);
  });

  // -------------------------------------------------------------------------
  // #8639 — regressão para "rescue commitou merge markers em silêncio".
  // Fixture: commit 3d54dcf20 (rescue automático real, 20/09/2026) deixou
  // `<<<<<<< Updated upstream` / `>>>>>>> Stashed changes` versionados em
  // scripts/lib/diaria-subscribers-db.ts — provável sobra de um `git stash
  // pop` conflitante (git-sync.ts, #6668) que a árvore ainda não tinha
  // resolvido quando o rescue rodou. A rede de segurança: detectar o
  // marcador ANTES de checkout -b/add/commit e abortar, nunca versionar o
  // conflito.
  // -------------------------------------------------------------------------

  it("#8639 REPRODUÇÃO: árvore suja com marcador de conflito → conflict_markers_found, NUNCA cria branch/add/commit", () => {
    const conflictedGrepOutput =
      "scripts/lib/diaria-subscribers-db.ts:183:<<<<<<< Updated upstream\n" +
      "scripts/lib/diaria-subscribers-db.ts:205:>>>>>>> Stashed changes\n";
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/lib/diaria-subscribers-db.ts\n?? scripts/kit-confirmacao-import.ts\n")],
      "git grep": [ok(conflictedGrepOutput)], // status 0 = achou marcador
      "git checkout": [ok(), ok()],
      "git add": [ok()],
      "git commit": [ok()],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-20T20:28:59.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "conflict_markers_found");
    if (result.outcome !== "conflict_markers_found") throw new Error("unreachable");
    assert.deepEqual(result.files, ["scripts/lib/diaria-subscribers-db.ts"]);
    assert.match(result.message, /#8639/);
    assert.match(result.message, /diaria-subscribers-db\.ts/);

    // Nunca chega a checkout -b/add/commit — a árvore fica intocada.
    assert.deepEqual(calls[0], ["git", "status", "--porcelain"]);
    assert.equal(calls[1][1], "grep");
    assert.equal(calls.length, 2);
    assert.equal(calls.some((c) => c[1] === "checkout"), false);
    assert.equal(calls.some((c) => c[1] === "add"), false);
    assert.equal(calls.some((c) => c[1] === "commit"), false);
  });

  it("#8639: árvore suja SEM marcador de conflito → segue normalmente pra 'rescued' (guard não é falso-positivo)", () => {
    const { spawn } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git grep": [fail()], // status 1 = sem marcador
      "git checkout": [ok(), ok()],
      "git add": [ok()],
      "git commit": [ok()],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescued");
  });

  it("#8639 correção: git grep falha por erro real (status 128, não é repo) → rescue_failed, NUNCA prossegue como 'sem marcador' pra checkout -b/add/commit", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git status": [ok(" M scripts/foo.ts\n")],
      "git grep": [{ status: 128, stdout: "", stderr: "fatal: not a git repository" }],
      "git checkout": [ok(), ok()],
      "git add": [ok()],
      "git commit": [ok()],
    });
    const result = rescueOrphanedWork(spawn, "2026-09-20T20:28:59.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescue_failed");
    if (result.outcome !== "rescue_failed") throw new Error("unreachable");
    assert.match(result.message, /grep/i);
    assert.match(result.message, /not a git repository/);

    // Nunca chega a checkout -b/add/commit — erro real do grep bloqueia o rescue inteiro,
    // exatamente como qualquer outra falha de comando git nesta função (status/checkout/add/commit).
    assert.equal(calls.some((c) => c[1] === "checkout"), false);
    assert.equal(calls.some((c) => c[1] === "add"), false);
    assert.equal(calls.some((c) => c[1] === "commit"), false);
  });

  it("#8639: lock adquirido → release() chamado mesmo com outcome conflict_markers_found", () => {
    const conflictedGrepOutput = "arquivo-com-conflito.ts:1:<<<<<<< HEAD\narquivo-com-conflito.ts:5:>>>>>>> branch\n";
    const { spawn } = makeFakeSpawn({
      "git status": [ok(" M arquivo-com-conflito.ts\n")],
      "git grep": [ok(conflictedGrepOutput)],
    });
    let released = false;
    const trackedLock: SyncLock = {
      path: "/fake/.diaria-sync.lock",
      acquire: () => true,
      release: () => {
        released = true;
      },
    };
    const result = rescueOrphanedWork(spawn, "2026-09-02T10:00:00.000Z", trackedLock);
    assert.equal(result.outcome, "conflict_markers_found");
    assert.equal(released, true);
  });
});

describe("detectConflictMarkers (#8639)", () => {
  function makeSimpleSpawn(response: SpawnResult): SpawnFn {
    return () => response;
  }

  it("git grep status 0 (achou match) → outcome:found com arquivos parseados", () => {
    const spawn = makeSimpleSpawn(ok("a.ts:1:<<<<<<< HEAD\na.ts:3:>>>>>>> branch\nb.ts:1:<<<<<<< HEAD\n"));
    const result = detectConflictMarkers(spawn);
    assert.equal(result.outcome, "found");
    assert.deepEqual(result.outcome === "found" ? result.files : null, ["a.ts", "b.ts"]);
  });

  it("git grep status 1 (sem match) → outcome:clean, único caso genuinamente limpo", () => {
    const spawn = makeSimpleSpawn(fail());
    const result = detectConflictMarkers(spawn);
    assert.equal(result.outcome, "clean");
  });

  it("git grep falha por outro motivo (ex: não é repo, status 128) → outcome:grep_failed, NUNCA clean (#8639 correção)", () => {
    const spawn = makeSimpleSpawn({ status: 128, stdout: "", stderr: "fatal: not a git repository" });
    const result = detectConflictMarkers(spawn);
    assert.equal(result.outcome, "grep_failed");
    assert.ok(result.outcome === "grep_failed" && /not a git repository/.test(result.message));
  });

  it("git grep morto por timeout (status: null) → outcome:grep_failed, nunca clean", () => {
    const spawn = makeSimpleSpawn({ status: null, stdout: "", stderr: "" });
    const result = detectConflictMarkers(spawn);
    assert.equal(result.outcome, "grep_failed");
    assert.ok(result.outcome === "grep_failed" && /timeout/.test(result.message));
  });

  it("chama git grep com --untracked (pega placeholder novo, não só tracked modificado)", () => {
    const calls: string[][] = [];
    const spawn: SpawnFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      return fail();
    };
    detectConflictMarkers(spawn);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("--untracked"));
    assert.ok(calls[0].includes("^<<<<<<< "));
    assert.ok(calls[0].includes("^>>>>>>> "));
  });
});

describe("parseConflictMarkerFiles (#8639)", () => {
  it("extrai arquivos únicos, ordenados, de stdout no formato path:line:conteúdo", () => {
    const stdout = "b.ts:5:>>>>>>> branch\na.ts:1:<<<<<<< HEAD\na.ts:3:>>>>>>> branch\n";
    assert.deepEqual(parseConflictMarkerFiles(stdout), ["a.ts", "b.ts"]);
  });

  it("stdout vazio → lista vazia", () => {
    assert.deepEqual(parseConflictMarkerFiles(""), []);
  });

  it("ignora linhas em branco", () => {
    assert.deepEqual(parseConflictMarkerFiles("\n\na.ts:1:<<<<<<< HEAD\n\n"), ["a.ts"]);
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

// ---------------------------------------------------------------------------
// #8588 — commit(s) direto em master no checkout compartilhado (irmão do
// guard de árvore suja acima). Regressão para a rodada overnight 260921: uma
// sessão continuo commitou 2x direto em master, sem branch própria, enquanto
// já existia PR aberta pra mesma issue.
// ---------------------------------------------------------------------------

describe("planMasterCommitRescueBranch (#8588)", () => {
  it("gera nome de branch distinguível do rescue de árvore suja (prefixo rescue-master-)", () => {
    const plan = planMasterCommitRescueBranch("2026-09-21T23:20:00.000Z", "12345-abcd");
    assert.match(plan.branchName, /^continuo\/rescue-master-20260921T232000Z-12345-abcd$/);
    assert.match(plan.commitMessage, /#8588/);
  });
});

describe("rescueOrphanedMasterCommits (#8588)", () => {
  it("HEAD não é master → not-applicable, nenhum outro comando git roda", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git rev-parse": [ok("continuo/fix-123-slug\n")],
    });
    const result = rescueOrphanedMasterCommits(spawn, "2026-09-21T23:20:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "not-applicable");
    assert.equal(calls.length, 1);
  });

  it("master limpo e em paridade com origin/master → clean", () => {
    const { spawn } = makeFakeSpawn({
      "git rev-parse": [ok("master\n")],
      "git status": [ok("")],
      "git fetch": [ok()],
      "git rev-list": [ok("")],
    });
    const result = rescueOrphanedMasterCommits(spawn, "2026-09-21T23:20:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "clean");
  });

  it("árvore suja em master → rescue_failed (pré-condição violada, quem chama devia ter rodado rescueOrphanedWork antes)", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git rev-parse": [ok("master\n")],
      "git status": [ok(" M scripts/foo.ts\n")],
    });
    const result = rescueOrphanedMasterCommits(spawn, "2026-09-21T23:20:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescue_failed");
    assert.match(result.message, /árvore suja/);
    // Nunca chega a fetch/rev-list/branch/reset com a árvore suja.
    assert.equal(calls.some((c) => c[1] === "fetch"), false);
  });

  it("git fetch falha → fetch_failed, fail-soft (nunca mexe em master)", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git rev-parse": [ok("master\n")],
      "git status": [ok("")],
      "git fetch": [fail("could not resolve host")],
    });
    const result = rescueOrphanedMasterCommits(spawn, "2026-09-21T23:20:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "fetch_failed");
    assert.equal(calls.some((c) => c[1] === "rev-list"), false);
    assert.equal(calls.some((c) => c[1] === "branch"), false);
    assert.equal(calls.some((c) => c[1] === "reset"), false);
  });

  it("REPRODUÇÃO #8588: master local com 2 commits à frente de origin/master → rescued, branch dedicada + reset pra origin/master", () => {
    const sha1 = "3657b320d1234567890abcdef1234567890abcd";
    const sha2 = "1075491ce1234567890abcdef1234567890abcd";
    const { spawn, calls } = makeFakeSpawn({
      "git rev-parse": [ok("master\n")],
      "git status": [ok("")],
      "git fetch": [ok()],
      "git rev-list": [ok(`${sha2}\n${sha1}\n`)],
      "git branch": [ok()],
      "git reset": [ok()],
    });
    const result = rescueOrphanedMasterCommits(spawn, "2026-09-21T23:20:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescued");
    if (result.outcome !== "rescued") return;
    assert.deepEqual(result.commitShas, [sha2, sha1]);
    assert.equal(result.resetFailed, false);
    assert.match(result.branch, /^continuo\/rescue-master-/);
    // branch criada ANTES do reset — nunca reseta master sem antes ter
    // preservado os commits numa branch (mesma ordem de segurança do rescue
    // de árvore suja: checkout -b sempre antes de mexer no estado).
    const branchIdx = calls.findIndex((c) => c[1] === "branch");
    const resetIdx = calls.findIndex((c) => c[1] === "reset");
    assert.ok(branchIdx >= 0 && resetIdx >= 0 && branchIdx < resetIdx);
  });

  it("git branch falha → rescue_failed, master NUNCA é resetado sem a branch de segurança existir primeiro", () => {
    const { spawn, calls } = makeFakeSpawn({
      "git rev-parse": [ok("master\n")],
      "git status": [ok("")],
      "git fetch": [ok()],
      "git rev-list": [ok("abc123\n")],
      "git branch": [fail("já existe uma branch com esse nome")],
    });
    const result = rescueOrphanedMasterCommits(spawn, "2026-09-21T23:20:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescue_failed");
    assert.equal(calls.some((c) => c[1] === "reset"), false);
  });

  it("git reset --hard falha → rescued com resetFailed:true (commits preservados, master ainda duplicado)", () => {
    const { spawn } = makeFakeSpawn({
      "git rev-parse": [ok("master\n")],
      "git status": [ok("")],
      "git fetch": [ok()],
      "git rev-list": [ok("abc123\n")],
      "git branch": [ok()],
      "git reset": [fail("local changes would be overwritten")],
    });
    const result = rescueOrphanedMasterCommits(spawn, "2026-09-21T23:20:00.000Z", NOOP_LOCK);
    assert.equal(result.outcome, "rescued");
    if (result.outcome !== "rescued") return;
    assert.equal(result.resetFailed, true);
    assert.match(result.message, /AINDA carrega/);
  });

  it("lock ocupado → rescue_failed, nenhum comando git roda", () => {
    const { spawn, calls } = makeFakeSpawn({});
    const busyLock: SyncLock = {
      path: "/fake/.diaria-sync.lock",
      acquire: () => false,
      release: () => {},
    };
    const result = rescueOrphanedMasterCommits(spawn, "2026-09-21T23:20:00.000Z", busyLock);
    assert.equal(result.outcome, "rescue_failed");
    assert.equal(calls.length, 0);
  });

  it("lock é sempre liberado, mesmo em outcome rescued", () => {
    const { spawn } = makeFakeSpawn({
      "git rev-parse": [ok("master\n")],
      "git status": [ok("")],
      "git fetch": [ok()],
      "git rev-list": [ok("abc123\n")],
      "git branch": [ok()],
      "git reset": [ok()],
    });
    let released = false;
    const trackedLock: SyncLock = {
      path: "/fake/.diaria-sync.lock",
      acquire: () => true,
      release: () => {
        released = true;
      },
    };
    rescueOrphanedMasterCommits(spawn, "2026-09-21T23:20:00.000Z", trackedLock);
    assert.equal(released, true);
  });
});

/**
 * test/merge-train-live.test.ts (#6300, regressão #633)
 *
 * Cobre a ORQUESTRAÇÃO viva de scripts/lib/merge-train-live.ts com um
 * `TrainRunner` FAKE (nenhum git/gh/rede real é tocado) — a máquina de
 * estados do trem: caminho feliz (lote passa, merge squash, fecha PRs
 * originais), CI vermelho (bissecta), timeout de CI (tratado como
 * vermelho, bissecta), conflito de integração (bissecta), piso da
 * bissecção (merge solo, sem trem), merge-lock negado (retry bounded, e
 * `lock-blocked` se esgotar), revalidação de Gate 2 antes de mergear.
 *
 * Por que um runner fake em vez de subprocess real: cada teste abriria um
 * PR de verdade / mergearia de verdade contra o GitHub se usasse `gh`/`git`
 * reais — inviável e destrutivo pra suíte de CI. O fake é o mesmo padrão
 * de injeção de dependência já usado noutros módulos deste repo pra
 * separar orquestração de I/O.
 *
 * ISOLAMENTO EM WORKTREE (2ª rodada do fleet review, PR #6361): `exec()`
 * agora aceita um `cwd` opcional por chamada — os testes abaixo distinguem
 * chamadas que rodam no worktree ISOLADO (merge/push da branch de
 * integração) das que rodam no checkout PRINCIPAL (`worktree add/remove`,
 * `gh pr merge`, `git pull`), verificando o 3º argumento de `exec` quando
 * a distinção importa pro teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRealTrainRunner,
  fetchTrainPrInfo,
  revalidateGate2,
  buildIntegrationBranch,
  openTrainPr,
  pollTrainCi,
  mergeTrainBatch,
  mergeSoloPr,
  cleanupIntegrationBranch,
  runMergeTrain,
  checkPrRetido,
  partitionRetidoCandidates,
  trainHasRealFailure,
  checkStudioTrainPr,
  type TrainRunner,
  type ExecResult,
} from "../scripts/lib/merge-train-live.ts";
import type { TrainBatch, TrainPrInfo } from "../scripts/lib/merge-train.ts";

const MAIN_CWD = "C:/repo";

/** Handler roteado por (cmd, args, cwd) — primeiro que casar vence. Chamadas
 * não-casadas lançam (teste malformado, não silêncio). */
type Handler = (args: string[], cwd?: string) => ExecResult;

function ok(stdout = ""): ExecResult {
  return { ok: true, stdout, stderr: "" };
}
function fail(stderr = "erro simulado"): ExecResult {
  return { ok: false, stdout: "", stderr };
}

/** Resposta padrão pra `gh pr view --json statusCheckRollup`: CI verde. */
function ciPassJson(): string {
  return JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "SUCCESS", status: "COMPLETED" }] });
}
/** Resposta padrão pra `gh api graphql` (threads): nenhuma pendente. */
function noThreadsJson(): string {
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } });
}

/** Resposta padrão pra `gh pr view --json labels,body` (#10294): sem retenção. */
function notRetidoJson(): string {
  return JSON.stringify({ labels: [{ name: "bug" }], body: "Closes #10" });
}
/** PR retida para o editor via label (#10278). */
function retidoJson(): string {
  return JSON.stringify({ labels: [{ name: "retido-para-editor" }], body: "Closes #10" });
}
/** Roteia `gh pr view {pr} --json labels,body` de UM PR específico. */
function isRetidoView(pr: number) {
  return (a: string[]) => a[0] === "pr" && a[1] === "view" && a[2] === String(pr) && a.includes("labels,body");
}

class FakeTrainRunner implements TrainRunner {
  readonly calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  readonly warnings: string[] = [];
  private clock = 0;
  private handlers: { cmd: string; match: (args: string[], cwd?: string) => boolean; handler: Handler }[] = [];
  private tempDirCounter = 0;

  on(cmd: string, match: (args: string[], cwd?: string) => boolean, handler: Handler): this {
    this.handlers.push({ cmd, match, handler });
    return this;
  }

  /** Roteia automaticamente as chamadas de revalidação de Gate 2 (usadas
   * por mergeTrainBatch/mergeSoloPr em TODO caminho feliz) e de
   * merge-lock — a maioria dos testes quer isso "verde por padrão" e só
   * sobrescreve o que importa pro caso específico. */
  withGate2Green(): this {
    return this.on("gh", (a) => a[0] === "pr" && a[1] === "view" && a.includes("statusCheckRollup"), () => ok(ciPassJson()))
      .on("gh", (a) => a[0] === "api" && a[1] === "graphql", () => ok(noThreadsJson()))
      .on("gh", (a) => a[0] === "pr" && a[1] === "view" && a.includes("labels,body"), () => ok(notRetidoJson()))
      .on("gh", (a) => a[0] === "pr" && a[1] === "view" && a.includes("title,body"), () => ok(JSON.stringify({ title: "fix: exemplo", body: "Closes #10" })));
  }

  withLockOk(): this {
    return this.on("npx", (a) => a.includes("merge-lock-acquire"), () => ok()).on("npx", (a) => a.includes("merge-lock-release"), () => ok());
  }

  /** Avança o relógio simulado em cada sleep() — usado por pollTrainCi/retry pra checar timeout sem esperar de verdade. */
  advanceMs = 1000;

  exec(cmd: string, args: string[], cwd?: string): ExecResult {
    this.calls.push({ cmd, args, cwd });
    // Último registrado que casa VENCE (não o primeiro) — permite que um
    // teste use `fullRunner()` como base genérica e SOBRESCREVA só a
    // chamada que importa pro cenário específico, registrando depois.
    const found = [...this.handlers].reverse().find((h) => h.cmd === cmd && h.match(args, cwd));
    if (!found) throw new Error(`FakeTrainRunner: chamada não roteirizada: ${cmd} ${args.join(" ")} (cwd=${cwd ?? "default"})`);
    return found.handler(args, cwd);
  }

  async sleep(_ms: number): Promise<void> {
    this.clock += this.advanceMs;
  }

  now(): number {
    return this.clock;
  }

  mkTempDir(prefix: string): string {
    this.tempDirCounter++;
    return `/tmp/${prefix}${this.tempDirCounter}`;
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

function makePrInfo(overrides: Partial<TrainPrInfo> = {}): TrainPrInfo {
  return { pr: 100, headRefName: "develop/fix-100", title: "fix: alguma coisa", issueNumbers: [10], ...overrides };
}

describe("fetchTrainPrInfo", () => {
  it("extrai headRefName/title e as issues via parseClosesIssues do body", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "view" && a[2] === "100", () =>
      ok(JSON.stringify({ number: 100, headRefName: "develop/fix-100", title: "fix: X", body: "Closes #10\nFixes #20\nresolve #30" })),
    );
    const info = fetchTrainPrInfo(runner, 100);
    assert.equal(info.pr, 100);
    assert.equal(info.headRefName, "develop/fix-100");
    assert.deepEqual(info.issueNumbers, [10, 20, 30]);
  });

  it("lança se gh pr view falha", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", () => true, () => fail("PR não existe"));
    assert.throws(() => fetchTrainPrInfo(runner, 999), /gh pr view falhou/);
  });
});

describe("revalidateGate2", () => {
  it("ok quando CI passou e zero threads não resolvidas", () => {
    const runner = new FakeTrainRunner().withGate2Green();
    const result = revalidateGate2(runner, 100);
    assert.equal(result.ok, true);
  });

  it("reprova se a condição 1 (CI) não está pass", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", (a) => a.includes("statusCheckRollup"), () =>
      ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "FAILURE", status: "COMPLETED" }] })),
    );
    const result = revalidateGate2(runner, 100);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /condição 1/);
  });

  it("reprova se sobra thread não resolvida (condição 2)", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("gh", (a) => a.includes("statusCheckRollup"), () => ok(ciPassJson()))
      .on("gh", (a) => a[0] === "api" && a[1] === "graphql", () =>
        ok(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }] } } } } })),
      );
    const result = revalidateGate2(runner, 100);
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /condição 2/);
  });

  it("reprova (nunca assume ok) se gh pr view falha", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", () => true, () => fail("timeout"));
    const result = revalidateGate2(runner, 100);
    assert.equal(result.ok, false);
  });
});

describe("buildIntegrationBranch — worktree isolado (2ª rodada do fleet review)", () => {
  const batch: TrainBatch = { prs: [100, 101] };
  const prInfos: TrainPrInfo[] = [
    makePrInfo({ pr: 100, headRefName: "develop/fix-100" }),
    makePrInfo({ pr: 101, headRefName: "develop/fix-101" }),
  ];

  it("caminho feliz: fetch base no checkout principal, worktree add, fetch+merge de cada PR NO WORKTREE, push", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a, cwd) => a[0] === "fetch" && a[2] === "master" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "add" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "fetch" && (a[2] === "develop/fix-100" || a[2] === "develop/fix-101") && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "merge" && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "push" && cwd !== MAIN_CWD, () => ok());

    const result = buildIntegrationBranch(runner, batch, prInfos, { baseBranch: "master", branchName: "merge-train/lote-1", mainCwd: MAIN_CWD });
    assert.equal(result.ok, true);
    assert.equal(result.branchName, "merge-train/lote-1");
    assert.ok(result.worktreePath.length > 0);
    // Ordem importa: os 2 merges acontecem na ordem do lote, no worktree.
    const mergeCalls = runner.calls.filter((c) => c.cmd === "git" && c.args[0] === "merge");
    assert.equal(mergeCalls.length, 2);
    assert.ok(mergeCalls.every((c) => c.cwd === result.worktreePath), "merges devem rodar no worktree isolado, não no checkout principal");
  });

  it("merge conflitante: aborta o merge NO WORKTREE, devolve conflictOnPr, nunca toca o checkout principal", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a, cwd) => a[0] === "fetch" && a[2] === "master" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "add" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "fetch" && a[2] === "develop/fix-100" && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "merge" && !a.includes("--abort") && cwd !== MAIN_CWD, () => fail("CONFLICT"))
      .on("git", (a, cwd) => a[0] === "merge" && a.includes("--abort") && cwd !== MAIN_CWD, () => ok());

    const result = buildIntegrationBranch(runner, { prs: [100] }, prInfos, { baseBranch: "master", branchName: "merge-train/x", mainCwd: MAIN_CWD });
    assert.equal(result.ok, false);
    assert.equal(result.conflictOnPr, 100);
    assert.ok(runner.calls.some((c) => c.cmd === "git" && c.args.includes("--abort")), "merge --abort deve ser chamado após conflito");
    assert.ok(!runner.calls.some((c) => c.cmd === "git" && c.cwd === MAIN_CWD && (c.args[0] === "checkout" || c.args[0] === "merge")), "checkout principal nunca deve ser tocado por um merge/checkout de conteúdo");
  });

  it("--abort também falhando: reporta erro mas NÃO trava — worktree é descartável, avisa via runner.warn", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a, cwd) => a[0] === "fetch" && a[2] === "master" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "add" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "fetch" && a[2] === "develop/fix-100" && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "merge" && !a.includes("--abort") && cwd !== MAIN_CWD, () => fail("CONFLICT"))
      .on("git", (a, cwd) => a[0] === "merge" && a.includes("--abort") && cwd !== MAIN_CWD, () => fail("index travado"));

    const result = buildIntegrationBranch(runner, { prs: [100] }, prInfos, { baseBranch: "master", branchName: "merge-train/x", mainCwd: MAIN_CWD });
    assert.equal(result.ok, false);
    assert.equal(result.conflictOnPr, 100);
    assert.ok(runner.warnings.length > 0, "abort falhando deve gerar warn, não ser engolido em silêncio");
  });

  it("git push falhando reporta erro sem conflictOnPr (não é problema de conteúdo, é de rede/permissão)", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a, cwd) => a[0] === "fetch" && a[2] === "master" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "add" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "fetch" && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "merge" && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "push" && cwd !== MAIN_CWD, () => fail("permission denied"));

    const result = buildIntegrationBranch(runner, batch, prInfos, { baseBranch: "master", branchName: "merge-train/lote-1", mainCwd: MAIN_CWD });
    assert.equal(result.ok, false);
    assert.equal(result.conflictOnPr, undefined);
  });
});

describe("cleanupIntegrationBranch", () => {
  it("caminho feliz: remove worktree, deleta branch remota (best-effort) e local, no checkout principal", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "remove" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "push" && a.includes("--delete") && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "branch" && a.includes("-D") && cwd === MAIN_CWD, () => ok());

    const result = cleanupIntegrationBranch(runner, "merge-train/lote-1", "/tmp/wt1", MAIN_CWD);
    assert.equal(result.ok, true);
  });

  it("worktree remove falhando: reporta ok:false + warn, mas não lança (best-effort, achado do fleet review)", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "remove" && cwd === MAIN_CWD, () => fail("worktree travado"))
      .on("git", (a, cwd) => a[0] === "push" && a.includes("--delete") && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "branch" && a.includes("-D") && cwd === MAIN_CWD, () => fail("branch ainda em uso"));

    const result = cleanupIntegrationBranch(runner, "merge-train/lote-1", "/tmp/wt1", MAIN_CWD);
    assert.equal(result.ok, false);
    assert.ok(runner.warnings.some((w) => /worktree remove/.test(w)));
  });

  it("#8209 (regressão #633): git reporta sucesso mas sobra uma casca com junction node_modules -> resolveWorktreeRemoval limpa via fallback, alvo intacto", () => {
    const base = mkdtempSync(join(tmpdir(), "diaria-mtl-8209-"));
    const worktreePath = join(base, "worktree-integracao");
    const nodeModulesTarget = join(base, "SHARED-node-modules-descartavel");
    mkdirSync(nodeModulesTarget, { recursive: true });
    writeFileSync(join(nodeModulesTarget, "canary.txt"), "conteúdo real do node_modules do checkout principal");
    mkdirSync(worktreePath, { recursive: true });
    symlinkSync(nodeModulesTarget, join(worktreePath, "node_modules"), "dir");

    const runner = new FakeTrainRunner();
    runner
      // git relata sucesso, mas — igual ao #8209 no Windows — o diretório
      // sobrevive por causa da junction/symlink lá dentro.
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "remove" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "push" && a.includes("--delete") && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "branch" && a.includes("-D") && cwd === MAIN_CWD, () => ok());

    const result = cleanupIntegrationBranch(runner, "merge-train/lote-1", worktreePath, MAIN_CWD);

    assert.equal(result.ok, true, "a limpeza segura de fallback recupera a casca — o resultado final continua ok");
    assert.equal(existsSync(worktreePath), false, "a casca precisa sumir depois do fallback");
    // Asserção mais importante do teste (#8209): o ALVO do link sobrevive
    // intacto — prova que a limpeza NUNCA seguiu a junction/symlink pra
    // dentro do node_modules do checkout principal.
    assert.equal(existsSync(nodeModulesTarget), true, "alvo do link precisa sobreviver intacto");
    assert.equal(readFileSync(join(nodeModulesTarget, "canary.txt"), "utf8"), "conteúdo real do node_modules do checkout principal");

    rmSync(base, { recursive: true, force: true });
  });
});

describe("openTrainPr", () => {
  it("extrai o número do PR da URL impressa por gh pr create", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => ok("https://github.com/vjpixel/diaria-studio/pull/6400\n"));
    const n = openTrainPr(runner, "merge-train/lote-1", "master", "[trem] lote de 2", "corpo");
    assert.equal(n, 6400);
  });

  it("lança se gh pr create falha", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", () => true, () => fail("erro"));
    assert.throws(() => openTrainPr(runner, "x", "master", "t", "b"), /gh pr create falhou/);
  });

  it("lança se a saída não tem número de PR reconhecível", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", () => true, () => ok("saída inesperada sem URL"));
    assert.throws(() => openTrainPr(runner, "x", "master", "t", "b"), /não consegui extrair/);
  });
});

describe("pollTrainCi", () => {
  it("verdict pass assim que evaluatePrChecksGate resolve para pass", async () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "view", () => ok(ciPassJson()));
    const verdict = await pollTrainCi(runner, 6400, { timeoutMs: 60_000, intervalMs: 1000 });
    assert.equal(verdict, "pass");
  });

  it("verdict fail assim que qualquer check reprova", async () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "view", () =>
      ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "FAILURE", status: "COMPLETED" }] })),
    );
    const verdict = await pollTrainCi(runner, 6400, { timeoutMs: 60_000, intervalMs: 1000 });
    assert.equal(verdict, "fail");
  });

  it("continua fazendo polling enquanto pending, até estourar o timeout — vira 'timeout'", async () => {
    const runner = new FakeTrainRunner();
    runner.advanceMs = 20_000; // cada sleep() simulado avança 20s
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "view", () =>
      ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: null, status: "IN_PROGRESS" }] })),
    );
    const verdict = await pollTrainCi(runner, 6400, { timeoutMs: 50_000, intervalMs: 1000 });
    assert.equal(verdict, "timeout");
  });

  it("pending vira pass assim que o check conclui (várias rodadas de polling)", async () => {
    const runner = new FakeTrainRunner();
    let call = 0;
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "view", () => {
      call++;
      const conclusion = call < 3 ? null : "SUCCESS";
      const status = call < 3 ? "IN_PROGRESS" : "COMPLETED";
      return ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion, status }] }));
    });
    const verdict = await pollTrainCi(runner, 6400, { timeoutMs: 60_000, intervalMs: 1000 });
    assert.equal(verdict, "pass");
    assert.equal(call, 3);
  });
});

describe("mergeTrainBatch", () => {
  const batch: TrainBatch = { prs: [100, 101] };
  const prInfos: TrainPrInfo[] = [makePrInfo({ pr: 100 }), makePrInfo({ pr: 101, issueNumbers: [11] })];

  it("caminho feliz: revalida Gate 2 de cada PR → lock → squash merge → pull → release → comenta+fecha as 2 PRs originais", () => {
    const runner = new FakeTrainRunner().withGate2Green().withLockOk();
    runner
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok())
      .on("git", (a) => a[0] === "pull", () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "comment", () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "close", () => ok());

    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "sess-1", kind: "develop", commitTitle: "trem(#6300): lote", commitBody: "Closes #10, #11" });
    assert.equal(result.ok, true);
    assert.equal(runner.calls.filter((c) => c.cmd === "gh" && c.args[1] === "close").length, 2);
    assert.equal(runner.calls.filter((c) => c.cmd === "gh" && c.args[1] === "comment").length, 2);
  });

  it("revalidação de Gate 2 falhando pra 1 PR do lote: NÃO tenta lock nem merge", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", (a) => a.includes("statusCheckRollup"), () =>
      ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "FAILURE", status: "COMPLETED" }] })),
    );
    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "s", kind: "develop", commitTitle: "t", commitBody: "b" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /revalidação de Gate 2/);
    assert.ok(!runner.calls.some((c) => c.cmd === "npx"), "não pode tentar o lock se a revalidação já reprovou");
  });

  it("merge-lock negado: reporta lockDenied:true, NUNCA tenta o gh pr merge", () => {
    const runner = new FakeTrainRunner().withGate2Green();
    runner.on("npx", (a) => a.includes("merge-lock-acquire"), () => fail("denied (held by another session)"));
    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "s", kind: "develop", commitTitle: "t", commitBody: "b" });
    assert.equal(result.ok, false);
    assert.equal(result.lockDenied, true);
    assert.ok(!runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "merge"), "não pode tentar merge sem o lock");
  });

  it("acquire falhando por motivo NÃO identificável como 'denied': lockDenied fica false/undefined, não presume a causa", () => {
    const runner = new FakeTrainRunner().withGate2Green();
    runner.on("npx", (a) => a.includes("merge-lock-acquire"), () => fail("ENOENT: tsx não encontrado"));
    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "s", kind: "develop", commitTitle: "t", commitBody: "b" });
    assert.equal(result.ok, false);
    assert.ok(!result.lockDenied, "erro que não menciona 'denied' não deve ser rotulado como negação de lock");
  });

  it("lock sempre é liberado, mesmo se gh pr merge falhar (finally)", () => {
    const runner = new FakeTrainRunner().withGate2Green().withLockOk();
    runner
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => fail("CI mudou de verde pra vermelho entre o poll e o merge"))
      .on("gh", (a) => a[0] === "pr" && a[1] === "view" && a.includes("state,mergedAt"), () => ok(JSON.stringify({ state: "OPEN", mergedAt: null })));

    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "s", kind: "develop", commitTitle: "t", commitBody: "b" });
    assert.equal(result.ok, false);
    assert.ok(runner.calls.some((c) => c.cmd === "npx" && c.args.includes("merge-lock-release")), "lock deve ser liberado mesmo em falha");
  });

  it("#573 — gh pr merge reporta falha, mas gh pr view confirma MERGED: trata como sucesso (o remoto é a fonte de verdade)", () => {
    const runner = new FakeTrainRunner().withGate2Green().withLockOk();
    runner
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => fail("timeout local, mas pode ter ido"))
      .on("gh", (a) => a[0] === "pr" && a[1] === "view" && a.includes("state,mergedAt"), () => ok(JSON.stringify({ state: "MERGED", mergedAt: "2026-08-26T12:00:00Z" })))
      .on("git", (a) => a[0] === "pull", () => ok())
      .on("gh", (a) => a[0] === "pr" && (a[1] === "comment" || a[1] === "close"), () => ok());

    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "s", kind: "develop", commitTitle: "t", commitBody: "b" });
    assert.equal(result.ok, true, "confirmação via gh pr view --json state,mergedAt deve prevalecer sobre o exit code do gh pr merge");
  });

  it("git pull local falhando NÃO desfaz o merge — reporta ok:true com aviso (merge já é fato consumado no remoto)", () => {
    const runner = new FakeTrainRunner().withGate2Green().withLockOk();
    runner
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok())
      .on("git", (a) => a[0] === "pull", () => fail("network blip"))
      .on("gh", (a) => a[0] === "pr" && (a[1] === "comment" || a[1] === "close"), () => ok());

    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "s", kind: "develop", commitTitle: "t", commitBody: "b" });
    assert.equal(result.ok, true);
    assert.match(result.error ?? "", /pull local falhou/);
  });
});

describe("mergeSoloPr — piso da bissecção, caminho de hoje sem trem", () => {
  it("caminho feliz: revalida Gate 2 → lock → squash merge com título/body atuais da PR → pull → release", () => {
    const runner = new FakeTrainRunner().withGate2Green().withLockOk();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok()).on("git", (a) => a[0] === "pull", () => ok());

    const result = mergeSoloPr(runner, 100, { sessionId: "s", kind: "develop" });
    assert.equal(result.ok, true);
    const mergeCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "merge");
    assert.ok(mergeCall);
    assert.equal(mergeCall.args[mergeCall.args.indexOf("--subject") + 1], "fix: exemplo");
    assert.equal(mergeCall.args[mergeCall.args.indexOf("--body") + 1], "Closes #10");
  });

  it("#11190: body REFS prevalece sobre Closes antigo no commit", () => {
    const runner = new FakeTrainRunner().withGate2Green().withLockOk();
    const body = "REFS #11119, NÃO CLOSES (escopo parcial)";
    runner.on("gh", (a) => a.includes("title,body"), () => ok(JSON.stringify({ title: "fix: escopo parcial", body })))
      .on("gh", (a) => a[1] === "merge", (args) => {
        // Sem mensagem explícita, o squash do GitHub herda o commit antigo.
        const squashBody = args.includes("--body") ? args[args.indexOf("--body") + 1] : "Closes #11119";
        assert.equal(squashBody, body);
        return ok();
      })
      .on("git", (a) => a[0] === "pull", () => ok());
    assert.equal(mergeSoloPr(runner, 100, { sessionId: "s", kind: "develop" }).ok, true);
    const lockIndex = runner.calls.findIndex((c) => c.args.includes("merge-lock-acquire"));
    const readIndex = runner.calls.findIndex((c) => c.args.includes("title,body"));
    assert.ok(readIndex > lockIndex, "relê a PR sob o lock, sem usar snapshot da descoberta");
  });

  for (const response of [fail("offline"), ok("invalid json"), ok("{}"), ok('{"title":"fix"}')]) {
    it(`#11190: mensagem da PR ilegível bloqueia merge e libera lock (${response.stdout || response.stderr})`, () => {
      const runner = new FakeTrainRunner().withGate2Green().withLockOk();
      runner.on("gh", (a) => a.includes("title,body"), () => response);
      const result = mergeSoloPr(runner, 100, { sessionId: "s", kind: "develop" });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /mensagem.*PR/i);
      assert.ok(!runner.calls.some((c) => c.args[1] === "merge"));
      assert.ok(runner.calls.some((c) => c.args.includes("merge-lock-release")));
    });
  }

  it("revalidação de Gate 2 falhando: NÃO tenta lock nem merge", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", () => true, () => fail("erro"));
    const result = mergeSoloPr(runner, 100, { sessionId: "s", kind: "develop" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /revalidação de Gate 2/);
  });
});

describe("runMergeTrain — máquina de estados de ponta a ponta", () => {
  function fullRunner(): FakeTrainRunner {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a, cwd) => a[0] === "fetch" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "add" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "remove" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "fetch" && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "merge" && !a.includes("--abort") && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "merge" && a.includes("--abort") && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "push" && !a.includes("--delete") && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "push" && a.includes("--delete") && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "branch" && a.includes("-D") && cwd === MAIN_CWD, () => ok())
      .on("git", (a) => a[0] === "pull", () => ok())
      .withLockOk()
      .withGate2Green()
      .on("gh", (a) => a[0] === "pr" && (a[1] === "comment" || a[1] === "close"), () => ok());
    return runner;
  }

  const prInfos3: TrainPrInfo[] = [
    makePrInfo({ pr: 100, headRefName: "develop/fix-100", issueNumbers: [10] }),
    makePrInfo({ pr: 101, headRefName: "develop/fix-101", issueNumbers: [11] }),
    makePrInfo({ pr: 102, headRefName: "develop/fix-102", issueNumbers: [12] }),
  ];

  it("caminho feliz: lote de 3, CI verde de primeira, 1 único merge, worktree limpo no checkout principal", async () => {
    const runner = fullRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => ok("https://github.com/x/y/pull/9001\n")).on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "merged");
    assert.ok(runner.calls.some((c) => c.cmd === "git" && c.args[0] === "worktree" && c.args[1] === "remove"), "worktree deve ser removido após merge");
  });

  it("CI vermelho CONFIRMADO (2 execuções, #7064) no lote de 3 → bissecta em {2,1} → o de 2 passa, o de 1 vai solo", async () => {
    const runner = fullRunner();
    let createCalls = 0;
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => {
      createCalls++;
      return ok(`https://github.com/x/y/pull/900${createCalls}\n`);
    });
    let viewCalls = 0;
    // Sobrescreve especificamente o PR-trem (número != PR original) pra simular vermelho nas 2 execuções
    // (1ª + reconfirmação, #7064) — as revalidações de Gate 2 dos PRs 100/101/102 e o trem-filho da
    // bissecção (outro número de PR) continuam caindo no handler genérico de fullRunner() (verde).
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "view" && a[2] === "9001" && a.includes("statusCheckRollup"), () => {
      viewCalls++;
      return ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "FAILURE", status: "COMPLETED" }] }));
    });
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD, ciPollIntervalMs: 1 });
    assert.ok(viewCalls >= 2, "reconfirmação (#7064) deve consultar o PR-trem 9001 pelo menos 2x antes de bissectar");
    const statuses = outcomes.map((o) => o.status);
    assert.ok(statuses.includes("abandoned"), "lote original vermelho deve aparecer como abandoned");
    assert.ok(statuses.includes("merged") || statuses.includes("solo-merged"), "algum sub-lote deve fechar com sucesso");
  });

  it("regressão #7064: 1ª execução fail + reconfirmação pass → 'indeterminate', NUNCA bissecta e NUNCA mergeia", async () => {
    const runner = fullRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => ok("https://github.com/x/y/pull/9001\n"));
    let viewCalls = 0;
    // Simula exatamente a corrida do #7060 medida ao vivo: 1ª execução do CI
    // do lote reprova, a reconfirmação (2ª execução, mesmo PR-trem/sha)
    // aprova — discordância é a assinatura da corrida, nunca reprovação.
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "view" && a[2] === "9001" && a.includes("statusCheckRollup"), () => {
      viewCalls++;
      const conclusion = viewCalls === 1 ? "FAILURE" : "SUCCESS";
      return ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion, status: "COMPLETED" }] }));
    });
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD, ciPollIntervalMs: 1 });

    assert.equal(viewCalls, 2, "deve consultar o PR-trem exatamente 2x (1ª execução + reconfirmação) — nunca uma 3ª");
    assert.equal(outcomes.length, 1, "lote não deve ser bissectado — discordância vira 1 outcome terminal, não 2 sub-lotes na fila");
    assert.equal(outcomes[0].status, "indeterminate");
    assert.match(outcomes[0].detail, /discord[âa]ncia/i);
    assert.ok(!outcomes.some((o) => o.status === "abandoned"), "discordância nunca deve aparecer como abandoned/bissecção");
    assert.ok(!outcomes.some((o) => o.status === "merged" || o.status === "solo-merged"), "discordância nunca deve mergear — 'nunca aprovação' tanto quanto 'nunca reprovação'");
    assert.ok(!runner.calls.some((c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "merge"), "gh pr merge nunca deve ser chamado num lote indeterminado");
    assert.ok(runner.calls.some((c) => c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "close" && c.args[2] === "9001"), "PR-trem descartável deve ser fechado mesmo em estado indeterminado");
  });

  it("conflito de integração bissecta em vez de abortar tudo — checkout principal nunca é envenenado (worktree isolado)", async () => {
    const runner = new FakeTrainRunner();
    let mergeAttempt = 0;
    runner
      .on("git", (a, cwd) => a[0] === "fetch" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "add" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "worktree" && a[1] === "remove" && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "fetch" && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "merge" && a.includes("--abort") && cwd !== MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "merge" && !a.includes("--abort") && cwd !== MAIN_CWD, () => {
        mergeAttempt++;
        return mergeAttempt === 2 ? fail("CONFLICT") : ok();
      })
      .on("git", (a, cwd) => a[0] === "push" && a.includes("--delete") && cwd === MAIN_CWD, () => ok())
      .on("git", (a, cwd) => a[0] === "branch" && a.includes("-D") && cwd === MAIN_CWD, () => ok())
      .on("git", (a) => a[0] === "pull", () => ok())
      .withLockOk()
      .withGate2Green()
      .on("gh", (a) => a[0] === "pr" && (a[1] === "comment" || a[1] === "close"), () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100, 101] }, prInfos3.slice(0, 2), { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    const statuses = outcomes.map((o) => o.status);
    assert.ok(statuses.includes("abandoned"), "conflito de integração deve virar abandoned + bissecção");
    // Depois da bissecção {100},{101}, ambos são piso (tamanho 1) → merge solo.
    assert.ok(statuses.filter((s) => s === "solo-merged").length === 2);
    assert.ok(!runner.calls.some((c) => c.cmd === "git" && c.cwd === MAIN_CWD && c.args[0] === "merge"), "checkout principal nunca deve receber um git merge de conteúdo");
  });

  it("lote de 1 desde o início vai direto pro merge solo — nunca monta integração/PR-trem/worktree", async () => {
    const runner = new FakeTrainRunner().withGate2Green().withLockOk();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok()).on("git", (a) => a[0] === "pull", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100] }, [prInfos3[0]], { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "solo-merged");
    assert.ok(!runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "create"), "lote de 1 não deve abrir PR-trem nenhum");
    assert.ok(!runner.calls.some((c) => c.cmd === "git" && c.args[0] === "worktree"), "lote de 1 não deve montar worktree nenhum");
  });

  it("lock negado após CI verde: retenta (bounded) e resolve — não bissecta um lote que já provou passar", async () => {
    const runner = fullRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => ok("https://github.com/x/y/pull/9001\n"));
    let acquireAttempts = 0;
    runner.on("npx", (a) => a.includes("merge-lock-acquire"), () => {
      acquireAttempts++;
      return acquireAttempts < 2 ? fail("denied (held by another session)") : ok();
    });
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "merged");
    assert.ok(acquireAttempts >= 2, "deve ter retentado o lock pelo menos uma vez");
  });

  it("lock negado esgotando os retries: status terminal 'lock-blocked' (falha real, não bissecta)", async () => {
    const runner = fullRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => ok("https://github.com/x/y/pull/9001\n"));
    runner.on("npx", (a) => a.includes("merge-lock-acquire"), () => fail("denied (held by another session)"));

    const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "lock-blocked");
    assert.ok(!outcomes.some((o) => o.status === "abandoned"), "lock negado não deve bissectar — o lote já provou passar junto no CI");
  });

  // #10294: label `retido-para-editor` aplicada por outra trilha DEPOIS da
  // descoberta — a revalidação no instante do merge tira só esse PR e o
  // resto do lote segue (nunca `lock-blocked` pro lote inteiro, nunca merge
  // do retido).
  it("PR retido no instante do merge: sai do lote (status 'retido'), o resto é refeito e mergeado (#10294)", async () => {
    const runner = fullRunner();
    let createCalls = 0;
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => {
      createCalls++;
      return ok(`https://github.com/x/y/pull/900${createCalls}\n`);
    });
    const merged: string[] = [];
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", (a) => {
      merged.push(a[2]);
      return ok();
    });
    runner.on("gh", isRetidoView(101), () => ok(retidoJson()));

    const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    const retidos = outcomes.filter((o) => o.status === "retido");
    assert.equal(retidos.length, 1);
    assert.deepEqual([...retidos[0].batch.prs], [101]);
    const mergedOutcome = outcomes.find((o) => o.status === "merged");
    assert.ok(mergedOutcome, "o resto do lote deve mergear");
    assert.deepEqual([...mergedOutcome.batch.prs], [100, 102]);
    assert.ok(!outcomes.some((o) => o.status === "lock-blocked"), "retido nunca prende o lote como lock-blocked");
    assert.ok(!merged.includes("101"), "o PR retido nunca é mergeado");
    // O 1º PR-trem (que continha o retido) foi fechado sem mergear.
    assert.deepEqual(merged, ["9002"]);
  });

  it("lote de 1 retido: status terminal 'retido', sem gh pr merge (#10294)", async () => {
    const runner = fullRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => {
      throw new Error("não deveria mergear PR retido");
    });
    runner.on("gh", isRetidoView(100), () => ok(retidoJson()));
    const outcomes = await runMergeTrain(runner, { prs: [100] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "retido");
  });

  // #10299: sinal ilegível no instante do merge (gh falhou) não é retenção
  // deliberada — antes virava `retido` e o trem saía com exit 0.
  it("lote de 1 com sinal retido ilegível no merge: status 'retido-ilegivel', conta como falha real (#10299)", async () => {
    const runner = fullRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => {
      throw new Error("não deveria mergear com sinal ilegível");
    });
    runner.on("gh", isRetidoView(100), () => fail("timeout de rede"));
    const outcomes = await runMergeTrain(runner, { prs: [100] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "retido-ilegivel");
    assert.equal(trainHasRealFailure(outcomes), true);
  });

  it("lote >=2 com sinal ilegível num PR: ele sai como 'retido-ilegivel' (falha), o resto mergeia (#10299)", async () => {
    const runner = fullRunner();
    let createCalls = 0;
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => {
      createCalls++;
      return ok(`https://github.com/x/y/pull/900${createCalls}\n`);
    });
    const merged: string[] = [];
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", (a) => {
      merged.push(a[2]);
      return ok();
    });
    runner.on("gh", isRetidoView(101), () => ok("não-json"));
    const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    const ilegiveis = outcomes.filter((o) => o.status === "retido-ilegivel");
    assert.equal(ilegiveis.length, 1);
    assert.deepEqual([...ilegiveis[0].batch.prs], [101]);
    assert.ok(!outcomes.some((o) => o.status === "retido"), "ilegível nunca é reportado como retenção deliberada");
    assert.deepEqual(merged, ["9002"]);
    assert.equal(trainHasRealFailure(outcomes), true);
  });

  it("retido de fato não conta como falha; o ilegível da descoberta conta (#10299)", async () => {
    const runner = fullRunner();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => {
      throw new Error("não deveria mergear PR retido");
    });
    runner.on("gh", isRetidoView(100), () => ok(retidoJson()));
    const outcomes = await runMergeTrain(runner, { prs: [100] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
    assert.equal(trainHasRealFailure(outcomes), false);
    assert.equal(trainHasRealFailure(outcomes, true), true);
  });

  // #10997 (regressão #633): rodada 261023, trem 5 — lote vermelho, piso da
  // bissecção mergeou o PR solo com o CI verde dele (base ANTIGA) e master
  // ficou vermelha. PR que esteve num lote vermelho só mergeia com CI verde
  // sobre a base ATUAL (PR-trem de 1 sobre origin/master fresco).
  describe("#10997 — piso da bissecção depois de lote vermelho exige CI sobre a base atual", () => {
    const red = () => ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "FAILURE", status: "COMPLETED" }] }));

    /** PR-trem 9001 = [100,101,102], 9002 = [100,101], 9003 = [102]. */
    function scenario(trainCi: Record<string, "pass" | "fail">) {
      const runner = fullRunner();
      let createCalls = 0;
      const created: { num: string; head: string }[] = [];
      runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", (a) => {
        createCalls++;
        const num = `900${createCalls}`;
        created.push({ num, head: a[a.indexOf("--head") + 1] });
        return ok(`https://github.com/x/y/pull/${num}\n`);
      });
      for (const [num, verdict] of Object.entries(trainCi)) {
        runner.on("gh", (a) => a[0] === "pr" && a[1] === "view" && a[2] === num && a.includes("statusCheckRollup"), () => (verdict === "fail" ? red() : ok(ciPassJson())));
      }
      const merged: string[] = [];
      runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", (a) => {
        merged.push(a[2]);
        return ok();
      });
      return { runner, created, merged };
    }

    it("PR do lote vermelho cujo CI sobre a base atual reprova: 'solo-failed', NUNCA mergeado com o CI velho", async () => {
      const { runner, created, merged } = scenario({ "9001": "fail", "9003": "fail" });
      const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD, ciPollIntervalMs: 1 });

      assert.ok(!merged.includes("102"), "o PR 102 nunca pode ir pro merge solo direto (CI verde dele é da base antiga)");
      assert.deepEqual(merged, ["9002"], "só o sub-lote verde sobre a base atual mergeia");
      assert.equal(created.length, 3, "o PR solo ganha um PR-trem próprio (integração sobre origin/master fresco)");
      assert.match(created[2].head, /102$/, "o 3º PR-trem é o do PR 102 sozinho");
      const solo = outcomes.find((o) => o.batch.prs.length === 1 && o.batch.prs[0] === 102);
      assert.equal(solo?.status, "solo-failed");
      assert.match(solo?.detail ?? "", /base atual/);
      assert.equal(trainHasRealFailure(outcomes), true, "PR não mergeado por CI vermelho na base atual é falha real (exit != 0)");
      assert.ok(runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "close" && c.args[2] === "9003"), "PR-trem do solo é fechado");
      assert.ok(!runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "close" && c.args[2] === "102"), "o PR original 102 fica aberto pro coordenador");
    });

    it("PR do lote vermelho cujo CI sobre a base atual passa: 'solo-merged' via PR-trem de 1, PR original fechado", async () => {
      const { runner, merged } = scenario({ "9001": "fail" });
      const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD, ciPollIntervalMs: 1 });

      assert.deepEqual(merged, ["9002", "9003"], "o 102 entra em master pelo PR-trem 9003, que passou no CI sobre a base atual");
      const solo = outcomes.find((o) => o.batch.prs.length === 1 && o.batch.prs[0] === 102);
      assert.equal(solo?.status, "solo-merged");
      assert.match(solo?.detail ?? "", /revalidado sobre a base atual/);
      assert.equal(trainHasRealFailure(outcomes), false);
      const squash = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "merge" && c.args[2] === "9003");
      assert.match(squash?.args[squash.args.indexOf("--body") + 1] ?? "", /^Closes #12$/m, "o commit squash fecha a issue do PR 102");
      assert.ok(runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "close" && c.args[2] === "102"), "PR original fechado com apontamento pro trem");
    });

    it("timeout do CI do lote também conta como lote vermelho pro piso", async () => {
      const runner = fullRunner();
      runner.advanceMs = 10_000;
      let createCalls = 0;
      runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => {
        createCalls++;
        return ok(`https://github.com/x/y/pull/900${createCalls}\n`);
      });
      const pending = ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: null, status: "IN_PROGRESS" }] }));
      runner.on("gh", (a) => a[0] === "pr" && a[1] === "view" && a[2] === "9001" && a.includes("statusCheckRollup"), () => pending);
      const merged: string[] = [];
      runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", (a) => {
        merged.push(a[2]);
        return ok();
      });
      const outcomes = await runMergeTrain(runner, { prs: [100, 101] }, prInfos3.slice(0, 2), {
        sessionId: "s",
        kind: "develop",
        mainCwd: MAIN_CWD,
        ciTimeoutMs: 30_000,
        ciPollIntervalMs: 1,
      });
      assert.ok(!merged.includes("100") && !merged.includes("101"), "nenhum PR do lote em timeout vai pro merge solo direto");
      assert.deepEqual(merged, ["9002", "9003"]);
      assert.deepEqual(outcomes.map((o) => o.status), ["abandoned", "solo-merged", "solo-merged"]);
    });

    it("lote que só falhou na INTEGRAÇÃO (sem CI vermelho) mantém o merge solo de hoje", async () => {
      const runner = fullRunner();
      runner.on("git", (a, cwd) => a[0] === "merge" && !a.includes("--abort") && cwd !== MAIN_CWD, () => fail("CONFLICT"));
      const merged: string[] = [];
      runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", (a) => {
        merged.push(a[2]);
        return ok();
      });
      const outcomes = await runMergeTrain(runner, { prs: [100, 101] }, prInfos3.slice(0, 2), { sessionId: "s", kind: "develop", mainCwd: MAIN_CWD });
      assert.deepEqual(merged, ["100", "101"]);
      assert.ok(!runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "create"));
      assert.deepEqual(outcomes.map((o) => o.status), ["abandoned", "solo-merged", "solo-merged"]);
    });
  });
});

describe("checkPrRetido / partitionRetidoCandidates (#10294)", () => {
  it("label retido-para-editor → retido true", () => {
    const runner = new FakeTrainRunner().on("gh", isRetidoView(7), () => ok(retidoJson()));
    assert.equal(checkPrRetido(runner, 7).retido, true);
  });

  it("marcador no corpo → retido true", () => {
    const runner = new FakeTrainRunner().on("gh", isRetidoView(7), () =>
      ok(JSON.stringify({ labels: [], body: "x\n<!-- retido-para-editor -->\n" })),
    );
    assert.equal(checkPrRetido(runner, 7).retido, true);
  });

  it("gh falha ou JSON malformado → retido null (fail-closed, nunca livre)", () => {
    const failing = new FakeTrainRunner().on("gh", () => true, () => fail("rate limit"));
    assert.equal(checkPrRetido(failing, 7).retido, null);
    const garbage = new FakeTrainRunner().on("gh", () => true, () => ok("não-json"));
    assert.equal(checkPrRetido(garbage, 7).retido, null);
  });

  it("separa elegíveis e excluídos preservando a ordem — o retido nunca entra no lote", () => {
    const runner = new FakeTrainRunner()
      .on("gh", (a) => a.includes("labels,body"), () => ok(notRetidoJson()))
      .on("gh", isRetidoView(2), () => ok(retidoJson()))
      .on("gh", isRetidoView(4), () => fail("timeout"));
    const { eligible, excluded } = partitionRetidoCandidates(runner, [1, 2, 3, 4]);
    assert.deepEqual(eligible, [1, 3]);
    assert.deepEqual(
      excluded.map((e) => [e.pr, e.retido]),
      [
        [2, true],
        [4, null],
      ],
    );
    assert.ok(excluded.every((e) => e.reason.length > 0), "motivo explícito por exclusão");
  });

  it("revalidateGate2 reprova na condição 3 com retido=true quando a label aparece (#10294)", () => {
    const runner = new FakeTrainRunner().withGate2Green().on("gh", isRetidoView(100), () => ok(retidoJson()));
    const result = revalidateGate2(runner, 100);
    assert.equal(result.ok, false);
    assert.equal(result.retido, true);
    assert.match(result.reason ?? "", /condição 3/);
  });

  it("revalidateGate2 com sinal ilegível devolve retido=null, nunca true (#10299)", () => {
    const runner = new FakeTrainRunner().withGate2Green().on("gh", isRetidoView(100), () => fail("rate limit"));
    const result = revalidateGate2(runner, 100);
    assert.equal(result.ok, false);
    assert.equal(result.retido, null);
  });
});

describe("runner real — regressão #10849", () => {
  for (const platform of ["win32", "linux", "darwin"] as const) {
    it(`comando por plataforma: ${platform}`, () => {
      const calls: unknown[][] = [];
      const spawn = ((...params: unknown[]) => {
        calls.push(params);
        return { status: 0, stdout: "ok", stderr: "" };
      }) as typeof import("node:child_process").spawnSync;
      const runner = createRealTrainRunner("/repo com espaço", platform, spawn);
      const args = ["tsx", "scripts/lib/session-registry.ts", "merge-lock-acquire", "--session-id", "sessão & teste"];
      assert.equal(runner.exec("npx", args).ok, true);
      assert.equal(calls[0][0], platform === "win32" ? process.execPath : "npx");
      assert.deepEqual(calls[0][1], platform === "win32" ? ["--import", "tsx", ...args.slice(1)] : args);
      assert.deepEqual(calls[0][2], { cwd: "/repo com espaço", encoding: "utf8", timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
      runner.exec("gh", ["--version"], "/outro");
      assert.equal(calls[1][0], "gh");
      assert.equal((calls[1][2] as { cwd: string }).cwd, "/outro");
    });
  }
  it("diagnostica ENOENT e preserva outros erros", () => {
    for (const code of ["ENOENT", "ETIMEDOUT"]) {
      const spawn = ((): import("node:child_process").SpawnSyncReturns<string | Buffer> => ({
        pid: 0, output: [], stdout: "", stderr: "", status: null, signal: null,
        error: Object.assign(new Error("spawn falhou"), { code }),
      })) as typeof import("node:child_process").spawnSync;
      const result = createRealTrainRunner("/repo", "linux", spawn).exec("npx", ["tsx"]);
      assert.equal(result.ok, false);
      assert.equal(result.stderr, code === "ENOENT"
        ? "executável não encontrado: npx (cwd: /repo): spawn falhou" : "spawn falhou");
    }
  });
});

describe("#10618 fatia 4 (review 2, item 2) — checkStudioTrainPr: o trem é só-studio", () => {
  const view = (payload: unknown) =>
    new FakeTrainRunner().on("gh", (a) => a[0] === "pr" && a[1] === "view" && a.includes("number,state,baseRefName,url,isCrossRepository"), () =>
      ok(JSON.stringify(payload)),
    );
  const studio = { state: "OPEN", baseRefName: "master", url: "https://github.com/vjpixel/diaria-studio/pull/23", isCrossRepository: false };

  it("PR aberto do studio mirando master → studio", () => {
    assert.deepEqual(checkStudioTrainPr(view(studio), 23), { verdict: "studio" });
  });

  it("studio PR já fechado/mergeado → closed (nunca mergeado de novo; #10901: pulado, não recusa o trem)", () => {
    const r = checkStudioTrainPr(view({ ...studio, state: "MERGED" }), 23);
    assert.equal(r.verdict, "closed");
    assert.doesNotMatch((r as { reason: string }).reason, /outro repo/);
  });

  it("url de outro repo, base main ou fork → foreign", () => {
    assert.equal(checkStudioTrainPr(view({ ...studio, url: "https://github.com/vjpixel/diaria-design/pull/23" }), 23).verdict, "foreign");
    assert.equal(checkStudioTrainPr(view({ ...studio, baseRefName: "main" }), 23).verdict, "foreign");
    assert.equal(checkStudioTrainPr(view({ ...studio, isCrossRepository: true }), 23).verdict, "foreign");
    assert.equal(checkStudioTrainPr(view({ ...studio, url: "https://github.com/vjpixel/diaria-studio/pull/230" }), 23).verdict, "foreign");
  });

  it("gh falhou ou JSON ruim → unreadable (fail-closed, nunca studio)", () => {
    const failing = new FakeTrainRunner().on("gh", () => true, () => fail("HTTP 404"));
    assert.equal(checkStudioTrainPr(failing, 23).verdict, "unreadable");
    const bad = new FakeTrainRunner().on("gh", () => true, () => ok("não-json"));
    assert.equal(checkStudioTrainPr(bad, 23).verdict, "unreadable");
  });

  it("run-merge-train.ts chama screenTrainPrs (checkStudioTrainPr) antes de compor lotes (fiação)", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "run-merge-train.ts"), "utf8");
    const check = src.indexOf("screenTrainPrs(runner, prNumbers, !values.prs)");
    assert.ok(check > 0);
    assert.ok(check < src.indexOf("partitionRetidoCandidates(runner, prNumbers)"));
    assert.ok(check < src.indexOf("composeTrainBatches("));
  });
});

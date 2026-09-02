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
import {
  fetchTrainPrInfo,
  revalidateGate2,
  buildIntegrationBranch,
  openTrainPr,
  pollTrainCi,
  mergeTrainBatch,
  mergeSoloPr,
  cleanupIntegrationBranch,
  runMergeTrain,
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
    return this.on("gh", (a) => a[0] === "pr" && a[1] === "view" && a.includes("statusCheckRollup"), () => ok(ciPassJson())).on(
      "gh",
      (a) => a[0] === "api" && a[1] === "graphql",
      () => ok(noThreadsJson()),
    );
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
  it("caminho feliz: revalida Gate 2 → lock → squash merge (sem --subject/--body custom) → pull → release", () => {
    const runner = new FakeTrainRunner().withGate2Green().withLockOk();
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok()).on("git", (a) => a[0] === "pull", () => ok());

    const result = mergeSoloPr(runner, 100, { sessionId: "s", kind: "develop" });
    assert.equal(result.ok, true);
    const mergeCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "merge");
    assert.ok(mergeCall);
    assert.ok(!mergeCall!.args.includes("--subject"), "merge solo reusa a mensagem do PR, não custom");
  });

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
});

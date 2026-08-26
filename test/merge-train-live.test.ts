/**
 * test/merge-train-live.test.ts (#6300, regressão #633)
 *
 * Cobre a ORQUESTRAÇÃO viva de scripts/lib/merge-train-live.ts com um
 * `TrainRunner` FAKE (nenhum git/gh/rede real é tocado) — a máquina de
 * estados do trem: caminho feliz (lote passa, merge squash, fecha PRs
 * originais), CI vermelho (bissecta), timeout de CI (tratado como
 * vermelho, bissecta), conflito de integração (bissecta), piso da
 * bissecção (merge solo, sem trem), e merge-lock negado (não bissecta —
 * o lote já provou que passa, só precisa esperar o lock).
 *
 * Por que um runner fake em vez de subprocess real: cada teste abriria um
 * PR de verdade / mergearia de verdade contra o GitHub se usasse `gh`/`git`
 * reais — inviável e destrutivo pra suíte de CI. O fake é o mesmo padrão
 * de injeção de dependência já usado noutros módulos deste repo pra
 * separar orquestração de I/O.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchTrainPrInfo,
  buildIntegrationBranch,
  openTrainPr,
  pollTrainCi,
  mergeTrainBatch,
  mergeSoloPr,
  runMergeTrain,
  type TrainRunner,
  type ExecResult,
} from "../scripts/lib/merge-train-live.ts";
import type { TrainBatch, TrainPrInfo } from "../scripts/lib/merge-train.ts";

/** Handler roteado por (cmd, args) — primeiro que casar vence. Chamadas
 * não-casadas lançam (teste malformado, não silêncio). */
type Handler = (args: string[]) => ExecResult;

function ok(stdout = ""): ExecResult {
  return { ok: true, stdout, stderr: "" };
}
function fail(stderr = "erro simulado"): ExecResult {
  return { ok: false, stdout: "", stderr };
}

class FakeTrainRunner implements TrainRunner {
  readonly calls: { cmd: string; args: string[] }[] = [];
  private clock = 0;
  private handlers: { cmd: string; match: (args: string[]) => boolean; handler: Handler }[] = [];

  on(cmd: string, match: (args: string[]) => boolean, handler: Handler): this {
    this.handlers.push({ cmd, match, handler });
    return this;
  }

  /** Avança o relógio simulado em cada sleep() — usado por pollTrainCi pra checar timeout sem esperar de verdade. */
  advanceMs = 1000;

  exec(cmd: string, args: string[]): ExecResult {
    this.calls.push({ cmd, args });
    const found = this.handlers.find((h) => h.cmd === cmd && h.match(args));
    if (!found) throw new Error(`FakeTrainRunner: chamada não roteirizada: ${cmd} ${args.join(" ")}`);
    return found.handler(args);
  }

  async sleep(_ms: number): Promise<void> {
    this.clock += this.advanceMs;
  }

  now(): number {
    return this.clock;
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
    // parseClosesIssues em si já tem cobertura própria em test/merge-train.test.ts —
    // aqui só confirma que fetchTrainPrInfo de fato delega pra ele sobre o body real.
    assert.deepEqual(info.issueNumbers, [10, 20, 30]);
  });

  it("lança se gh pr view falha", () => {
    const runner = new FakeTrainRunner();
    runner.on("gh", () => true, () => fail("PR não existe"));
    assert.throws(() => fetchTrainPrInfo(runner, 999), /gh pr view falhou/);
  });
});

describe("buildIntegrationBranch", () => {
  const batch: TrainBatch = { prs: [100, 101] };
  const prInfos: TrainPrInfo[] = [
    makePrInfo({ pr: 100, headRefName: "develop/fix-100" }),
    makePrInfo({ pr: 101, headRefName: "develop/fix-101" }),
  ];

  it("caminho feliz: fetch base, checkout -b, fetch+merge de cada PR em ordem, push", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a) => a[0] === "fetch" && a[2] === "master", () => ok())
      .on("git", (a) => a[0] === "checkout" && a[1] === "-b", () => ok())
      .on("git", (a) => a[0] === "fetch" && (a[2] === "develop/fix-100" || a[2] === "develop/fix-101"), () => ok())
      .on("git", (a) => a[0] === "merge", () => ok())
      .on("git", (a) => a[0] === "push", () => ok());

    const result = buildIntegrationBranch(runner, batch, prInfos, { baseBranch: "master", branchName: "merge-train/lote-1" });
    assert.equal(result.ok, true);
    assert.equal(result.branchName, "merge-train/lote-1");
    // Ordem importa: os 2 merges acontecem na ordem do lote.
    const mergeCalls = runner.calls.filter((c) => c.cmd === "git" && c.args[0] === "merge");
    assert.equal(mergeCalls.length, 2);
  });

  it("merge conflitante: aborta o merge e devolve conflictOnPr", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a) => a[0] === "fetch" && a[2] === "master", () => ok())
      .on("git", (a) => a[0] === "checkout" && a[1] === "-b", () => ok())
      .on("git", (a) => a[0] === "fetch" && a[2] === "develop/fix-100", () => ok())
      .on("git", (a) => a[0] === "merge" && a[0] !== "abort", () => fail("CONFLICT"))
      .on("git", (a) => a[0] === "merge" && a.includes("--abort"), () => ok());

    const result = buildIntegrationBranch(runner, { prs: [100] }, prInfos, { baseBranch: "master", branchName: "merge-train/x" });
    assert.equal(result.ok, false);
    assert.equal(result.conflictOnPr, 100);
    assert.ok(runner.calls.some((c) => c.cmd === "git" && c.args.includes("--abort")), "merge --abort deve ser chamado após conflito");
  });

  it("git push falhando reporta erro sem conflictOnPr (não é problema de conteúdo, é de rede/permissão)", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a) => a[0] === "fetch" && a[2] === "master", () => ok())
      .on("git", (a) => a[0] === "checkout" && a[1] === "-b", () => ok())
      .on("git", (a) => a[0] === "fetch" && a[2] === "develop/fix-100" || a[2] === "develop/fix-101", () => ok())
      .on("git", (a) => a[0] === "merge", () => ok())
      .on("git", (a) => a[0] === "push", () => fail("permission denied"));

    const result = buildIntegrationBranch(runner, batch, prInfos, { baseBranch: "master", branchName: "merge-train/lote-1" });
    assert.equal(result.ok, false);
    assert.equal(result.conflictOnPr, undefined);
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
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "view", () =>
      ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "SUCCESS", status: "COMPLETED" }] })),
    );
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

  it("caminho feliz: lock → squash merge → pull → release → comenta+fecha as 2 PRs originais", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("npx", (a) => a.includes("merge-lock-acquire"), () => ok())
      .on("npx", (a) => a.includes("merge-lock-release"), () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok())
      .on("git", (a) => a[0] === "pull", () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "comment", () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "close", () => ok());

    const result = mergeTrainBatch(runner, 6400, batch, prInfos, {
      sessionId: "sess-1",
      kind: "develop",
      commitTitle: "trem(#6300): lote",
      commitBody: "Closes #10, #11",
    });
    assert.equal(result.ok, true);
    assert.equal(runner.calls.filter((c) => c.cmd === "gh" && c.args[1] === "close").length, 2);
    assert.equal(runner.calls.filter((c) => c.cmd === "gh" && c.args[1] === "comment").length, 2);
  });

  it("merge-lock negado: reporta erro, NUNCA tenta o gh pr merge", () => {
    const runner = new FakeTrainRunner();
    runner.on("npx", (a) => a.includes("merge-lock-acquire"), () => fail("denied"));
    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "s", kind: "develop", commitTitle: "t", commitBody: "b" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /negado/);
    assert.ok(!runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "merge"), "não pode tentar merge sem o lock");
  });

  it("lock sempre é liberado, mesmo se gh pr merge falhar (finally)", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("npx", (a) => a.includes("merge-lock-acquire"), () => ok())
      .on("npx", (a) => a.includes("merge-lock-release"), () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => fail("CI mudou de verde pra vermelho entre o poll e o merge"));

    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "s", kind: "develop", commitTitle: "t", commitBody: "b" });
    assert.equal(result.ok, false);
    assert.ok(runner.calls.some((c) => c.cmd === "npx" && c.args.includes("merge-lock-release")), "lock deve ser liberado mesmo em falha");
  });

  it("git pull local falhando NÃO desfaz o merge — reporta ok:true com aviso (merge já é fato consumado no remoto)", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("npx", (a) => a.includes("merge-lock-acquire"), () => ok())
      .on("npx", (a) => a.includes("merge-lock-release"), () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok())
      .on("git", (a) => a[0] === "pull", () => fail("network blip"))
      .on("gh", (a) => a[0] === "pr" && (a[1] === "comment" || a[1] === "close"), () => ok());

    const result = mergeTrainBatch(runner, 6400, batch, prInfos, { sessionId: "s", kind: "develop", commitTitle: "t", commitBody: "b" });
    assert.equal(result.ok, true);
    assert.match(result.error ?? "", /pull local falhou/);
  });
});

describe("mergeSoloPr — piso da bissecção, caminho de hoje sem trem", () => {
  it("caminho feliz: lock → squash merge (sem --subject/--body custom) → pull → release", () => {
    const runner = new FakeTrainRunner();
    runner
      .on("npx", (a) => a.includes("merge-lock-acquire"), () => ok())
      .on("npx", (a) => a.includes("merge-lock-release"), () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok())
      .on("git", (a) => a[0] === "pull", () => ok());

    const result = mergeSoloPr(runner, 100, { sessionId: "s", kind: "develop" });
    assert.equal(result.ok, true);
    const mergeCall = runner.calls.find((c) => c.cmd === "gh" && c.args[1] === "merge");
    assert.ok(mergeCall);
    assert.ok(!mergeCall!.args.includes("--subject"), "merge solo reusa a mensagem do PR, não custom");
  });
});

describe("runMergeTrain — máquina de estados de ponta a ponta", () => {
  function fullRunner(): FakeTrainRunner {
    const runner = new FakeTrainRunner();
    runner
      .on("git", (a) => a[0] === "fetch", () => ok())
      .on("git", (a) => a[0] === "checkout" && a[1] === "-b", () => ok())
      .on("git", (a) => a[0] === "merge" && !a.includes("--abort"), () => ok())
      .on("git", (a) => a[0] === "merge" && a.includes("--abort"), () => ok())
      .on("git", (a) => a[0] === "push" && !a.includes("--delete"), () => ok())
      .on("git", (a) => a[0] === "push" && a.includes("--delete"), () => ok())
      .on("git", (a) => a[0] === "checkout" && a[1] === "master", () => ok())
      .on("git", (a) => a[0] === "branch" && a.includes("-D"), () => ok())
      .on("git", (a) => a[0] === "pull", () => ok())
      .on("npx", (a) => a.includes("merge-lock-acquire"), () => ok())
      .on("npx", (a) => a.includes("merge-lock-release"), () => ok())
      .on("gh", (a) => a[0] === "pr" && (a[1] === "comment" || a[1] === "close"), () => ok());
    return runner;
  }

  const prInfos3: TrainPrInfo[] = [
    makePrInfo({ pr: 100, headRefName: "develop/fix-100", issueNumbers: [10] }),
    makePrInfo({ pr: 101, headRefName: "develop/fix-101", issueNumbers: [11] }),
    makePrInfo({ pr: 102, headRefName: "develop/fix-102", issueNumbers: [12] }),
  ];

  it("caminho feliz: lote de 3, CI verde de primeira, 1 único merge", async () => {
    const runner = fullRunner();
    runner
      .on("gh", (a) => a[0] === "pr" && a[1] === "create", () => ok("https://github.com/x/y/pull/9001\n"))
      .on("gh", (a) => a[0] === "pr" && a[1] === "view", () =>
        ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion: "SUCCESS", status: "COMPLETED" }] })),
      )
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop" });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "merged");
  });

  it("CI vermelho no lote de 3 → bissecta em {2,1} → o de 2 passa, o de 1 vai solo", async () => {
    const runner = fullRunner();
    let createCalls = 0;
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "create", () => {
      createCalls++;
      return ok(`https://github.com/x/y/pull/900${createCalls}\n`);
    });
    // 1º PR-trem (lote de 3) → vermelho; 2º PR-trem (lote de 2, o resto após bissecção) → verde.
    let viewCalls = 0;
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "view", () => {
      viewCalls++;
      const conclusion = viewCalls === 1 ? "FAILURE" : "SUCCESS";
      return ok(JSON.stringify({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", conclusion, status: "COMPLETED" }] }));
    });
    runner.on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100, 101, 102] }, prInfos3, { sessionId: "s", kind: "develop", ciPollIntervalMs: 1 });
    // 1 abandoned (lote original de 3, vermelho) + o resultado dos 2 sub-lotes ({100,101} tamanho 2 -> trem; {102} tamanho 1 -> solo).
    const statuses = outcomes.map((o) => o.status);
    assert.ok(statuses.includes("abandoned"), "lote original vermelho deve aparecer como abandoned");
    assert.ok(statuses.includes("merged") || statuses.includes("solo-merged"), "algum sub-lote deve fechar com sucesso");
  });

  it("conflito de integração bissecta em vez de abortar tudo", async () => {
    const runner = new FakeTrainRunner();
    let mergeAttempt = 0;
    runner
      .on("git", (a) => a[0] === "fetch", () => ok())
      .on("git", (a) => a[0] === "checkout" && a[1] === "-b", () => ok())
      .on("git", (a) => a[0] === "merge" && a.includes("--abort"), () => ok())
      .on("git", (a) => a[0] === "merge" && !a.includes("--abort"), () => {
        mergeAttempt++;
        // 1ª tentativa (lote de 2 PRs, no merge do 2º) conflita; sub-lotes de 1 não chamam merge nenhum (piso solo).
        return mergeAttempt === 2 ? fail("CONFLICT") : ok();
      })
      .on("git", (a) => a[0] === "push" && a.includes("--delete"), () => ok())
      .on("git", (a) => a[0] === "checkout" && a[1] === "master", () => ok())
      .on("git", (a) => a[0] === "branch" && a.includes("-D"), () => ok())
      .on("git", (a) => a[0] === "pull", () => ok())
      .on("npx", (a) => a.includes("merge-lock-acquire"), () => ok())
      .on("npx", (a) => a.includes("merge-lock-release"), () => ok())
      .on("gh", (a) => a[0] === "pr" && (a[1] === "comment" || a[1] === "close"), () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100, 101] }, prInfos3.slice(0, 2), { sessionId: "s", kind: "develop" });
    const statuses = outcomes.map((o) => o.status);
    assert.ok(statuses.includes("abandoned"), "conflito de integração deve virar abandoned + bissecção");
    // Depois da bissecção {100},{101}, ambos são piso (tamanho 1) → merge solo.
    assert.ok(statuses.filter((s) => s === "solo-merged").length === 2);
  });

  it("lote de 1 desde o início vai direto pro merge solo — nunca monta integração/PR-trem", async () => {
    const runner = new FakeTrainRunner();
    runner
      .on("npx", (a) => a.includes("merge-lock-acquire"), () => ok())
      .on("npx", (a) => a.includes("merge-lock-release"), () => ok())
      .on("gh", (a) => a[0] === "pr" && a[1] === "merge", () => ok())
      .on("git", (a) => a[0] === "pull", () => ok());

    const outcomes = await runMergeTrain(runner, { prs: [100] }, [prInfos3[0]], { sessionId: "s", kind: "develop" });
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].status, "solo-merged");
    assert.ok(!runner.calls.some((c) => c.cmd === "gh" && c.args[1] === "create"), "lote de 1 não deve abrir PR-trem nenhum");
  });
});

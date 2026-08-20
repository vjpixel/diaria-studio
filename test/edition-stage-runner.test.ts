/**
 * test/edition-stage-runner.test.ts (#5744)
 *
 * Cobre o laço compartilhado "uma sessão `claude` por stage"
 * (`scripts/lib/edition-stage-runner.ts`), extraído do runner agendado do
 * #5738 para o caminho interativo reusar.
 *
 * O que estes testes protegem, em ordem de importância:
 *   1. O stdout de sucesso NUNCA volta para o chamador — é a premissa
 *      inteira do #5744; se voltar, a sessão do editor recria o contexto
 *      que o laço existe para evitar e o ganho some sem nada quebrar.
 *   2. Nenhum plano pode conter Stage 5/6 — eles spawnariam com
 *      `--no-gates`, e o default do Stage 5 sem `--skip` é dispatchar todos
 *      os canais (#1326).
 *   3. `--no-gates` presente em todo prompt (achado P0 do review do #5739).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STAGE_PLAN,
  HEADLESS_FLAGS,
  runEditionStages,
  assertNoPublishStage,
  summarizeFailure,
  formatStagesSummary,
  FAILURE_TAIL_LINES,
} from "../scripts/lib/edition-stage-runner.ts";
import { planThrough } from "../scripts/run-edition-stages.ts";

const AAMMDD = "260820";

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    aammdd: AAMMDD,
    editionDir: "/fake/data/editions/2608/260820",
    repoRootAbs: "/fake/repo",
    resolveClaudeBin: () => "/fake/bin/claude",
    env: {} as NodeJS.ProcessEnv,
    sentinelExistsFn: () => false,
    nowMs: () => 0,
    ...overrides,
  } as Parameters<typeof runEditionStages>[0];
}

describe("edition-stage-runner — contrato de saída (#5744)", () => {
  it("stdout de sucesso NÃO volta para o chamador", () => {
    const huge = "x".repeat(50_000);
    const execFn = (() => huge) as unknown as typeof import("node:child_process").execFileSync;

    const result = runEditionStages(makeOpts({ execFn }));

    // A premissa inteira do #5744. Se este teste cair, o laço continua
    // "funcionando" e economizando ZERO — a sessão-mãe volta a carregar o
    // conteúdo dos stages, só que por outro caminho.
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(huge), "o stdout do stage vazou no resultado");
    assert.ok(serialized.length < 2000, `resultado grande demais (${serialized.length}) — algo está vazando`);
    assert.ok(result.outcomes.every((o) => o.status === "ok"));
  });

  it("stdout de FALHA volta, mas truncado", () => {
    const noisy = Array.from({ length: 200 }, (_, i) => `linha ${i}`).join("\n");
    const execFn = (() => {
      const err = new Error("boom") as Error & { status?: number; stdout?: string };
      err.status = 4;
      err.stdout = noisy;
      throw err;
    }) as unknown as typeof import("node:child_process").execFileSync;

    const result = runEditionStages(makeOpts({ execFn }));

    assert.equal(result.exitCode, 4);
    const tail = result.outcomes.find((o) => o.status === "failed")?.failureTail ?? "";
    assert.ok(tail.includes("linha 199"), "deveria preservar o fim, que é onde o erro está");
    assert.ok(!tail.includes("linha 0"), "não deveria preservar o começo inteiro");
    assert.equal(tail.split(" | ").length, FAILURE_TAIL_LINES);
  });
});

describe("edition-stage-runner — guard de publicação", () => {
  it("plano com Stage 5 LANÇA, nunca só avisa", () => {
    assert.throws(
      () => assertNoPublishStage([{ stage: 5, skill: "diaria-5-publicacao" }]),
      /publicação|#1326/i,
      "Stage 5 spawnaria com --no-gates e dispatcharia todos os canais",
    );
  });

  it("runEditionStages recusa o plano antes de spawnar qualquer coisa", () => {
    let spawned = 0;
    const execFn = (() => {
      spawned++;
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    assert.throws(() =>
      runEditionStages(
        makeOpts({ execFn, plan: [{ stage: 1, skill: "diaria-1-pesquisa" }, { stage: 6, skill: "diaria-6-agendamento" }] }),
      ),
    );
    // Recusar DEPOIS de rodar o stage 1 seria pior que não recusar: deixaria
    // a edição pela metade com o editor achando que nada aconteceu.
    assert.equal(spawned, 0, "nenhum stage deveria ter spawnado");
  });

  it("STAGE_PLAN em si nunca contém publicação", () => {
    assert.doesNotThrow(() => assertNoPublishStage(STAGE_PLAN));
    assert.ok(STAGE_PLAN.every((p) => p.stage <= 4));
  });

  it("planThrough recusa --through 5 com mensagem legível", () => {
    assert.throws(() => planThrough(5), /--through inválido/);
    assert.throws(() => planThrough(0), /--through inválido/);
    assert.deepEqual(
      planThrough(3).map((p) => p.stage),
      [1, 2, 3],
    );
    assert.deepEqual(
      planThrough(4).map((p) => p.stage),
      [1, 2, 3, 4],
    );
  });
});

describe("edition-stage-runner — laço", () => {
  it("todo prompt carrega --no-gates (achado P0 do review #5739)", () => {
    const prompts: string[] = [];
    const execFn = ((_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    runEditionStages(makeOpts({ execFn }));

    assert.equal(prompts.length, STAGE_PLAN.length);
    for (const p of prompts) assert.ok(p.endsWith(HEADLESS_FLAGS), `prompt sem ${HEADLESS_FLAGS}: ${p}`);
  });

  it("--through 3 spawna só 1-3 — o corte do caminho interativo", () => {
    const prompts: string[] = [];
    const execFn = ((_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    runEditionStages(makeOpts({ execFn, plan: planThrough(3) }));

    assert.deepEqual(prompts, [
      `/diaria-1-pesquisa ${AAMMDD} --no-gates`,
      `/diaria-2-escrita ${AAMMDD} --no-gates`,
      `/diaria-3-imagens ${AAMMDD} --no-gates`,
    ]);
    // O Stage 4 fica de fora porque é onde está o gate humano de revisão —
    // ele roda NA sessão do editor, já com o contexto limpo que os 3 spawns
    // acima preservaram.
    assert.ok(!prompts.some((p) => p.includes("diaria-4-revisao")));
  });

  it("falha interrompe o laço: stages seguintes não spawnam", () => {
    const prompts: string[] = [];
    const execFn = ((_cmd: string, args: string[]) => {
      const prompt = args[args.length - 1];
      prompts.push(prompt);
      if (prompt.includes("diaria-2-escrita")) {
        const err = new Error("falhou") as Error & { status?: number };
        err.status = 9;
        throw err;
      }
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    const result = runEditionStages(makeOpts({ execFn }));

    assert.equal(result.exitCode, 9);
    assert.equal(result.failedStage, 2);
    assert.equal(prompts.length, 2, "stages 3 e 4 não deveriam ter rodado sobre o output ausente do 2");
  });

  it("sentinela presente pula sem spawnar, e o resultado registra o skip", () => {
    const prompts: string[] = [];
    const execFn = ((_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      return "";
    }) as unknown as typeof import("node:child_process").execFileSync;

    const result = runEditionStages(
      makeOpts({ execFn, sentinelExistsFn: (_d: string, step: number) => step <= 2 }),
    );

    assert.deepEqual(prompts, [
      `/diaria-3-imagens ${AAMMDD} --no-gates`,
      `/diaria-4-revisao ${AAMMDD} --no-gates`,
    ]);
    assert.deepEqual(
      result.outcomes.filter((o) => o.status === "skipped").map((o) => o.stage),
      [1, 2],
    );
  });

  it("resolveClaudeBin é chamado DENTRO do try — falha vira resultado, não crash (#5549)", () => {
    const result = runEditionStages(
      makeOpts({
        resolveClaudeBin: () => {
          throw new Error("binário `claude` não encontrado. Defina CLAUDE_BIN");
        },
      }),
    );

    // Resolver fora do try faria isto ser uma exceção não-tratada no
    // chamador, perdendo a mensagem acionável que o #5549 construiu.
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.failedStage, 1);
    assert.match(result.outcomes[0].failureTail ?? "", /CLAUDE_BIN/);
  });
});

describe("edition-stage-runner — resumo", () => {
  it("formatStagesSummary nomeia o stage que falhou e avisa que o resto não rodou", () => {
    const out = formatStagesSummary(
      {
        outcomes: [
          { stage: 1, skill: "diaria-1-pesquisa", status: "ok", exitCode: 0, durationMs: 60_000 },
          { stage: 2, skill: "diaria-2-escrita", status: "failed", exitCode: 3, durationMs: 1000, failureTail: "boom" },
        ],
        exitCode: 3,
        failedStage: 2,
      },
      AAMMDD,
    );
    assert.match(out, /stage 1 .*OK \(60s\)/);
    assert.match(out, /stage 2 .*FALHOU exit=3/);
    assert.match(out, /Interrompido no stage 2/);
  });

  it("summarizeFailure achata e corta", () => {
    assert.equal(summarizeFailure("a\n\n  b  \nc"), "a | b | c");
    assert.equal(summarizeFailure(""), "");
  });
});

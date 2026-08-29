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
  SESSION_SUPERVISED_FLAG,
  runEditionStages,
  collectMcpPermissionFailures,
  assertNoPublishStage,
  summarizeFailure,
  formatStagesSummary,
  FAILURE_TAIL_LINES,
  NO_BACKGROUND_DIRECTIVE,
  BACKGROUND_WAIT_MAX_ATTEMPTS,
} from "../scripts/lib/edition-stage-runner.ts";
import { planThrough, main as cliMain, DEFAULT_THROUGH } from "../scripts/run-edition-stages.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const AAMMDD = "260820";

/**
 * Mundo de sentinelas fake — modela DISCO, não contagem de chamadas (#5744).
 *
 * A primeira versão contava invocações ("1ª = antes de spawnar, 2ª = depois"),
 * e quebrou assim que outro ponto do código passou a consultar o mesmo stage:
 * a contagem saía do compasso e todo stage era pulado. Modelar o estado — um
 * conjunto de concluídos que o spawn ATUALIZA — é fiel ao real e imune à
 * ordem/número de consultas.
 *
 * `neverCompletes`: stages cujo processo sai 0 sem escrever sentinela — o
 * cenário do `--max-turns` esgotado, que a pós-condição existe para pegar.
 */
function sentinelWorld(doneUpTo = 0, neverCompletes: number[] = []) {
  const done = new Set<number>();
  for (let i = 1; i <= doneUpTo; i++) done.add(i);
  return {
    assertFn: (_dir: string, step: number) =>
      done.has(step)
        ? { ok: true as const }
        : { ok: false as const, reason: "sentinel_missing" as const },
    complete: (step: number) => {
      if (!neverCompletes.includes(step)) done.add(step);
    },
  };
}

function spawnInto(
  world: ReturnType<typeof sentinelWorld>,
  prompts: string[],
  failOn?: { stage: string; code: number },
  stdout = "",
) {
  return ((_cmd: string, args: string[]) => {
    const prompt = args[args.length - 1];
    prompts.push(prompt);
    if (failOn && prompt.includes(failOn.stage)) {
      const e = new Error("falhou") as Error & { status?: number };
      e.status = failOn.code;
      throw e;
    }
    const m = prompt.match(/diaria-(\d)-/);
    if (m) world.complete(Number(m[1]));
    return stdout;
  }) as unknown as typeof import("node:child_process").execFileSync;
}

let W = sentinelWorld();

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    aammdd: AAMMDD,
    editionDir: "/fake/data/editions/2608/260820",
    repoRootAbs: "/fake/repo",
    resolveClaudeBin: () => "/fake/bin/claude",
    env: {} as NodeJS.ProcessEnv,
    assertSentinelFn: W.assertFn,
    nowMs: () => 0,
    ...overrides,
  } as Parameters<typeof runEditionStages>[0];
}

describe("edition-stage-runner — contrato de saída (#5744)", () => {
  it("stdout de sucesso NÃO volta para o chamador", () => {
    W = sentinelWorld(0);
    const huge = "x".repeat(50_000);
    const execFn = spawnInto(W, [], undefined, huge);

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
    W = sentinelWorld(0);
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
    W = sentinelWorld(0);
    assert.throws(
      () => assertNoPublishStage([{ stage: 5, skill: "diaria-5-publicacao" }]),
      /publicação|#1326/i,
      "Stage 5 spawnaria com --no-gates e dispatcharia todos os canais",
    );
  });

  it("runEditionStages recusa o plano antes de spawnar qualquer coisa", () => {
    W = sentinelWorld(0);
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
    W = sentinelWorld(0);
    assert.doesNotThrow(() => assertNoPublishStage(STAGE_PLAN));
    assert.ok(STAGE_PLAN.every((p) => p.stage <= 4));
  });

  it("planThrough recusa --through 5 com mensagem legível", () => {
    W = sentinelWorld(0);
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
    W = sentinelWorld(0);
    const prompts: string[] = [];
    const execFn = spawnInto(W, prompts);

    runEditionStages(makeOpts({ execFn }));

    assert.equal(prompts.length, STAGE_PLAN.length);
    for (const p of prompts) assert.ok(p.includes(HEADLESS_FLAGS), `prompt sem ${HEADLESS_FLAGS}: ${p}`);
  });

  it("--through 3 spawna só 1-3 — o corte do caminho interativo", () => {
    W = sentinelWorld(0);
    const prompts: string[] = [];
    const execFn = spawnInto(W, prompts);

    runEditionStages(makeOpts({ execFn, plan: planThrough(3) }));

    assert.deepEqual(prompts, [
      `/diaria-1-pesquisa ${AAMMDD} --no-gates ${NO_BACKGROUND_DIRECTIVE}`,
      `/diaria-2-escrita ${AAMMDD} --no-gates ${NO_BACKGROUND_DIRECTIVE}`,
      `/diaria-3-imagens ${AAMMDD} --no-gates ${NO_BACKGROUND_DIRECTIVE}`,
    ]);
    // O Stage 4 fica de fora porque é onde está o gate humano de revisão —
    // ele roda NA sessão do editor, já com o contexto limpo que os 3 spawns
    // acima preservaram.
    assert.ok(!prompts.some((p) => p.includes("diaria-4-revisao")));
  });

  describe("#6719: sessionSupervised — pre_gate chega ao Stage 1 spawnado", () => {
    it("sessionSupervised default (false) NÃO anexa a flag a nenhum stage — comportamento pré-existente preservado", () => {
      W = sentinelWorld(0);
      const prompts: string[] = [];
      const execFn = spawnInto(W, prompts);

      runEditionStages(makeOpts({ execFn, plan: planThrough(4) }));

      for (const p of prompts) assert.ok(!p.includes(SESSION_SUPERVISED_FLAG), `flag vazou sem sessionSupervised: ${p}`);
    });

    it("sessionSupervised=true anexa a flag SÓ ao prompt do Stage 1 — é o único playbook que lê pre_gate", () => {
      W = sentinelWorld(0);
      const prompts: string[] = [];
      const execFn = spawnInto(W, prompts);

      runEditionStages(makeOpts({ execFn, plan: planThrough(4), sessionSupervised: true }));

      assert.equal(prompts.length, 4);
      assert.ok(
        prompts[0].startsWith(`/diaria-1-pesquisa ${AAMMDD} ${HEADLESS_FLAGS} ${SESSION_SUPERVISED_FLAG} `),
        `Stage 1 deveria carregar ${SESSION_SUPERVISED_FLAG}: ${prompts[0]}`,
      );
      for (const p of prompts.slice(1)) {
        assert.ok(!p.includes(SESSION_SUPERVISED_FLAG), `stage 2-4 não deveria carregar a flag: ${p}`);
      }
      // --no-gates continua presente em TODO prompt — a flag nova é aditiva,
      // nunca substitui o guard existente do #5739.
      for (const p of prompts) assert.ok(p.includes(HEADLESS_FLAGS));
    });
  });

  it("#6045: todo prompt carrega a diretiva anti-background (sessão single-turn)", () => {
    W = sentinelWorld(0);
    const prompts: string[] = [];
    const execFn = spawnInto(W, prompts);

    runEditionStages(makeOpts({ execFn }));

    assert.ok(prompts.length > 0);
    for (const p of prompts) {
      assert.match(p, /single-turn/);
      assert.match(p, /run_in_background/);
    }
  });

  it("#6045: saída com sintoma background-wait e sentinela ausente -> 1 retry antes de falhar", () => {
    W = sentinelWorld(0); // stage 1 só completa no retry
    const prompts: string[] = [];
    const bgStdout =
      "I'll wait for the background task notification (stage-1-run.ts pre-research) before continuing.";
    const execFn = ((_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      const m = args[args.length - 1].match(/diaria-(\d)-/);
      if (m && prompts.filter((p) => p.includes("diaria-1-")).length > 1) W.complete(Number(m[1])); // só o retry completa
      return bgStdout;
    }) as unknown as typeof import("node:child_process").execFileSync;

    const result = runEditionStages(makeOpts({ execFn }));

    assert.equal(result.exitCode, 0, "retry completou o stage — não é falha");
    assert.equal(result.failedStage, null);
    assert.equal(
      prompts.filter((p) => p.includes("diaria-1-")).length,
      2,
      "exatamente 1 tentativa original + 1 retry do stage 1",
    );
    assert.ok(result.outcomes.find((o) => o.stage === 1 && o.status === "ok"));
  });

  it("#6045: sintoma background-wait persistente -> falha só após esgotar as tentativas", () => {
    W = sentinelWorld(0, [1]);
    const prompts: string[] = [];
    const bgStdout = "Running in background, waiting for it to finish.";
    const execFn = ((_cmd: string, args: string[]) => {
      prompts.push(args[args.length - 1]);
      return bgStdout;
    }) as unknown as typeof import("node:child_process").execFileSync;

    const result = runEditionStages(makeOpts({ execFn }));

    assert.notEqual(result.exitCode, 0);
    assert.equal(result.failedStage, 1);
    assert.equal(prompts.length, BACKGROUND_WAIT_MAX_ATTEMPTS, "1 original + retries do teto, nada além");
    assert.equal(result.outcomes.length, 1, "stages seguintes não rodam sobre output ausente");
    assert.match(result.outcomes[0].failureTail ?? "", /background|não completou/i);
  });

  it("falha interrompe o laço: stages seguintes não spawnam", () => {
    W = sentinelWorld(0);
    const prompts: string[] = [];
    const execFn = spawnInto(W, prompts, { stage: "diaria-2-escrita", code: 9 });

    const result = runEditionStages(makeOpts({ execFn }));

    assert.equal(result.exitCode, 9);
    assert.equal(result.failedStage, 2);
    assert.equal(prompts.length, 2, "stages 3 e 4 não deveriam ter rodado sobre o output ausente do 2");
  });

  it("stage sai 0 SEM escrever sentinela -> FALHA, nunca 'ok' (o buraco do --max-turns)", () => {
    W = sentinelWorld(0, [2]); // stage 2 "roda", sai 0, e não completa nada
    const prompts: string[] = [];
    const execFn = spawnInto(W, prompts);

    const result = runEditionStages(makeOpts({ execFn }));

    // Este é o pior desfecho possível do mecanismo, e o motivo de a
    // pós-condição existir: `execFileSync` só lança quando o filho sai != 0,
    // e uma sessão que esgota `--max-turns 120` no meio do trabalho pode sair
    // 0. Sem esta checagem o laço marcaria "ok", seguiria para o Stage 3, e o
    // editor chegaria ao gate de revisão sobre uma edição incompleta — sem
    // nada em lugar nenhum indicando que faltou trabalho.
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.failedStage, 2);
    const failed = result.outcomes.find((o) => o.status === "failed");
    assert.match(failed?.failureTail ?? "", /saiu com código 0 mas não completou/);
    assert.equal(prompts.length, 2, "o stage 3 não pode rodar sobre o trabalho ausente do 2");
  });

  it("stage sai 0 sem sentinela: as últimas linhas do stdout do filho aparecem no failureTail (#5791)", () => {
    W = sentinelWorld(0, [1]); // stage 1 "roda", sai 0, e não completa nada
    const stdoutFromChild = Array.from({ length: 100 }, (_, i) => `log linha ${i}`).join("\n") + "\ntail-marker-final";
    const execFn = spawnInto(W, [], undefined, stdoutFromChild);

    const result = runEditionStages(makeOpts({ execFn }));

    const failed = result.outcomes.find((o) => o.status === "failed");
    // Antes do #5791 este branch não tinha NENHUMA visibilidade do que o
    // processo filho escreveu — só "sentinela não foi escrita". A captura
    // não é opcional: sem ela, a próxima ocorrência do achado 260821
    // (exit 0 em 62s sem output, vs ~13min rodando manualmente) fica sem
    // nenhum sinal pra diagnosticar.
    assert.match(failed?.failureTail ?? "", /saiu com código 0 mas não completou/);
    assert.match(failed?.failureTail ?? "", /tail-marker-final/, "deveria incluir o fim do stdout capturado");
    assert.doesNotMatch(failed?.failureTail ?? "", /log linha 0\b/, "só as últimas linhas, não o log inteiro");
  });

  it("stage sai 0 sem sentinela e SEM nenhum stdout: failureTail não fica em branco (#5791)", () => {
    W = sentinelWorld(0, [1]);
    const execFn = spawnInto(W, [], undefined, "");

    const result = runEditionStages(makeOpts({ execFn }));

    const failed = result.outcomes.find((o) => o.status === "failed");
    assert.match(failed?.failureTail ?? "", /sem stdout/, "ausência de captura deve ser explícita, não um buraco silencioso");
  });

  it("sentinela órfã (output apagado) NÃO conta como stage concluído", () => {
    const prompts: string[] = [];
    // `assertSentinel` distingue "arquivo existe" de "existe e os outputs
    // declarados continuam em disco". Com a versão fraca (`sentinelExists`),
    // uma sentinela cujo output foi apagado — edição manual do editor, debug —
    // faria o stage ser pulado e o pipeline seguir sobre conteúdo ausente.
    const orphan = {
      assertFn: (_d: string, step: number) =>
        step === 1
          ? { ok: false as const, reason: "outputs_missing" as const, missingOutputs: ["01-categorized.md"] }
          : { ok: true as const },
      complete: () => {},
    };
    runEditionStages(makeOpts({ execFn: spawnInto(orphan as never, prompts), assertSentinelFn: orphan.assertFn }));

    assert.ok(
      prompts.some((p) => p.includes("diaria-1-pesquisa")),
      "stage com output ausente precisa rodar de novo, não ser pulado",
    );
  });

  it("sentinela presente pula sem spawnar, e o resultado registra o skip", () => {
    W = sentinelWorld(2);
    const prompts: string[] = [];
    const execFn = spawnInto(W, prompts);

    const result = runEditionStages(
      makeOpts({ execFn, assertSentinelFn: W.assertFn }),
    );

    assert.deepEqual(prompts, [
      `/diaria-3-imagens ${AAMMDD} --no-gates ${NO_BACKGROUND_DIRECTIVE}`,
      `/diaria-4-revisao ${AAMMDD} --no-gates ${NO_BACKGROUND_DIRECTIVE}`,
    ]);
    assert.deepEqual(
      result.outcomes.filter((o) => o.status === "skipped").map((o) => o.stage),
      [1, 2],
    );
  });

  it("resolveClaudeBin é chamado DENTRO do try — falha vira resultado, não crash (#5549)", () => {
    W = sentinelWorld(0);
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
    W = sentinelWorld(0);
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
    W = sentinelWorld(0);
    assert.equal(summarizeFailure("a\n\n  b  \nc"), "a | b | c");
    assert.match(summarizeFailure(""), /sem stdout/);
  });
});

describe("run-edition-stages CLI — main() (#5744, gap apontado no review da PR #5753)", () => {
  function makeDeps(over: Record<string, unknown> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const prompts: string[] = [];
    const deps = {
      execFn: spawnInto(W, prompts),
      resolveClaudeBinFn: () => "/fake/bin/claude",
      assertSentinelFn: W.assertFn,
      env: { SAFE: "1" } as NodeJS.ProcessEnv,
      stdout: (l: string) => out.push(l),
      stderr: (l: string) => err.push(l),
      repoRootAbs: "/fake/repo",
      ...over,
    };
    return { deps, out, err, prompts };
  }

  it("--edition ausente ou malformado -> exit 2 com mensagem de uso, sem spawnar", () => {
    W = sentinelWorld(0);
    for (const argv of [[], ["--edition", "26082"], ["--edition", "abcdef"]]) {
      const { deps, err, prompts } = makeDeps();
      const code = cliMain(argv, deps);
      assert.equal(code, 2, `argv ${JSON.stringify(argv)} deveria falhar`);
      assert.match(err.join("\n"), /Uso: npx tsx scripts\/run-edition-stages\.ts/);
      assert.equal(prompts.length, 0, "não deveria spawnar com edição inválida");
    }
  });

  it("--through 5 -> exit 2 com a mensagem legível, sem spawnar (fim a fim)", () => {
    W = sentinelWorld(0);
    const { deps, err, prompts } = makeDeps();
    const code = cliMain(["--edition", "260820", "--through", "5"], deps);
    // A função pura já era testada; o que faltava era o CAMINHO REAL — o
    // editor digitando --through 5 por engano precisa ver a mensagem e não
    // um stack trace, e nenhum stage pode ter rodado antes da recusa.
    assert.equal(code, 2);
    assert.match(err.join("\n"), /--through inválido/);
    assert.equal(prompts.length, 0);
  });

  it("default sem --through PARA no Stage 3 — nunca auto-aprova o gate de revisão", () => {
    W = sentinelWorld(0);
    const a = makeDeps();
    cliMain(["--edition", "260820"], a.deps);

    // Achado do review da PR #5753: o default era 4, e como todo stage
    // spawnado recebe `--no-gates`, um comando incompleto (debug, uso ad hoc)
    // auto-aprovava em silêncio o gate humano de revisão — um dos dois gates
    // de projeto. O default seguro é parar antes dele.
    assert.equal(a.prompts.length, DEFAULT_THROUGH);
    assert.ok(
      !a.prompts.some((p) => p.includes("diaria-4-revisao")),
      "o default jamais pode spawnar o Stage 4 headless",
    );

    W = sentinelWorld(0); // mundo novo: o bloco acima já concluiu 1-3
    const b = makeDeps();
    cliMain(["--edition", "260820", "--through", "3"], b.deps);
    assert.deepEqual(
      b.prompts.map((p) => p.split(" ")[0]),
      ["/diaria-1-pesquisa", "/diaria-2-escrita", "/diaria-3-imagens"],
    );
  });

  it("--through 4 é possível, mas só por escrito", () => {
    W = sentinelWorld(0);
    const { deps, prompts } = makeDeps();
    cliMain(["--edition", "260820", "--through", "4"], deps);
    assert.equal(prompts.length, 4);
    assert.ok(prompts[3].includes("diaria-4-revisao"));
  });

  it("progresso vai pro stderr; stdout carrega SÓ o resumo", () => {
    W = sentinelWorld(0);
    const { deps, out, err } = makeDeps();
    cliMain(["--edition", "260820", "--through", "3"], deps);

    // O split não é cosmético: é o que permite a sessão do editor ler um
    // resumo curto em vez do rastro de execução dos 3 stages.
    assert.equal(out.length, 1, "stdout deveria ter exatamente o resumo");
    assert.match(out[0], /Edição 260820/);
    assert.ok(err.some((l) => l.includes("Stage 1")), "progresso deveria estar no stderr");
    assert.ok(!out[0].includes("claude -p"), "stdout não deveria conter linhas de progresso");
  });

  it("--json troca o resumo por JSON, e o JSON também não carrega stdout de stage", () => {
    W = sentinelWorld(0);
    const huge = "y".repeat(40_000);
    const { deps, out } = makeDeps({ execFn: spawnInto(W, [], undefined, huge) });
    cliMain(["--edition", "260820", "--through", "3", "--json"], deps);

    assert.equal(out.length, 1);
    const parsed = JSON.parse(out[0]);
    assert.equal(parsed.exitCode, 0);
    assert.ok(!out[0].includes(huge), "--json não pode virar a porta dos fundos do vazamento de contexto");
  });

  it("falha de stage propaga o exit code do stage pro exit code do CLI", () => {
    W = sentinelWorld(0);
    const { deps } = makeDeps({ execFn: spawnInto(W, [], { stage: "diaria-2-escrita", code: 6 }) });
    assert.equal(cliMain(["--edition", "260820", "--through", "3"], deps), 6);
  });

  it("#6719: --session-supervised chega até o prompt do Stage 1 quando passado; ausente por default", () => {
    W = sentinelWorld(0);
    const supervised = makeDeps();
    cliMain(["--edition", "260820", "--through", "3", "--session-supervised"], supervised.deps);
    assert.ok(
      supervised.prompts[0].includes(SESSION_SUPERVISED_FLAG),
      "sem --session-supervised no argv, o Stage 1 spawnado nunca recebe pre_gate=true — §0-replies (#6719) ficaria sempre pulado mesmo com o editor presente",
    );

    W = sentinelWorld(0);
    const unsupervised = makeDeps();
    cliMain(["--edition", "260820", "--through", "3"], unsupervised.deps);
    assert.ok(
      !unsupervised.prompts.some((p) => p.includes(SESSION_SUPERVISED_FLAG)),
      "sem a flag no argv, nenhum prompt deveria carregá-la — comportamento desassistido (runner agendado) preservado",
    );
  });
});

describe("wiring da skill /diaria-edicao (#5744)", () => {
  it("SKILL.md cita o script, e o script citado existe de fato", () => {
    const skill = readFileSync(
      join(import.meta.dirname, "..", ".claude", "skills", "diaria-edicao", "SKILL.md"),
      "utf8",
    );
    const cited = skill.match(/npx tsx (scripts\/run-edition-stages\.ts)/);
    assert.ok(cited, "Passo 2 da skill precisa invocar run-edition-stages.ts");
    // Sem esta segunda metade o teste seria decorativo: o valor está em
    // pegar o dia em que o script for renomeado/movido e a skill continuar
    // mandando a sessão rodar um path que não existe — falha que só
    // apareceria no meio de uma edição real.
    assert.ok(
      existsSync(join(import.meta.dirname, "..", cited[1])),
      `SKILL.md cita ${cited[1]}, que não existe no repo`,
    );
    assert.match(skill, /--through 3/, "a skill deve parar no Stage 3; 4-6 ficam no top-level");
    assert.ok(
      !/--through\s*[456]/.test(skill),
      "a skill nunca pode mandar spawnar Stage 4+ headless — são os gates humanos",
    );
  });

  it("#6719: SKILL.md instrui repassar --session-supervised quando o editor não passou --no-gates", () => {
    const skill = readFileSync(
      join(import.meta.dirname, "..", ".claude", "skills", "diaria-edicao", "SKILL.md"),
      "utf8",
    );
    assert.match(
      skill,
      /--session-supervised/,
      "sem esta instrução, §0-replies (#6719) fica pulado mesmo em invocação totalmente interativa",
    );
  });
});

// ── #6088: MCP permission_not_granted_noninteractive deixa de ser silencioso ──
describe("edition-stage-runner — #6088: mcpPermissionWarnings", () => {
  const MCP_LINE_GMAIL =
    '{"timestamp":"2026-08-25T14:54:50.000Z","edition":"260825","stage":0,"agent":"orchestrator","level":"warn",' +
    '"message":"mcp_disconnect: claude_ai_Gmail","details":{"server":"claude_ai_Gmail","kind":"mcp_disconnect",' +
    '"reason":"permission_not_granted_noninteractive"}}';
  const MCP_LINE_BEEHIIV = MCP_LINE_GMAIL.replaceAll("claude_ai_Gmail", "claude_ai_Beehiiv");

  it("collectMcpPermissionFailures(): extrai servidores dedup do sintoma exato", () => {
    const servers = collectMcpPermissionFailures([
      MCP_LINE_GMAIL,
      MCP_LINE_BEEHIIV,
      MCP_LINE_GMAIL, // duplicata — dedup
      '{"message":"mcp_disconnect: outro","details":{"server":"X","reason":"not_connected_in_session"}}', // outro reason
      "linha não-JSON",
      "",
    ]);
    assert.deepEqual(servers.sort(), ["claude_ai_Beehiiv", "claude_ai_Gmail"]);
  });

  it("collectMcpPermissionFailures(): nada compatível → vazio", () => {
    assert.deepEqual(collectMcpPermissionFailures([]), []);
    assert.deepEqual(collectMcpPermissionFailures(['{"message":"qualquer coisa"}']), []);
  });

  it("formatStagesSummary(): warnings aparecem como banner ⚠ explícito", () => {
    const summary = formatStagesSummary(
      {
        outcomes: [{ stage: 1, skill: "diaria-1-pesquisa", status: "ok", exitCode: 0, durationMs: 1000 }],
        exitCode: 0,
        failedStage: null,
        mcpPermissionWarnings: ["claude_ai_Gmail"],
      },
      AAMMDD,
    );
    assert.match(summary, /#6088/);
    assert.match(summary, /claude_ai_Gmail/);
    assert.match(summary, /PULADAS/);
  });

  it("runEditionStages(): mcp_disconnect novo no run-log durante a execução vira warning", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpRepo = mkdtempSync(join(tmpdir(), "6088-"));
    const { mkdirSync, writeFileSync, appendFileSync, rmSync } = await import("node:fs");
    mkdirSync(join(tmpRepo, "data"), { recursive: true });
    writeFileSync(join(tmpRepo, "data", "run-log.jsonl"), "linha-preexistente\n");

    const world = sentinelWorld(0);
    const progress: string[] = [];
    // O spawn "completa" o stage e o playbook da sub-sessão loga o
    // mcp_disconnect no run-log — é exatamente o que aconteceu na 260825.
    const result = runEditionStages({
      aammdd: AAMMDD,
      editionDir: join(tmpRepo, "editions", AAMMDD),
      repoRootAbs: tmpRepo,
      resolveClaudeBin: () => "echo",
      env: {},
      plan: STAGE_PLAN.slice(0, 1),
      execFn: ((_cmd: string, _args: string[]) => {
        appendFileSync(join(tmpRepo, "data", "run-log.jsonl"), MCP_LINE_GMAIL + "\n");
        world.complete(1);
        return "";
      }) as unknown as typeof import("node:child_process").execFileSync,
      assertSentinelFn: world.assertFn,
      onProgress: (m) => progress.push(m),
    });

    assert.equal(result.exitCode, 0, "fail-soft preservado: warning nunca muda o veredito do stage");
    assert.deepEqual(result.mcpPermissionWarnings, ["claude_ai_Gmail"]);
    assert.ok(progress.some((m) => m.includes("#6088") && m.includes("claude_ai_Gmail")));
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  it("runEditionStages(): mcp_disconnect PREEXISTENTE no run-log NÃO gera warning", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpRepo = mkdtempSync(join(tmpdir(), "6088b-"));
    const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    mkdirSync(join(tmpRepo, "data"), { recursive: true });
    writeFileSync(join(tmpRepo, "data", "run-log.jsonl"), MCP_LINE_GMAIL + "\n"); // de ontem

    const world = sentinelWorld(0);
    const result = runEditionStages({
      aammdd: AAMMDD,
      editionDir: join(tmpRepo, "editions", AAMMDD),
      repoRootAbs: tmpRepo,
      resolveClaudeBin: () => "echo",
      env: {},
      plan: STAGE_PLAN.slice(0, 1),
      execFn: ((_cmd: string, _args: string[]) => {
        world.complete(1);
        return "";
      }) as unknown as typeof import("node:child_process").execFileSync,
      assertSentinelFn: world.assertFn,
    });

    assert.deepEqual(result.mcpPermissionWarnings, []);
    rmSync(tmpRepo, { recursive: true, force: true });
  });
});

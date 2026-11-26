/**
 * test/stage-3-run.test.ts (#5415, incremento 2/3)
 *
 * Cobre `scripts/stage-3-run.ts` — o orquestrador determinístico do MIOLO
 * de §3b do Stage 3 (Imagens) do orchestrator diar.ia.br. Mesmo padrão de
 * `test/stage-0-run.test.ts`: `exec`/`checkComfyUi` são fakes injetados
 * (nenhum spawn real, nenhuma rede real, nenhum `data/` real tocado) — os
 * testes verificam RESULTADO (exit code, shape do JSON) e a SEQUÊNCIA/ARGS
 * dos passos que importam.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import {
  runStage3,
  parseStage3RunArgs,
  readDestaqueCountFromDisk,
  parseStepJson,
  Stage3Abort,
  runWithConcurrency,
  realExecAsync,
  killChildTree,
  shouldRetrySerially,
  retryArgs,
  DEFAULT_IMAGE_CONCURRENCY,
  type Stage3RunDeps,
  type ExecFn,
  type AsyncExecFn,
  type StepResult,
} from "../scripts/stage-3-run.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(stdout = "{}"): StepResult {
  return { code: 0, stdout, stderr: "" };
}
function fail(code = 1, stderr = "erro"): StepResult {
  return { code, stdout: "", stderr };
}

/** Fake exec dispatcher — casa pelo NOME DO ARQUIVO (basename) do script,
 * não pelo path relativo inteiro. Handlers ausentes caem no default
 * (sucesso, `{}`). */
function makeFakeExec(handlers: Record<string, (args: string[]) => StepResult> = {}) {
  const calls: Array<{ script: string; args: string[] }> = [];
  const exec: ExecFn = (script, args) => {
    calls.push({ script, args });
    const base = script.split("/").pop() ?? script;
    const handler = handlers[base];
    return handler ? handler(args) : ok("{}");
  };
  return { exec, calls };
}

/** Handlers "felizes" mínimos pra um run completo bem-sucedido de 3
 * destaques — cada teste sobrepõe só o que precisa mudar. */
function happyHandlers(overrides: Record<string, (args: string[]) => StepResult> = {}): Record<string, (args: string[]) => StepResult> {
  return {
    "find-current-edition.ts": () => ({ code: 0, stdout: "data/editions/2604/260423\n", stderr: "" }),
    "pipeline-sentinel.ts": () => ok("{}"),
    "lint-image-prompt.ts": () => ok(JSON.stringify({ ok: true, issues: [], triggers: [] })),
    "image-generate.ts": () => ok(JSON.stringify({ ok: true })),
    "gen-social-card-4x5.ts": () => ok(JSON.stringify({ ok: true })),
    "fetch-leaderboard-top1.ts": () => ok(JSON.stringify({ top1: [] })),
    "inject-champions-callout.ts": () => ({ code: 0, stdout: "[inject-champions-callout] edição não é a 1ª do mês — no-op.\n", stderr: "" }),
    "check-invariants.ts": () => ok(JSON.stringify({ passed: true, violations: [] })),
    "run-image-crop-reviewer.ts": () => fail(1, "nenhum par encontrado"),
    "log-event.ts": () => ok("{}"),
    "render-halt-banner.ts": () => ok(""),
    ...overrides,
  };
}

function baseDeps(overrides: Partial<Stage3RunDeps> = {}): Stage3RunDeps {
  const { exec } = makeFakeExec();
  return {
    rootDir: "/fake-root",
    exec,
    existsSync: () => true, // prompts presentes por default
    readFile: (p) => {
      if (p.endsWith("platform.config.json")) return JSON.stringify({ image_generator: "gemini" });
      if (p.endsWith("01-approved-capped.json")) return JSON.stringify({ highlights: [1, 2, 3] });
      throw new Error(`readFile não mockado: ${p}`);
    },
    checkComfyUi: () => true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseStepJson (só sanity — a implementação é idêntica ao stage-0-run.ts)
// ---------------------------------------------------------------------------

describe("parseStepJson", () => {
  it("parseia JSON puro", () => {
    assert.deepEqual(parseStepJson('{"a":1}'), { a: 1 });
  });
  it("stdout vazio -> undefined", () => {
    assert.equal(parseStepJson(""), undefined);
  });
});

// ---------------------------------------------------------------------------
// parseStage3RunArgs
// ---------------------------------------------------------------------------

describe("parseStage3RunArgs", () => {
  it("--edition obrigatório", () => {
    assert.throws(() => parseStage3RunArgs([]), Stage3Abort);
  });

  it("--edition mal formado -> Stage3Abort", () => {
    assert.throws(() => parseStage3RunArgs(["--edition", "abc"]), Stage3Abort);
  });

  it("parseia --edition válido, sem --only nem --force", () => {
    const o = parseStage3RunArgs(["--edition", "260423"]);
    assert.equal(o.edition, "260423");
    assert.equal(o.only, undefined);
    assert.equal(o.force, false);
  });

  it("parseia --only d1,d2", () => {
    const o = parseStage3RunArgs(["--edition", "260423", "--only", "d1,d2"]);
    assert.deepEqual(o.only, ["d1", "d2"]);
  });

  it("--only com valor inválido -> Stage3Abort", () => {
    assert.throws(() => parseStage3RunArgs(["--edition", "260423", "--only", "d1,d9"]), Stage3Abort);
  });

  it("--force vira flag booleana", () => {
    const o = parseStage3RunArgs(["--edition", "260423", "--force"]);
    assert.equal(o.force, true);
  });
});

// ---------------------------------------------------------------------------
// readDestaqueCountFromDisk
// ---------------------------------------------------------------------------

describe("readDestaqueCountFromDisk", () => {
  it("arquivo ausente -> default 3", () => {
    const deps = baseDeps({ existsSync: () => false });
    assert.equal(readDestaqueCountFromDisk(deps, "data/editions/2604/260423"), 3);
  });

  it("2 highlights -> 2", () => {
    const deps = baseDeps({ readFile: () => JSON.stringify({ highlights: [1, 2] }) });
    assert.equal(readDestaqueCountFromDisk(deps, "data/editions/2604/260423"), 2);
  });

  it("3 highlights -> 3", () => {
    const deps = baseDeps({ readFile: () => JSON.stringify({ highlights: [1, 2, 3] }) });
    assert.equal(readDestaqueCountFromDisk(deps, "data/editions/2604/260423"), 3);
  });

  it("JSON malformado -> default 3, nunca lança", () => {
    const deps = baseDeps({ readFile: () => "{not json" });
    assert.equal(readDestaqueCountFromDisk(deps, "data/editions/2604/260423"), 3);
  });

  it("highlights fora do intervalo -> default 3", () => {
    const deps = baseDeps({ readFile: () => JSON.stringify({ highlights: [1] }) });
    assert.equal(readDestaqueCountFromDisk(deps, "data/editions/2604/260423"), 3);
  });
});

// ---------------------------------------------------------------------------
// runStage3 — caminho feliz
// ---------------------------------------------------------------------------

describe("runStage3 — caminho feliz", () => {
  it("3 destaques: lint + 2x1 + 4x5 por destaque, card, leaderboard, champions no-op, invariants ok", async () => {
    const { exec, calls } = makeFakeExec(happyHandlers());
    const deps = baseDeps({ exec });
    const result = await runStage3(["--edition", "260423"], deps);

    assert.equal(result.code, 0);
    assert.equal(result.editionDir, "data/editions/2604/260423");
    assert.equal(result.destaqueCount, 3);
    assert.equal(result.destaques.length, 3);
    for (const d of result.destaques) {
      assert.equal(d.lintOk, true);
      assert.equal(d.imageGenerated, true);
      assert.equal(d.nativeArt4x5Generated, true);
    }
    assert.equal(result.cardsGenerated, true);
    assert.equal(result.carouselCardsGenerated, true);
    assert.equal(result.leaderboardFetched, true);
    assert.equal(result.championsInjected, "noop");
    assert.equal(result.invariantsPassed, true);
    assert.equal(result.cropReviewPairs, undefined);
    assert.equal(result.pendingAgentDispatch.length, 0);
    assert.equal(result.haltRequired, undefined);

    // image-generate.ts chamado 2x por destaque (2x1 default + 4x5) = 6 vezes.
    const genCalls = calls.filter((c) => c.script.endsWith("image-generate.ts"));
    assert.equal(genCalls.length, 6);
    const ratio4x5Calls = genCalls.filter((c) => c.args.includes("--ratio"));
    assert.equal(ratio4x5Calls.length, 3);
  });

  it("2 destaques (destaque_count=2): d3 nunca processado", async () => {
    const { exec, calls } = makeFakeExec(happyHandlers());
    const deps = baseDeps({
      exec,
      readFile: (p) => {
        if (p.endsWith("platform.config.json")) return JSON.stringify({ image_generator: "gemini" });
        if (p.endsWith("01-approved-capped.json")) return JSON.stringify({ highlights: [1, 2] });
        throw new Error(`readFile não mockado: ${p}`);
      },
    });
    const result = await runStage3(["--edition", "260423"], deps);

    assert.equal(result.code, 0);
    assert.equal(result.destaqueCount, 2);
    assert.deepEqual(
      result.destaques.map((d) => d.destaque),
      ["d1", "d2"],
    );
    const genCalls = calls.filter((c) => c.script.endsWith("image-generate.ts") && c.args.includes("--destaque") && c.args[c.args.indexOf("--destaque") + 1] === "d3");
    assert.equal(genCalls.length, 0);
  });

  it("--only d1 restringe o processamento a d1", async () => {
    const { exec } = makeFakeExec(happyHandlers());
    const deps = baseDeps({ exec });
    const result = await runStage3(["--edition", "260423", "--only", "d1"], deps);
    assert.equal(result.code, 0);
    assert.deepEqual(
      result.destaques.map((d) => d.destaque),
      ["d1"],
    );
  });

  it("--only d3 com destaque_count=2 é ignorado (nota registrada, lista vazia)", async () => {
    const { exec } = makeFakeExec(happyHandlers());
    const deps = baseDeps({
      exec,
      readFile: (p) => {
        if (p.endsWith("platform.config.json")) return JSON.stringify({ image_generator: "gemini" });
        if (p.endsWith("01-approved-capped.json")) return JSON.stringify({ highlights: [1, 2] });
        throw new Error(`readFile não mockado: ${p}`);
      },
    });
    const result = await runStage3(["--edition", "260423", "--only", "d3"], deps);
    assert.equal(result.code, 0);
    assert.equal(result.destaques.length, 0);
    assert.ok(result.notes.some((n) => n.includes("--only incluiu d3")));
  });

  it("--force propaga pra image-generate.ts", async () => {
    const { exec, calls } = makeFakeExec(happyHandlers());
    const deps = baseDeps({ exec });
    await runStage3(["--edition", "260423", "--only", "d1", "--force"], deps);
    const genCalls = calls.filter((c) => c.script.endsWith("image-generate.ts"));
    for (const c of genCalls) assert.ok(c.args.includes("--force"));
  });
});

// ---------------------------------------------------------------------------
// Sentinel Stage 2
// ---------------------------------------------------------------------------

describe("runStage3 — sentinel Stage 2", () => {
  it("exit 1 (sentinel ausente) -> Stage3Abort, code 1", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "pipeline-sentinel.ts": () => fail(1, "sentinel ausente") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 1);
    assert.ok(result.notes.some((n) => n.includes("Etapa 2 não completou")));
  });

  it("exit 2 (outputs ausentes) -> Stage3Abort, code 1", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "pipeline-sentinel.ts": () => fail(2, "outputs ausentes") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 1);
    assert.ok(result.notes.some((n) => n.includes("Outputs do Stage 2 ausentes")));
  });

  it("exit 3 (legacy, outputs presentes) -> warn e continua", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "pipeline-sentinel.ts": () => fail(3, "legacy") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 0);
    assert.ok(result.notes.some((n) => n.includes("stage2_sentinel_missing_legacy")));
  });
});

// ---------------------------------------------------------------------------
// Lint pre-flight
// ---------------------------------------------------------------------------

describe("runStage3 — lint pre-flight", () => {
  it("exit 1 (violação) pausa SÓ aquele destaque — próximo segue", async () => {
    const { exec } = makeFakeExec(
      happyHandlers({
        "lint-image-prompt.ts": (args) => (args[0].includes("d1") ? fail(1, "Noite Estrelada detectada") : ok(JSON.stringify({ ok: true, issues: [] }))),
      }),
    );
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 0);
    const d1 = result.destaques.find((d) => d.destaque === "d1")!;
    assert.equal(d1.lintOk, false);
    assert.equal(d1.imageGenerated, false);
    assert.ok(d1.lintViolations?.includes("Noite Estrelada"));
    const d2 = result.destaques.find((d) => d.destaque === "d2")!;
    assert.equal(d2.lintOk, true);
    assert.equal(d2.imageGenerated, true);
  });

  it("exit 2 (I/O error) -> Stage3Abort duro", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "lint-image-prompt.ts": () => fail(2, "arquivo não existe") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 1);
  });

  it("prompt ausente no disco -> destaque marcado com error, sem chamar lint", async () => {
    const { exec, calls } = makeFakeExec(happyHandlers());
    const deps = baseDeps({
      exec,
      existsSync: (p) => !p.includes("02-d1-prompt.md"),
      readFile: (p) => {
        if (p.endsWith("platform.config.json")) return JSON.stringify({ image_generator: "gemini" });
        if (p.endsWith("01-approved-capped.json")) return JSON.stringify({ highlights: [1, 2, 3] });
        throw new Error(`readFile não mockado: ${p}`);
      },
    });
    const result = await runStage3(["--edition", "260423"], deps);
    const d1 = result.destaques.find((d) => d.destaque === "d1")!;
    assert.equal(d1.error, "prompt_missing");
    const lintCallsForD1 = calls.filter((c) => c.script.endsWith("lint-image-prompt.ts") && c.args[0]?.includes("d1"));
    assert.equal(lintCallsForD1.length, 0);
  });
});

// ---------------------------------------------------------------------------
// image-generate.ts / gen-social-card-4x5.ts — BLOQUEANTE (#4090)
// ---------------------------------------------------------------------------

describe("runStage3 — falhas bloqueantes (#4090)", () => {
  it("image-generate.ts (2x1) falhando aborta o Stage 3 inteiro", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "image-generate.ts": () => fail(1, "Gemini API error") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 1);
    assert.ok(result.notes.some((n) => n.includes("image-generate.ts d1 (2x1) falhou")));
  });

  it("image-generate.ts (4x5 nativo) falhando aborta o Stage 3 inteiro", async () => {
    const { exec } = makeFakeExec(
      happyHandlers({
        "image-generate.ts": (args) => (args.includes("--ratio") ? fail(1, "fonte ausente") : ok("{}")),
      }),
    );
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 1);
    assert.ok(result.notes.some((n) => n.includes("4x5 nativo") && n.includes("BLOQUEANTE")));
  });

  it("gen-social-card-4x5.ts falhando aborta o Stage 3 inteiro", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "gen-social-card-4x5.ts": () => fail(1, "assertBrandSerifAvailable: Georgia ausente") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 1);
    assert.ok(result.notes.some((n) => n.includes("gen-social-card-4x5.ts falhou") && n.includes("BLOQUEANTE")));
  });

  it("nenhum destaque pronto -> pula gen-social-card-4x5.ts sem abortar (gen-carousel-cards.ts roda mesmo assim — só depende do Stage 2)", async () => {
    const { exec, calls } = makeFakeExec(happyHandlers({ "lint-image-prompt.ts": () => fail(1, "violação") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 0);
    assert.equal(result.cardsGenerated, false);
    assert.equal(result.carouselCardsGenerated, true);
    assert.equal(calls.some((c) => c.script.endsWith("gen-social-card-4x5.ts")), false);
    assert.equal(calls.some((c) => c.script.endsWith("gen-carousel-cards.ts")), true);
  });

  it("gen-carousel-cards.ts falhando aborta o Stage 3 inteiro (#6005)", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "gen-carousel-cards.ts": () => fail(1, "assertBrandSerifAvailable: Georgia ausente") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 1);
    assert.ok(result.notes.some((n) => n.includes("gen-carousel-cards.ts falhou") && n.includes("BLOQUEANTE")));
  });

  it("gen-carousel-cards.ts roda DEPOIS de gen-social-card-4x5.ts", async () => {
    const { exec, calls } = makeFakeExec(happyHandlers());
    await runStage3(["--edition", "260423"], baseDeps({ exec }));
    const cardIdx = calls.findIndex((c) => c.script.endsWith("gen-social-card-4x5.ts"));
    const carouselIdx = calls.findIndex((c) => c.script.endsWith("gen-carousel-cards.ts"));
    assert.ok(cardIdx >= 0 && carouselIdx >= 0 && carouselIdx > cardIdx);
  });
});

// ---------------------------------------------------------------------------
// ComfyUI health check
// ---------------------------------------------------------------------------

describe("runStage3 — ComfyUI", () => {
  it("image_generator=gemini (default) -> nunca chama checkComfyUi", async () => {
    const { exec } = makeFakeExec(happyHandlers());
    let called = false;
    const deps = baseDeps({ exec, checkComfyUi: () => ((called = true), true) });
    await runStage3(["--edition", "260423"], deps);
    assert.equal(called, false);
  });

  it("image_generator=comfyui + saudável -> segue normalmente", async () => {
    const { exec } = makeFakeExec(happyHandlers());
    const deps = baseDeps({
      exec,
      checkComfyUi: () => true,
      readFile: (p) => {
        if (p.endsWith("platform.config.json")) return JSON.stringify({ image_generator: "comfyui" });
        if (p.endsWith("01-approved-capped.json")) return JSON.stringify({ highlights: [1, 2, 3] });
        throw new Error(`readFile não mockado: ${p}`);
      },
    });
    const result = await runStage3(["--edition", "260423"], deps);
    assert.equal(result.code, 0);
  });

  it("image_generator=comfyui + indisponível -> HALT (code 2), banner renderizado", async () => {
    const { exec, calls } = makeFakeExec(happyHandlers());
    const deps = baseDeps({
      exec,
      checkComfyUi: () => false,
      readFile: (p) => {
        if (p.endsWith("platform.config.json")) return JSON.stringify({ image_generator: "comfyui" });
        if (p.endsWith("01-approved-capped.json")) return JSON.stringify({ highlights: [1, 2, 3] });
        throw new Error(`readFile não mockado: ${p}`);
      },
    });
    const result = await runStage3(["--edition", "260423"], deps);
    assert.equal(result.code, 2);
    assert.ok(result.haltRequired?.reason.includes("ComfyUI"));
    assert.ok(calls.some((c) => c.script.endsWith("render-halt-banner.ts")));
    // Nenhuma imagem deveria ter sido gerada.
    assert.equal(calls.some((c) => c.script.endsWith("image-generate.ts")), false);
  });
});

// ---------------------------------------------------------------------------
// inject-champions-callout.ts
// ---------------------------------------------------------------------------

describe("runStage3 — champions callout", () => {
  it("exit 0 com 'injetado em' -> championsInjected='injected'", async () => {
    const { exec } = makeFakeExec(
      happyHandlers({
        "inject-champions-callout.ts": () => ({ code: 0, stdout: "[inject-champions-callout] callout do sorteio (2 de julho) injetado em 02-reviewed.md\n", stderr: "" }),
      }),
    );
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.championsInjected, "injected");
  });

  it("exit 0 com 'callout já presente' -> championsInjected='skipped-existing-callout'", async () => {
    const { exec } = makeFakeExec(
      happyHandlers({
        "inject-champions-callout.ts": () => ({ code: 0, stdout: "[inject-champions-callout] callout já presente na região de intro (...)\n", stderr: "" }),
      }),
    );
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.championsInjected, "skipped-existing-callout");
  });

  it("exit 1 (#4583 raffle stale) -> HALT (code 2), nunca publica data errada em silêncio", async () => {
    const { exec, calls } = makeFakeExec(
      happyHandlers({
        "inject-champions-callout.ts": () => fail(1, "FATAL: raffle.sorteio_do_mes.mes não bate com o mês da edição corrente"),
      }),
    );
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 2);
    assert.ok(result.haltRequired?.reason.includes("FATAL"));
    assert.ok(calls.some((c) => c.script.endsWith("render-halt-banner.ts")));
  });

  it("exit 2 (uso) -> Stage3Abort duro", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "inject-champions-callout.ts": () => fail(2, "uso incorreto") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 1);
  });
});

// ---------------------------------------------------------------------------
// check-invariants.ts --stage 3
// ---------------------------------------------------------------------------

describe("runStage3 — pre-gate invariants", () => {
  it("falha (exit 1) é reportada, NUNCA aborta o script", async () => {
    const { exec } = makeFakeExec(
      happyHandlers({
        "check-invariants.ts": () => ({ code: 1, stdout: JSON.stringify({ violations: [{ rule: "all-images-exist", message: "faltando" }] }), stderr: "" }),
      }),
    );
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 0);
    assert.equal(result.invariantsPassed, false);
    assert.equal(result.invariantsViolations?.length, 1);
  });

  it("exit 2 (uso) -> Stage3Abort duro", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "check-invariants.ts": () => fail(2, "uso incorreto") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 1);
  });
});

// ---------------------------------------------------------------------------
// run-image-crop-reviewer.ts (descoberta) -> pendingAgentDispatch
// ---------------------------------------------------------------------------

describe("runStage3 — crop reviewer (descoberta)", () => {
  it("pares encontrados -> cropReviewPairs + pendingAgentDispatch", async () => {
    const pairs = [{ destaque: "d1", ratio: "1x1", hero_path: "x", crop_path: "y" }];
    const { exec } = makeFakeExec(
      happyHandlers({
        "run-image-crop-reviewer.ts": () => ok(JSON.stringify({ edition: "260423", pairs, out_path: "data/editions/2604/260423/_internal/04-crop-review.json" })),
      }),
    );
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 0);
    assert.deepEqual(result.cropReviewPairs, pairs);
    assert.equal(result.pendingAgentDispatch.length, 1);
    assert.equal(result.pendingAgentDispatch[0].agent, "image-crop-reviewer");
  });

  it("nenhum par (exit 1) -> warn, sem pendingAgentDispatch, não bloqueia", async () => {
    const { exec } = makeFakeExec(happyHandlers({ "run-image-crop-reviewer.ts": () => fail(1, "nenhum par encontrado") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 0);
    assert.equal(result.cropReviewPairs, undefined);
    assert.equal(result.pendingAgentDispatch.length, 0);
  });
});

// ---------------------------------------------------------------------------
// delegatedSteps — nunca vazio, sempre presente no resultado
// ---------------------------------------------------------------------------

describe("runStage3 — delegatedSteps", () => {
  it("sempre presente, mencionando §3a/§3a-bis/crop-reviewer/gate", async () => {
    const { exec } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.ok(result.delegatedSteps.length >= 4);
    assert.ok(result.delegatedSteps.some((s) => s.includes("3a")));
    assert.ok(result.delegatedSteps.some((s) => s.includes("humanizador")));
    assert.ok(result.delegatedSteps.some((s) => s.includes("crop-reviewer")));
    assert.ok(result.delegatedSteps.some((s) => s.includes("gate humano")));
  });
});

// ---------------------------------------------------------------------------
// Geração de imagens em paralelo (#14036) — gerador FALSO, nenhuma imagem real
// ---------------------------------------------------------------------------

/** Gerador falso assíncrono: cada chamada de image-generate.ts espera um
 * tick e devolve o que `decide` mandar. Mede quantas estavam em voo juntas. */
function makeFakeImageGen(decide: (args: string[], attempt: number) => StepResult = () => ok("{}")) {
  const calls: string[][] = [];
  const started: string[] = [];
  const attempts = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  const label = (args: string[]) => `${args[args.indexOf("--destaque") + 1]}:${args.includes("--ratio") ? "4x5" : "2x1"}`;
  const execAsync: AsyncExecFn = async (script, args) => {
    assert.ok(script.endsWith("image-generate.ts"), `execAsync só deveria rodar image-generate.ts, rodou ${script}`);
    calls.push(args);
    const key = label(args);
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    started.push(key);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return decide(args, n);
  };
  return { execAsync, calls, started, label, get maxInFlight() { return maxInFlight; } };
}

describe("parseStage3RunArgs — concorrência (#14036)", () => {
  it("default = DEFAULT_IMAGE_CONCURRENCY (6)", () => {
    assert.equal(parseStage3RunArgs(["--edition", "260423"]).imageConcurrency, DEFAULT_IMAGE_CONCURRENCY);
    assert.equal(DEFAULT_IMAGE_CONCURRENCY, 6);
  });
  it("--concurrency 2 e --serial", () => {
    assert.equal(parseStage3RunArgs(["--edition", "260423", "--concurrency", "2"]).imageConcurrency, 2);
    assert.equal(parseStage3RunArgs(["--edition", "260423", "--serial"]).imageConcurrency, 1);
  });
  it("--concurrency fora de 1..6 -> Stage3Abort", () => {
    assert.throws(() => parseStage3RunArgs(["--edition", "260423", "--concurrency", "0"]), Stage3Abort);
    assert.throws(() => parseStage3RunArgs(["--edition", "260423", "--concurrency", "7"]), Stage3Abort);
    assert.throws(() => parseStage3RunArgs(["--edition", "260423", "--concurrency", "x"]), Stage3Abort);
  });
});

describe("runWithConcurrency (#14036)", () => {
  it("respeita o teto e devolve na ordem da lista, não na de término", async () => {
    let inFlight = 0;
    let max = 0;
    const jobs = [30, 5, 15, 1].map((ms, i) => async () => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return i;
    });
    assert.deepEqual(await runWithConcurrency(jobs, 2), [0, 1, 2, 3]);
    assert.equal(max, 2);
  });
  it("lista vazia não trava", async () => {
    assert.deepEqual(await runWithConcurrency([], 6), []);
  });
});

describe("realExecAsync (#14036) — spawn de verdade, sem gerar imagem", () => {
  it("captura exit code e stderr (image-generate.ts sem args sai 1 no uso, antes de qualquer geração)", async () => {
    const root = new URL("..", import.meta.url);
    const r = await realExecAsync(fileURLToPath(root), { forwardSignals: false })("scripts/image-generate.ts", []);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Uso: image-generate\.ts/);
  });

  /** Filho real que não termina sozinho (60 s), num diretório temporário. */
  function withSleeper(fn: (root: string, rel: string) => Promise<void>) {
    return async () => {
      const root = fileURLToPath(new URL("..", import.meta.url));
      const dir = mkdtempSync(join(tmpdir(), "stage3-timeout-14036-"));
      const sleeper = join(dir, "sleeper.mjs");
      writeFileSync(sleeper, "setTimeout(() => {}, 60_000);\n");
      try {
        await fn(root, relative(root, sleeper).split(sep).join("/"));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it(
    "timeout: kill da árvore pelo PID, job só termina no close (morte confirmada) e segue repetível",
    withSleeper(async (root, rel) => {
      const killed: Array<number | undefined> = [];
      const exec = realExecAsync(root, {
        timeoutMs: 1500,
        forwardSignals: false,
        killTree: (pid) => {
          killed.push(pid);
          return killChildTree(pid);
        },
      });
      const r = await exec(rel, []);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /kill da árvore: ok/);
      assert.match(r.stderr, /filho encerrado/, "terminou pelo close, não no momento do kill");
      assert.equal(r.retryable, undefined);
      assert.equal(killed.length, 1);
      assert.equal(typeof killed[0], "number");
    }),
  );

  it(
    "kill que FALHA: falha não repetível, status do kill no stderr",
    withSleeper(async (root, rel) => {
      let childPid: number | undefined;
      const exec = realExecAsync(root, {
        timeoutMs: 1000,
        forwardSignals: false,
        killTree: (pid) => {
          childPid = pid;
          return { ok: false, detail: "taskkill /T /F /PID x: status 1 (Acesso negado)" };
        },
      });
      try {
        const r = await exec(rel, []);
        assert.equal(r.code, 1);
        assert.equal(r.retryable, false);
        assert.match(r.stderr, /kill da árvore: FALHOU — taskkill .*Acesso negado/);
        assert.match(r.stderr, /não repetível/);
      } finally {
        killChildTree(childPid); // limpeza real do sleeper
      }
    }),
  );

  it(
    "kill 'ok' mas sem close no prazo: morte não confirmada, falha não repetível",
    withSleeper(async (root, rel) => {
      let childPid: number | undefined;
      const exec = realExecAsync(root, {
        timeoutMs: 1000,
        killConfirmGraceMs: 300,
        forwardSignals: false,
        killTree: (pid) => {
          childPid = pid;
          return { ok: true, detail: "relatou ok sem matar" };
        },
      });
      try {
        const r = await exec(rel, []);
        assert.equal(r.code, 1);
        assert.equal(r.retryable, false);
        assert.match(r.stderr, /sem close do filho/);
      } finally {
        killChildTree(childPid);
      }
    }),
  );
});

describe("killChildTree (#14036)", () => {
  it("Windows: taskkill /T /F pelo PID, status no detail; 0 e 128 (já saiu) = ok, outro = falha", () => {
    const pids: number[] = [];
    const r = killChildTree(4242, {
      platform: "win32",
      execTaskkill: (p) => (pids.push(p), { status: 0, output: "ÊXITO" }),
      killFn: () => assert.fail("sem kill POSIX no Windows"),
    });
    assert.deepEqual(pids, [4242]);
    assert.equal(r.ok, true);
    assert.match(r.detail, /taskkill \/T \/F \/PID 4242: status 0/);
    assert.equal(killChildTree(1, { platform: "win32", execTaskkill: () => ({ status: 128, output: "" }) }).ok, true);
    assert.equal(killChildTree(1, { platform: "win32", execTaskkill: () => ({ status: 1, output: "Acesso negado" }) }).ok, false);
  });

  it("POSIX: sem grupo (filho não é detached) — mata os descendentes (folhas primeiro) e depois o PID", () => {
    const sent: Array<[number, string]> = [];
    const tree: Record<number, number[]> = { 4242: [5000], 5000: [6000], 6000: [] };
    const r = killChildTree(4242, {
      platform: "linux",
      listChildren: (p) => tree[p] ?? [],
      killFn: (p, s) => sent.push([p, s]),
      execTaskkill: () => assert.fail("sem taskkill no POSIX"),
    });
    assert.deepEqual(sent, [[6000, "SIGKILL"], [5000, "SIGKILL"], [4242, "SIGKILL"]]);
    assert.ok(sent.every(([p]) => p > 0), "nunca kill(-pid): o filho está no grupo do runner");
    assert.equal(r.ok, true);
  });

  it("POSIX: ESRCH no PID = já saiu (ok); EPERM = falha", () => {
    const err = (code: string) => Object.assign(new Error(code), { code });
    const esrch = killChildTree(7, { platform: "linux", listChildren: () => [], killFn: () => { throw err("ESRCH"); } });
    assert.equal(esrch.ok, true);
    const eperm = killChildTree(7, { platform: "linux", listChildren: () => [], killFn: () => { throw err("EPERM"); } });
    assert.equal(eperm.ok, false);
    assert.match(eperm.detail, /EPERM/);
  });

  it("sem pid: não mata nada e reporta falha", () => {
    const r = killChildTree(undefined, { platform: "win32", execTaskkill: () => assert.fail("não deveria matar") });
    assert.equal(r.ok, false);
  });
});

describe("shouldRetrySerially / retryArgs (#14036)", () => {
  it("repete se alguma passou", () => {
    assert.equal(shouldRetrySerially([{ ok: true, stderr: "" }, { ok: false, stderr: "boom" }]), true);
  });
  it("todas falharam: só repete com sinal de concorrência/taxa", () => {
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "login expirado" }, { ok: false, stderr: "x" }]), false);
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "HTTP 429" }, { ok: false, stderr: "x" }]), true);
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "rate limit exceeded" }]), true);
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "too many concurrent requests" }]), true);
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "OpenAI: status 429" }]), true);
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "rate_limit_exceeded" }]), true);
  });
  it("regex ancorada: 'concurrency: 6' e um 429 solto NÃO disparam a repetição", () => {
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "image-generate: concurrency: 6, login expirado" }]), false);
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "arquivo 04-d1-429.jpg ausente" }]), false);
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "processamento simultâneo falhou" }]), false);
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "ratelimit config ok" }]), false);
  });
  it("falha não repetível (morte não confirmada) nunca é candidata", () => {
    assert.equal(shouldRetrySerially([{ ok: true, stderr: "" }, { ok: false, stderr: "x", retryable: false }]), false);
    assert.equal(shouldRetrySerially([{ ok: false, stderr: "HTTP 429", retryable: false }]), false);
  });
  it("nenhuma falha: não repete", () => {
    assert.equal(shouldRetrySerially([{ ok: true, stderr: "" }]), false);
  });
  it("retryArgs acrescenta --force uma vez só", () => {
    assert.deepEqual(retryArgs(["--destaque", "d1"]), ["--destaque", "d1", "--force"]);
    assert.deepEqual(retryArgs(["--destaque", "d1", "--force"]), ["--destaque", "d1", "--force"]);
  });
});

describe("runStage3 — imagens em paralelo (#14036)", () => {
  it("3 destaques: as 6 imagens (2x1 + 4x5 de cada) rodam juntas, card/carrossel só depois", async () => {
    const gen = makeFakeImageGen();
    const { exec, calls } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 0);
    assert.equal(gen.calls.length, 6);
    assert.equal(gen.maxInFlight, 6);
    assert.equal(result.imageConcurrency, 6);
    assert.equal(result.imageJobs?.length, 6);
    assert.ok(result.imageJobs?.every((j) => j.ok && !j.retriedSerially));
    // Nenhum image-generate.ts pelo exec síncrono quando há execAsync.
    assert.equal(calls.filter((c) => c.script.endsWith("image-generate.ts")).length, 0);
    assert.ok(calls.some((c) => c.script.endsWith("gen-social-card-4x5.ts")));
    assert.deepEqual(result.destaques.map((d) => d.destaque), ["d1", "d2", "d3"]);
  });

  it("--serial: uma imagem por vez, na ordem antiga (d1 2x1, d1 4x5, d2 2x1...)", async () => {
    const gen = makeFakeImageGen();
    const { exec } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423", "--serial"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 0);
    assert.equal(gen.maxInFlight, 1);
    assert.deepEqual(gen.started, ["d1:2x1", "d1:4x5", "d2:2x1", "d2:4x5", "d3:2x1", "d3:4x5"]);
  });

  it("--concurrency 3 limita a 3 em voo", async () => {
    const gen = makeFakeImageGen();
    const { exec } = makeFakeExec(happyHandlers());
    await runStage3(["--edition", "260423", "--concurrency", "3"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(gen.maxInFlight, 3);
  });

  it("2x1 ausente (vai ser regerado): 2x1 leva --keep-4x5-nativo e o 4x5 leva --force (mesmo resultado da ordem antiga, sem corrida)", async () => {
    const gen = makeFakeImageGen();
    const { exec } = makeFakeExec(happyHandlers());
    const deps = baseDeps({ exec, execAsync: gen.execAsync, existsSync: (p) => !p.replace(/\\/g, "/").endsWith("04-d1-2x1.jpg") });
    await runStage3(["--edition", "260423"], deps);
    const d1_2x1 = gen.calls.find((a) => gen.label(a) === "d1:2x1")!;
    const d1_4x5 = gen.calls.find((a) => gen.label(a) === "d1:4x5")!;
    assert.ok(d1_2x1.includes("--keep-4x5-nativo"));
    assert.ok(!d1_2x1.includes("--force"), "sem --force do editor, o 2x1 não é forçado");
    assert.ok(d1_4x5.includes("--force"));
    // d2/d3 com o 2x1 presente: skip-if-exists de sempre, nenhum dos dois forçado.
    const d2_2x1 = gen.calls.find((a) => gen.label(a) === "d2:2x1")!;
    const d2_4x5 = gen.calls.find((a) => gen.label(a) === "d2:4x5")!;
    assert.ok(!d2_2x1.includes("--keep-4x5-nativo") && !d2_2x1.includes("--force"));
    assert.ok(!d2_4x5.includes("--force"));
  });

  it("falha só no paralelo -> repetida em série, passa, Stage 3 segue (code 0) e o fallback fica no run-log", async () => {
    const gen = makeFakeImageGen((args, attempt) => (args.includes("d2") && args.includes("--ratio") && attempt === 1 ? fail(1, "429 too many concurrent requests") : ok("{}")));
    const { exec, calls } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 0);
    assert.equal(gen.calls.length, 7);
    const job = result.imageJobs?.find((j) => j.destaque === "d2" && j.ratio === "4x5");
    assert.equal(job?.ok, true);
    assert.equal(job?.retriedSerially, true);
    assert.ok(result.notes.some((n) => n.includes("d2:4x5") && n.includes("repetindo em série")));
    assert.ok(calls.some((c) => c.script.endsWith("log-event.ts") && c.args.includes("stage3_image_parallel_fallback")));
  });

  it("falha persistente de um destaque -> BLOQUEANTE, mas d1/d3 aparecem prontos e d2 mostra qual ratio falhou", async () => {
    const gen = makeFakeImageGen((args) => (args.includes("d2") && args.includes("--ratio") ? fail(1, "codex: login expirado") : ok("{}")));
    const { exec, calls } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 1);
    const byId = Object.fromEntries(result.destaques.map((d) => [d.destaque, d]));
    assert.equal(byId.d1.imageGenerated && byId.d1.nativeArt4x5Generated, true);
    assert.equal(byId.d3.imageGenerated && byId.d3.nativeArt4x5Generated, true);
    assert.equal(byId.d2.imageGenerated, true);
    assert.equal(byId.d2.nativeArt4x5Generated, false);
    assert.match(byId.d2.error ?? "", /d2 \(4x5 nativo\) falhou.*login expirado/);
    assert.ok(result.notes.some((n) => n.includes("image-generate.ts d2 (4x5 nativo) falhou") && n.includes("BLOQUEANTE")));
    // Abort antes do card: nada composto com imagem faltando.
    assert.equal(calls.some((c) => c.script.endsWith("gen-social-card-4x5.ts")), false);
  });

  it("duas falhas na mesma rodada aparecem as duas na mensagem", async () => {
    const gen = makeFakeImageGen((args) => (args.includes("d1") || args.includes("d3") ? (args.includes("--ratio") ? ok("{}") : fail(1, "boom")) : ok("{}")));
    const { exec } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 1);
    assert.ok(result.notes.some((n) => n.includes("2 imagens falharam") && n.includes("d1 (2x1)") && n.includes("d3 (2x1)")));
  });

  it("--serial aborta na 1ª falha, como antes: não roda o resto nem repete", async () => {
    const gen = makeFakeImageGen((args) => (args.includes("d1") && !args.includes("--ratio") ? fail(1, "Gemini API error") : ok("{}")));
    const { exec, calls } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423", "--serial"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 1);
    assert.deepEqual(gen.started, ["d1:2x1"]);
    assert.equal(result.imageJobs?.length, 1);
    assert.ok(result.imageJobs?.every((j) => !j.retriedSerially));
    assert.deepEqual(result.destaques.map((d) => d.destaque), ["d1"]);
    assert.ok(result.notes.some((n) => n.includes("image-generate.ts d1 (2x1) falhou (exit 1): Gemini API error")));
    assert.ok(!result.notes.some((n) => n.includes("imagens falharam")), "mensagem única, como na ordem antiga");
    assert.equal(calls.some((c) => c.args.includes("stage3_image_parallel_fallback")), false);
  });

  it("paralelo: TODAS falham sem sinal de concorrência -> abort direto, sem repetição", async () => {
    const gen = makeFakeImageGen(() => fail(1, "codex: login expirado"));
    const { exec, calls } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 1);
    assert.equal(gen.calls.length, 6);
    assert.ok(result.imageJobs?.every((j) => !j.retriedSerially));
    assert.equal(calls.some((c) => c.args.includes("stage3_image_parallel_fallback")), false);
    assert.ok(result.notes.some((n) => n.includes("sem repetição em série")));
  });

  it("paralelo: TODAS falham com 429 -> repete em série (a concorrência pode ser a causa)", async () => {
    const gen = makeFakeImageGen((_args, attempt) => (attempt === 1 ? fail(1, "HTTP 429 Too Many Requests") : ok("{}")));
    const { exec } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 0);
    assert.equal(gen.calls.length, 12);
    assert.ok(result.imageJobs?.every((j) => j.ok && j.retriedSerially));
  });

  it("job com morte do filho não confirmada (retryable:false) não é repetido, mesmo com outras imagens ok", async () => {
    const gen = makeFakeImageGen((args) =>
      args.includes("d1") && !args.includes("--ratio")
        ? { code: 1, stdout: "", stderr: "kill da árvore: FALHOU", retryable: false as const }
        : ok("{}"),
    );
    const { exec, calls } = makeFakeExec(happyHandlers());
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 1);
    assert.equal(gen.calls.length, 6, "nenhuma repetição: o filho pode estar vivo");
    const job = result.imageJobs?.find((j) => j.destaque === "d1" && j.ratio === "2x1");
    assert.equal(job?.retryable, false);
    assert.ok(result.notes.some((n) => n.includes("d1:2x1 sem morte confirmada")));
    assert.equal(calls.some((c) => c.args.includes("stage3_image_parallel_fallback")), false);
  });

  it("a repetição leva --force (nunca pula por 'já existe' um arquivo parcial) e o 2x1 mantém --keep-4x5-nativo", async () => {
    const gen = makeFakeImageGen((args, attempt) => (args.includes("d1") && attempt === 1 ? fail(1, "compress-jpeg falhou") : ok("{}")));
    const { exec } = makeFakeExec(happyHandlers());
    // 2x1 do d1 ausente: o 1º 2x1 leva --keep-4x5-nativo e não leva --force.
    const deps = baseDeps({ exec, execAsync: gen.execAsync, existsSync: (p) => !p.replace(/\\/g, "/").endsWith("04-d1-2x1.jpg") });
    const result = await runStage3(["--edition", "260423"], deps);
    assert.equal(result.code, 0);
    const d1Calls = gen.calls.filter((a) => a.includes("d1"));
    assert.equal(d1Calls.length, 4);
    const [first2x1, retry2x1] = d1Calls.filter((a) => gen.label(a) === "d1:2x1");
    assert.ok(!first2x1.includes("--force"));
    assert.ok(retry2x1.includes("--force") && retry2x1.includes("--keep-4x5-nativo"));
    const retry4x5 = d1Calls.filter((a) => gen.label(a) === "d1:4x5")[1];
    assert.equal(retry4x5.filter((x) => x === "--force").length, 1, "--force sem duplicar");
  });

  it("lint com violação num destaque: os outros geram em paralelo, o pausado não gera nada", async () => {
    const gen = makeFakeImageGen();
    const { exec } = makeFakeExec(
      happyHandlers({ "lint-image-prompt.ts": (args) => (args[0].includes("d2") ? fail(1, "Noite Estrelada") : ok("{}")) }),
    );
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec, execAsync: gen.execAsync }));
    assert.equal(result.code, 0);
    assert.equal(gen.calls.length, 4);
    assert.equal(gen.calls.some((a) => a.includes("d2")), false);
    assert.deepEqual(result.destaques.map((d) => [d.destaque, d.lintOk]), [["d1", true], ["d2", false], ["d3", true]]);
  });
});

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
import {
  runStage3,
  parseStage3RunArgs,
  readDestaqueCountFromDisk,
  parseStepJson,
  Stage3Abort,
  type Stage3RunDeps,
  type ExecFn,
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

  it("nenhum destaque pronto -> pula gen-social-card-4x5.ts sem abortar", async () => {
    const { exec, calls } = makeFakeExec(happyHandlers({ "lint-image-prompt.ts": () => fail(1, "violação") }));
    const result = await runStage3(["--edition", "260423"], baseDeps({ exec }));
    assert.equal(result.code, 0);
    assert.equal(result.cardsGenerated, false);
    assert.equal(calls.some((c) => c.script.endsWith("gen-social-card-4x5.ts")), false);
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
        "inject-champions-callout.ts": () => ({ code: 0, stdout: "[inject-champions-callout] box de campeões (julho) + sorteio injetado em 02-reviewed.md\n", stderr: "" }),
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

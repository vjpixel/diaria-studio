/**
 * test/stage-1-run.test.ts (#5415, incremento 3/3)
 *
 * Cobre `scripts/stage-1-run.ts` — o orquestrador determinístico do GLUE do
 * Stage 1 (Pesquisa) do orchestrator diar.ia.br, dividido em 5 fases. Mesmo
 * padrão de `test/stage-0-run.test.ts`/`test/stage-3-run.test.ts`: `exec`/
 * `spawnDetached` são fakes injetados (nenhum spawn real, nenhuma rede real,
 * nenhum `data/` real tocado) — fases com I/O intenso de arquivo usam um
 * diretório temporário real (`mkdtempSync`) em vez de mockar `readFile`/
 * `writeFile` linha a linha, mesmo padrão do bloco "0h.2" de
 * `test/stage-0-run.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync as nodeMkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync as nodeExistsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  runStage1,
  parseStage1RunArgs,
  editionIsoFromAammdd,
  isoDateOnly,
  subtractDaysIso,
  defaultWindowDays,
  computePrevEditionFromPastRaw,
  mergeJsonArrays,
  applyLinkVerifyAnnotations,
  promoteRunnersUpToSix,
  computeMinSectionWarnings,
  assembleFinalCategorized,
  parseStepJson,
  Stage1Abort,
  type Stage1RunDeps,
  type ExecFn,
  type SpawnDetachedFn,
  type StepResult,
} from "../scripts/stage-1-run.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(stdout = "{}"): StepResult {
  return { code: 0, stdout, stderr: "" };
}
function fail(code = 1, stderr = "erro"): StepResult {
  return { code, stdout: "", stderr };
}

/** Fake exec dispatcher — casa pelo NOME DO ARQUIVO (basename), como
 * stage-0-run.test.ts/stage-3-run.test.ts. Handlers recebem `args` inteiro
 * pra poder branchar por subcomando (ex: pipeline-sentinel.ts
 * assert-marker vs write). Handlers ausentes caem no default (sucesso, `{}`). */
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

function noopSpawnDetached(): { spawnDetached: SpawnDetachedFn; calls: Array<{ script: string; args: string[] }> } {
  const calls: Array<{ script: string; args: string[] }> = [];
  return {
    spawnDetached: (script, args) => {
      calls.push({ script, args });
    },
    calls,
  };
}

function baseDeps(overrides: Partial<Stage1RunDeps> = {}): Stage1RunDeps {
  const { exec } = makeFakeExec();
  const { spawnDetached } = noopSpawnDetached();
  return {
    rootDir: "/fake-root",
    now: () => new Date("2026-04-23T08:00:00Z"),
    exec,
    spawnDetached,
    existsSync: () => false,
    mkdirSync: () => {},
    readFile: (p) => {
      throw new Error(`readFile não mockado: ${p}`);
    },
    writeFile: () => {},
    renameFile: () => {},
    hasEnv: () => undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseStepJson (sanity — implementação idêntica aos outros runners)
// ---------------------------------------------------------------------------

describe("parseStepJson", () => {
  it("parseia JSON puro", () => {
    assert.deepEqual(parseStepJson('{"a":1}'), { a: 1 });
  });
  it("stdout vazio -> undefined", () => {
    assert.equal(parseStepJson(""), undefined);
  });
  it("array puro", () => {
    assert.deepEqual(parseStepJson("[1,2,3]"), [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Datas (mesmos helpers de stage-0-run.ts, duplicados aqui — sanity)
// ---------------------------------------------------------------------------

describe("editionIsoFromAammdd / isoDateOnly / subtractDaysIso / defaultWindowDays", () => {
  it("editionIsoFromAammdd converte AAMMDD -> YYYY-MM-DD", () => {
    assert.equal(editionIsoFromAammdd("260423"), "2026-04-23");
  });
  it("editionIsoFromAammdd rejeita formato inválido", () => {
    assert.throws(() => editionIsoFromAammdd("abc"), Stage1Abort);
  });
  it("isoDateOnly extrai a data", () => {
    assert.equal(isoDateOnly(new Date("2026-04-23T08:00:00Z")), "2026-04-23");
  });
  it("subtractDaysIso subtrai dias em UTC", () => {
    assert.equal(subtractDaysIso("2026-04-23", 4), "2026-04-19");
  });
  it("defaultWindowDays: quarta/quinta/sexta -> 3", () => {
    assert.equal(defaultWindowDays(new Date("2026-04-22T00:00:00Z")), 3); // quarta
    assert.equal(defaultWindowDays(new Date("2026-04-24T00:00:00Z")), 3); // sexta
  });
  it("defaultWindowDays: segunda/terça/fds -> 4", () => {
    assert.equal(defaultWindowDays(new Date("2026-04-20T00:00:00Z")), 4); // segunda
    assert.equal(defaultWindowDays(new Date("2026-04-26T00:00:00Z")), 4); // domingo
  });
});

// ---------------------------------------------------------------------------
// computePrevEditionFromPastRaw (§1c)
// ---------------------------------------------------------------------------

describe("computePrevEditionFromPastRaw", () => {
  it("extrai AAMMDD do primeiro item", () => {
    const raw = JSON.stringify([{ published_at: "2026-04-22T10:00:00Z" }]);
    assert.equal(computePrevEditionFromPastRaw(raw), "260422");
  });
  it("array vazio -> null", () => {
    assert.equal(computePrevEditionFromPastRaw("[]"), null);
  });
  it("JSON inválido -> null, nunca lança", () => {
    assert.equal(computePrevEditionFromPastRaw("{not json"), null);
  });
  it("published_at ausente -> null", () => {
    assert.equal(computePrevEditionFromPastRaw(JSON.stringify([{}])), null);
  });
  it("published_at inválido -> null", () => {
    assert.equal(computePrevEditionFromPastRaw(JSON.stringify([{ published_at: "not-a-date" }])), null);
  });
  it("não-array -> null", () => {
    assert.equal(computePrevEditionFromPastRaw(JSON.stringify({ foo: "bar" })), null);
  });
});

// ---------------------------------------------------------------------------
// mergeJsonArrays (§1f Path A merge)
// ---------------------------------------------------------------------------

describe("mergeJsonArrays", () => {
  it("concatena dois arrays", () => {
    assert.deepEqual(mergeJsonArrays([1, 2], [3, 4]), [1, 2, 3, 4]);
  });
  it("trata não-array como vazio", () => {
    assert.deepEqual(mergeJsonArrays(null, [1]), [1]);
    assert.deepEqual(mergeJsonArrays([1], undefined), [1]);
  });
});

// ---------------------------------------------------------------------------
// applyLinkVerifyAnnotations (§1i)
// ---------------------------------------------------------------------------

describe("applyLinkVerifyAnnotations", () => {
  it("artigo sem verdict correspondente passa intacto", () => {
    const out = applyLinkVerifyAnnotations([{ url: "https://a.com" }], []);
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://a.com");
  });

  it("remove artigo não-inbox com verdict paywall", () => {
    const out = applyLinkVerifyAnnotations([{ url: "https://a.com" }], [{ url: "https://a.com", verdict: "paywall" }]);
    assert.equal(out.length, 0);
  });

  it("remove artigo não-inbox com verdict blocked", () => {
    const out = applyLinkVerifyAnnotations([{ url: "https://a.com" }], [{ url: "https://a.com", verdict: "blocked" }]);
    assert.equal(out.length, 0);
  });

  it("remove artigo não-inbox com verdict aggregator sem resolvedFrom", () => {
    const out = applyLinkVerifyAnnotations([{ url: "https://a.com" }], [{ url: "https://a.com", verdict: "aggregator" }]);
    assert.equal(out.length, 0);
  });

  it("MANTÉM aggregator COM resolvedFrom (expandido) e troca a URL", () => {
    const out = applyLinkVerifyAnnotations(
      [{ url: "https://agg.com" }],
      [{ url: "https://agg.com", verdict: "aggregator", resolvedFrom: "https://agg.com", finalUrl: "https://real.com" }],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].url, "https://real.com");
    assert.equal(out[0].resolvedFrom, "https://agg.com");
  });

  it("editor_submitted NUNCA é removido por verdict de acessibilidade — só anotado (#778)", () => {
    const out = applyLinkVerifyAnnotations(
      [{ url: "https://a.com", flag: "editor_submitted" }],
      [{ url: "https://a.com", verdict: "paywall" }],
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].verify_verdict, "paywall");
  });

  it("source: inbox também é isento da remoção", () => {
    const out = applyLinkVerifyAnnotations([{ url: "https://a.com", source: "inbox" }], [{ url: "https://a.com", verdict: "blocked" }]);
    assert.equal(out.length, 1);
  });

  it("verdict anti_bot -> access_uncertain: true, mantido", () => {
    const out = applyLinkVerifyAnnotations([{ url: "https://a.com" }], [{ url: "https://a.com", verdict: "anti_bot" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].access_uncertain, true);
  });

  it("verdict uncertain -> date_unverified: true, mantido", () => {
    const out = applyLinkVerifyAnnotations([{ url: "https://a.com" }], [{ url: "https://a.com", verdict: "uncertain" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].date_unverified, true);
  });

  it("verdict accessible -> só anota verify_verdict, mantido", () => {
    const out = applyLinkVerifyAnnotations([{ url: "https://a.com" }], [{ url: "https://a.com", verdict: "accessible" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].verify_verdict, "accessible");
  });
});

// ---------------------------------------------------------------------------
// promoteRunnersUpToSix (§1r)
// ---------------------------------------------------------------------------

describe("promoteRunnersUpToSix", () => {
  it("já tem 6 highlights -> no-op", () => {
    const highlights = Array.from({ length: 6 }, (_, i) => ({ score: i }));
    const r = promoteRunnersUpToSix({ highlights, runners_up: [{ score: 99 }] });
    assert.equal(r.promoted, 0);
    assert.equal(r.highlights.length, 6);
    assert.equal(r.runnersUp.length, 1);
  });

  it("promove do runners_up (ordenado por score desc) até completar 6", () => {
    const highlights = [{ score: 90 }, { score: 80 }];
    const runnersUp = [{ score: 50 }, { score: 70 }, { score: 60 }];
    const r = promoteRunnersUpToSix({ highlights, runners_up: runnersUp });
    assert.equal(r.promoted, 3);
    assert.equal(r.highlights.length, 5);
    assert.deepEqual(
      r.highlights.map((h) => h.score),
      [90, 80, 70, 60, 50],
    );
    assert.equal(r.runnersUp.length, 0);
  });

  it("renumera rank 1..N após promoção", () => {
    const r = promoteRunnersUpToSix({ highlights: [{ score: 90 }], runners_up: [{ score: 50 }] });
    assert.deepEqual(
      r.highlights.map((h) => h.rank),
      [1, 2],
    );
  });

  it("runners_up insuficiente -> promove o que houver, sem lançar", () => {
    const r = promoteRunnersUpToSix({ highlights: [{ score: 90 }], runners_up: [] });
    assert.equal(r.promoted, 0);
    assert.equal(r.highlights.length, 1);
  });

  it("highlights/runners_up ausentes -> trata como []", () => {
    const r = promoteRunnersUpToSix({});
    assert.equal(r.promoted, 0);
    assert.deepEqual(r.highlights, []);
  });
});

// ---------------------------------------------------------------------------
// computeMinSectionWarnings (§1t)
// ---------------------------------------------------------------------------

describe("computeMinSectionWarnings", () => {
  it("todos os mínimos cumpridos -> sem warnings", () => {
    const warnings = computeMinSectionWarnings({
      lancamento: [1, 2, 3],
      radar: Array(8).fill(0),
      use_melhor: [1, 2, 3],
    });
    assert.deepEqual(warnings, []);
  });

  it("lancamento abaixo do mínimo -> warning", () => {
    const warnings = computeMinSectionWarnings({ lancamento: [1], radar: Array(8).fill(0), use_melhor: [1, 2, 3] });
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("lançamento"));
  });

  it("radar abaixo do mínimo -> warning", () => {
    const warnings = computeMinSectionWarnings({ lancamento: [1, 2, 3], radar: [1], use_melhor: [1, 2, 3] });
    assert.ok(warnings.some((w) => w.includes("RADAR")));
  });

  it("buckets ausentes -> tratados como 0, todos os 3 warnings", () => {
    const warnings = computeMinSectionWarnings({});
    assert.equal(warnings.length, 3);
  });
});

// ---------------------------------------------------------------------------
// assembleFinalCategorized (§1u)
// ---------------------------------------------------------------------------

describe("assembleFinalCategorized", () => {
  it("remove o campo verifier de cada artigo", () => {
    const out = assembleFinalCategorized({
      highlights: [{ url: "https://a.com", verifier: { note: "x" } }],
      radar: [{ url: "https://b.com", verifier: "y" }],
    });
    assert.deepEqual(out.highlights, [{ url: "https://a.com" }]);
    assert.deepEqual(out.radar, [{ url: "https://b.com" }]);
  });

  it("buckets ausentes viram []", () => {
    const out = assembleFinalCategorized({});
    assert.deepEqual(out, { highlights: [], runners_up: [], lancamento: [], radar: [], use_melhor: [], video: [], clusters: [] });
  });

  it("preserva clusters como veio (sem strip, já que não é artigo)", () => {
    const out = assembleFinalCategorized({ clusters: [{ id: "c1" }] });
    assert.deepEqual(out.clusters, [{ id: "c1" }]);
  });
});

// ---------------------------------------------------------------------------
// parseStage1RunArgs
// ---------------------------------------------------------------------------

describe("parseStage1RunArgs", () => {
  it("--phase obrigatório e validado", () => {
    assert.throws(() => parseStage1RunArgs(["--edition", "260423"]), Stage1Abort);
    assert.throws(() => parseStage1RunArgs(["--phase", "nao-existe", "--edition", "260423"]), Stage1Abort);
  });

  it("--edition obrigatório e validado", () => {
    assert.throws(() => parseStage1RunArgs(["--phase", "pre-research"]), Stage1Abort);
    assert.throws(() => parseStage1RunArgs(["--phase", "pre-research", "--edition", "abc"]), Stage1Abort);
  });

  it("pre-research: parse básico ok", () => {
    const o = parseStage1RunArgs(["--phase", "pre-research", "--edition", "260423"]);
    assert.equal(o.phase, "pre-research");
    assert.equal(o.edition, "260423");
    assert.equal(o.auto, false);
  });

  it("--window-days inválido -> Stage1Abort", () => {
    assert.throws(() => parseStage1RunArgs(["--phase", "pre-research", "--edition", "260423", "--window-days", "0"]), Stage1Abort);
    assert.throws(() => parseStage1RunArgs(["--phase", "pre-research", "--edition", "260423", "--window-days", "abc"]), Stage1Abort);
  });

  it("post-score exige --chunk-count >= 2", () => {
    assert.throws(() => parseStage1RunArgs(["--phase", "post-score", "--edition", "260423"]), Stage1Abort);
    assert.throws(() => parseStage1RunArgs(["--phase", "post-score", "--edition", "260423", "--chunk-count", "1"]), Stage1Abort);
    const o = parseStage1RunArgs(["--phase", "post-score", "--edition", "260423", "--chunk-count", "3"]);
    assert.equal(o.chunkCount, 3);
  });

  it("post-select-render exige --selection-json OU --fallback-scored-json, não ambos, não nenhum", () => {
    assert.throws(() => parseStage1RunArgs(["--phase", "post-select-render", "--edition", "260423"]), Stage1Abort);
    assert.throws(
      () =>
        parseStage1RunArgs([
          "--phase",
          "post-select-render",
          "--edition",
          "260423",
          "--selection-json",
          "a.json",
          "--fallback-scored-json",
          "b.json",
        ]),
      Stage1Abort,
    );
    const o1 = parseStage1RunArgs(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "a.json"]);
    assert.equal(o1.selectionJson, "a.json");
    const o2 = parseStage1RunArgs(["--phase", "post-select-render", "--edition", "260423", "--fallback-scored-json", "b.json"]);
    assert.equal(o2.fallbackScoredJson, "b.json");
  });

  it("post-gate exige --md OU --auto, não ambos, não nenhum", () => {
    assert.throws(() => parseStage1RunArgs(["--phase", "post-gate", "--edition", "260423"]), Stage1Abort);
    assert.throws(() => parseStage1RunArgs(["--phase", "post-gate", "--edition", "260423", "--md", "x.md", "--auto"]), Stage1Abort);
    const o1 = parseStage1RunArgs(["--phase", "post-gate", "--edition", "260423", "--auto"]);
    assert.equal(o1.auto, true);
    const o2 = parseStage1RunArgs(["--phase", "post-gate", "--edition", "260423", "--md", "x.md"]);
    assert.equal(o2.md, "x.md");
  });
});

// ---------------------------------------------------------------------------
// Fixture helper: diretório temporário real (mesmo padrão do bloco "0h.2"
// de test/stage-0-run.test.ts) — usado pelas fases com I/O de arquivo
// intenso (post-research-pre-score, post-select-render, post-gate).
// ---------------------------------------------------------------------------

async function withTmpRoot<T>(prefix: string, fn: (root: string, editionDir: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const editionDir = "data/editions/2604/260423";
  nodeMkdirSync(resolve(root, editionDir, "_internal", "scoring-chunks"), { recursive: true });
  nodeMkdirSync(resolve(root, "data"), { recursive: true });
  try {
    return await fn(root, editionDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function tmpDeps(root: string, editionDir: string, overrides: Partial<Stage1RunDeps> = {}): Partial<Stage1RunDeps> {
  return {
    rootDir: root,
    existsSync: (p) => nodeExistsSync(p),
    mkdirSync: (p) => nodeMkdirSync(p, { recursive: true }),
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, c) => writeFileSync(p, c, "utf8"),
    renameFile: (from, to) => renameSync(from, to),
    ...overrides,
  };
}

function writeJson(root: string, relPath: string, data: unknown): void {
  const abs = resolve(root, relPath);
  nodeMkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify(data), "utf8");
}

// ---------------------------------------------------------------------------
// FASE pre-research
// ---------------------------------------------------------------------------

describe("runStage1 --phase pre-research", () => {
  function happyHandlers(overrides: Record<string, (args: string[]) => StepResult> = {}): Record<string, (args: string[]) => StepResult> {
    return {
      "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
      "inbox-drain.ts": () => ok(JSON.stringify({ new_entries: 0, urls: [], topics: [], skipped: false })),
      "fetch-poll-stats.ts": () => ok("{}"),
      "list-active-sources.ts": () => ok(JSON.stringify([])),
      "fetch-rss-batch.ts": () => ok(JSON.stringify({ articles_total: 0 })),
      "extract-inbox-topics.ts": () => ok(JSON.stringify([])),
      "fetch-websearch-batch.ts": () => ok(JSON.stringify({ ok: true })),
      "eia-dispatch-state.ts": () => ok("{}"),
      "log-event.ts": () => ok("{}"),
      ...overrides,
    };
  }

  it("Path A roda com sucesso -> researchPathA true, pendingAgentDispatch vazio", async () => {
    const deps = baseDeps({
      exec: makeFakeExec(happyHandlers()).exec,
      readFile: (p) => {
        if (p.endsWith("websearch-results.json")) return JSON.stringify([{ source: "a" }]);
        if (p.endsWith("researcher-results.json")) return JSON.stringify([]);
        throw new Error(`readFile não mockado: ${p}`);
      },
    });
    const result = await runStage1(["--phase", "pre-research", "--edition", "260423"], deps);
    assert.equal(result.code, 0);
    assert.equal(result.researchPathA, true);
    assert.equal(result.pendingAgentDispatch.length, 0);
    assert.equal(result.editionDir, "data/editions/2604/260423");
  });

  it("BRAVE_API_KEY ausente (exit 3) -> Path B, pendingAgentDispatch com manifest", async () => {
    const writes: Record<string, string> = {};
    const deps = baseDeps({
      exec: makeFakeExec(
        happyHandlers({
          "fetch-websearch-batch.ts": () => fail(3, "BRAVE_API_KEY ausente"),
          "check-source-blocklist.ts": () => ok(JSON.stringify({ kept: [{ name: "A" }], skipped: [{ name: "B" }] })),
        }),
      ).exec,
      readFile: (p) => {
        if (p.endsWith("inbox-topics.json")) return JSON.stringify(["tópico do editor"]);
        throw new Error(`readFile não mockado: ${p}`);
      },
      writeFile: (p, c) => {
        writes[p] = c;
      },
    });
    const result = await runStage1(["--phase", "pre-research", "--edition", "260423"], deps);
    assert.equal(result.code, 0);
    assert.equal(result.researchPathA, false);
    assert.equal(result.pendingAgentDispatch.length, 1);
    assert.equal(result.pendingAgentDispatch[0].step, "1f-path-b");
    assert.equal(result.pendingAgentDispatch[0].agent, "source-researcher + discovery-searcher");
    assert.ok(result.pendingAgentDispatch[0].manifestPath?.includes("stage-1-path-b-manifest.json"));
    // manifest foi escrito com sourcesKept/discoveryQueriesDeterministic
    const manifestKey = Object.keys(writes).find((k) => k.includes("stage-1-path-b-manifest.json"));
    assert.ok(manifestKey);
    const manifest = JSON.parse(writes[manifestKey as string]);
    assert.deepEqual(manifest.sourcesKept, [{ name: "A" }]);
    assert.ok(manifest.discoveryQueriesDeterministic.includes("tópico do editor"));
  });

  // #5891 (validação ao vivo 260821): mesmo contrato do dedup —
  // check-source-blocklist.ts com `--out` escreve o JSON só no arquivo e
  // deixa stdout vazio. Ler do ARQUIVO; stdout vazio não pode zerar sourcesKept.
  it("check-source-blocklist com --out (stdout vazio) -> sourcesKept lido do arquivo", async () => {
    const writes: Record<string, string> = {};
    const deps = baseDeps({
      exec: makeFakeExec(
        happyHandlers({
          "fetch-websearch-batch.ts": () => fail(3, "BRAVE_API_KEY ausente"),
          "check-source-blocklist.ts": () => ok(""), // contrato real: stdout vazio
        }),
      ).exec,
      existsSync: (p) => p.includes("sources-kept-skipped.json"),
      readFile: (p) => {
        if (p.endsWith("sources-kept-skipped.json")) return JSON.stringify({ kept: [{ name: "A" }], skipped: [{ name: "B" }] });
        if (p.endsWith("inbox-topics.json")) return "[]";
        throw new Error(`readFile não mockado: ${p}`);
      },
      writeFile: (p, c) => {
        writes[p] = c;
      },
    });
    const result = await runStage1(["--phase", "pre-research", "--edition", "260423"], deps);
    assert.equal(result.code, 0);
    assert.equal(result.researchPathA, false);
    assert.equal(result.pendingAgentDispatch.length, 1);
    const manifestKey = Object.keys(writes).find((k) => k.includes("stage-1-path-b-manifest.json"));
    assert.ok(manifestKey);
    const manifest = JSON.parse(writes[manifestKey as string]) as { sourcesKept: unknown[] };
    assert.deepEqual(manifest.sourcesKept, [{ name: "A" }]);
  });

  it("WEBSEARCH_BACKEND=agents força Path B mesmo com key presente (sem chamar fetch-websearch-batch)", async () => {
    const { exec, calls } = makeFakeExec(
      happyHandlers({
        "check-source-blocklist.ts": () => ok(JSON.stringify({ kept: [], skipped: [] })),
      }),
    );
    const deps = baseDeps({
      exec,
      hasEnv: (name) => (name === "WEBSEARCH_BACKEND" ? "agents" : undefined),
      readFile: (p) => {
        if (p.endsWith("inbox-topics.json")) return "[]";
        throw new Error(`readFile não mockado: ${p}`);
      },
      writeFile: () => {},
    });
    const result = await runStage1(["--phase", "pre-research", "--edition", "260423"], deps);
    assert.equal(result.code, 0);
    assert.equal(result.researchPathA, false);
    assert.equal(
      calls.some((c) => c.script.endsWith("fetch-websearch-batch.ts")),
      false,
    );
  });

  it("erro inesperado do Path A (exit != 0,3) -> Stage1Abort, code 1", async () => {
    const deps = baseDeps({
      exec: makeFakeExec(happyHandlers({ "fetch-websearch-batch.ts": () => fail(9, "boom") })).exec,
    });
    const result = await runStage1(["--phase", "pre-research", "--edition", "260423"], deps);
    assert.equal(result.code, 1);
  });

  it("01-eia.md já existe -> não dispatcha eia-compose (resume)", async () => {
    const { spawnDetached, calls: spawnCalls } = noopSpawnDetached();
    const deps = baseDeps({
      exec: makeFakeExec(happyHandlers()).exec,
      spawnDetached,
      existsSync: (p) => p.endsWith("01-eia.md"),
      readFile: (p) => {
        if (p.endsWith("websearch-results.json")) return "[]";
        if (p.endsWith("researcher-results.json")) return "[]";
        throw new Error(`readFile não mockado: ${p}`);
      },
    });
    await runStage1(["--phase", "pre-research", "--edition", "260423"], deps);
    assert.equal(
      spawnCalls.some((c) => c.script.endsWith("eia-compose.ts")),
      false,
    );
  });

  it("01-eia.md ausente -> dispatcha eia-compose detached + grava eia-dispatch-state", async () => {
    const { spawnDetached, calls: spawnCalls } = noopSpawnDetached();
    const { exec, calls: execCalls } = makeFakeExec(happyHandlers());
    const deps = baseDeps({
      exec,
      spawnDetached,
      existsSync: () => false,
      readFile: (p) => {
        if (p.endsWith("websearch-results.json")) return "[]";
        if (p.endsWith("researcher-results.json")) return "[]";
        throw new Error(`readFile não mockado: ${p}`);
      },
    });
    await runStage1(["--phase", "pre-research", "--edition", "260423"], deps);
    assert.ok(spawnCalls.some((c) => c.script.endsWith("eia-compose.ts")));
    assert.ok(execCalls.some((c) => c.script.endsWith("eia-dispatch-state.ts")));
  });

  it("inbox-drain skipped -> nunca aborta, apenas nota warn", async () => {
    const deps = baseDeps({
      exec: makeFakeExec(
        happyHandlers({ "inbox-drain.ts": () => ok(JSON.stringify({ skipped: true, reason: "auth_expired" })) }),
      ).exec,
      readFile: (p) => {
        if (p.endsWith("websearch-results.json")) return "[]";
        if (p.endsWith("researcher-results.json")) return "[]";
        throw new Error(`readFile não mockado: ${p}`);
      },
    });
    const result = await runStage1(["--phase", "pre-research", "--edition", "260423"], deps);
    assert.equal(result.code, 0);
    assert.ok(result.notes.some((n) => n.includes("auth_expired")));
  });
});

// ---------------------------------------------------------------------------
// FASE post-research-pre-score
// ---------------------------------------------------------------------------

describe("runStage1 --phase post-research-pre-score", () => {
  function seedFixtures(root: string, editionDir: string): void {
    writeJson(root, `${editionDir}/_internal/researcher-results.json`, []);
    writeJson(root, `${editionDir}/_internal/tmp-articles-raw.json`, [{ url: "https://a.com" }, { url: "https://b.com" }]);
    writeJson(root, `${editionDir}/_internal/link-verify-all.json`, [
      { url: "https://a.com", verdict: "accessible" },
      { url: "https://b.com", verdict: "paywall" },
    ]);
  }

  function happyHandlers(chunkCount: number, overrides: Record<string, (args: string[]) => StepResult> = {}): Record<string, (args: string[]) => StepResult> {
    return {
      "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
      "record-source-runs.ts": () => ok(JSON.stringify({ summary: { sources_with_consecutive_failures_ge3: [] } })),
      "assemble-research-pool.ts": () => ok("{}"),
      "load-carry-over.ts": () => ok(JSON.stringify({ prev: null })),
      "inject-inbox-urls.ts": () => ok("{}"),
      "validate-stage-1-injection.ts": () => ok("{}"),
      "pipeline-sentinel.ts": (args) => (args[0] === "assert-marker" ? ok("{}") : ok("{}")),
      "verify-accessibility.ts": () => ok("{}"),
      "expand-inbox-aggregators.ts": () => ok("{}"),
      "enrich-inbox-articles.ts": () => ok("{}"),
      "dedup.ts": () => ok(JSON.stringify({ kept: [{ url: "https://a.com" }], editorSubmittedLost: [] })),
      "categorize.ts": () => ok("{}"),
      "enrich-primary-source.ts": () => ok("{}"),
      "verify-summary-integrity.ts": () => ok(JSON.stringify({ ok: true })),
      "check-promoted-dedup.ts": () => ok(JSON.stringify({ demoted: [], checked: 0 })),
      "measure-type-hint-divergence.ts": () => ok("{}"),
      "topic-cluster.ts": () => ok("{}"),
      "filter-date-window.ts": () => ok("{}"),
      "research-review-dates.ts": () => ok(JSON.stringify({ stats: {} })),
      "split-articles-for-scoring.ts": () => ok(JSON.stringify({ chunk_count: chunkCount, chunk_files: [] })),
      "log-event.ts": () => ok("{}"),
      "render-halt-banner.ts": () => ok("HALT BANNER"),
      ...overrides,
    };
  }

  it("caminho chunked: chunk_count > 1 -> pendingAgentDispatch pro scorer-chunk", async () => {
    return withTmpRoot("stage-1-run-p2-", (root, editionDir) => {
      seedFixtures(root, editionDir);
      const { exec } = makeFakeExec(happyHandlers(3));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-research-pre-score", "--edition", "260423"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.equal(result.needsScorerFallback, false);
        assert.equal(result.chunkCount, 3);
        assert.equal(result.pendingAgentDispatch.length, 1);
        assert.equal(result.pendingAgentDispatch[0].step, "1q.2");
      });
    });
  });

  it("pool pequeno: chunk_count <= 1 -> needsScorerFallback true, pendingAgentDispatch pro scorer", async () => {
    return withTmpRoot("stage-1-run-p2-fb-", (root, editionDir) => {
      seedFixtures(root, editionDir);
      const { exec } = makeFakeExec(happyHandlers(1));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-research-pre-score", "--edition", "260423"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.equal(result.needsScorerFallback, true);
        assert.equal(result.pendingAgentDispatch[0].step, "1q-fallback");
        assert.equal(result.pendingAgentDispatch[0].agent, "scorer");
      });
    });
  });

  it("marker inject-inbox-urls ausente -> HALT (code 2)", async () => {
    return withTmpRoot("stage-1-run-p2-marker-", (root, editionDir) => {
      seedFixtures(root, editionDir);
      const { exec } = makeFakeExec(
        happyHandlers(3, { "pipeline-sentinel.ts": (args) => (args[0] === "assert-marker" ? fail(1, "marker ausente") : ok("{}")) }),
      );
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-research-pre-score", "--edition", "260423"], deps).then((result) => {
        assert.equal(result.code, 2);
        assert.ok(result.haltRequired);
        assert.ok(result.haltRequired!.reason.includes("marker"));
      });
    });
  });

  it("validate-stage-1-injection exit 1 -> Stage1Abort (code 1)", async () => {
    return withTmpRoot("stage-1-run-p2-inj-", (root, editionDir) => {
      seedFixtures(root, editionDir);
      const { exec } = makeFakeExec(happyHandlers(3, { "validate-stage-1-injection.ts": () => fail(1, "skip detectado") }));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-research-pre-score", "--edition", "260423"], deps).then((result) => {
        assert.equal(result.code, 1);
      });
    });
  });

  it("verify-summary-integrity exit 1 (tmp-categorized.json) -> Stage1Abort", async () => {
    return withTmpRoot("stage-1-run-p2-integrity-", (root, editionDir) => {
      seedFixtures(root, editionDir);
      const { exec } = makeFakeExec(happyHandlers(3, { "verify-summary-integrity.ts": () => fail(1, "regressão") }));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-research-pre-score", "--edition", "260423"], deps).then((result) => {
        assert.equal(result.code, 1);
      });
    });
  });

  it("--agent-research-results é mergeado em researcher-results.json antes de seguir", async () => {
    return withTmpRoot("stage-1-run-p2-merge-", (root, editionDir) => {
      seedFixtures(root, editionDir);
      writeJson(root, "agent-results.json", [{ source: "discovery:x", outcome: "ok", articles: [] }]);
      const { exec } = makeFakeExec(happyHandlers(3));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-research-pre-score", "--edition", "260423", "--agent-research-results", "agent-results.json"], deps).then(
        (result) => {
          assert.equal(result.code, 0);
          const merged = JSON.parse(readFileSync(resolve(root, editionDir, "_internal", "researcher-results.json"), "utf8"));
          assert.equal(merged.length, 1);
          assert.equal(merged[0].source, "discovery:x");
        },
      );
    });
  });

  it("editorSubmittedLost não-vazio -> nota de warning no report", async () => {
    return withTmpRoot("stage-1-run-p2-lost-", (root, editionDir) => {
      seedFixtures(root, editionDir);
      const { exec } = makeFakeExec(
        happyHandlers(3, { "dedup.ts": () => ok(JSON.stringify({ kept: [], editorSubmittedLost: [{ title: "X", dedup_note: "dup" }] })) }),
      );
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-research-pre-score", "--edition", "260423"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.ok(result.notes.some((n) => n.includes("submissão(ões) do editor removida")));
      });
    });
  });

  // #5891 (validação ao vivo 260821): contrato REAL do dedup.ts com `--out` —
  // escreve o JSON no arquivo e deixa o stdout VAZIO (a nota vai pra stderr).
  // O mock antigo devolvia JSON no stdout e escondia o bug: `tmp-kept.json`
  // saía `[]` e o pool inteiro (categorize → score → render) zerava sem erro.
  it("dedup com --out (stdout vazio, JSON só no arquivo) -> tmp-kept.json populado do arquivo", async () => {
    return withTmpRoot("stage-1-run-p2-dedupfile-", (root, editionDir) => {
      seedFixtures(root, editionDir);
      const { exec } = makeFakeExec(
        happyHandlers(3, {
          "dedup.ts": (args) => {
            const outIdx = args.indexOf("--out");
            assert.ok(outIdx >= 0, "dedup.ts deve ser invocado com --out");
            writeJson(root, args[outIdx + 1], { kept: [{ url: "https://a.com" }, { url: "https://c.com" }], editorSubmittedLost: [] });
            return ok(""); // contrato real: stdout vazio
          },
        }),
      );
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-research-pre-score", "--edition", "260423"], deps).then((result) => {
        assert.equal(result.code, 0);
        const keptRaw = readFileSync(resolve(root, `${editionDir}/_internal/tmp-kept.json`), "utf8");
        const kept = JSON.parse(keptRaw) as Array<{ url: string }>;
        assert.equal(kept.length, 2, "tmp-kept.json deve conter os itens lidos do ARQUIVO de saída do dedup, não do stdout vazio");
        assert.equal(kept[0].url, "https://a.com");
      });
    });
  });
});

// ---------------------------------------------------------------------------
// FASE post-score
// ---------------------------------------------------------------------------

describe("runStage1 --phase post-score", () => {
  it("merge ok -> pendingAgentDispatch pro scorer-select", async () => {
    const deps = baseDeps({
      exec: makeFakeExec({
        "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
        "merge-scored-chunks.ts": () => ok(JSON.stringify({ pool_size: 10, scored_count: 10, finalists_count: 6, incomplete: false })),
        "verify-summary-integrity.ts": () => ok(JSON.stringify({ ok: true })),
      }).exec,
    });
    const result = await runStage1(["--phase", "post-score", "--edition", "260423", "--chunk-count", "3"], deps);
    assert.equal(result.code, 0);
    assert.equal(result.pendingAgentDispatch.length, 1);
    assert.equal(result.pendingAgentDispatch[0].step, "1q.4");
    assert.equal(result.pendingAgentDispatch[0].agent, "scorer-select");
  });

  it("merge incomplete: true -> segue com warn (código 0)", async () => {
    const deps = baseDeps({
      exec: makeFakeExec({
        "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
        "merge-scored-chunks.ts": () => ok(JSON.stringify({ incomplete: true })),
        "verify-summary-integrity.ts": () => ok(JSON.stringify({ ok: true })),
      }).exec,
    });
    const result = await runStage1(["--phase", "post-score", "--edition", "260423", "--chunk-count", "3"], deps);
    assert.equal(result.code, 0);
    assert.ok(result.notes.some((n) => n.includes("incomplete")));
  });

  it("merge catastrófico (exit 2) -> code 1, NÃO segue, sem pendingAgentDispatch", async () => {
    const deps = baseDeps({
      exec: makeFakeExec({
        "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
        "merge-scored-chunks.ts": () => fail(2, "catastrophic"),
      }).exec,
    });
    const result = await runStage1(["--phase", "post-score", "--edition", "260423", "--chunk-count", "3"], deps);
    assert.equal(result.code, 1);
    assert.equal(result.pendingAgentDispatch.length, 0);
    assert.equal(result.mergeCatastrophic, true);
  });

  it("merge exit 1 (erro de invocação) -> Stage1Abort, code 1", async () => {
    const deps = baseDeps({
      exec: makeFakeExec({
        "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
        "merge-scored-chunks.ts": () => fail(1, "args malformados"),
      }).exec,
    });
    const result = await runStage1(["--phase", "post-score", "--edition", "260423", "--chunk-count", "3"], deps);
    assert.equal(result.code, 1);
  });

  it("verify-summary-integrity exit 1 (tmp-finalists.json) -> Stage1Abort", async () => {
    const deps = baseDeps({
      exec: makeFakeExec({
        "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
        "merge-scored-chunks.ts": () => ok(JSON.stringify({ incomplete: false })),
        "verify-summary-integrity.ts": () => fail(1, "regressão"),
      }).exec,
    });
    const result = await runStage1(["--phase", "post-score", "--edition", "260423", "--chunk-count", "3"], deps);
    assert.equal(result.code, 1);
  });

  it("chunk-scores passados com os paths canônicos scored-chunk-{i}.json", async () => {
    const { exec, calls } = makeFakeExec({
      "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
      "merge-scored-chunks.ts": () => ok(JSON.stringify({ incomplete: false })),
      "verify-summary-integrity.ts": () => ok(JSON.stringify({ ok: true })),
    });
    const deps = baseDeps({ exec });
    await runStage1(["--phase", "post-score", "--edition", "260423", "--chunk-count", "2"], deps);
    const mergeCall = calls.find((c) => c.script.endsWith("merge-scored-chunks.ts"));
    const chunkScoresArg = mergeCall!.args[mergeCall!.args.indexOf("--chunk-scores") + 1];
    assert.ok(chunkScoresArg.includes("scored-chunk-0.json"));
    assert.ok(chunkScoresArg.includes("scored-chunk-1.json"));
  });
});

// ---------------------------------------------------------------------------
// FASE post-select-render
// ---------------------------------------------------------------------------

describe("runStage1 --phase post-select-render", () => {
  function happyHandlers(overrides: Record<string, (args: string[]) => StepResult> = {}): Record<string, (args: string[]) => StepResult> {
    return {
      "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
      "assemble-scored.ts": () => ok("{}"),
      "finalize-stage1.ts": () => ok("{}"),
      "dedup-intra-edition.ts": () => ok("{}"),
      "dedup-evergreen-buckets.ts": () => ok("{}"),
      "render-categorized-md.ts": () => ok("{}"),
      "validate-lancamentos.ts": () => ok("{}"),
      "review-use-melhor.ts": () => ok(JSON.stringify({ suspicious: [] })),
      "review-highlight-source.ts": () => ok(JSON.stringify({ flagged: [] })),
      "review-highlight-official-swap.ts": () => ok(JSON.stringify({ suggestions: [] })),
      "validate-stage-1-completeness.ts": () => ok("{}"),
      "validate-stage-1-output.ts": () => ok(JSON.stringify({ assertions: [], blocking_count: 0, warning_count: 0 })),
      "check-invariants.ts": () => ok(JSON.stringify({ passed: true })),
      "log-stage-1-payload-sizes.ts": () => ok("{}"),
      "check-highlight-themes.ts": () => ok("{}"),
      "log-event.ts": () => ok("{}"),
      "render-halt-banner.ts": () => ok("HALT"),
      ...overrides,
    };
  }

  function seedScored(root: string, editionDir: string, opts: { highlightsCount?: number } = {}): void {
    const n = opts.highlightsCount ?? 6;
    writeJson(
      root,
      `${editionDir}/_internal/tmp-scored.json`,
      { highlights: Array.from({ length: n }, (_, i) => ({ url: `https://h${i}.com`, score: 100 - i })), runners_up: [{ url: "https://r1.com", score: 50 }] },
    );
    writeJson(root, `${editionDir}/_internal/tmp-finalized.json`, {
      highlights: [{ url: "https://h0.com", verifier: "x" }],
      runners_up: [],
      lancamento: [1, 2, 3],
      radar: Array(8).fill(0),
      use_melhor: [1, 2, 3],
      video: [],
      clusters: [],
    });
  }

  it("caminho chunked (--selection-json): assemble + finalize + render, code 0", async () => {
    return withTmpRoot("stage-1-run-p4-sel-", (root, editionDir) => {
      seedScored(root, editionDir);
      writeJson(root, "selection.json", { highlights: [], runners_up: [] });
      const { exec } = makeFakeExec(happyHandlers());
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "selection.json"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.ok(result.categorizedPath);
        assert.ok(result.mdPath);
      });
    });
  });

  // Achado ao vivo 260824 (edição 260824): finalize-stage1.ts real só escreve
  // os 4 buckets em tmp-finalized.json — nunca `highlights`/`runners_up`
  // (bypassam join de score e domain cap por design, docstring do próprio
  // script). O mock `seedScored` acima pré-semeava tmp-finalized.json JÁ com
  // highlights, mascarando o gap: em produção o merge nunca acontecia e toda
  // edição saía com 0 destaques. Este teste reproduz o shape REAL (sem
  // highlights/runners_up em tmp-finalized.json) e garante que
  // 01-categorized.json final carrega os highlights de tmp-scored.json.
  it("tmp-finalized.json sem highlights/runners_up (shape real do finalize-stage1.ts) -> categorized.json carrega de tmp-scored.json (#5952-bug)", async () => {
    return withTmpRoot("stage-1-run-p4-nohl-", (root, editionDir) => {
      writeJson(root, `${editionDir}/_internal/tmp-scored.json`, {
        highlights: Array.from({ length: 6 }, (_, i) => ({ url: `https://h${i}.com`, score: 100 - i })),
        runners_up: [{ url: "https://r1.com", score: 50 }],
      });
      // Shape real de finalize-stage1.ts: só os 4 buckets, sem highlights/runners_up.
      writeJson(root, `${editionDir}/_internal/tmp-finalized.json`, {
        lancamento: [1, 2, 3],
        radar: Array(8).fill(0),
        use_melhor: [1, 2, 3],
        video: [],
      });
      writeJson(root, "selection.json", {});
      const { exec } = makeFakeExec(happyHandlers());
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "selection.json"], deps).then((result) => {
        assert.equal(result.code, 0);
        const categorized = JSON.parse(readFileSync(resolve(root, result.categorizedPath as string), "utf8"));
        assert.equal(categorized.highlights.length, 6);
        assert.equal(categorized.runners_up.length, 1);
      });
    });
  });

  it("caminho fallback (--fallback-scored-json): pula assemble-scored, code 0", async () => {
    return withTmpRoot("stage-1-run-p4-fb-", (root, editionDir) => {
      writeJson(root, "fallback-scored.json", { highlights: Array.from({ length: 6 }, (_, i) => ({ url: `https://h${i}.com`, score: 100 - i })), runners_up: [] });
      writeJson(root, `${editionDir}/_internal/tmp-finalized.json`, {
        highlights: [],
        runners_up: [],
        lancamento: [1, 2, 3],
        radar: Array(8).fill(0),
        use_melhor: [1, 2, 3],
        video: [],
        clusters: [],
      });
      const { exec, calls } = makeFakeExec(happyHandlers());
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--fallback-scored-json", "fallback-scored.json"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.equal(
          calls.some((c) => c.script.endsWith("assemble-scored.ts")),
          false,
        );
      });
    });
  });

  it("scorer produziu < 6 highlights -> promoção de runners_up registrada (§1r)", async () => {
    return withTmpRoot("stage-1-run-p4-promo-", (root, editionDir) => {
      seedScored(root, editionDir, { highlightsCount: 4 });
      writeJson(root, "selection.json", {});
      const { exec } = makeFakeExec(happyHandlers());
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "selection.json"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.ok(result.notes.some((n) => n.includes("promovi")));
      });
    });
  });

  it("validate-stage-1-completeness exit 1 -> HALT (code 2)", async () => {
    return withTmpRoot("stage-1-run-p4-completeness-", (root, editionDir) => {
      seedScored(root, editionDir);
      writeJson(root, "selection.json", {});
      const { exec } = makeFakeExec(happyHandlers({ "validate-stage-1-completeness.ts": () => fail(1, "1f skipado") }));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "selection.json"], deps).then((result) => {
        assert.equal(result.code, 2);
        assert.ok(result.haltRequired);
      });
    });
  });

  it("validate-stage-1-output blocker (exit 2) -> HALT (code 2)", async () => {
    return withTmpRoot("stage-1-run-p4-blocker-", (root, editionDir) => {
      seedScored(root, editionDir);
      writeJson(root, "selection.json", {});
      const { exec } = makeFakeExec(happyHandlers({ "validate-stage-1-output.ts": () => fail(2, "blocker") }));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "selection.json"], deps).then((result) => {
        assert.equal(result.code, 2);
      });
    });
  });

  it("validate-stage-1-output erro de uso (exit 3) -> Stage1Abort, code 1", async () => {
    return withTmpRoot("stage-1-run-p4-usage-", (root, editionDir) => {
      seedScored(root, editionDir);
      writeJson(root, "selection.json", {});
      const { exec } = makeFakeExec(happyHandlers({ "validate-stage-1-output.ts": () => fail(3, "args inválidos") }));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "selection.json"], deps).then((result) => {
        assert.equal(result.code, 1);
      });
    });
  });

  it("check-invariants categorized-has-eia-section exit 1 -> HALT (code 2)", async () => {
    return withTmpRoot("stage-1-run-p4-invariants-", (root, editionDir) => {
      seedScored(root, editionDir);
      writeJson(root, "selection.json", {});
      const { exec } = makeFakeExec(happyHandlers({ "check-invariants.ts": () => fail(1, "sem seção É IA?") }));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "selection.json"], deps).then((result) => {
        assert.equal(result.code, 2);
      });
    });
  });

  it("validate-lancamentos falha -> warning coletado, NÃO bloqueia (code 0)", async () => {
    return withTmpRoot("stage-1-run-p4-lanc-", (root, editionDir) => {
      seedScored(root, editionDir);
      writeJson(root, "selection.json", {});
      const { exec } = makeFakeExec(happyHandlers({ "validate-lancamentos.ts": () => fail(1, "URL não oficial") }));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "selection.json"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.equal((result.lancamentosWarnings as string[]).length, 1);
      });
    });
  });

  it("minSectionWarnings expostos a partir do tmp-finalized.json", async () => {
    return withTmpRoot("stage-1-run-p4-minsec-", (root, editionDir) => {
      writeJson(root, `${editionDir}/_internal/tmp-scored.json`, { highlights: Array.from({ length: 6 }, (_, i) => ({ score: 100 - i })), runners_up: [] });
      writeJson(root, `${editionDir}/_internal/tmp-finalized.json`, {
        highlights: [],
        runners_up: [],
        lancamento: [1],
        radar: [1],
        use_melhor: [],
        video: [],
        clusters: [],
      });
      writeJson(root, "selection.json", {});
      const { exec } = makeFakeExec(happyHandlers());
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-select-render", "--edition", "260423", "--selection-json", "selection.json"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.equal((result.minSectionWarnings as string[]).length, 3);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// FASE post-gate
// ---------------------------------------------------------------------------

describe("runStage1 --phase post-gate", () => {
  function happyHandlers(overrides: Record<string, (args: string[]) => StepResult> = {}): Record<string, (args: string[]) => StepResult> {
    return {
      "find-current-edition.ts": () => ok("data/editions/2604/260423\n"),
      "apply-gate-edits.ts": () => ok("{}"),
      "render-categorized-md.ts": () => ok("{}"),
      "validate-lancamentos.ts": () => ok("{}"),
      "check-invariants.ts": () => ok(JSON.stringify({ passed: true })),
      "experiment-d3-radar.ts": () => fail(2, "disabled"),
      "pipeline-sentinel.ts": (args) => (args[0] === "write" ? ok("sentinel escrito") : ok("{}")),
      "update-stage-status.ts": () => ok("{}"),
      "capture-stage-usage.ts": () => ok(JSON.stringify({ source: "transcript" })),
      "log-event.ts": () => ok("{}"),
      ...overrides,
    };
  }

  it("--auto: aplica gate sem edição humana, pula re-render/validate-lancamentos", async () => {
    return withTmpRoot("stage-1-run-p5-auto-", (root, editionDir) => {
      writeFileSync(resolve(root, "data", "inbox.md"), "conteúdo do inbox", "utf8");
      const { exec, calls } = makeFakeExec(happyHandlers());
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec, now: () => new Date("2026-04-23T08:00:00Z") }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-gate", "--edition", "260423", "--auto"], deps).then((result) => {
        assert.equal(result.code, 0);
        const applyCall = calls.find((c) => c.script.endsWith("apply-gate-edits.ts"));
        assert.ok(applyCall!.args.includes("--auto"));
        assert.equal(
          calls.some((c) => c.script.endsWith("render-categorized-md.ts")),
          false,
        );
        // inbox arquivado
        assert.ok(nodeExistsSync(resolve(root, "data", "inbox-archive", "2026-04-23.md")));
        assert.equal(readFileSync(resolve(root, "data", "inbox.md"), "utf8"), "");
      });
    });
  });

  it("--md: aplica gate + re-renderiza MD + valida lançamentos", async () => {
    return withTmpRoot("stage-1-run-p5-md-", (root, editionDir) => {
      writeFileSync(resolve(root, "data", "inbox.md"), "conteúdo", "utf8");
      const { exec, calls } = makeFakeExec(happyHandlers());
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec, now: () => new Date("2026-04-23T08:00:00Z") }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-gate", "--edition", "260423", "--md", `${editionDir}/01-categorized.md`], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.ok(calls.some((c) => c.script.endsWith("render-categorized-md.ts")));
        assert.ok(calls.some((c) => c.script.endsWith("validate-lancamentos.ts")));
      });
    });
  });

  it("check-invariants pós-gate falha -> warn, NÃO bloqueia (sentinel ainda escrito)", async () => {
    return withTmpRoot("stage-1-run-p5-inv-", (root, editionDir) => {
      const { exec, calls } = makeFakeExec(happyHandlers({ "check-invariants.ts": () => fail(1, "bug downstream") }));
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-gate", "--edition", "260423", "--auto"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.ok(calls.some((c) => c.script.endsWith("pipeline-sentinel.ts") && c.args[0] === "write"));
      });
    });
  });

  it("sentinel write falha -> warn, não bloqueia", async () => {
    return withTmpRoot("stage-1-run-p5-sentinel-", (root, editionDir) => {
      const { exec } = makeFakeExec(
        happyHandlers({ "pipeline-sentinel.ts": (args) => (args[0] === "write" ? fail(1, "erro") : ok("{}")) }),
      );
      const deps = { ...baseDeps(), ...tmpDeps(root, editionDir, { exec }) } as Stage1RunDeps;
      return runStage1(["--phase", "post-gate", "--edition", "260423", "--auto"], deps).then((result) => {
        assert.equal(result.code, 0);
        assert.ok(result.notes.some((n) => n.includes("sentinel_write_failed")));
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Erro inesperado — fase indeterminada não trava o result shape
// ---------------------------------------------------------------------------

describe("runStage1 — erro inesperado", () => {
  it("exceção não-Stage1Abort é convertida (code 1, mensagem preservada)", async () => {
    const deps = baseDeps({
      exec: makeFakeExec({
        "find-current-edition.ts": () => {
          throw new Error("boom inesperado");
        },
      }).exec,
    });
    const result = await runStage1(["--phase", "pre-research", "--edition", "260423"], deps);
    assert.equal(result.code, 1);
    assert.ok(result.notes.some((n) => n.includes("boom inesperado")));
  });
});

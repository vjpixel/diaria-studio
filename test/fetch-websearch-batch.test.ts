/**
 * test/fetch-websearch-batch.test.ts (#1555)
 *
 * Tests for the pure helpers in fetch-websearch-batch.ts.
 * The full main() with rate-limited dispatch is not tested in unit (integration concern),
 * EXCEPT for the checkpoint-lifecycle regression tests at the bottom (#7970) — those exercise
 * `main()` end-to-end with a mocked `fetch` (no real Brave calls, no network), because the bug
 * they cover lives in main()'s own wiring (when the checkpoint file gets deleted), not in any
 * pure helper.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processResult,
  buildSourceQuery,
  shouldRecordBraveResponse,
  checkpointPathFor,
  parseCheckpointLines,
  planQueriesWithCheckpoint,
  main,
  type RunRecord,
  type PlannedQuery,
} from "../scripts/fetch-websearch-batch.ts";

describe("processResult", () => {
  const cutoff = "2026-05-25";

  it("keeps AI-relevant result within date window", () => {
    const r = processResult(
      {
        title: "OpenAI launches new GPT model",
        url: "https://openai.com/blog/new-gpt",
        description: "An update on our language model lineup",
        page_age: "2026-05-27T10:00:00Z",
      },
      "OpenAI",
      cutoff,
    );
    assert.ok(r.kept, "should keep AI-relevant recent article");
    assert.equal(r.kept?.source, "OpenAI");
    assert.equal(r.kept?.url, "https://openai.com/blog/new-gpt");
    assert.equal(r.kept?.date, "2026-05-27");
  });

  it("filters by date when page_age is before cutoff", () => {
    const r = processResult(
      {
        title: "OpenAI launches GPT model",
        url: "https://openai.com/blog/x",
        description: "AI thing",
        page_age: "2026-05-20T10:00:00Z",
      },
      "OpenAI",
      cutoff,
    );
    assert.equal(r.kept, null);
    assert.equal(r.reason, "date");
  });

  it("filters out aggregator URLs", () => {
    const r = processResult(
      {
        title: "AI roundup of the week",
        url: "https://flipboard.com/article/123",
        description: "Top AI stories about LLM and machine learning",
      },
      "WebSearch",
      cutoff,
    );
    assert.equal(r.kept, null);
    assert.equal(r.reason, "aggregator");
  });

  it("filters out non-AI-relevant results", () => {
    const r = processResult(
      {
        title: "Restaurant review: New Italian place opens",
        url: "https://example.com/food",
        description: "The pasta was great and the wine list extensive",
      },
      "WebSearch",
      cutoff,
    );
    assert.equal(r.kept, null);
    assert.equal(r.reason, "relevance");
  });

  it("strips Brave's <strong> highlight tags from title and summary", () => {
    const r = processResult(
      {
        title: "<strong>OpenAI</strong> launches AI model",
        url: "https://openai.com/x",
        description: "New <strong>LLM</strong> announcement",
        page_age: "2026-05-27T10:00:00Z",
      },
      "OpenAI",
      cutoff,
    );
    assert.ok(r.kept);
    assert.equal(r.kept?.title, "OpenAI launches AI model");
    assert.equal(r.kept?.summary, "New LLM announcement");
  });

  it("allows article through when page_age missing (verify-dates handles downstream)", () => {
    const r = processResult(
      {
        title: "AI model update",
        url: "https://openai.com/x",
        description: "GPT changes",
        // no page_age
      },
      "OpenAI",
      cutoff,
    );
    assert.ok(r.kept);
    assert.equal(r.kept?.date, undefined);
  });

  it("marks discovered_source=true when discovered=true", () => {
    const r = processResult(
      {
        title: "AI breakthrough in LLM research",
        url: "https://example.com/x",
        description: "New transformer architecture",
        page_age: "2026-05-27T10:00:00Z",
      },
      "discovery: LLM",
      cutoff,
      true,
    );
    assert.ok(r.kept);
    assert.equal(r.kept?.discovered_source, true);
  });

  it("does NOT set discovered_source when discovered=false", () => {
    const r = processResult(
      {
        title: "AI breakthrough in LLM",
        url: "https://example.com/x",
        description: "transformer",
        page_age: "2026-05-27T10:00:00Z",
      },
      "OpenAI",
      cutoff,
      false,
    );
    assert.ok(r.kept);
    assert.equal(r.kept?.discovered_source, undefined);
  });
});

// (#3389) REGRESSÃO: raiz do falso-positivo persistente do alarme critical
// (#3002/#3122/#3271/#3307/#3389). Antes deste fix, o guard em runQuery só
// gravava crédito para status ok/rate_limited — uma resposta 402 "usage limit
// exceeded" (free tier esgotado) descartava o header quota_remaining mesmo
// quando presente, congelando `quota_remaining_last_seen` no último valor
// pré-exaustão pelo resto do mês. Este teste caracteriza a decisão correta:
// gravar (sem contar como query real — ver test/brave-credits.test.ts) sempre
// que o header vier junto do erro.
describe("shouldRecordBraveResponse (#3389)", () => {
  it("grava sempre que status é ok", () => {
    assert.equal(shouldRecordBraveResponse({ status: "ok" }), true);
  });

  it("grava sempre que status é rate_limited (429), mesmo sem quota_remaining", () => {
    assert.equal(shouldRecordBraveResponse({ status: "rate_limited" }), true);
  });

  it("grava quando status é error MAS o header quota_remaining veio preenchido (402 com header) — o fix do #3389", () => {
    assert.equal(shouldRecordBraveResponse({ status: "error", quota_remaining: 0 }), true);
    assert.equal(shouldRecordBraveResponse({ status: "error", quota_remaining: 49 }), true);
  });

  it("NÃO grava quando status é error e não há quota_remaining (comportamento pré-#3389 preservado)", () => {
    assert.equal(shouldRecordBraveResponse({ status: "error" }), false);
    assert.equal(shouldRecordBraveResponse({ status: "error", quota_remaining: undefined }), false);
  });
});

describe("buildSourceQuery", () => {
  it("prefixes site: when site_query lacks it", () => {
    const q = buildSourceQuery({ name: "OpenAI", site_query: "openai.com" });
    assert.match(q, /^site:openai\.com /);
    assert.match(q, /artificial intelligence/);
  });

  it("preserves site: prefix when already present", () => {
    const q = buildSourceQuery({ name: "OpenAI", site_query: "site:openai.com" });
    assert.match(q, /^site:openai\.com /);
    assert.doesNotMatch(q, /site:site:/);
  });

  it("includes AI terms in PT and EN", () => {
    const q = buildSourceQuery({ name: "X", site_query: "x.com" });
    assert.match(q, /inteligência artificial/i);
    assert.match(q, /artificial intelligence/i);
  });
});

// #7944: checkpoint por query — evita re-gastar crédito Brave a cada
// restart do Stage 1. Ver "Checkpoint por query (#7944)" em
// scripts/fetch-websearch-batch.ts pro racional completo.
describe("checkpointPathFor", () => {
  it("deriva o path do checkpoint a partir do --out final", () => {
    assert.equal(
      checkpointPathFor("/repo/data/editions/260904/_internal/websearch-results.json"),
      "/repo/data/editions/260904/_internal/websearch-results.checkpoint.jsonl",
    );
  });

  it("é case-insensitive pra extensão .json", () => {
    assert.equal(checkpointPathFor("/x/out.JSON"), "/x/out.checkpoint.jsonl");
  });
});

describe("parseCheckpointLines", () => {
  function rec(source: string, query_used: string, outcome: RunRecord["outcome"]): RunRecord {
    return { source, query_used, outcome, duration_ms: 1, method: "websearch_brave", articles: [] };
  }

  it("retorna [] para arquivo vazio", () => {
    assert.deepEqual(parseCheckpointLines(""), []);
  });

  it("parseia linhas JSONL válidas", () => {
    const raw = `${JSON.stringify(rec("OpenAI", "site:openai.com AI", "ok"))}\n${JSON.stringify(rec("Anthropic", "site:anthropic.com AI", "empty"))}\n`;
    const parsed = parseCheckpointLines(raw);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].source, "OpenAI");
    assert.equal(parsed[1].outcome, "empty");
  });

  it("tolera linha final corrompida/truncada (kill no meio do append) sem abortar o parse", () => {
    const good = JSON.stringify(rec("OpenAI", "site:openai.com AI", "ok"));
    const raw = `${good}\n{"source": "Anthropic", "query_us`; // linha 2 truncada
    const parsed = parseCheckpointLines(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].source, "OpenAI");
  });

  it("última ocorrência da mesma chave (source+query_used) vence", () => {
    const raw = `${JSON.stringify(rec("OpenAI", "q1", "fail"))}\n${JSON.stringify(rec("OpenAI", "q1", "ok"))}\n`;
    const parsed = parseCheckpointLines(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].outcome, "ok");
  });

  it("ignora entradas sem source/query_used string", () => {
    const raw = `${JSON.stringify({ outcome: "ok" })}\n${JSON.stringify(rec("OpenAI", "q1", "ok"))}\n`;
    const parsed = parseCheckpointLines(raw);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].source, "OpenAI");
  });
});

describe("planQueriesWithCheckpoint", () => {
  function rec(source: string, query_used: string, outcome: RunRecord["outcome"]): RunRecord {
    return { source, query_used, outcome, duration_ms: 1, method: "websearch_brave", articles: [] };
  }
  function planned(name: string, query: string): PlannedQuery {
    return { name, query, discovered: false };
  }

  it("resume COMPLETO: todas as queries já com checkpoint ok/empty — nada a rodar (issue #7944 cenário (a))", () => {
    const plan = [planned("OpenAI", "q-openai"), planned("Anthropic", "q-anthropic")];
    const checkpoint = [rec("OpenAI", "q-openai", "ok"), rec("Anthropic", "q-anthropic", "empty")];
    const { toRun, reused } = planQueriesWithCheckpoint(plan, checkpoint);
    assert.deepEqual(toRun, []);
    assert.equal(reused.length, 2);
  });

  it("resume PARCIAL: só dispara as que faltam no checkpoint (issue #7944 cenário (b))", () => {
    const plan = [planned("OpenAI", "q-openai"), planned("Anthropic", "q-anthropic"), planned("Google", "q-google")];
    const checkpoint = [rec("OpenAI", "q-openai", "ok")]; // Anthropic e Google nunca rodaram
    const { toRun, reused } = planQueriesWithCheckpoint(plan, checkpoint);
    assert.equal(reused.length, 1);
    assert.equal(reused[0].source, "OpenAI");
    assert.deepEqual(
      toRun.map((p) => p.name),
      ["Anthropic", "Google"],
    );
  });

  it("query com outcome 'fail' no checkpoint é retentada, não reaproveitada", () => {
    const plan = [planned("OpenAI", "q-openai")];
    const checkpoint = [rec("OpenAI", "q-openai", "fail")];
    const { toRun, reused } = planQueriesWithCheckpoint(plan, checkpoint);
    assert.deepEqual(reused, []);
    assert.equal(toRun.length, 1);
  });

  it("sem checkpoint algum: todas as queries vão para toRun (1ª tentativa)", () => {
    const plan = [planned("OpenAI", "q-openai"), planned("Anthropic", "q-anthropic")];
    const { toRun, reused } = planQueriesWithCheckpoint(plan, []);
    assert.equal(toRun.length, 2);
    assert.deepEqual(reused, []);
  });

  it("checkpointKey distingue por query, não só por nome — drift de query (ex: inbox-topics mudou) não reusa indevidamente", () => {
    const plan = [planned("discovery: tema novo", "tema novo query 2026")];
    // checkpoint tem uma query ANTIGA pro mesmo "nome" truncado — não deve casar
    const checkpoint = [rec("discovery: tema novo", "tema velho query 2025", "ok")];
    const { toRun, reused } = planQueriesWithCheckpoint(plan, checkpoint);
    assert.equal(toRun.length, 1);
    assert.deepEqual(reused, []);
  });
});

describe("main() — ciclo de vida do checkpoint (#7970 — regressão)", () => {
  // Sem --sources/--discovery, `main()` ainda planeja 3 queries how-to
  // (#2278) + 1 query de impacto-negativo (#3916/#3918) — determinístico
  // pra um --edition fixo. Usar esse fato pra não precisar de fixtures de
  // sources/discovery: 4 queries totais, sempre as mesmas pra este edition.
  const EDITION = "990101";
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.BRAVE_API_KEY;
  const tmpDirs: string[] = [];

  after(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.BRAVE_API_KEY;
    else process.env.BRAVE_API_KEY = originalApiKey;
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  function fakeBraveResponse(): Response {
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({ web: { results: [] } }),
      text: async () => "",
    } as unknown as Response;
  }

  function installCountingFetch(): { calls: () => number } {
    let count = 0;
    globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
      count++;
      return fakeBraveResponse();
    }) as typeof fetch;
    return { calls: () => count };
  }

  function newTmpOut(): string {
    const dir = mkdtempSync(join(tmpdir(), "fetch-websearch-batch-test-"));
    tmpDirs.push(dir);
    return join(dir, "websearch-results.json");
  }

  it("reexecução da MESMA edição após sucesso total volta a rodar as queries (checkpoint não sobrevive ao próprio sucesso)", async () => {
    process.env.BRAVE_API_KEY = "fake-test-key";
    const outPath = newTmpOut();
    const checkpointPath = checkpointPathFor(outPath);
    const argv = ["--cutoff-iso", "2020-01-01", "--window-days", "3", "--out", outPath, "--edition", EDITION];

    const fetch1 = installCountingFetch();
    await main(argv);
    assert.ok(existsSync(outPath), "1ª tentativa: --out deve existir");
    assert.equal(fetch1.calls(), 4, "1ª tentativa: 4 queries planejadas, 4 chamadas Brave");
    assert.ok(!existsSync(checkpointPath), "checkpoint deve ser apagado após main() bem-sucedido (#7970)");

    // Reexecução DELIBERADA da mesma edição (mesmo --out) — uso documentado
    // (`/diaria-1-pesquisa {mesma AAMMDD}`), tipicamente pra pegar notícias
    // mais frescas. Antes do fix, o checkpoint sobrevivia e isto rodava
    // zero queries.
    const fetch2 = installCountingFetch();
    await main(argv);
    assert.equal(fetch2.calls(), 4, "reexecução após sucesso total deve rodar as 4 queries de novo, não reusar o checkpoint da tentativa anterior");
    assert.ok(!existsSync(checkpointPath), "checkpoint apagado de novo após a 2ª tentativa bem-sucedida");
  });

  it("resume após interrupção continua funcionando — não regride o #7944", async () => {
    process.env.BRAVE_API_KEY = "fake-test-key";
    const outPath = newTmpOut();
    const checkpointPath = checkpointPathFor(outPath);
    const argv = ["--cutoff-iso", "2020-01-01", "--window-days", "3", "--out", outPath, "--edition", EDITION];

    // Simula uma tentativa INTERROMPIDA: o checkpoint já tem as 4 queries
    // resolvidas (outcome "ok"), mas o `--out` final nunca foi escrito
    // (kill antes do renameSync) — reproduz literalmente o cenário do
    // #7944, não só a checagem pure de `planQueriesWithCheckpoint`.
    const { getHowToDiscoveryQueries } = await import("../scripts/lib/use-melhor-curation.ts");
    const { getNegativeImpactDiscoveryQueries } = await import("../scripts/lib/negative-impact-curation.ts");
    const editionNum = parseInt(EDITION, 10);
    const topics = [
      ...getHowToDiscoveryQueries(editionNum).map((q) => q),
      ...getNegativeImpactDiscoveryQueries(editionNum).map((q) => q),
    ];
    const fakeRecords: RunRecord[] = topics.map((q) => ({
      source: `discovery: ${q.slice(0, 40)}`,
      outcome: "ok",
      duration_ms: 1,
      query_used: q,
      method: "websearch_brave",
      articles: [],
    }));
    writeFileSync(checkpointPath, fakeRecords.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    assert.ok(!existsSync(outPath), "pré-condição: --out final nunca foi escrito (simulação de interrupção)");

    const fetch1 = installCountingFetch();
    await main(argv);

    assert.equal(fetch1.calls(), 0, "resume completo: todas as 4 queries já tinham checkpoint 'ok' — zero chamadas Brave");
    assert.ok(existsSync(outPath), "--out final deve ser escrito reaproveitando o checkpoint");
    const written = JSON.parse(readFileSync(outPath, "utf8")) as RunRecord[];
    assert.equal(written.length, 4);
    // E, como este `main()` terminou com sucesso, o checkpoint agora some —
    // resume funcionando NÃO significa que o checkpoint deva sobreviver
    // indefinidamente (#7970 continua valendo mesmo no caminho de resume).
    assert.ok(!existsSync(checkpointPath));
  });
});

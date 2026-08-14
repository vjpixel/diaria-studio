/**
 * test/bing-pull.test.ts (#4908 item 2; estendido #5128/#5130)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseBingQueryStatsResponse,
  parseBingTrafficStatsResponse,
  parseBingDate,
  bingSiteSlug,
  buildBingUrl,
  buildBingPullOutput,
  pullBingQueryStats,
  pullBingTrafficStats,
  isoDate,
  buildBingEndpointUrl,
  parseBingKeywordTotalResponse,
  parseBingKeywordRowsResponse,
  pullBingKeyword,
  pullBingRelatedKeywords,
  pullBingKeywordStats,
  buildBingDemandTerms,
  bingKeywordSeedsPath,
  parseBingKeywordSeedsCsv,
  loadBingKeywordSeeds,
  isAiDomainRelevant,
  filterRelevantRelated,
  summarizeBingKeywordTerms,
  buildBingKeywordsPullOutput,
  parseBingLinkCountsResponse,
  parseBingUrlLinksResponse,
  domainOf,
  pullBingLinkCounts,
  pullBingUrlLinks,
  buildBingLinksPullOutput,
  type BingQueryRow,
  type BingTrafficRow,
  type BingKeywordRow,
  type BingKeywordTermEntry,
  type BingLinksPageDetail,
} from "../scripts/bing-pull.ts";
import { GEO_HUB_QUESTIONS } from "../scripts/lib/geo-citation-monitor.ts";

describe("parseBingDate (#4908)", () => {
  it("formato .NET /Date(ms)/ → YYYY-MM-DD", () => {
    // 2026-08-11T00:00:00.000Z
    assert.equal(parseBingDate("/Date(1786406400000)/"), "2026-08-11");
  });

  it("string ISO simples também é aceita (fallback)", () => {
    assert.equal(parseBingDate("2026-08-11"), "2026-08-11");
  });

  it("valor ausente/não-string/inválido → null, nunca lança", () => {
    assert.equal(parseBingDate(undefined), null);
    assert.equal(parseBingDate(null), null);
    assert.equal(parseBingDate(42), null);
    assert.equal(parseBingDate("não é uma data"), null);
  });
});

describe("parseBingQueryStatsResponse (#4908)", () => {
  it("parseia array direto de QueryStats (PascalCase, schema documentado do SDK)", () => {
    const rows = parseBingQueryStatsResponse([
      { Query: "como usar ia", Clicks: 3, Impressions: 40, AvgClickPosition: 4.2, AvgImpressionPosition: 6.1 },
    ]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      query: "como usar ia",
      clicks: 3,
      impressions: 40,
      avgClickPosition: 4.2,
      avgImpressionPosition: 6.1,
    });
  });

  it("aceita resposta embrulhada em { d: [...] } (convenção ASP.NET AJAX/WCF .svc/json)", () => {
    const rows = parseBingQueryStatsResponse({ d: [{ Query: "x", Clicks: 1, Impressions: 2 }] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].query, "x");
  });

  it("fallback camelCase quando o shape não é PascalCase", () => {
    const rows = parseBingQueryStatsResponse([{ query: "y", clicks: 5, impressions: 10, avgClickPosition: 1, avgImpressionPosition: 2 }]);
    assert.equal(rows[0].query, "y");
    assert.equal(rows[0].clicks, 5);
  });

  it("elemento null/campos ausentes não crasham — defaults tolerantes (mesma filosofia de parseGscResponse)", () => {
    const rows = parseBingQueryStatsResponse([null, {}, { Query: "z" }]);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0], { query: "", clicks: 0, impressions: 0, avgClickPosition: 0, avgImpressionPosition: 0 });
    assert.equal(rows[2].query, "z");
    assert.equal(rows[2].clicks, 0);
  });

  it("resposta vazia (0 linhas, esperado pra propriedade nova — #4908) → []", () => {
    assert.deepEqual(parseBingQueryStatsResponse([]), []);
  });

  it("shape totalmente inesperado (não array, sem .d) → [] em vez de lançar", () => {
    assert.deepEqual(parseBingQueryStatsResponse({}), []);
    assert.deepEqual(parseBingQueryStatsResponse(null), []);
    assert.deepEqual(parseBingQueryStatsResponse("erro"), []);
  });
});

describe("parseBingTrafficStatsResponse (#4908)", () => {
  it("parseia array de RankAndTrafficStats com Date no formato .NET", () => {
    const rows = parseBingTrafficStatsResponse([
      { Date: "/Date(1786406400000)/", Clicks: 2, Impressions: 30, AvgClickPosition: 3, AvgImpressionPosition: 5 },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, "2026-08-11");
    assert.equal(rows[0].clicks, 2);
  });

  it("elemento sem Date → date null, resto com defaults", () => {
    const rows = parseBingTrafficStatsResponse([{}]);
    assert.equal(rows[0].date, null);
    assert.equal(rows[0].clicks, 0);
  });

  it("resposta vazia → []", () => {
    assert.deepEqual(parseBingTrafficStatsResponse([]), []);
  });
});

describe("bingSiteSlug (#4908)", () => {
  it("host + protocolo + barra final → slug de arquivo", () => {
    assert.equal(bingSiteSlug("https://diar.ia.br/"), "diar-ia-br");
    assert.equal(bingSiteSlug("https://arquivo.diar.ia.br/"), "arquivo-diar-ia-br");
  });

  it("sem barra final também funciona", () => {
    assert.equal(bingSiteSlug("https://diar.ia.br"), "diar-ia-br");
  });

  it("sem hífen pendente no início/fim", () => {
    const s = bingSiteSlug("http://x.com/");
    assert.ok(!s.startsWith("-"));
    assert.ok(!s.endsWith("-"));
  });
});

describe("buildBingUrl (#4908)", () => {
  it("monta a URL com siteUrl e apikey como query params", () => {
    const url = buildBingUrl("GetQueryStats", "https://diar.ia.br/", "SECRETKEY");
    assert.match(url, /^https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetQueryStats\?/);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("siteUrl"), "https://diar.ia.br/");
    assert.equal(parsed.searchParams.get("apikey"), "SECRETKEY");
  });
});

describe("buildBingPullOutput (#4908)", () => {
  const queryRow = (o: Partial<BingQueryRow> = {}): BingQueryRow => ({
    query: "q",
    clicks: 0,
    impressions: 10,
    avgClickPosition: 1,
    avgImpressionPosition: 2,
    ...o,
  });
  const trafficRow = (o: Partial<BingTrafficRow> = {}): BingTrafficRow => ({
    date: "2026-08-11",
    clicks: 0,
    impressions: 10,
    avgClickPosition: 1,
    avgImpressionPosition: 2,
    ...o,
  });

  it("inclui as N query_rows e M traffic_rows de entrada, totais batem", () => {
    const queryRows = [queryRow({ query: "a" }), queryRow({ query: "b" })];
    const trafficRows = [trafficRow()];
    const out = buildBingPullOutput("https://diar.ia.br/", "2026-08-11", queryRows, trafficRows);
    assert.equal(out.total_query_rows, 2);
    assert.equal(out.total_traffic_rows, 1);
    assert.deepEqual(out.query_rows, queryRows);
    assert.deepEqual(out.traffic_rows, trafficRows);
  });

  it("rows vazias → totais 0 e arrays vazios (caso esperado hoje — propriedade nova)", () => {
    const out = buildBingPullOutput("https://diar.ia.br/", "2026-08-11", [], []);
    assert.equal(out.total_query_rows, 0);
    assert.equal(out.total_traffic_rows, 0);
    assert.deepEqual(out.query_rows, []);
    assert.deepEqual(out.traffic_rows, []);
  });

  it("site/pulled_at são repassados tal qual, sem transformação", () => {
    const out = buildBingPullOutput("https://arquivo.diar.ia.br/", "2026-01-01", [], []);
    assert.equal(out.site, "https://arquivo.diar.ia.br/");
    assert.equal(out.pulled_at, "2026-01-01");
  });
});

describe("isoDate (#4908)", () => {
  it("epoch ms → YYYY-MM-DD", () => {
    assert.equal(isoDate(Date.UTC(2026, 5, 9, 12, 0, 0)), "2026-06-09");
  });
});

describe("pullBingQueryStats / pullBingTrafficStats (#4908) — fetchImpl injetado, sem rede real", () => {
  function fakeFetch(body: unknown, ok = true, status = 200): typeof fetch {
    return (async (url: string | URL) => {
      return {
        ok,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
        url: String(url),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("pullBingQueryStats chama a URL certa e retorna as rows parseadas", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => [{ Query: "q1", Clicks: 1, Impressions: 5, AvgClickPosition: 2, AvgImpressionPosition: 3 }],
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const rows = await pullBingQueryStats("https://diar.ia.br/", "KEY123", fetchImpl);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].query, "q1");
    assert.match(capturedUrl, /GetQueryStats/);
    assert.match(capturedUrl, /apikey=KEY123/);
    assert.match(capturedUrl, /siteUrl=https/);
  });

  it("pullBingTrafficStats chama GetRankAndTrafficStats e retorna as rows parseadas", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => [{ Date: "/Date(1786406400000)/", Clicks: 1, Impressions: 5 }],
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const rows = await pullBingTrafficStats("https://diar.ia.br/", "KEY123", fetchImpl);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, "2026-08-11");
    assert.match(capturedUrl, /GetRankAndTrafficStats/);
  });

  it("0 linhas (caso real confirmado ao vivo na issue #4908, propriedade nova sem backfill) → []", async () => {
    const rows = await pullBingQueryStats("https://diar.ia.br/", "KEY123", fakeFetch([]));
    assert.deepEqual(rows, []);
  });

  it("resposta não-ok propaga erro com status + corpo, nunca engole a falha em silêncio", async () => {
    const fetchImpl = fakeFetch({ Message: "Invalid API key" }, false, 401);
    await assert.rejects(
      () => pullBingQueryStats("https://diar.ia.br/", "BADKEY", fetchImpl),
      /Bing WMT GetQueryStats 401/,
    );
  });
});

// ── #4908/#4983/#5048: mesma disciplina do script irmão clarice-envio-run.ts —
// teste ESTÁTICO (regex sobre o source), não comportamental. `loadProjectEnv()`
// roda no corpo do módulo ESM na 1ª importação (já aconteceu quando os testes
// acima importaram o arquivo), então um teste comportamental passaria mesmo
// com a chamada movida pra depois do preflight. O invariante real é
// sintático: a chamada aparece ANTES do bloco que lê
// `process.env.BING_WEBMASTER_API_KEY`.
describe("#4908 — loadProjectEnv() em scope top-level, antes do preflight de credencial", () => {
  const SCRIPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "bing-pull.ts");
  const src = readFileSync(SCRIPT_PATH, "utf8");

  it("importa loadProjectEnv de lib/env-loader.ts", () => {
    assert.match(
      src,
      /import\s+\{\s*loadProjectEnv\s*\}\s+from\s+["']\.\/lib\/env-loader\.ts["']/,
      "scripts/bing-pull.ts deve importar loadProjectEnv de ./lib/env-loader.ts",
    );
  });

  it("chama loadProjectEnv() em scope top-level (não dentro de main())", () => {
    assert.match(
      src,
      /^loadProjectEnv\(\);?\s*$/m,
      "scripts/bing-pull.ts deve chamar loadProjectEnv() em scope top-level — guarda contra remoção " +
        "acidental ou mover pra dentro de main() (achado #4983/#5048 em scripts irmãos).",
    );
  });

  it("a chamada de loadProjectEnv() aparece ANTES da leitura de process.env.BING_WEBMASTER_API_KEY", () => {
    const callMatch = src.match(/^loadProjectEnv\(\);?\s*$/m);
    // Regex específico do USO real (`const apiKey = process.env.X`), não de
    // qualquer menção textual à var — a docstring/comentários acima também
    // citam o nome da env var em prosa, o que faria um regex genérico casar
    // ali (ANTES da chamada) e inverter falsamente a asserção de ordem.
    const readMatch = src.match(/apiKey\s*=\s*process\.env\.BING_WEBMASTER_API_KEY/);
    assert.ok(callMatch, "chamada explícita loadProjectEnv() não encontrada");
    assert.ok(readMatch, "leitura `apiKey = process.env.BING_WEBMASTER_API_KEY` não encontrada — arquivo mudou de forma inesperada?");
    assert.ok(
      (callMatch!.index as number) < (readMatch!.index as number),
      "loadProjectEnv() deve vir ANTES da leitura de BING_WEBMASTER_API_KEY — mesmo achado do #4983/#5048: " +
        "sob systemd --user (sem herdar .env do shell), ler a env var antes de carregar .env falha mesmo " +
        "com a key presente no arquivo.",
    );
  });
});

function fakeFetchJson(body: unknown, ok = true, status = 200): typeof fetch {
  return (async (url: string | URL) => {
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body), url: String(url) } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("buildBingEndpointUrl (#5128/#5130)", () => {
  it("monta a URL com params arbitrários + apikey, sem exigir siteUrl fixo", () => {
    const url = buildBingEndpointUrl("GetKeyword", { q: "ia no brasil", country: "BR", language: "pt-BR" }, "KEY");
    const parsed = new URL(url);
    assert.match(url, /^https:\/\/ssl\.bing\.com\/webmaster\/api\.svc\/json\/GetKeyword\?/);
    assert.equal(parsed.searchParams.get("q"), "ia no brasil");
    assert.equal(parsed.searchParams.get("country"), "BR");
    assert.equal(parsed.searchParams.get("language"), "pt-BR");
    assert.equal(parsed.searchParams.get("apikey"), "KEY");
  });
});

describe("parseBingKeywordTotalResponse (#5128) — GetKeyword, shape CONFIRMADO ao vivo em 12/ago/2026", () => {
  it("{d: {Query, Impressions, BroadImpressions}} — objeto único, o total do período", () => {
    const parsed = parseBingKeywordTotalResponse({
      d: { __type: "Keyword:#Microsoft.Bing.Webmaster.Api", Query: "chatgpt", Impressions: 1383455, BroadImpressions: 1491838 },
    });
    assert.deepEqual(parsed, { query: "chatgpt", impressions: 1383455, broadImpressions: 1491838 });
  });

  it("fallback camelCase e resposta já desembrulhada (sem `d`)", () => {
    assert.deepEqual(parseBingKeywordTotalResponse({ query: "x", impressions: 5, broadImpressions: 7 }), {
      query: "x",
      impressions: 5,
      broadImpressions: 7,
    });
  });

  it("shape totalmente inesperado -> zerado, nunca lança", () => {
    assert.deepEqual(parseBingKeywordTotalResponse(null), { query: "", impressions: 0, broadImpressions: 0 });
    assert.deepEqual(parseBingKeywordTotalResponse("erro"), { query: "", impressions: 0, broadImpressions: 0 });
  });
});

describe("parseBingKeywordRowsResponse (#5128) — GetKeywordStats/GetRelatedKeywords, shape CONFIRMADO ao vivo em 12/ago/2026", () => {
  it("GetKeywordStats: {d: [{Query,Date,Impressions,BroadImpressions}, ...]} — série do MESMO termo", () => {
    const rows = parseBingKeywordRowsResponse({
      d: [{ Query: "chatgpt", Date: "/Date(1786406400000)/", Impressions: 317124, BroadImpressions: 331562 }],
    });
    assert.deepEqual(rows, [{ query: "chatgpt", date: "2026-08-11", impressions: 317124, broadImpressions: 331562 }]);
  });

  it("GetRelatedKeywords: mesma forma de linha SEM Date — termos diferentes, não pontos no tempo", () => {
    const rows = parseBingKeywordRowsResponse({
      d: [{ Query: "chatgpt online", Impressions: 3012, BroadImpressions: 5540 }],
    });
    assert.equal(rows[0].query, "chatgpt online");
    assert.equal(rows[0].date, null);
  });

  it("fallback camelCase e array direto (sem `d`)", () => {
    const rows = parseBingKeywordRowsResponse([{ query: "x", impressions: 5, broadImpressions: 7 }]);
    assert.deepEqual(rows, [{ query: "x", date: null, impressions: 5, broadImpressions: 7 }]);
  });

  it("shape inesperado -> [], nunca lança", () => {
    assert.deepEqual(parseBingKeywordRowsResponse(null), []);
    assert.deepEqual(parseBingKeywordRowsResponse({}), []);
  });
});

describe("pullBingKeyword / pullBingRelatedKeywords / pullBingKeywordStats (#5128) — fetchImpl injetado", () => {
  it("pullBingKeyword chama GetKeyword com os 5 params + apikey e retorna data+raw", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ d: { Query: "q", Impressions: 0, BroadImpressions: 0 } }), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    const { data, raw } = await pullBingKeyword("q", "br", "pt-BR", "2026-07-12", "2026-08-11", "KEY", fetchImpl);
    assert.equal(data.query, "q");
    assert.deepEqual(raw, { d: { Query: "q", Impressions: 0, BroadImpressions: 0 } });
    assert.match(capturedUrl, /GetKeyword/);
    assert.match(capturedUrl, /startDate=2026-07-12/);
    assert.match(capturedUrl, /endDate=2026-08-11/);
    assert.match(capturedUrl, /country=br/);
  });

  it("pullBingRelatedKeywords chama GetRelatedKeywords e retorna data+raw", async () => {
    const { data, raw } = await pullBingRelatedKeywords(
      "q",
      "br",
      "pt-BR",
      "2026-07-12",
      "2026-08-11",
      "KEY",
      fakeFetchJson({ d: [{ Query: "a" }, { Query: "b" }] }),
    );
    assert.deepEqual(data.map((r) => r.query), ["a", "b"]);
    assert.deepEqual(raw, { d: [{ Query: "a" }, { Query: "b" }] });
  });

  it("pullBingKeywordStats chama GetKeywordStats (sem startDate/endDate) e retorna data+raw", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ d: [] }), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    await pullBingKeywordStats("q", "br", "pt-BR", "KEY", fetchImpl);
    assert.match(capturedUrl, /GetKeywordStats/);
    assert.doesNotMatch(capturedUrl, /startDate/);
  });

  it("resposta não-ok propaga erro com status + corpo (não engole a falha)", async () => {
    await assert.rejects(
      () => pullBingKeyword("q", "br", "pt-BR", "2026-07-12", "2026-08-11", "BADKEY", fakeFetchJson({ Message: "Invalid API key" }, false, 401)),
      /Bing WMT GetKeyword 401/,
    );
  });
});

describe("parseBingKeywordSeedsCsv (#5253)", () => {
  it("1 termo por linha, ignora header 'term' (case-insensitive) e linhas vazias", () => {
    const csv = "term\nchatgpt\n\nnewsletter de ia\n";
    assert.deepEqual(parseBingKeywordSeedsCsv(csv), ["chatgpt", "newsletter de ia"]);
    assert.deepEqual(parseBingKeywordSeedsCsv("Term\nx\n"), ["x"]);
  });

  it("trima espaços em volta de cada termo", () => {
    assert.deepEqual(parseBingKeywordSeedsCsv("  ia generativa  \n\tferramentas de ia\t\n"), [
      "ia generativa",
      "ferramentas de ia",
    ]);
  });

  it("CSV vazio -> []", () => {
    assert.deepEqual(parseBingKeywordSeedsCsv(""), []);
  });
});

describe("bingKeywordSeedsPath (#5253)", () => {
  it("aponta pra seed/keywords.csv relativo ao root informado", () => {
    assert.match(bingKeywordSeedsPath("/repo"), /\/repo\/seed\/keywords\.csv$/);
  });
});

describe("loadBingKeywordSeeds / buildBingDemandTerms (#5253 — regressão do ruído de GEO_HUB_QUESTIONS)", () => {
  it("seed/keywords.csv real tem entre 15 e 20 termos, todos não-vazios", () => {
    const seeds = loadBingKeywordSeeds();
    assert.ok(seeds.length >= 15 && seeds.length <= 20, `esperado 15-20 termos, veio ${seeds.length}`);
    for (const t of seeds) assert.ok(t.trim().length > 0);
  });

  it("NUNCA inclui nenhuma pergunta de GEO_HUB_QUESTIONS — a semente é curada, não derivada de título de matéria (achado #5253)", () => {
    const seeds = loadBingKeywordSeeds();
    for (const q of GEO_HUB_QUESTIONS) {
      assert.ok(!seeds.includes(q), `seed/keywords.csv contém pergunta de hub: "${q}"`);
    }
  });

  it("buildBingDemandTerms() sem args carrega de seed/keywords.csv", () => {
    assert.deepEqual(buildBingDemandTerms(), loadBingKeywordSeeds());
  });

  it("buildBingDemandTerms(seeds) usa a lista explícita passada, sem tocar o disco", () => {
    assert.deepEqual(buildBingDemandTerms(["a", "b"]), ["a", "b"]);
  });
});

describe("isAiDomainRelevant / filterRelevantRelated (#5253 item 4)", () => {
  it("termo com marcador de domínio (substring, tolerante a acento) é relevante", () => {
    assert.ok(isAiDomainRelevant("chatgpt de graça"));
    assert.ok(isAiDomainRelevant("inteligência artificial generativa"));
    assert.ok(isAiDomainRelevant("inteligencia artificial generativa"));
    assert.ok(isAiDomainRelevant("prompt engineering curso"));
  });

  it("'ia' como palavra isolada é relevante, mas não dentro de outra palavra ('dia', 'companhia')", () => {
    assert.ok(isAiDomainRelevant("o que é ia"));
    assert.ok(!isAiDomainRelevant("bom dia"));
    assert.ok(!isAiDomainRelevant("nome da companhia"));
  });

  it("termo sem nenhum marcador de domínio (fofoca de celebridade — achado real #5253) é descartado", () => {
    assert.ok(!isAiDomainRelevant("o que aconteceu com a xuxa"));
    assert.ok(!isAiDomainRelevant("aniversário da cantora"));
  });

  it("filterRelevantRelated mantém só as linhas relevantes, preserva o objeto tal qual", () => {
    const rows: BingKeywordRow[] = [
      { query: "chatgpt gratis", date: null, impressions: 10, broadImpressions: 20 },
      { query: "o que aconteceu com a fulana", date: null, impressions: 5000, broadImpressions: 9000 },
    ];
    assert.deepEqual(filterRelevantRelated(rows), [rows[0]]);
  });

  it("todas relevantes -> array idêntico; nenhuma relevante -> []", () => {
    const relevant: BingKeywordRow[] = [{ query: "curso de ia", date: null, impressions: 1, broadImpressions: 1 }];
    assert.deepEqual(filterRelevantRelated(relevant), relevant);
    const irrelevant: BingKeywordRow[] = [{ query: "receita de bolo", date: null, impressions: 1, broadImpressions: 1 }];
    assert.deepEqual(filterRelevantRelated(irrelevant), []);
  });
});

describe("summarizeBingKeywordTerms (#5253 itens 3 e 5)", () => {
  const okEntry = (term: string, impressions: number): BingKeywordTermEntry => ({
    term,
    keyword: { ok: true, data: { query: term, impressions, broadImpressions: impressions * 2 }, raw: {} },
    related: { ok: true, data: [], raw: [] },
    stats: { ok: true, data: [], raw: [] },
  });
  const errEntry = (term: string): BingKeywordTermEntry => ({
    term,
    keyword: { ok: false, error: "boom" },
    related: { ok: false, error: "boom" },
    stats: { ok: false, error: "boom" },
  });

  it("zeroVolume=true só quando a chamada teve sucesso E impressions===0", () => {
    const summary = summarizeBingKeywordTerms([okEntry("a", 0), okEntry("b", 5)]);
    assert.deepEqual(summary, [
      { term: "a", impressions: 0, broadImpressions: 0, zeroVolume: true },
      { term: "b", impressions: 5, broadImpressions: 10, zeroVolume: false },
    ]);
  });

  it("chamada com erro -> impressions/broadImpressions null, zeroVolume false (nunca 0 inventado)", () => {
    const summary = summarizeBingKeywordTerms([errEntry("c")]);
    assert.deepEqual(summary, [{ term: "c", impressions: null, broadImpressions: null, zeroVolume: false }]);
  });
});

describe("buildBingKeywordsPullOutput (#5128, summary/terms_with_zero_impressions #5253)", () => {
  it("monta o payload com total_terms batendo e campos repassados tal qual", () => {
    const entries: BingKeywordTermEntry[] = [
      {
        term: "ia generativa",
        keyword: { ok: true, data: { query: "ia generativa", impressions: 0, broadImpressions: 0 }, raw: {} },
        related: { ok: true, data: [], raw: [] },
        stats: { ok: false, error: "boom" },
      },
    ];
    const out = buildBingKeywordsPullOutput("br", "pt-BR", "2026-07-12", "2026-08-11", "2026-08-11", entries);
    assert.equal(out.country, "br");
    assert.equal(out.language, "pt-BR");
    assert.equal(out.start_date, "2026-07-12");
    assert.equal(out.end_date, "2026-08-11");
    assert.equal(out.total_terms, 1);
    assert.deepEqual(out.terms, entries);
  });

  it("deriva terms_with_zero_impressions e summary de terms (#5253)", () => {
    const entries: BingKeywordTermEntry[] = [
      {
        term: "ia generativa",
        keyword: { ok: true, data: { query: "ia generativa", impressions: 0, broadImpressions: 0 }, raw: {} },
        related: { ok: true, data: [], raw: [] },
        stats: { ok: true, data: [], raw: [] },
      },
      {
        term: "chatgpt",
        keyword: { ok: true, data: { query: "chatgpt", impressions: 500, broadImpressions: 900 }, raw: {} },
        related: { ok: true, data: [], raw: [] },
        stats: { ok: true, data: [], raw: [] },
      },
    ];
    const out = buildBingKeywordsPullOutput("br", "pt-BR", "2026-07-12", "2026-08-11", "2026-08-11", entries);
    assert.equal(out.terms_with_zero_impressions, 1);
    assert.deepEqual(out.summary, [
      { term: "ia generativa", impressions: 0, broadImpressions: 0, zeroVolume: true },
      { term: "chatgpt", impressions: 500, broadImpressions: 900, zeroVolume: false },
    ]);
  });
});

describe("parseBingLinkCountsResponse / parseBingUrlLinksResponse (#5130) — shape CONFIRMADO ao vivo em 12/ago/2026", () => {
  it("{d: {Links: [...], TotalPages: N}} — objeto único embrulhando o array (diferente do resto do arquivo)", () => {
    const parsed = parseBingLinkCountsResponse({
      d: { __type: "LinkCounts:#Microsoft.Bing.Webmaster.Api", Links: [{ Url: "https://diar.ia.br/p/x", Count: 3 }], TotalPages: 1 },
    });
    assert.deepEqual(parsed, { rows: [{ url: "https://diar.ia.br/p/x", count: 3 }], totalPages: 1 });
  });

  it("{d: {Links: [], TotalPages: 0}} — resposta real confirmada pra diar.ia.br/arquivo.diar.ia.br (0 backlinks hoje)", () => {
    assert.deepEqual(parseBingLinkCountsResponse({ d: { Links: [], TotalPages: 0 } }), { rows: [], totalPages: 0 });
  });

  it("tolerante a camelCase e shape inesperado -> vazio, nunca lança", () => {
    assert.deepEqual(parseBingLinkCountsResponse({ links: [{ url: "x", count: 1 }], totalPages: 1 }).rows, [{ url: "x", count: 1 }]);
    assert.deepEqual(parseBingLinkCountsResponse(null), { rows: [], totalPages: 0 });
    assert.deepEqual(parseBingLinkCountsResponse({}), { rows: [], totalPages: 0 });
  });

  it("parseBingUrlLinksResponse: forma (a) objeto embrulhando Links (simetria com GetLinkCounts)", () => {
    assert.deepEqual(parseBingUrlLinksResponse({ d: { Links: ["https://x.com/a", { Url: "https://y.com/b" }] } }), [
      "https://x.com/a",
      "https://y.com/b",
    ]);
  });

  it("parseBingUrlLinksResponse: forma (b) array bruto embrulhado em d — não confirmada ao vivo, fallback", () => {
    assert.deepEqual(parseBingUrlLinksResponse({ d: ["https://x.com/a", { Url: "https://y.com/b" }, {}] }), [
      "https://x.com/a",
      "https://y.com/b",
    ]);
  });

  it("shape inesperado -> [], nunca lança", () => {
    assert.deepEqual(parseBingUrlLinksResponse(null), []);
    assert.deepEqual(parseBingUrlLinksResponse({}), []);
  });
});

describe("domainOf (#5130)", () => {
  it("extrai hostname lowercase de uma URL válida", () => {
    assert.equal(domainOf("https://WWW.Example.com/path?x=1"), "www.example.com");
  });

  it("string inválida -> null, nunca lança", () => {
    assert.equal(domainOf("não é url"), null);
    assert.equal(domainOf(""), null);
  });
});

describe("pullBingLinkCounts / pullBingUrlLinks (#5130) — fetchImpl injetado", () => {
  it("pullBingLinkCounts chama GetLinkCounts com siteUrl+page e retorna data+raw", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({ d: { Links: [{ Url: "https://diar.ia.br/", Count: 1 }], TotalPages: 1 } }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { data } = await pullBingLinkCounts("https://diar.ia.br/", 0, "KEY", fetchImpl);
    assert.deepEqual(data, { rows: [{ url: "https://diar.ia.br/", count: 1 }], totalPages: 1 });
    assert.match(capturedUrl, /GetLinkCounts/);
    assert.match(capturedUrl, /page=0/);
  });

  it("pullBingUrlLinks chama GetUrlLinks com siteUrl+url+page e retorna data+raw", async () => {
    let capturedUrl = "";
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return { ok: true, status: 200, json: async () => ({ d: ["https://outro.com/post"] }), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    const { data } = await pullBingUrlLinks("https://diar.ia.br/", "https://diar.ia.br/p/x", 0, "KEY", fetchImpl);
    assert.deepEqual(data, ["https://outro.com/post"]);
    assert.match(capturedUrl, /GetUrlLinks/);
    assert.match(capturedUrl, /url=https/);
  });
});

describe("buildBingLinksPullOutput (#5130 item 2 — SEM scoreOpportunities, só agregação)", () => {
  const pages: BingLinksPageDetail[] = [
    { url: "https://diar.ia.br/p/a", count: 2, linkingUrls: ["https://x.com/1", "https://x.com/2"], error: null, raw: [{ d: { Links: ["https://x.com/1", "https://x.com/2"] } }] },
    { url: "https://diar.ia.br/p/b", count: 1, linkingUrls: ["https://y.com/1"], error: null, raw: [{ d: { Links: ["https://y.com/1"] } }] },
    { url: "https://diar.ia.br/p/c", count: 0, linkingUrls: [], error: null, raw: [] },
  ];

  it("agrega domínios distintos (x.com aparece 2x mas conta 1) e total de URLs de link", () => {
    const out = buildBingLinksPullOutput("https://diar.ia.br/", "2026-08-12", null, pages);
    assert.equal(out.total_distinct_domains, 2);
    assert.deepEqual(out.distinct_domains, ["x.com", "y.com"]);
    assert.equal(out.total_linking_urls, 3);
    assert.equal(out.total_pages_with_links, 2); // só count > 0
    assert.equal(out.pages.length, 3); // todas as páginas persistidas, inclusive count=0
  });

  it("propaga link_counts_error tal qual, sem mascarar a falha", () => {
    const out = buildBingLinksPullOutput("https://diar.ia.br/", "2026-08-12", "Bing WMT GetLinkCounts 500: boom", []);
    assert.equal(out.link_counts_error, "Bing WMT GetLinkCounts 500: boom");
    assert.equal(out.total_distinct_domains, 0);
  });

  it("distinct_domains vem ordenado (diff estável entre rodadas)", () => {
    const out = buildBingLinksPullOutput("https://diar.ia.br/", "2026-08-12", null, [
      { url: "p", count: 2, linkingUrls: ["https://z.com/1", "https://a.com/1"], error: null, raw: [] },
    ]);
    assert.deepEqual(out.distinct_domains, ["a.com", "z.com"]);
  });

  it("persiste raw de GetUrlLinks por página, ao lado do campo parseado (self-review #5158 achado 1)", () => {
    const rawA = { d: { Links: ["https://x.com/1", "https://x.com/2"] } };
    const rawEmpty: unknown[] = [];
    const out = buildBingLinksPullOutput("https://diar.ia.br/", "2026-08-12", null, pages);
    assert.deepEqual(out.pages[0].raw, [rawA]);
    assert.deepEqual(out.pages[2].raw, rawEmpty); // count=0 → nenhuma chamada GetUrlLinks feita
  });
});

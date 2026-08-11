/**
 * test/bing-pull.test.ts (#4908 item 2)
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
  type BingQueryRow,
  type BingTrafficRow,
} from "../scripts/bing-pull.ts";

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

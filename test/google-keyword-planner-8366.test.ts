/**
 * test/google-keyword-planner-8366.test.ts (#8366)
 * Miolo do Keyword Planner + retry de login-customer-id compartilhado. Sem rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildKeywordIdeasBody,
  parseKeywordIdeas,
  filterRelevantIdeas,
  flagContaminatedSeeds,
  sortIdeas,
  fetchKeywordIdeas,
  renderKeywordReport,
} from "../scripts/lib/google-keyword-planner.ts";
import { parseSeedsCsv, parseTermsArg } from "../scripts/google-keyword-pull.ts";
import type { FetchLike, GoogleAdsAuthConfig } from "../scripts/lib/google-ads-ingest.ts";

const AUTH: GoogleAdsAuthConfig = {
  clientId: "c", clientSecret: "s", refreshToken: "r", developerToken: "d",
  loginCustomerId: "6236094249", customerId: "2369219639",
};

const PAYLOAD = {
  results: [
    { text: "gemini", keywordIdeaMetrics: { avgMonthlySearches: "30400000", competition: "LOW", competitionIndex: "15" } },
    { text: "gemini dj", keywordIdeaMetrics: { avgMonthlySearches: "1000", competition: "LOW" } },
    { text: "cdj gemini", keywordIdeaMetrics: { avgMonthlySearches: "900", competition: "LOW" } },
    { text: "gemini google ia", keywordIdeaMetrics: { avgMonthlySearches: "500", competition: "LOW" } },
    { text: "deepfake", keywordIdeaMetrics: { avgMonthlySearches: "33100", competition: "LOW", lowTopOfPageBidMicros: "10000", highTopOfPageBidMicros: "990000" } },
    { text: "sem metricas" },
  ],
};

describe("#8366 — corpo e parse", () => {
  it("corpo pede pt/Brasil/GOOGLE_SEARCH e limita a 20 sementes", () => {
    const b = buildKeywordIdeasBody(Array.from({ length: 25 }, (_, i) => `t${i}`)) as any;
    assert.equal(b.language, "languageConstants/1014");
    assert.deepEqual(b.geoTargetConstants, ["geoTargetConstants/2076"]);
    assert.equal(b.keywordPlanNetwork, "GOOGLE_SEARCH");
    assert.equal(b.keywordSeed.keywords.length, 20);
  });

  it("parse converte int64-string e micros; métrica ausente vira null, não 0", () => {
    const rows = parseKeywordIdeas(PAYLOAD);
    assert.equal(rows[0].avgMonthlySearches, 30_400_000);
    assert.equal(rows[4].lowBidBrl, 0.01);
    assert.equal(rows[4].highBidBrl, 0.99);
    assert.equal(rows[5].avgMonthlySearches, null);
    assert.equal(rows[5].competition, "UNKNOWN");
    assert.deepEqual(parseKeywordIdeas(null), []);
  });
});

describe("#8366 — filtro de marca contaminada (caso gemini/DJ)", () => {
  const ideas = parseKeywordIdeas(PAYLOAD);
  const seeds = ["gemini", "deepfake"];

  it("descarta vizinha sem marcador de IA, mantém semente e vizinha com marcador", () => {
    const { kept, discarded } = filterRelevantIdeas(ideas, seeds);
    assert.deepEqual(discarded.map((i) => i.keyword).sort(), ["cdj gemini", "gemini dj", "sem metricas"].sort());
    assert.ok(kept.some((i) => i.keyword === "gemini google ia"));
    assert.ok(kept.some((i) => i.keyword === "gemini"));
  });

  it("sinaliza a semente gemini como contaminada; deepfake não", () => {
    const flagged = flagContaminatedSeeds(ideas, seeds);
    assert.deepEqual(flagged.map((f) => f.seed), ["gemini"]);
    assert.equal(flagged[0].volume, 30_400_000);
  });

  it("não sinaliza semente que já tem marcador de IA", () => {
    assert.deepEqual(flagContaminatedSeeds(ideas, ["gemini ia"]), []);
  });
});

describe("#8366 — ordenação e relatório", () => {
  it("ordena por volume desc, empate por competição asc", () => {
    const mk = (keyword: string, v: number, competition: string) => ({
      keyword, avgMonthlySearches: v, competition, competitionIndex: 1, lowBidBrl: null, highBidBrl: null,
    });
    const s = sortIdeas([mk("a", 10, "HIGH"), mk("b", 10, "LOW"), mk("c", 50, "HIGH")]);
    assert.deepEqual(s.map((i) => i.keyword), ["c", "b", "a"]);
  });

  it("relatório traz seção de contaminação só quando há", () => {
    const md = renderKeywordReport({ date: "2026-09-19", seeds: ["x"], kept: [], discarded: [], contaminated: [] });
    assert.ok(!md.includes("contaminado"));
    const md2 = renderKeywordReport({
      date: "2026-09-19", seeds: ["gemini"], kept: [], discarded: [],
      contaminated: [{ seed: "gemini", volume: 1, discardedNeighbours: ["gemini dj"] }],
    });
    assert.ok(md2.includes("contaminado") && md2.includes("gemini dj"));
  });
});

describe("#8366 — CLI helpers", () => {
  it("parseSeedsCsv ignora cabeçalho 'term' e linhas vazias", () => {
    assert.deepEqual(parseSeedsCsv("term\r\nnewsletter de ia\n\ncurso de ia\n"), ["newsletter de ia", "curso de ia"]);
  });
  it("parseTermsArg separa por vírgula e aparda", () => {
    assert.deepEqual(parseTermsArg(" a, b ,,c"), ["a", "b", "c"]);
  });
});

describe("#8366 — transporte reusa o retry de login-customer-id (#5237)", () => {
  it("403 USER_PERMISSION_DENIED com MCC → retry com a própria conta → 200", async () => {
    const logins: string[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      const login = (init!.headers as Record<string, string>)["login-customer-id"];
      logins.push(login);
      if (login === "6236094249") return new Response('{"error":{"details":"USER_PERMISSION_DENIED"}}', { status: 403 });
      return new Response(JSON.stringify(PAYLOAD), { status: 200 });
    };
    const r = await fetchKeywordIdeas(fetchImpl, AUTH, "tok", ["deepfake"]);
    assert.deepEqual(logins, ["6236094249", "2369219639"]);
    assert.ok(r.ok && r.ideas.length === 6);
  });

  it("outro 403 não faz retry e vira erro; rede que cai vira erro sem lançar", async () => {
    let calls = 0;
    const r1 = await fetchKeywordIdeas(
      async () => { calls++; return new Response("DEVELOPER_TOKEN_NOT_APPROVED", { status: 403 }); },
      AUTH, "t", ["x"],
    );
    assert.equal(calls, 1);
    assert.ok(!r1.ok && r1.error.includes("HTTP 403"));
    const r2 = await fetchKeywordIdeas(async () => { throw new Error("boom"); }, AUTH, "t", ["x"]);
    assert.ok(!r2.ok && r2.error.includes("boom"));
  });

  it("URL usa :generateKeywordIdeas na conta anunciante", async () => {
    let seen = "";
    await fetchKeywordIdeas(async (u) => { seen = u; return new Response("{}", { status: 200 }); }, AUTH, "t", ["x"]);
    assert.equal(seen, "https://googleads.googleapis.com/v25/customers/2369219639:generateKeywordIdeas");
  });
});

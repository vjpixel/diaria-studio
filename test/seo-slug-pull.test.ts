/**
 * test/seo-slug-pull.test.ts (#1989)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugify, seoSlug, seoMetaDescription, formatManualSlugFixInstructions } from "../scripts/lib/slug.ts";
import { scoreOpportunities, parseGscResponse, isoDate, type GscRow } from "../scripts/seo-pull.ts";

describe("slug acent-correto (#1989)", () => {
  it("slugify: strip de acentos PT-BR (o bug do auto-slug do Beehiiv)", () => {
    // Beehiiv auto-derivava `automa-o`/`p-nico`; o slugify NFD resolve.
    assert.equal(slugify("Empregos e automação: pânico vs dados"), "empregos-e-automacao-panico-vs-dados");
    assert.equal(slugify("Inteligência Artificial à brasileira"), "inteligencia-artificial-a-brasileira");
    assert.equal(slugify("ChatGPT, Gemini & Claude"), "chatgpt-gemini-claude");
  });

  it("#3449 regressão: título real da edição 260714 (â→a) — 'câncer' vira 'cancer', não 'c-ncer'", () => {
    // Caso real do post-mortem #3449: Beehiiv REMOVEU o 'â' em vez de
    // transliterar, gerando `ia-do-google-detecta-c-ncer-raro-no-sus`.
    assert.equal(
      slugify("IA do Google detecta câncer raro no SUS"),
      "ia-do-google-detecta-cancer-raro-no-sus",
    );
    assert.equal(
      seoSlug("IA do Google detecta câncer raro no SUS"),
      "ia-do-google-detecta-cancer-raro-no-sus",
    );
  });

  it("#3449: cobertura de todos os acentos PT-BR comuns (â/ç/ã/é/í/ó/ú)", () => {
    assert.equal(slugify("Câmera"), "camera"); // â
    assert.equal(slugify("Ação"), "acao"); // ã + ç (cedilha)
    assert.equal(slugify("Café"), "cafe"); // é
    assert.equal(slugify("País"), "pais"); // í
    assert.equal(slugify("Órgão"), "orgao"); // ó + ã
    assert.equal(slugify("Última"), "ultima"); // ú
    assert.equal(slugify("Reação química"), "reacao-quimica"); // ç + í
  });

  it("seoSlug: trunca em palavra inteira até maxLen (sem cortar palavra/hífen pendente)", () => {
    const long = "Microsoft lança sete modelos proprios da familia MAI para competir com OpenAI e Google";
    const s = seoSlug(long, 60);
    assert.ok(s.length <= 60);
    assert.ok(!s.endsWith("-"), "sem hífen pendente");
    assert.ok(!s.includes("--"), "sem hífen duplo");
    // não corta no meio de palavra: o último segmento é palavra inteira
    assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    // slug curto passa intacto
    assert.equal(seoSlug("GPT-5 chega ao Brasil"), "gpt-5-chega-ao-brasil");
  });

  it("seoMetaDescription: combina título+subtítulo, trunca em palavra + reticências", () => {
    const d = seoMetaDescription("Título curto", "Subtítulo curto");
    assert.equal(d, "Título curto — Subtítulo curto");
    const long = seoMetaDescription("A".repeat(100), "B".repeat(100), 80);
    assert.ok(long.length <= 81, "≤ maxLen + reticências");
    assert.ok(long.endsWith("…"));
  });
});

describe("formatManualSlugFixInstructions (#3449)", () => {
  it("inclui post_id, slug alvo e localização do campo na UI Beehiiv", () => {
    const msg = formatManualSlugFixInstructions("post_abc123", "ia-do-google-detecta-cancer-raro-no-sus");
    assert.match(msg, /post_abc123/);
    assert.match(msg, /ia-do-google-detecta-cancer-raro-no-sus/);
    assert.match(msg, /#text-input-slug/);
    assert.match(msg, /SEO/i);
    assert.match(msg, /app\.beehiiv\.com\/posts\/post_abc123\/edit/);
  });

  it("é determinística (mesma entrada → mesma saída)", () => {
    const a = formatManualSlugFixInstructions("post_x", "slug-x");
    const b = formatManualSlugFixInstructions("post_x", "slug-x");
    assert.equal(a, b);
  });
});

describe("scoreOpportunities (#1989)", () => {
  const row = (o: Partial<GscRow>): GscRow => ({ page: "p", clicks: 0, impressions: 100, ctr: 0.01, position: 8, ...o });

  it("low_ctr: impressões altas + CTR << esperado pra posição", () => {
    // posição 2 espera ~12%; CTR 1% << metade (6%) → low_ctr
    const opps = scoreOpportunities([row({ position: 2, ctr: 0.01, impressions: 500 })]);
    assert.equal(opps.length, 1);
    assert.equal(opps[0].type, "low_ctr");
  });

  it("near_first_page: posição 5-15 com impressões (CTR ok pra posição)", () => {
    // posição 8 espera ~2.5%; CTR 2% > metade (1.25%) → não low_ctr; 5≤8≤15 → near_first_page
    const opps = scoreOpportunities([row({ position: 8, ctr: 0.02, impressions: 300 })]);
    assert.equal(opps.length, 1);
    assert.equal(opps[0].type, "near_first_page");
  });

  it("ignora impressões abaixo do mínimo (ruído)", () => {
    assert.equal(scoreOpportunities([row({ impressions: 10 })]).length, 0);
  });

  it("ordena por impressões desc (maior potencial primeiro)", () => {
    const opps = scoreOpportunities([
      row({ page: "a", position: 8, ctr: 0.02, impressions: 100 }),
      row({ page: "b", position: 8, ctr: 0.02, impressions: 900 }),
    ]);
    assert.equal(opps[0].page, "b");
  });
});

describe("parseGscResponse + isoDate (#1989)", () => {
  it("parseia rows [page,query] da Search Analytics API", () => {
    const rows = parseGscResponse({
      rows: [{ keys: ["https://x.com/p", "como usar ia"], clicks: 5, impressions: 200, ctr: 0.025, position: 7.3 }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].page, "https://x.com/p");
    assert.equal(rows[0].query, "como usar ia");
    assert.equal(rows[0].position, 7.3);
  });

  it("resposta vazia/sem rows → []", () => {
    assert.deepEqual(parseGscResponse({}), []);
    assert.deepEqual(parseGscResponse({ rows: null }), []);
  });

  it("code-review: elemento null no array não crasha", () => {
    const rows = parseGscResponse({ rows: [null, { keys: ["p"], impressions: 10 }] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].page, ""); // null → defaults
    assert.equal(rows[1].page, "p");
  });

  it("isoDate: epoch ms → YYYY-MM-DD", () => {
    assert.equal(isoDate(Date.UTC(2026, 5, 9, 12, 0, 0)), "2026-06-09");
  });
});

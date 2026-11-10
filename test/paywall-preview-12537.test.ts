/**
 * #12537 Etapa 1: o manifest de `fact-check-sources/` registrava só
 * `ok | blocked | error`, e a prévia que um paywall serve (HTTP 200, 2-3
 * parágrafos + "assine para continuar") virava `ok`. Sem separar artigo
 * inteiro de prévia, a condição 1 da proposta ("lido inteiro") não tem como
 * ser garantida.
 *
 * Casos medidos ao vivo em 10/11/2026 (`measure-paywall-discards.ts --fetch`):
 * Bloomberg serve ~250 palavras com `isAccessibleForFree: false` +
 * `article:content_tier=metered` (prévia); Fortune/Business Insider marcam
 * `isAccessibleForFree: false` mas mandam o texto inteiro no HTML (~700-2.500
 * palavras), que conta como artigo inteiro.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assessPaywallPreview,
  detectPaywallSignals,
  PREVIEW_MAX_WORDS,
} from "../scripts/lib/diaria/paywall-preview.ts";
import { fetchSourceText } from "../scripts/fetch-source-text.ts";
import {
  formatGateSummary,
  formatUnverifiedSources,
  prefetchHighlightSources,
  type FactCheckResult,
  type ManifestEntry,
} from "../scripts/run-fact-checker.ts";
import {
  editionsInWindow,
  extractPaywallDiscards,
  summarizePaywallDiscards,
} from "../scripts/measure-paywall-discards.ts";

const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(" ");

const BLOOMBERG_LIKE = `<html><head>
<meta property="article:content_tier" content="metered">
<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>
</head><body><article><p>${words(250)}</p></article></body></html>`;

const FORTUNE_LIKE = `<html><head>
<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False"}</script>
</head><body><div class="paywall"><p>${words(900)}</p></div></body></html>`;

const FREE = `<html><body><article><p>${words(120)}</p></article></body></html>`;

describe("#12537 — detector de prévia de paywall", () => {
  it("prévia estilo Bloomberg (sinal forte + texto curto) sai preview", () => {
    const r = assessPaywallPreview(BLOOMBERG_LIKE, words(250));
    assert.equal(r.completeness, "preview");
    assert.deepEqual(r.signals, ["schema:isAccessibleForFree=false", "meta:content_tier=metered"]);
    assert.equal(r.words, 250);
  });

  it("paywall que manda o texto inteiro no HTML (Fortune/BI) sai full, com os sinais registrados", () => {
    const r = assessPaywallPreview(FORTUNE_LIKE, words(900));
    assert.equal(r.completeness, "full");
    assert.ok(r.signals.includes("schema:isAccessibleForFree=false"));
    assert.ok(r.signals.includes("html:paywall"));
  });

  it("página sem sinal nenhum é full mesmo curta (notícia curta não é prévia)", () => {
    const r = assessPaywallPreview(FREE, words(120));
    assert.equal(r.completeness, "full");
    assert.deepEqual(r.signals, []);
  });

  it("wordCount declarado decide: 700 de 1.500 palavras é prévia, 1.400 de 1.500 não", () => {
    const html = `<script type="application/ld+json">{"isAccessibleForFree":false,"wordCount":1500}</script>`;
    assert.equal(assessPaywallPreview(html, words(700)).completeness, "preview");
    assert.equal(assessPaywallPreview(html, words(1400)).completeness, "full");
    assert.equal(assessPaywallPreview(html, words(700)).declared_words, 1500);
  });

  it("frase de corte no texto puro (sem HTML) conta como sinal", () => {
    const text = `${words(150)} Para continuar lendo, assine.`;
    const r = assessPaywallPreview("", text);
    assert.equal(r.completeness, "preview");
    assert.deepEqual(r.signals, ['texto:"para continuar lendo"']);
  });

  it("frase solta 'assinantes' (falso positivo do verify) não é sinal", () => {
    assert.deepEqual(detectPaywallSignals("", "OpenAI começa a negar novos assinantes"), []);
  });

  it("limiar sem wordCount é PREVIEW_MAX_WORDS", () => {
    const html = `<meta name="article:content_tier" content="locked">`;
    assert.equal(assessPaywallPreview(html, words(PREVIEW_MAX_WORDS - 1)).completeness, "preview");
    assert.equal(assessPaywallPreview(html, words(PREVIEW_MAX_WORDS)).completeness, "full");
  });
});

const mk = (body: string) =>
  (async () => new Response(body, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

describe("#12537 — fetchSourceText e manifest registram a prévia", () => {
  it("fetchSourceText devolve paywall.completeness", async () => {
    const r = await fetchSourceText("https://x.test/a", mk(BLOOMBERG_LIKE));
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.paywall.completeness, "preview");
    const f = await fetchSourceText("https://x.test/b", mk(FREE));
    assert.ok(f.ok);
    if (f.ok) assert.equal(f.paywall.completeness, "full");
  });

  it("prefetchHighlightSources grava completeness/paywall_signals/words no manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-12537-"));
    try {
      const f = (async (u: string) =>
        new Response(u.includes("bbg") ? BLOOMBERG_LIKE : FREE, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
      await prefetchHighlightSources({ highlights: [{ url: "https://a.test/bbg" }, { url: "https://a.test/free" }] }, dir, f);
      const m = JSON.parse(readFileSync(join(dir, "fact-check-sources", "manifest.json"), "utf8")) as ManifestEntry[];
      assert.equal(m[0].status, "ok");
      assert.equal(m[0].completeness, "preview");
      assert.ok(m[0].paywall_signals!.includes("meta:content_tier=metered"));
      assert.equal(m[0].words, 250);
      assert.equal(m[1].completeness, "full");
      assert.deepEqual(m[1].paywall_signals, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12537 — gate do fact-check mostra a prévia", () => {
  const manifest: ManifestEntry[] = [
    {
      destaque: 1, url: "https://www.bloomberg.com/x", status: "ok", erro: null, bytes: 1500,
      fetched_at: "2026-11-10T00:00:00Z", completeness: "preview", paywall_signals: ["meta:content_tier=metered"], words: 250,
    },
    { destaque: 2, url: "https://b.test/y", status: "ok", erro: null, bytes: 4000, fetched_at: "2026-11-10T00:00:00Z" },
  ];

  it("formatUnverifiedSources lista o destaque em prévia e ignora entrada sem o campo (manifest antigo)", () => {
    const lines = formatUnverifiedSources([], manifest);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /prévia de paywall \(#12537\)/);
    assert.match(lines[1], /D1: prévia \(250 palavras\) · meta:content_tier=metered — https:\/\/www\.bloomberg\.com\/x/);
  });

  it("gate sem divergências deixa de dizer verde pleno quando a fonte é prévia", () => {
    const result: FactCheckResult = {
      edition: "261110",
      claims: [{ destaque: 1, claim_type: "number", text: "US$ 10 bi", context: "", sources: ["newsletter"], verdict: "SUSTAINED", source_url: "https://www.bloomberg.com/x" }],
      summary: { total: 1, sustained: 1, divergent: 0, not_found_in_source: 0, attention_items: 0 },
    } as unknown as FactCheckResult;
    const out = formatGateSummary(result, { manifest });
    assert.match(out, /não é verde pleno/);
    assert.doesNotMatch(out, /Todos os claims verificados sem divergências/);
  });
});

describe("#12537 — medição dos descartes por paywall", () => {
  const verifyAll = [
    { url: "https://www.bloomberg.com/a", verdict: "paywall", note: "known-paywall domain" },
    { url: "https://canaltech.com.br/b", verdict: "paywall", note: "browser marker: assinantes" },
    { url: "https://the-decoder.com/c", verdict: "paywall", note: "marker: subscribe now" },
    { url: "https://ok.test/d", verdict: "accessible" },
  ];

  it("extrai só os vereditos paywall e separa domínio de marcador", () => {
    const d = extractPaywallDiscards("261105", verifyAll);
    assert.deepEqual(d.map((x) => [x.host, x.origin]), [
      ["bloomberg.com", "domain"],
      ["canaltech.com.br", "marker"],
      ["the-decoder.com", "marker"],
    ]);
    assert.deepEqual(extractPaywallDiscards("261105", { not: "array" }), []);
  });

  it("resume por origem, host e nota (browser marker agrupa com marker)", () => {
    const s = summarizePaywallDiscards([...extractPaywallDiscards("261105", verifyAll), ...extractPaywallDiscards("261106", verifyAll)], 2, 2);
    assert.equal(s.total, 6);
    assert.equal(s.unique_urls, 3);
    assert.deepEqual(s.by_origin, { domain: 2, marker: 4 });
    assert.deepEqual(s.by_note.map((n) => n.note), ["known-paywall domain", "marker: assinantes", "marker: subscribe now"]);
  });

  it("janela de dias filtra por AAMMDD e ignora pastas que não são edição", () => {
    const now = new Date(Date.UTC(2026, 10, 10));
    assert.deepEqual(editionsInWindow(["261112", "261001", "260901", "replay-x", "261110"], 60, now), ["261001", "261110", "261112"]);
  });
});

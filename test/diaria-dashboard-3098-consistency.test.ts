/**
 * Regression tests for the "consistência/compactação" block of the #3098
 * grab-bag on workers/diaria-dashboard (distinct from clarice-dashboard/
 * brevo-dashboard — separate worker, separate CSS, no shared code):
 *
 *  - Cliques/contagens absolutas alternavam entre `<small>` (aba CTR Top 10,
 *    aba Use Melhor) e `td.metric` (aba Top links, mesma grandeza). Fix:
 *    Top links passa a usar `<small>` também — td.metric fica reservado ao
 *    dado central de cada tabela (CTR%), não a contagens de apoio.
 *  - Aba Top links: "Janela: 260706, 260703, …" listava os 20 códigos de
 *    edição inline (2 linhas de ruído). Fix: "Janela: X → Y (N edições)"
 *    compactado, lista completa preservada em title=.
 *  - Aba CTR (Top 10), mobile: coluna Tema quebrava em até 6 linhas por
 *    causa da largura de Data+Categoria. Fix: Categoria vira cat-col
 *    (escondida em @media max-width:700px) e reaparece fundida como
 *    <small class="cat-inline"> sob o Tema só nessa media query.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardData, CtrByCategoryRow, TopClickedRecentSummary } from "../workers/diaria-dashboard/src/types.ts";

// Import dinâmico (mesmo padrão de test/dashboard-tab-enhance.test.ts): o
// package.json de workers/diaria-dashboard não declara "type": "module".
const { renderCtrSection, renderTopClickedRecentSection, renderDashboardHtml } = await import(
  "../workers/diaria-dashboard/src/index.ts"
);

function baseData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generated_at: "2026-07-08T00:00:00Z",
    schema_version: 1,
    source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
    ctr: null,
    overnight: { runs: [], total_runs: 0 },
    use_melhor: null,
    poll_eia: null,
    top_clicked_recent: null,
    audience: null,
    stubs: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Consistência: cliques absolutos usam <small>, não td.metric, na aba Top links
// ---------------------------------------------------------------------------

test("#3098: renderTopClickedRecentSection usa <small> pros cliques, não mais td.metric", () => {
  const tcr: TopClickedRecentSummary = {
    window_editions: ["260706", "260705"],
    top_items: [
      { edition: "260706", post_title: "P", anchor: "Âncora X", base_url: "https://ex.com/a", category: "Destaque", unique_verified_clicks: 42 },
    ],
  };
  const html = renderTopClickedRecentSection(baseData({ top_clicked_recent: tcr }));
  assert.match(html, /<td><small>42<\/small><\/td>/, "cliques devem renderizar em <small>, igual às outras abas");
  assert.doesNotMatch(html, /<td class="metric">42<\/td>/, "td.metric não deve mais envolver a contagem de cliques aqui");
});

// ---------------------------------------------------------------------------
// Compactação: "Janela" vira X → Y (N edições), lista completa no title=
// ---------------------------------------------------------------------------

test("#3098: janela compacta como 'oldest → newest (N edições)' em vez de listar os 20 códigos", () => {
  const editions = ["260706", "260705", "260704", "260602"]; // desc (mais recente primeiro, como o build script gera)
  const tcr: TopClickedRecentSummary = { window_editions: editions, top_items: [] };
  const html = renderTopClickedRecentSection(baseData({ top_clicked_recent: tcr }));
  assert.match(html, /Janela: 260602 → 260706 \(4 edições\)/, "label compacto deve mostrar oldest → newest + contagem");
  assert.match(html, new RegExp(`title="${editions.join(", ")}"`), "lista completa deve estar preservada no title=");
  assert.doesNotMatch(html, /Janela: 260706, 260705, 260704, 260602/, "não deve mais listar os códigos inline no texto visível");
});

test("#3098: janela com 1 única edição não usa a forma X → Y (edge case)", () => {
  const tcr: TopClickedRecentSummary = { window_editions: ["260706"], top_items: [] };
  const html = renderTopClickedRecentSection(baseData({ top_clicked_recent: tcr }));
  assert.match(html, /Janela: 260706(?!\s*→)/, "com 1 edição só, não deve renderizar seta");
});

test("#3098: janela vazia mantém fallback 'Janela: —'", () => {
  const tcr: TopClickedRecentSummary = { window_editions: [], top_items: [] };
  const html = renderTopClickedRecentSection(baseData({ top_clicked_recent: tcr }));
  assert.match(html, /Janela: —/);
});

// ---------------------------------------------------------------------------
// Aba CTR (Top 10) mobile: Categoria funde sob Tema, coluna isolada some
// ---------------------------------------------------------------------------

test("#3098: renderCtrSection duplica a categoria como cat-inline sob o Tema, e marca a coluna isolada como cat-col", () => {
  const catRow: CtrByCategoryRow = { category: "Destaque", link_count: 1, total_clicks: 10, avg_ctr_pct: 5, max_ctr_pct: 5 };
  const html = renderCtrSection(baseData({
    ctr: {
      total_editions: 1,
      total_links: 1,
      top_categories: [catRow],
      top_links: [{ date: "260706", category: "Destaque", anchor: "Aprofunde", highlight_title: "Tema X", post_title: "Post X", ctr_pct: 5, unique_verified_clicks: 10, base_url: "https://ex.com/a" }],
    },
  }));
  assert.match(html, /<th class="cat-col">Categoria<\/th>/, "o <th> Categoria deve ter a classe cat-col");
  assert.match(html, /<td class="cat-col"><small>Destaque<\/small><\/td>/, "a célula Categoria isolada deve ter a classe cat-col");
  assert.match(html, /<small class="cat-inline muted">Destaque<\/small>/, "a categoria deve reaparecer fundida sob o Tema via cat-inline");
});

test("#3098: CSS esconde .cat-col e mostra .cat-inline só na media query mobile", () => {
  // renderCtrSection não inclui <style> — buscamos via renderDashboardHtml pro bloco de CSS.
  const full = renderDashboardHtml(baseData());
  const style = full.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  assert.match(style, /\.cat-inline\s*\{\s*display:\s*none;\s*\}/, "cat-inline deve começar oculto (default)");
  const mq = style.match(/@media \(max-width:\s*700px\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(mq, /\.cat-col\s*\{\s*display:\s*none;\s*\}/, "cat-col deve sumir na media query mobile");
  assert.match(mq, /\.cat-inline\s*\{\s*display:\s*block/, "cat-inline deve aparecer na media query mobile");
});

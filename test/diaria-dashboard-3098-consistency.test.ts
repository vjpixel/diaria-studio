/**
 * Regression tests for the "consistência/compactação" block of the #3098
 * grab-bag on workers/diaria-dashboard (distinct from clarice-dashboard/
 * brevo-dashboard — separate worker, separate CSS, no shared code):
 *
 *  - Cliques/contagens absolutas alternavam entre `<small>` (aba CTR Top 10,
 *    aba Use Melhor) e `td.metric` (aba Top links, mesma grandeza). Fix:
 *    as 3 abas passam a usar um `clicksCell()` compartilhado (<small>,
 *    fallback "—") — td.metric fica reservado ao dado central de cada
 *    tabela (CTR%, exceto na aba Top links, onde cliques É a chave de
 *    ordenação — tradeoff documentado no código, não revertido, porque a
 *    consistência entre abas foi o que a issue #3098 pediu explicitamente).
 *  - Aba Top links: "Janela: 260706, 260703, …" listava os 20 códigos de
 *    edição inline (2 linhas de ruído). Fix: "Janela: X → Y (N edições)"
 *    compactado, lista completa preservada em title=, na MESMA ordem
 *    (ascendente) do rótulo. A lista é reordenada e String()-coagida
 *    internamente (não confia na ordem/tipo do produtor — achados de
 *    self-review: escHtml() direto num elemento não-string crasharia a
 *    página inteira, e a ordem do KV não é re-validada).
 *  - Aba CTR (Top 10) E aba Top links, mobile: coluna de texto longo (Tema /
 *    Âncora) quebrava em várias linhas por causa da largura de Categoria
 *    adjacente. Fix: Categoria vira cat-col (escondida em @media
 *    max-width:700px) e reaparece fundida como <small class="cat-inline">
 *    (com prefixo textual "Categoria: ", não só posicional — preserva
 *    contexto pra leitor de tela) só nessa media query, SEM <br> (achado de
 *    self-review: um <br> irmão solto renderiza incondicionalmente mesmo
 *    com cat-inline em display:none, forçando linha em branco no desktop —
 *    display:block já quebra linha sozinho, então o <br> era redundante e
 *    ao mesmo tempo um bug em telas largas).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardData, CtrByCategoryRow, TopClickedRecentSummary, UseMelhorSummary } from "../workers/diaria-dashboard/src/types.ts";

// Import dinâmico (mesmo padrão de test/dashboard-tab-enhance.test.ts): o
// package.json de workers/diaria-dashboard não declara "type": "module".
const { renderCtrSection, renderTopClickedRecentSection, renderUseMelhorSection, renderDashboardHtml } = await import(
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
// Consistência: cliques absolutos usam <small> (clicksCell) nas 3 abas
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

test("#3098: renderCtrSection (Top 10) usa clicksCell() pros cliques", () => {
  const html = renderCtrSection(baseData({
    ctr: {
      total_editions: 1,
      total_links: 1,
      top_categories: [],
      top_links: [{ date: "260706", category: "Destaque", anchor: "Manchete", highlight_title: null, post_title: "Post X", ctr_pct: 5, unique_verified_clicks: 7, base_url: "https://ex.com/a" }],
    },
  }));
  assert.match(html, /<td><small>7<\/small><\/td>/, "cliques da aba CTR devem usar a mesma célula <small>");
});

test("#3098: renderUseMelhorSection usa clicksCell() (comportamento idêntico ao '?? —' anterior)", () => {
  const um: UseMelhorSummary = {
    total_editions_with_use_melhor: 1,
    first_edition: "260501",
    editions: [],
    top_items: [
      { edition: "260501", url: "https://ex.com/a", title: "Com cliques", ctr_pct: 5, unique_verified_clicks: 9 },
      { edition: "260502", url: "https://ex.com/b", title: "Sem cliques (null)", ctr_pct: 5, unique_verified_clicks: null as unknown as number },
    ],
    coverage: { total_items: 2, matched: 2, unmatched: 0, coverage_pct: 100 },
  };
  const html = renderUseMelhorSection(baseData({ use_melhor: um }));
  assert.match(html, /<td><small>9<\/small><\/td>/, "item com cliques deve renderizar o número em <small>");
  assert.match(html, /<td><small>—<\/small><\/td>/, "item sem cliques (null) deve renderizar '—', preservando o fallback antigo");
});

// ---------------------------------------------------------------------------
// Compactação: "Janela" vira X → Y (N edições), lista completa no title=
// ---------------------------------------------------------------------------

test("#3098: janela compacta como 'oldest → newest (N edições)' em vez de listar os 20 códigos", () => {
  const editions = ["260706", "260705", "260704", "260602"]; // desc (mais recente primeiro, como o build script gera)
  const tcr: TopClickedRecentSummary = { window_editions: editions, top_items: [] };
  const html = renderTopClickedRecentSection(baseData({ top_clicked_recent: tcr }));
  assert.match(html, /Janela: 260602 → 260706 \(4 edições\)/, "label compacto deve mostrar oldest → newest + contagem");
  // Tooltip lista na MESMA ordem (ascendente) que o rótulo — não na ordem crua de entrada.
  assert.ok(html.includes('title="260602, 260704, 260705, 260706"'), "tooltip deve listar em ordem ascendente, igual ao rótulo");
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

test("#3098 (self-review): janela fora de ordem (não confia no produtor) ainda calcula oldest/newest corretamente", () => {
  // Ordem embaralhada de propósito — renderOvernightSection (mesma arquivo) também
  // reordena `ov.runs` em vez de confiar na ordem do produtor; o mesmo padrão
  // defensivo agora se aplica aqui.
  const tcr: TopClickedRecentSummary = { window_editions: ["260704", "260602", "260706", "260705"], top_items: [] };
  const html = renderTopClickedRecentSection(baseData({ top_clicked_recent: tcr }));
  assert.match(html, /Janela: 260602 → 260706 \(4 edições\)/, "oldest/newest devem ser calculados por ordenação interna, não por índice cru");
});

test("#3098 (self-review): elemento não-string em window_editions não crasha o render (schema drift)", () => {
  // Simula KV corrompido/schema drift: JSON.parse + `as DashboardData` não valida em runtime.
  const tcr = { window_editions: [260706, "260602"] as unknown as string[], top_items: [] } as TopClickedRecentSummary;
  assert.doesNotThrow(() => renderTopClickedRecentSection(baseData({ top_clicked_recent: tcr })), "escHtml não deve crashar em elemento não-string");
  const html = renderTopClickedRecentSection(baseData({ top_clicked_recent: tcr }));
  assert.match(html, /Janela: 260602 → 260706/, "elemento numérico deve ser coagido pra string antes de comparar/escapar");
});

// ---------------------------------------------------------------------------
// Mobile: coluna Categoria funde sob o texto longo adjacente (Tema / Âncora),
// SEM <br> solto (bug de self-review: <br> irmão sempre renderiza mesmo com
// cat-inline em display:none, forçando linha em branco em telas largas)
// ---------------------------------------------------------------------------

test("#3098: renderCtrSection (Top 10) funde a categoria sob o Tema via cat-inline, sem <br> solto", () => {
  const html = renderCtrSection(baseData({
    ctr: {
      total_editions: 1,
      total_links: 1,
      top_categories: [],
      top_links: [{ date: "260706", category: "Destaque", anchor: "Aprofunde", highlight_title: "Tema X", post_title: "Post X", ctr_pct: 5, unique_verified_clicks: 10, base_url: "https://ex.com/a" }],
    },
  }));
  assert.match(html, /<th class="cat-col">Categoria<\/th>/, "o <th> Categoria deve ter a classe cat-col");
  assert.match(html, /<td class="cat-col"><small>Destaque<\/small><\/td>/, "a célula Categoria isolada deve ter a classe cat-col");
  assert.match(html, /<small class="cat-inline muted">Categoria: Destaque<\/small>/, "a categoria deve reaparecer fundida sob o Tema via cat-inline, com prefixo textual");
  assert.doesNotMatch(html, /Tema X<br>/, "não deve haver <br> solto entre o Tema e o cat-inline (bug: renderiza incondicionalmente mesmo em desktop)");
});

test("#3098: renderTopClickedRecentSection também funde a categoria sob a Âncora via cat-inline (mesma estrutura de 6 colunas da aba CTR)", () => {
  const tcr: TopClickedRecentSummary = {
    window_editions: ["260706"],
    top_items: [
      { edition: "260706", post_title: "P", anchor: "Âncora Longa X", base_url: "https://ex.com/a", category: "Destaque", unique_verified_clicks: 42 },
    ],
  };
  const html = renderTopClickedRecentSection(baseData({ top_clicked_recent: tcr }));
  assert.match(html, /<th class="cat-col" title="Categoria do link">Categoria<\/th>/, "o <th> Categoria da aba Top links também deve ter cat-col");
  assert.match(html, /<td class="cat-col"><small>Destaque<\/small><\/td>/, "a célula Categoria isolada da aba Top links deve ter cat-col");
  assert.match(html, /<small class="cat-inline muted">Categoria: Destaque<\/small>/, "a categoria deve reaparecer fundida sob a Âncora via cat-inline");
  assert.doesNotMatch(html, /Âncora Longa X<br>/, "não deve haver <br> solto (mesmo bug do CTR Top 10, mesmo fix)");
});

test("#3098: CSS esconde .cat-col e mostra .cat-inline só na media query mobile", () => {
  // renderCtrSection/renderTopClickedRecentSection não incluem <style> — buscamos via renderDashboardHtml pro bloco de CSS.
  const full = renderDashboardHtml(baseData());
  const style = full.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  assert.match(style, /\.cat-inline\s*\{\s*display:\s*none;\s*\}/, "cat-inline deve começar oculto (default)");
  const mq = style.match(/@media \(max-width:\s*700px\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(mq, /\.cat-col\s*\{\s*display:\s*none;\s*\}/, "cat-col deve sumir na media query mobile");
  assert.match(mq, /\.cat-inline\s*\{\s*display:\s*block/, "cat-inline deve aparecer na media query mobile");
});

test("sanity: renderCtrSection e renderTopClickedRecentSection renderizam sem lançar com todos os fixes aplicados juntos", () => {
  const ctrData = baseData({
    ctr: {
      total_editions: 2,
      total_links: 2,
      top_categories: [{ category: "Destaque", link_count: 2, total_clicks: 20, avg_ctr_pct: 5, max_ctr_pct: 6 } satisfies CtrByCategoryRow],
      top_links: [{ date: "260706", category: "Destaque", anchor: "Aprofunde", highlight_title: "Tema X", post_title: "Post X", ctr_pct: 5, unique_verified_clicks: 10, base_url: "https://ex.com/a" }],
    },
    top_clicked_recent: { window_editions: ["260706", "260705", "260704"], top_items: [{ edition: "260706", post_title: "P", anchor: "A", base_url: "https://ex.com/b", category: "Radar", unique_verified_clicks: 5 }] },
  });
  assert.doesNotThrow(() => renderCtrSection(ctrData));
  assert.doesNotThrow(() => renderTopClickedRecentSection(ctrData));
  assert.doesNotThrow(() => renderDashboardHtml(ctrData));
});

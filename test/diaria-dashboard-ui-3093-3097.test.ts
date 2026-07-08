/**
 * Regression tests for a batch of 5 UI/a11y fixes on diaria-dashboard
 * (workers/diaria-dashboard, distinct from clarice-dashboard/brevo-dashboard —
 * separate worker, separate CSS, no shared code), all landed together in the
 * same PR (same Fable review pass):
 *
 *  - #3093: `.tab-bar` showed a phantom vertical scrollbar on every screen.
 *    Cause: `.tab-label` has `margin-bottom: -2px` (overlaps the active tab's
 *    border) which overflows the flex container by 2px vertically — with
 *    `overflow-x: auto` set and no explicit `overflow-y`, the computed
 *    overflow-y became `auto` too, rendering a vertical scrollbar that never
 *    has anything to scroll. Fix: `overflow-y: hidden` on `.tab-bar` (keeps
 *    `overflow-x: auto` for the legitimate horizontal affordance).
 *  - #3094: the 6 tabs didn't fit at 390px (labels wrapped to 2 lines,
 *    "Audiência" got cut off — scrollWidth 348 vs clientWidth 336, ~12px
 *    deficit). Fix: `white-space: nowrap` on `.tab-label` (prevents wrap,
 *    relies on the existing horizontal scroll instead); tighter `gap` (2px)
 *    and `padding` (6px 8px) in the `@media (max-width: 700px)` block; plus a
 *    subtle right-edge fade (`.tab-bar-wrap::after`, a `--paper` gradient)
 *    that hints more tabs are scrollable off-screen on any width.
 *  - #3095: the Timeline "Resultado" column's ✓ ↩ ⊘ ⏳ symbols were explained
 *    only via `title=` (hover, inaccessible on touch). Fix: a visible
 *    `section-note` line under the table spells out the legend —
 *    complements the tooltip (#2557), doesn't replace it.
 *  - #3096: teal (`--brand`, #00A0A0) measures ~3.08:1 over `--paper`
 *    (#FBFAF6) — below WCAG AA (4.5:1) for normal text. `td.metric` is the
 *    central data cell of every table on the dashboard. Fix: reverts to
 *    `--ink` (font-weight 600 keeps the visual emphasis); teal stays
 *    reserved for links/interactive elements (3:1 is acceptable there).
 *  - #3097: `(N seguidas)` / `N sem match` — the exact text that signals the
 *    editor needs to act — rendered inside `<small>` with an inherited
 *    `opacity: 0.6` (~3.40:1), making it LESS legible than neutral bold teal
 *    numbers. Fix: `.alert-text { opacity: 1; font-weight: 600; }` overrides
 *    the inherited opacity explicitly. No new color introduced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardData, OvernightRun } from "../workers/diaria-dashboard/src/types.ts";

// Import dinâmico (mesmo padrão de test/dashboard-tab-enhance.test.ts): o
// package.json de workers/diaria-dashboard não declara "type": "module"
// (diferente de workers/brevo-dashboard), então um `import ... from` estático
// desse módulo não expõe os named exports sob o Node ESM/CJS interop.
const { renderDashboardHtml, renderOvernightSection } = await import(
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

function styleBlockOf(html: string): string {
  return html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
}

// ---------------------------------------------------------------------------
// #3093 — .tab-bar não deve exibir scrollbar vertical fantasma
// ---------------------------------------------------------------------------

test("#3093: .tab-bar tem overflow-y: hidden (mantendo overflow-x: auto)", () => {
  const html = renderDashboardHtml(baseData());
  const style = styleBlockOf(html);
  const rule = style.match(/\.tab-bar\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /overflow-x:\s*auto/, "overflow-x: auto deve continuar (rolagem horizontal legítima)");
  assert.match(rule, /overflow-y:\s*hidden/, "#3093: overflow-y: hidden deve estar presente");
});

// ---------------------------------------------------------------------------
// #3094 — 6 abas não cabem em mobile (390px)
// ---------------------------------------------------------------------------

test("#3094: .tab-label tem white-space: nowrap (evita quebra de linha)", () => {
  const html = renderDashboardHtml(baseData());
  const style = styleBlockOf(html);
  const rule = style.match(/\.tab-label\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /white-space:\s*nowrap/, "#3094: .tab-label deve ter white-space: nowrap");
});

test("#3094: media query mobile reduz gap e padding das abas", () => {
  const html = renderDashboardHtml(baseData());
  const style = styleBlockOf(html);
  const mq = style.match(/@media \(max-width:\s*700px\)\s*\{[\s\S]*?\n  \}/)?.[0] ?? "";
  assert.match(mq, /\.tab-bar\s*\{\s*gap:\s*2px;\s*\}/, "#3094: .tab-bar deve reduzir gap para 2px em mobile");
  assert.match(mq, /\.tab-label\s*\{\s*padding:\s*6px 8px/, "#3094: .tab-label deve reduzir padding para 6px 8px em mobile");
});

test("#3094: fade de overflow (.tab-bar-wrap::after) presente e ancorado FORA da área que rola", () => {
  const html = renderDashboardHtml(baseData());
  const style = styleBlockOf(html);
  assert.match(style, /\.tab-bar-wrap\s*\{\s*position:\s*relative;\s*\}/, "#3094: wrapper deve existir para ancorar o fade");
  assert.match(style, /\.tab-bar-wrap::after\s*\{[^}]*background:\s*linear-gradient\([^)]*var\(--paper\)\)/, "#3094: fade deve degradar para --paper");
  // O fade é filho de .tab-bar-wrap, NÃO de .tab-bar — não conflita com o fix
  // #3093 (overflow-y: hidden em .tab-bar não afeta um elemento fora dele).
  assert.match(html, /<div class="tab-bar-wrap">\s*<div class="tab-bar"/, "#3094: .tab-bar deve estar dentro de .tab-bar-wrap no HTML");
});

// ---------------------------------------------------------------------------
// #3095 — símbolos da Timeline ganham legenda visível (não só tooltip)
// ---------------------------------------------------------------------------

test("#3095: renderOvernightSection inclui legenda visível dos símbolos sob a tabela", () => {
  const run: OvernightRun = {
    edition: "260707",
    started_at: "2026-07-07T02:00:00Z",
    total_issues: 5,
    merged: 3,
    draft: 1,
    pulada: 1,
    in_progress: 0,
    duration_ms: 3_600_000,
    slowest_unit: { label: "issue #3050", duration_ms: 900_000 },
  };
  const html = renderOvernightSection(baseData({ overnight: { runs: [run], total_runs: 1 } }));
  assert.match(html, /class="section-note[^"]*">✓ mergeada · ↩ draft · ⊘ pulada · ⏳ em andamento/, "#3095: legenda visível deve estar presente");
});

test("#3095: legenda complementa o title= (tooltip #2557), não o substitui", () => {
  const run: OvernightRun = {
    edition: "260707",
    started_at: "2026-07-07T02:00:00Z",
    total_issues: 1,
    merged: 1,
    draft: 0,
    pulada: 0,
    in_progress: 0,
    duration_ms: 60_000,
    slowest_unit: null,
  };
  const html = renderOvernightSection(baseData({ overnight: { runs: [run], total_runs: 1 } }));
  assert.match(html, /title="[^"]*N✓ mergeadas[^"]*"/, "tooltip original do header (#2557) continua presente");
});

// ---------------------------------------------------------------------------
// #3096 — td.metric volta a --ink (teal falha AA em texto pequeno)
// ---------------------------------------------------------------------------

test("#3096: td.metric usa --ink, não --brand", () => {
  const html = renderDashboardHtml(baseData());
  const style = styleBlockOf(html);
  const rule = style.match(/td\.metric\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /color:\s*var\(--ink\)/, "#3096: td.metric deve usar --ink");
  assert.doesNotMatch(rule, /color:\s*var\(--brand\)/, "#3096: td.metric NÃO deve mais usar --brand");
  assert.match(rule, /font-weight:\s*600/, "#3096: peso 600 mantém a ênfase visual sem depender de cor");
});

test("#3096: teal (--brand) continua reservado a elementos gráficos (aba ativa)", () => {
  const html = renderDashboardHtml(baseData());
  const style = styleBlockOf(html);
  assert.match(
    style,
    /color:\s*var\(--brand\);\s*border-bottom-color:\s*var\(--paper\);/,
    "estado ativo de aba continua teal (elemento gráfico, 3:1 aceitável)",
  );
});

// ---------------------------------------------------------------------------
// #3097 — .alert-text sobrescreve opacity herdada (0.6 de <small>)
// ---------------------------------------------------------------------------

test("#3097: .alert-text tem opacity: 1 explícito e font-weight: 600", () => {
  const html = renderDashboardHtml(baseData());
  const style = styleBlockOf(html);
  const rule = style.match(/\.alert-text\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /opacity:\s*1/, "#3097: opacity deve ser explicitamente 1 (sobrescreve o 0.6 herdado de small)");
  assert.match(rule, /font-weight:\s*600/, "#3097: peso 600 reforça a legibilidade");
  assert.match(rule, /color:\s*#C00000/, "#3097: cor de alerta não muda — mesma --alert de sempre");
});

test("#3097: streak de falhas na Saúde das fontes usa .alert-text (herda a nova opacity)", () => {
  const html = renderDashboardHtml(baseData({
    source_health: {
      entries: [{
        name: "Fonte X", slug: "fonte-x", attempts: 10, successes: 5, failures: 5,
        timeouts: 0, success_rate_pct: 50, consecutive_failures: 5,
        last_success_iso: null, last_failure_iso: "2026-07-07T00:00:00Z",
        last_duration_ms: 1000, status: "vermelho",
      }],
      total: 1, verde: 0, amarelo: 0, vermelho: 1, generated_at: "2026-07-08T00:00:00Z",
    },
  }));
  assert.match(html, /<small class="alert-text">\(5 seguidas\)<\/small>/, "#3097: streak renderiza com class alert-text");
});

// ---------------------------------------------------------------------------
// sanity: os 5 fixes coexistem sem colisão (mesmo worker, mesma revisão)
// ---------------------------------------------------------------------------

test("sanity: renderDashboardHtml renderiza sem lançar com todos os 5 fixes aplicados juntos", () => {
  const run: OvernightRun = {
    edition: "260707",
    started_at: "2026-07-07T02:00:00Z",
    total_issues: 5,
    merged: 3,
    draft: 1,
    pulada: 1,
    in_progress: 0,
    duration_ms: 3_600_000,
    slowest_unit: { label: "issue #3050", duration_ms: 900_000 },
  };
  assert.doesNotThrow(() => renderDashboardHtml(baseData({ overnight: { runs: [run], total_runs: 1 } })));
});

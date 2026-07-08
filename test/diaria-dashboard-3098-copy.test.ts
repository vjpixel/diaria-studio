/**
 * Regression tests for the "copy" block of the #3098 grab-bag on
 * workers/diaria-dashboard:
 *
 *  - Header misturava EN/pt-BR: "Dados locais (last push: …)" virou
 *    "Dados locais (último push: …)".
 *  - A nota de cobertura do Use Melhor citava "#CTR" como texto solto (não
 *    era link nem âncora navegável) — virou link de verdade para a aba CTR
 *    (`href="#panel-ctr"`, deep-link já suportado desde #2622).
 *  - "N sem match" (Use Melhor) renderizava dentro de .alert-text (vermelho
 *    de alerta) para uma condição que a própria nota descreve como esperada
 *    (join lossy por URL de pesquisa ≠ URL publicada). Fix: some a classe de
 *    alerta desse número especificamente — o alerta real (streak de falhas
 *    na Saúde das fontes) continua com .alert-text normalmente.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardData, SourceHealthEntry, UseMelhorSummary } from "../workers/diaria-dashboard/src/types.ts";

const { renderDashboardHtml, renderUseMelhorSection, renderSourceHealthSection } = await import(
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
// Header: "último push", não "last push"
// ---------------------------------------------------------------------------

test("#3098: header usa 'último push' (pt-BR), não 'last push' (EN)", () => {
  const html = renderDashboardHtml(baseData());
  assert.match(html, /Dados locais \(último push:/, "header deve usar 'último push'");
  assert.doesNotMatch(html, /last push/i, "'last push' (EN) não deve mais aparecer");
});

// ---------------------------------------------------------------------------
// Nota de cobertura Use Melhor: "#CTR" vira link de verdade pra aba CTR
// ---------------------------------------------------------------------------

const umWithUnmatched: UseMelhorSummary = {
  total_editions_with_use_melhor: 5,
  first_edition: "260601",
  editions: [],
  top_items: [],
  coverage: { total_items: 100, matched: 78, unmatched: 22, coverage_pct: 78 },
};

test("#3098: nota de cobertura linka de verdade pra aba CTR (href=\"#panel-ctr\"), não texto solto \"#CTR\"", () => {
  const html = renderUseMelhorSection(baseData({ use_melhor: umWithUnmatched }));
  assert.match(html, /<a href="#panel-ctr"[^>]*>CTR<\/a>/, "deve haver um link real para a aba CTR (deep-link #2622)");
  assert.doesNotMatch(html, /ver #CTR/, "\"#CTR\" solto (não navegável) não deve mais aparecer no texto");
});

test("#3098: footer note do Use Melhor também linka pra aba CTR em vez de citar #CTR como texto", () => {
  const html = renderUseMelhorSection(baseData({ use_melhor: umWithUnmatched }));
  assert.match(html, /~22% gap esperado — ver aba <a href="#panel-ctr"/, "footer note deve linkar a aba CTR");
});

// ---------------------------------------------------------------------------
// "N sem match": deixa de usar .alert-text (condição esperada, não alerta)
// ---------------------------------------------------------------------------

test("#3098: '22 sem match' não usa mais .alert-text (condição esperada, não alerta)", () => {
  const html = renderUseMelhorSection(baseData({ use_melhor: umWithUnmatched }));
  assert.match(html, /22 sem match/, "o número deve continuar visível");
  assert.doesNotMatch(html, /<span class="alert-text">22 sem match<\/span>/, "22 sem match não deve mais estar dentro de .alert-text");
});

test("#3098: alerta real (streak de falhas na Saúde das fontes) continua usando .alert-text normalmente", () => {
  const entry: SourceHealthEntry = {
    name: "Fonte X", slug: "fonte-x", attempts: 10, successes: 5, failures: 5,
    timeouts: 0, success_rate_pct: 50, consecutive_failures: 5,
    last_success_iso: null, last_failure_iso: "2026-07-07T00:00:00Z",
    last_duration_ms: 1000, status: "vermelho",
  };
  const html = renderSourceHealthSection(baseData({
    source_health: { entries: [entry], total: 1, verde: 0, amarelo: 0, vermelho: 1, generated_at: "2026-07-08T00:00:00Z" },
  }));
  assert.match(html, /<small class="alert-text">\(5 seguidas\)<\/small>/, "streak de falhas continua com .alert-text — só o 'sem match' do Use Melhor mudou");
});

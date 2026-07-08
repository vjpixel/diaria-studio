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
 *
 * Self-review follow-up (achados de code-review max effort, aplicados num PR
 * separado pois as 3 PRs originais já tinham sido squash-mergeadas):
 *  - A mesma condição esperada (join lossy) aparecia DUAS vezes no painel Use
 *    Melhor: na nota agregada ("N sem match", já corrigida acima) e por
 *    edição ("N sem CTR", ainda com .alert-text) — meio-corrigido convidava
 *    o mesmo bug a ser reportado de novo. Fix: matchNote por edição também
 *    perde .alert-text, vira .muted.
 *  - O mesmo `<a href="#panel-ctr" style="...">CTR</a>` estava duplicado
 *    verbatim em 2 pontos da mesma função. Fix: extraído pra uma const
 *    `ctrTabLink` reusada nos dois.
 *
 * 2ª rodada de self-review (achado CONFIRMADO, corrige a 1ª rodada): a 1ª
 * rodada tinha adicionado `opacity:1` no link pra "contrariar" a opacity
 * herdada do `<p class="... muted">` ao redor — mas CSS opacity num
 * ancestral compõe TODO o subtree num grupo semi-transparente antes de
 * desenhar na página; opacity:1 num descendente não devolve a opacidade
 * real (diferente de `color`, que um valor mais específico de fato
 * sobrescreve). `opacity:1` foi removido — não fazia nada (o teste
 * original só checava a string presente, não o efeito visual, e teria
 * passado igual sem nenhum efeito real). Ver comentário completo no
 * código-fonte (`ctrTabLink`, em renderUseMelhorSection).
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

// ---------------------------------------------------------------------------
// Self-review follow-up: matchNote por edição ("N sem CTR") também deixa de
// usar .alert-text — mesma condição esperada da nota agregada, meio-corrigir
// só a agregada seria inconsistente dentro do mesmo painel.
// ---------------------------------------------------------------------------

test("#3098 (self-review follow-up): 'N sem CTR' por edição também não usa mais .alert-text (mesma condição esperada da nota agregada)", () => {
  const um: UseMelhorSummary = {
    total_editions_with_use_melhor: 1,
    first_edition: "260501",
    editions: [{
      edition: "260501",
      items: [{ url: "https://ex.com/a", title: "Sem CTR", ctr_pct: null, unique_verified_clicks: null }],
      ctr_matched: 0,
      ctr_unmatched: 3,
    }],
    top_items: [],
    coverage: { total_items: 3, matched: 0, unmatched: 3, coverage_pct: 0 },
  };
  const html = renderUseMelhorSection(baseData({ use_melhor: um }));
  assert.match(html, /\(3 sem CTR\)/, "o número deve continuar visível");
  assert.doesNotMatch(html, /<small class="alert-text">\(3 sem CTR\)<\/small>/, "'sem CTR' por edição não deve mais estar dentro de .alert-text");
  assert.match(html, /<small class="muted">\(3 sem CTR\)<\/small>/, "deve usar .muted, consistente com o resto do painel");
});

// ---------------------------------------------------------------------------
// Self-review follow-up: link real pra CTR é definido uma vez só (dedup —
// antes duplicado verbatim nas 2 notas)
//
// 2ª rodada de self-review (achado CONFIRMADO): a 1ª rodada tinha
// adicionado `opacity:1` no link tentando contrariar a opacity herdada do
// `<p class="... muted">` ao redor — mas CSS opacity num ancestral compõe
// TODO o subtree num grupo semi-transparente antes de desenhar na página;
// opacity:1 num descendente não devolve a opacidade real da página (não é
// como `color`, que um valor mais específico realmente sobrescreve). E
// `.section-note` (presente em todo `<p>` de nota, com ou sem `.muted`) já
// define opacity:0.75 por conta própria — removendo só `.muted` não
// resolveria. Consertar de verdade exigiria trocar `.muted`/`.section-note`
// de opacity pra color, um refactor maior tocando ~15 outras notas, fora
// de escopo pra um cleanup P3. `opacity:1` foi removido — não fazia nada,
// e o teste anterior só checava a STRING presente, não o efeito visual
// (teria passado mesmo sem nenhum efeito real).
// ---------------------------------------------------------------------------

test("#3098 (self-review follow-up): link pra aba CTR NÃO tem opacity:1 (achado corrigido — opacity de ancestral não é contornável por opacity de descendente)", () => {
  const html = renderUseMelhorSection(baseData({ use_melhor: umWithUnmatched }));
  assert.match(html, /<a href="#panel-ctr" style="color:var\(--brand\)">CTR<\/a>/, "o link deve existir, sem opacity inline (não tinha efeito real)");
  assert.doesNotMatch(html, /opacity:1/, "opacity:1 não deve mais aparecer — CSS opacity de ancestral não é contornável por opacity de descendente (achado de self-review)");
});

test("#3098 (self-review follow-up): o link pra aba CTR é idêntico nas 2 notas (dedup — mesma const reusada)", () => {
  const html = renderUseMelhorSection(baseData({ use_melhor: umWithUnmatched }));
  const matches = [...html.matchAll(/<a href="#panel-ctr" style="color:var\(--brand\)">CTR<\/a>/g)];
  assert.equal(matches.length, 2, "deve aparecer exatamente 2x (nota de cobertura + nota de rodapé), ambas idênticas");
});

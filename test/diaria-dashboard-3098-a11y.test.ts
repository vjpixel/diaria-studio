/**
 * Regression tests for the "acessibilidade" block of the #3098 grab-bag on
 * workers/diaria-dashboard:
 *
 *  - Status de fonte (🟢🟡🔴 → renderizado como ●/◐/○) codificava só por cor
 *    (WCAG 1.4.1, Use of Color). Fix: title="verde"/"amarelo"/"vermelho" no
 *    span + glyph variado (● cheio / ◐ meio / ○ vazio).
 *  - `.muted` (opacity: 0.55) media ~4.03:1 sobre --paper em 0.85rem,
 *    levemente abaixo de AA (4.5:1). Fix: opacity sobe pra 0.65 (dentro da
 *    faixa 0.62-0.65 pedida).
 *
 * Self-review follow-up (achado de code-review max effort, aplicado num PR
 * separado pois a PR original já tinha sido squash-mergeada): title= sozinho
 * não é anunciado de forma confiável por leitores de tela (funciona só como
 * tooltip de hover, que não existe em touch). Ganha role="img"+aria-label,
 * mesmo padrão já usado pro semáforo 🟢/🟡 do brevo-dashboard (#3092 parte
 * 3/N, mesma sessão) — title= mantido como bônus de tooltip pra mouse.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { DashboardData, SourceHealthEntry } from "../workers/diaria-dashboard/src/types.ts";

const { renderDashboardHtml, renderSourceHealthSection } = await import(
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

function entry(status: SourceHealthEntry["status"], name: string): SourceHealthEntry {
  return {
    name, slug: name.toLowerCase(), attempts: 10, successes: 8, failures: 2,
    timeouts: 0, success_rate_pct: 80, consecutive_failures: 0,
    last_success_iso: "2026-07-07T00:00:00Z", last_failure_iso: null,
    last_duration_ms: 1000, status,
  };
}

// ---------------------------------------------------------------------------
// Status badge: title textual + glyph variado, não só cor
// ---------------------------------------------------------------------------

test("#3098: statusBadge verde tem title=\"verde\" e glyph ●", () => {
  const html = renderSourceHealthSection(baseData({
    source_health: { entries: [entry("verde", "Fonte Verde")], total: 1, verde: 1, amarelo: 0, vermelho: 0, generated_at: "" },
  }));
  assert.match(html, /<span style="color:#2d8a4e" title="verde"[^>]*>●<\/span>/, "verde deve ter title e glyph cheio");
});

test("#3098: statusBadge amarelo tem title=\"amarelo\" e glyph diferente do verde (◐)", () => {
  const html = renderSourceHealthSection(baseData({
    source_health: { entries: [entry("amarelo", "Fonte Amarela")], total: 1, verde: 0, amarelo: 1, vermelho: 0, generated_at: "" },
  }));
  assert.match(html, /<span style="color:#c07800" title="amarelo"[^>]*>◐<\/span>/, "amarelo deve ter title e glyph meio");
});

test("#3098: statusBadge vermelho tem title=\"vermelho\" e glyph diferente dos outros dois (○)", () => {
  const html = renderSourceHealthSection(baseData({
    source_health: { entries: [entry("vermelho", "Fonte Vermelha")], total: 1, verde: 0, amarelo: 0, vermelho: 1, generated_at: "" },
  }));
  assert.match(html, /<span style="color:#C00000" title="vermelho"[^>]*>○<\/span>/, "vermelho deve ter title e glyph vazio");
});

test("#3098: os 3 glyphs de status são distintos entre si (não codifica só por cor)", () => {
  const html = renderSourceHealthSection(baseData({
    source_health: {
      entries: [entry("verde", "A"), entry("amarelo", "B"), entry("vermelho", "C")],
      total: 3, verde: 1, amarelo: 1, vermelho: 1, generated_at: "",
    },
  }));
  const glyphs = [...html.matchAll(/<span style="color:#[0-9A-Fa-f]+" title="(verde|amarelo|vermelho)"[^>]*>(.)<\/span>/g)]
    .map((m) => m[2]);
  assert.equal(new Set(glyphs).size, glyphs.length, "glyphs devem ser todos distintos entre si");
});

// ---------------------------------------------------------------------------
// Self-review follow-up: title= sozinho não é confiável pra leitor de tela —
// role="img"+aria-label garante exposição (mesmo padrão do brevo-dashboard #3092)
// ---------------------------------------------------------------------------

test("#3098 (self-review follow-up): statusBadge tem role=\"img\" + aria-label pra cada status (title= sozinho não é anunciado de forma confiável por leitor de tela)", () => {
  const html = renderSourceHealthSection(baseData({
    source_health: {
      entries: [entry("verde", "A"), entry("amarelo", "B"), entry("vermelho", "C")],
      total: 3, verde: 1, amarelo: 1, vermelho: 1, generated_at: "",
    },
  }));
  assert.match(html, /role="img" aria-label="verde"/, "verde deve ter role=img+aria-label");
  assert.match(html, /role="img" aria-label="amarelo"/, "amarelo deve ter role=img+aria-label");
  assert.match(html, /role="img" aria-label="vermelho"/, "vermelho deve ter role=img+aria-label");
});

// ---------------------------------------------------------------------------
// .muted: opacity sobe de 0.55 para a faixa 0.62-0.65
// ---------------------------------------------------------------------------

test("#3098: .muted tem opacity entre 0.62 e 0.65 (subiu de 0.55, abaixo de AA)", () => {
  const html = renderDashboardHtml(baseData());
  const style = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  const rule = style.match(/\.muted\s*\{[^}]*\}/)?.[0] ?? "";
  const m = rule.match(/opacity:\s*([\d.]+)/);
  assert.ok(m, ".muted deve declarar opacity");
  const opacity = parseFloat(m![1]);
  assert.ok(opacity >= 0.62 && opacity <= 0.65, `opacity deveria estar em [0.62, 0.65], veio ${opacity}`);
  assert.notEqual(opacity, 0.55, "0.55 não deve mais ser usado (abaixo de AA)");
});

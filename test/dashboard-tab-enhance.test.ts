/**
 * test/dashboard-tab-enhance.test.ts (#2622)
 *
 * Garante que o progressive enhancement das abas — deep-link (hash<->aba) +
 * aria-selected — está presente em AMBOS os dashboards (diaria + brevo/clarice),
 * preservando o fallback CSS-only puro (radios + labels role=tab seguem no HTML
 * mesmo sem JS).
 *
 * Usa import dinâmico (padrão do repo para os workers Cloudflare).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

function diariaBase(): import("../workers/diaria-dashboard/src/types.ts").DashboardData {
  return {
    generated_at: "2026-06-27T00:00:00Z",
    schema_version: 1,
    source_health: { entries: [], total: 0, verde: 0, amarelo: 0, vermelho: 0, generated_at: "" },
    ctr: null,
    overnight: { runs: [], total_runs: 0 },
    use_melhor: null,
    poll_eia: null,
    stubs: [],
  };
}

function assertTabEnhance(html: string, nome: string): void {
  // Progressive enhancement (JS opcional)
  assert.match(html, /#2622: progressive enhancement/, `${nome}: script de enhancement presente`);
  assert.match(html, /aria-selected/, `${nome}: sync de aria-selected presente`);
  assert.match(html, /history\.replaceState/, `${nome}: deep-link via hash (replaceState) presente`);
  assert.match(html, /hashchange/, `${nome}: listener de hashchange presente`);
  // Fallback CSS-only puro preservado: sem JS, as abas seguem funcionando.
  assert.match(html, /class="tab-radios"/, `${nome}: radios CSS-only preservados`);
  assert.match(html, /role="tab"/, `${nome}: labels role=tab preservados`);
}

test("#2622: diaria-dashboard — progressive enhancement das abas + fallback CSS-only", async () => {
  const { renderDashboardHtml } = await import("../workers/diaria-dashboard/src/index.ts");
  assertTabEnhance(renderDashboardHtml(diariaBase()), "diaria");
});

test("#2622: brevo-dashboard — progressive enhancement das abas + fallback CSS-only", async () => {
  const { renderDashboardHtml } = await import("../workers/brevo-dashboard/src/index.ts");
  assertTabEnhance(renderDashboardHtml([]), "brevo");
});

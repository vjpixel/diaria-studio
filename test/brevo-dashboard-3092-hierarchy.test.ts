/**
 * test/brevo-dashboard-3092-hierarchy.test.ts (#3092 grab-bag — hierarquia visual)
 *
 * Regressão (#633) para o bloco de hierarquia da issue #3092:
 *  - A aba Engajamento empilha 5 tabelas consecutivas (S1 diário, Agregada,
 *    Fria, Quente, Mensal) sem separação visual além da margem padrão de
 *    `.phase2-section` — adicionada regra de margem/borda mais forte entre
 *    seções CONSECUTIVAS (`.phase2-section + .phase2-section`, adjacent
 *    sibling — não afeta a 1ª seção de cada aba).
 *  - Os h4 internos "Agregada"/"Fria"/"Quente" (dentro de "Resumo A/B/C por
 *    Audiência") usavam só `style="margin:16px 0 4px 0"` — mesmo peso visual
 *    do texto normal, sem sinalizar que são 3 subdivisões de UMA tabela-mãe.
 *    Rebaixados com tratamento tipo <th> (uppercase/opacity/letter-spacing)
 *    via classe `.subsection-title`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDashboardHtml, renderAbcAudienceSection, aggregateAbcByAudience } from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

function makeCampaign(id: number, name: string, sentDate: string): BrevoCampaign {
  return {
    id,
    name,
    subject: "s",
    status: "sent",
    sentDate,
    scheduledAt: sentDate,
    createdAt: sentDate,
    recipients: { lists: [id + 100] },
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990, hardBounces: 1, softBounces: 1,
        uniqueViews: 250, viewed: 250, trackableViews: 200,
        uniqueClicks: 40, clickers: 40, unsubscriptions: 5, complaints: 0, appleMppOpens: 10,
      },
    },
  } as unknown as BrevoCampaign;
}

// ---------------------------------------------------------------------------
// separação entre seções CONSECUTIVAS
// ---------------------------------------------------------------------------

test("#3092: CSS tem regra .phase2-section + .phase2-section com margem/borda mais fortes que a seção isolada", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  const baseRule = styleBlock.match(/(?<!\+ )\.phase2-section\s*\{[^}]*\}/)?.[0] ?? "";
  const siblingRule = styleBlock.match(/\.phase2-section \+ \.phase2-section\s*\{[^}]*\}/)?.[0] ?? "";
  assert.ok(baseRule, "regra base .phase2-section deve existir");
  assert.ok(siblingRule, "regra .phase2-section + .phase2-section (adjacent sibling) deve existir");
  assert.match(siblingRule, /border-top:\s*1px solid var\(--rule\)/, "seções consecutivas ganham régua visual entre elas");
  assert.match(siblingRule, /margin-top:\s*48px/, "seções consecutivas ganham margem maior que a base (32px)");
});

// ---------------------------------------------------------------------------
// h4 rebaixado (Agregada/Fria/Quente)
// ---------------------------------------------------------------------------

test("#3092: h4 'Agregada'/'Fria'/'Quente' usa class=\"subsection-title\", não style inline", () => {
  const cycle = "2606-07";
  const cold = [
    makeCampaign(1, "cold 2606-07 — A: s", "2026-07-05T09:00:00Z"),
    makeCampaign(2, "cold 2606-07 — B: s", "2026-07-05T09:01:00Z"),
    makeCampaign(3, "cold 2606-07 — C: s", "2026-07-05T09:02:00Z"),
  ];
  const warm = [
    makeCampaign(4, "Clarice News 2606-07 — A: s", "2026-07-03T06:00:00Z"),
    makeCampaign(5, "Clarice News 2606-07 — B: s", "2026-07-03T06:01:00Z"),
    makeCampaign(6, "Clarice News 2606-07 — C: s", "2026-07-03T06:02:00Z"),
  ];
  const result = aggregateAbcByAudience([...cold, ...warm], cycle);
  const html = renderAbcAudienceSection(cycle, result);
  assert.match(html, /<h4 class="subsection-title">Agregada \(Fria \+ Quente\)<\/h4>/);
  assert.match(html, /<h4 class="subsection-title">Fria \(nunca recebeu\)<\/h4>/);
  assert.match(html, /<h4 class="subsection-title">Quente \(já engajada\)<\/h4>/);
  assert.doesNotMatch(html, /<h4 style="margin:16px 0 4px 0;">/, "não deve mais usar o style inline antigo");
});

test("#3092: .subsection-title tem tratamento tipo <th> (uppercase, opacity, letter-spacing), sem cor nova", () => {
  const html = renderDashboardHtml([]);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? "";
  const rule = styleBlock.match(/\.subsection-title\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(rule, /text-transform:\s*uppercase/);
  assert.match(rule, /letter-spacing:/);
  assert.match(rule, /opacity:/);
  assert.match(rule, /color:\s*var\(--ink\)/, "não deve introduzir cor nova — reusa --ink");
});

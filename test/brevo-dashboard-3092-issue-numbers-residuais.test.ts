/**
 * test/brevo-dashboard-3092-issue-numbers-residuais.test.ts (#3092 grab-bag — follow-up)
 *
 * Achados do /code-review max (cleanup pass) no PR fix/3092-consistencia-estilos:
 * o fix original das notas de Cupons (removeu "#2750" do texto visível ao
 * editor) deixou passar 3 outras instâncias do MESMO padrão, na MESMA função
 * (renderContactsSummarySection) e num arquivo irmão (COHORTS_COLUMNS):
 *  - "Score (re-envio, por faixa — aguardando refresh #2731)" — header de tabela
 *  - "Sumário agregado do store único (#2647)." — nota de seção
 *  - "Cohort (taxonomia #2857)" — tooltip sempre-visível no glossário de colunas
 *  - footer global: "...em vez de circuit breaker (#3091; ver nota da própria
 *    tabela)." — legenda visível em toda página
 *
 * Nota: "#2871" em renderAbcSection (placeholder de reset do teste A/B/C) NÃO
 * foi removido — tem teste dedicado (test/brevo-dashboard-fase2.test.ts,
 * "#2871") que EXIGE a presença do número como referência à decisão
 * documentada do editor. Esse caso é intencional, não um leak acidental.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderContactsSummarySection,
  renderCohortsTabPanel,
  renderDashboardHtml,
  type ContactsSummary,
  type CohortStatsRow,
} from "../workers/brevo-dashboard/src/index.ts";

const sample: ContactsSummary = {
  generated_at: "2026-06-29T12:00:00Z",
  total: 100,
  brevo: { synced_rows: 50, has_signal: true },
  eligibility: { eligible: 90, ineligible: 10, by_reason: {} },
  priority_points: { lt0: 0, eq0: 100, p1_40: 0, p41_80: 0, gt80: 0, optin: 0 },
  mv: { verified: 40, none: 60 },
  engagement: { with_opens: 0, with_clicks: 0 },
};

test("#3092: renderContactsSummarySection não vaza '#2647'/'#2731' no texto visível ao editor", () => {
  // Fallback pré-#2731 (sem priority_points_histogram) exercita o header
  // "Score (re-envio, por faixa...)".
  const html = renderContactsSummarySection(sample);
  assert.doesNotMatch(html, /#2647/, "sumário do store não deve mais citar #2647 no texto visível");
  assert.doesNotMatch(html, /#2731/, "header de Score (re-envio) não deve mais citar #2731 no texto visível");
  assert.match(html, /Sumário agregado do store único\./, "nota do sumário deve continuar presente, só sem o número");
  assert.match(html, /aguardando refresh\)/, "header de fallback deve continuar indicando que está aguardando refresh");
});

test("#3092: tooltip da coluna 'Cohort' (COHORTS_COLUMNS) não vaza '#2857'", () => {
  const stats: Record<string, CohortStatsRow> = {
    "assinantes-ativos": { contacts: 10, eligible: 9, received: 9, opened: 5, clicked: 1, unsub: 0, hard_bounce: 0 },
  };
  const html = renderCohortsTabPanel(stats);
  assert.doesNotMatch(html, /#2857/, "tooltip/glossário da coluna Cohort não deve mais citar #2857");
  assert.match(html, /taxonomia/, "tooltip deve continuar explicando que é uma taxonomia nomeada");
});

test("#3092: footer global não vaza '#3091' na legenda de vermelho/circuit breaker", () => {
  const html = renderDashboardHtml([]);
  const footer = html.match(/<p class="footer">[\s\S]*?<\/p>/)?.[0] ?? "";
  assert.doesNotMatch(footer, /#3091/, "footer não deve mais citar #3091 no texto visível");
  assert.match(footer, /Vermelho sempre significa/i, "footer deve continuar afirmando que vermelho é sempre 'ruim'");
});

/**
 * test/brevo-dashboard-3092-cycle-label.test.ts (#3092 grab-bag — clareza do título do ciclo)
 *
 * Regressão (#633) para o item de navegação/clareza da issue #3092: o título
 * "Resumo A/B/C por Audiência (2607-07)" mostra o ciclo cru (formato
 * conteúdo-envio, AAMM-MM — ver CLAUDE.md), opaco pro editor à primeira
 * vista. `formatCycleEnvioLabel` deriva o sufixo legível do mês/ano de ENVIO
 * (a janela que de fato aparece nas linhas da tabela).
 *
 * Escopo explícito (decisão da rodada #3092): SÓ este item de clareza de
 * título foi implementado. "Fundir aba Links/Cliques com Engajamento" é
 * decisão de produto/navegação fora de escopo — comentado na issue, não
 * implementado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCycleEnvioLabel, renderAbcAudienceSection, aggregateAbcByAudience } from "../workers/brevo-dashboard/src/index.ts";
import type { BrevoCampaign } from "../workers/brevo-dashboard/src/types.ts";

// ---------------------------------------------------------------------------
// formatCycleEnvioLabel — unidade
// ---------------------------------------------------------------------------

test("#3092: formatCycleEnvioLabel deriva mês/ano de ENVIO a partir do ciclo conteúdo-envio", () => {
  // 2605-06: conteúdo=maio/2026, envio=junho/2026 (exemplo do CLAUDE.md)
  assert.equal(formatCycleEnvioLabel("2605-06"), "envios de jun/2026");
  // 2606-07: conteúdo=junho/2026, envio=julho/2026
  assert.equal(formatCycleEnvioLabel("2606-07"), "envios de jul/2026");
});

test("#3092: formatCycleEnvioLabel avança o ANO do envio quando o mês 'volta' (dez → jan)", () => {
  // conteúdo=dezembro/2026, envio=janeiro — deve ser 2027, não 2026.
  assert.equal(formatCycleEnvioLabel("2612-01"), "envios de jan/2027");
});

test("#3092: formatCycleEnvioLabel retorna null pra formato não reconhecido (título funciona sem o sufixo)", () => {
  assert.equal(formatCycleEnvioLabel("2607"), null, "ciclo diário (AAMM, sem hífen) não é um ciclo mensal");
  assert.equal(formatCycleEnvioLabel("not-a-cycle"), null);
  assert.equal(formatCycleEnvioLabel(""), null);
});

// ---------------------------------------------------------------------------
// integração — título da seção "Resumo A/B/C por Audiência"
// ---------------------------------------------------------------------------

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

test("#3092: título 'Resumo A/B/C por Audiência' acrescenta a data legível do ciclo (não só o cru '2606-07')", () => {
  const cycle = "2606-07";
  const campaigns = [
    makeCampaign(1, "cold 2606-07 — A: s", "2026-07-05T09:00:00Z"),
    makeCampaign(2, "cold 2606-07 — B: s", "2026-07-05T09:01:00Z"),
    makeCampaign(3, "cold 2606-07 — C: s", "2026-07-05T09:02:00Z"),
  ];
  const result = aggregateAbcByAudience(campaigns, cycle);
  const html = renderAbcAudienceSection(cycle, result);
  assert.match(
    html,
    /<h2 class="section-title">Resumo A\/B\/C por Audiência \(2606-07 · envios de jul\/2026\)<\/h2>/,
    "título deve conter o ciclo cru E o sufixo legível",
  );
});

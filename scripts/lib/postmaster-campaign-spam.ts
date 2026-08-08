/**
 * scripts/lib/postmaster-campaign-spam.ts (#4704 — item residual "spam POR
 * CAMPANHA", checklist original da issue)
 *
 * Funções PURAS (sem I/O) que ligam o `FEEDBACK_LOOP_ID` bruto devolvido pela
 * API v2 do Postmaster (`scripts/lib/postmaster-v2-client.ts`) a uma campanha
 * Brevo, e agregam a série diária de `FEEDBACK_LOOP_SPAM_RATE` de cada
 * campanha num resumo consultável. Consumidor de produção:
 * `scripts/postmaster-campaign-spam-report.ts` (I/O — as duas chamadas de API
 * + o print do relatório).
 *
 * ── Formato do feedback loop id (confirmado ao vivo em 260806, #4704) ──
 *
 * `{conta}_{campanha}` — ex: `"11130585_107"`, onde `11130585` é o
 * identificador de conta do ESP (Brevo) no Postmaster e `107` é o
 * `campaignId` da Brevo (`GET /v3/emailCampaigns/107`). Nem todo id desse
 * formato existe: a lista de `FEEDBACK_LOOP_ID` de um dia também inclui a
 * conta SOZINHA (`"11130585"`, tráfego não atribuído a campanha) e IPs crus
 * (`"77.32.148.101"`) — nenhum dos dois mapeia pra campanha, e
 * `parseFeedbackLoopId` devolve `null` pra ambos.
 *
 * ── Por que PICO, não só média (`aggregateCampaignSpamReadings`) ──
 *
 * O achado que motivou esta feature (comentário do editor na #4704) foi
 * justamente que o agregado por DOMÍNIO mascara o problema: em 02/08/2026 o
 * domínio inteiro leu 0,41% no dia, mas a campanha `_107` sozinha leu 1,39% —
 * quase 3,4× o agregado. Reportar só a MÉDIA da janela por campanha cometeria
 * o mesmo erro em escala menor (dilui um dia ruim isolado ao longo da
 * janela), então `aggregateCampaignSpamReadings` reporta os dois: a média (pra
 * comparabilidade) e o PICO com a data em que ocorreu (o sinal que de fato
 * importa pra decidir se uma variante específica tem problema).
 */

import type { DayReadingV2 } from "./postmaster-v2-client.ts";

/**
 * Confirmado ao vivo (#4704, 260806, comentário do editor): prefixo de conta
 * ESP (Brevo) em todo feedback_loop_id de campanha (`{conta}_{campanha}`).
 * Fonte única — antes vivia hardcoded separadamente em
 * `postmaster-campaign-spam-report.ts` (`--account-id` continua podendo
 * sobrescrever lá) e, desde #4705, também em `postmaster-spam-sync.ts` (sem
 * flag de override — caminho de produção automatizado). Não é garantido que
 * a conta nunca mude; um valor observado, não uma constante da API.
 */
export const DEFAULT_POSTMASTER_ACCOUNT_ID = "11130585";

/**
 * `{conta}_{campanha}`, ambos numéricos — ver docstring do arquivo. Ids que
 * não casam (conta sozinha, IP, qualquer outro formato) não mapeiam pra
 * campanha.
 */
const FEEDBACK_LOOP_CAMPAIGN_ID_RE = /^(\d+)_(\d+)$/;

export interface ParsedFeedbackLoopId {
  feedbackLoopId: string;
  account: string;
  campaignId: number;
}

/**
 * Pura: tenta interpretar um feedback_loop_id bruto como `{conta}_{campanha}`.
 * `null` quando o id não casa o formato (conta sozinha, IP, ou qualquer outro
 * valor que a API venha a devolver no futuro — nunca lança, o chamador decide
 * se ignora ou reporta o id não-mapeado).
 */
export function parseFeedbackLoopId(id: string): ParsedFeedbackLoopId | null {
  const m = FEEDBACK_LOOP_CAMPAIGN_ID_RE.exec(id.trim());
  if (!m) return null;
  return { feedbackLoopId: id, account: m[1], campaignId: Number(m[2]) };
}

/**
 * Pura: dedup por `campaignId` sobre múltiplos dias de `FEEDBACK_LOOP_ID` — a
 * mesma campanha aparece em vários dias da lista bruta (o feedback loop
 * report não é pontual), e só precisamos de UM `feedbackLoopId` por campanha
 * pra montar a query de `FEEDBACK_LOOP_SPAM_RATE` (o id não muda entre dias
 * pra uma mesma campanha).
 *
 * `accountId`, se passado, restringe a ids daquela conta ESP — ids que não
 * casam `{conta}_{campanha}` (conta sozinha, IP) são SEMPRE descartados,
 * independente de `accountId` estar presente ou não.
 *
 * Ordena por `campaignId` crescente — ordem determinística, não é a ordem
 * final do relatório (essa vem de `sortCampaignSpamReport`, por severidade).
 */
export function collectCampaignFeedbackLoopIds(
  idsByDay: { ids: string[] }[],
  accountId?: string,
): ParsedFeedbackLoopId[] {
  const seen = new Map<number, ParsedFeedbackLoopId>();
  for (const day of idsByDay) {
    for (const rawId of day.ids) {
      const parsed = parseFeedbackLoopId(rawId);
      if (!parsed) continue;
      if (accountId && parsed.account !== accountId) continue;
      if (!seen.has(parsed.campaignId)) seen.set(parsed.campaignId, parsed);
    }
  }
  return [...seen.values()].sort((a, b) => a.campaignId - b.campaignId);
}

export interface CampaignSpamAggregate {
  campaignId: number;
  feedbackLoopId: string;
  avgSpamRatePct: number;
  peakSpamRatePct: number;
  /** YYYY-MM-DD do dia com a maior leitura (empate: o primeiro encontrado na ordem cronológica de `dailyReadings`). */
  peakDate: string;
  daysWithData: number;
  /** Ordenado cronologicamente (mais antigo primeiro) — mesma convenção de `PostmasterSpamEntry.dailyReadings`. */
  dailyReadings: Array<{ date: string; spamRatePct: number }>;
}

/**
 * Pura: agrega as leituras diárias de `FEEDBACK_LOOP_SPAM_RATE` de UMA
 * campanha (já filtradas pelo `filter=feedback_loop_id="..."` na query, então
 * `readings` aqui é só dessa campanha). `null` se não há nenhuma leitura na
 * janela (mesma disciplina de `buildAveragedEntry` em `postmaster-spam-sync.ts`
 * — nunca inventar uma média/pico de zero elementos).
 *
 * Ver docstring do arquivo pro porquê de reportar PICO além da média.
 */
export function aggregateCampaignSpamReadings(
  campaignId: number,
  feedbackLoopId: string,
  readings: DayReadingV2[],
): CampaignSpamAggregate | null {
  if (readings.length === 0) return null;
  const dailyReadings = [...readings]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((r) => ({ date: r.date, spamRatePct: r.ratio * 100 }));
  const avgSpamRatePct = dailyReadings.reduce((sum, r) => sum + r.spamRatePct, 0) / dailyReadings.length;
  const peak = dailyReadings.reduce((max, r) => (r.spamRatePct > max.spamRatePct ? r : max), dailyReadings[0]);
  return {
    campaignId,
    feedbackLoopId,
    avgSpamRatePct,
    peakSpamRatePct: peak.spamRatePct,
    peakDate: peak.date,
    daysWithData: dailyReadings.length,
    dailyReadings,
  };
}

/**
 * Pura: ordena desc por PICO (não média) — é o pico que sinaliza "essa
 * variante teve um problema pontual", consistente com o racional de
 * `aggregateCampaignSpamReadings` acima. Não muta o array de entrada.
 */
export function sortCampaignSpamReport(rows: CampaignSpamAggregate[]): CampaignSpamAggregate[] {
  return [...rows].sort((a, b) => b.peakSpamRatePct - a.peakSpamRatePct);
}

/**
 * #4705: o valor por-campanha que alimenta o breaker (ver
 * `resolveSpamSignal` em `workers/brevo-dashboard/src/thresholds.ts`) —
 * `feedbackLoopId`/`campaignId` só informativos (debug/auditoria).
 */
export interface WorstCampaignSpam {
  campaignId: number;
  feedbackLoopId: string;
  spamRatePct: number;
  /** YYYY-MM-DD do dia em que o pico ocorreu (`peakDate` da campanha vencedora). */
  date: string;
}

/**
 * Pura: dentre as agregações de VÁRIAS campanhas na mesma janela, acha a que
 * teve o PICO mais alto (comparando pico contra pico, não média contra
 * média) — é este número que #4705 grava em
 * `PostmasterSpamEntry.worstCampaignSpamRatePct` pra alimentar o breaker,
 * preferido sobre a média de domínio quando disponível (ver
 * `resolveSpamSignal`). `null` quando `aggregates` está vazio (nenhuma
 * campanha atribuível na janela) — o chamador decide o fallback (domínio).
 */
export function findWorstCampaignSpam(aggregates: CampaignSpamAggregate[]): WorstCampaignSpam | null {
  if (aggregates.length === 0) return null;
  const worst = aggregates.reduce((max, a) => (a.peakSpamRatePct > max.peakSpamRatePct ? a : max), aggregates[0]);
  return {
    campaignId: worst.campaignId,
    feedbackLoopId: worst.feedbackLoopId,
    spamRatePct: worst.peakSpamRatePct,
    date: worst.peakDate,
  };
}

#!/usr/bin/env node
/**
 * postmaster-campaign-spam-report.ts (#4704 — item residual "spam POR
 * CAMPANHA" do checklist original, atacado nesta unidade porque ganha valor
 * concreto com o envio da Clarice previsto pra 07/08/2026)
 *
 * Relatório sob demanda: separa a leitura de spam do Postmaster POR CAMPANHA
 * (variante A/B/C de assunto), em vez de só o agregado por domínio inteiro
 * que `postmaster-spam-sync.ts` grava no breaker. Não escreve em nenhum KV de
 * produção — é 100% leitura (Postmaster `domainStats:query` + opcionalmente
 * Brevo `GET /emailCampaigns/{id}` pra enriquecer com nome/assunto), pensado
 * pra rodar ad-hoc quando o editor quer decidir se um assunto específico está
 * gerando reclamação antes do próximo envio da mesma safra.
 *
 * Persistência: DELIBERADAMENTE nenhuma (fora do escopo desta unidade — ver
 * comentário do editor na #4704, "Depois desta issue, não antes": uma coluna
 * de spam por campanha na tabela Envios do dashboard é o consumidor natural
 * deste dado, mas cruzar isso com KV/worker é sequenciado como trabalho
 * futuro separado). Este script imprime o relatório em texto (sempre) e,
 * com `--json`, também a estrutura completa em JSON — quem quiser persistir
 * hoje redireciona a saída `--json` pra um arquivo por fora do script.
 *
 * Como funciona:
 *   1. Query `FEEDBACK_LOOP_ID` (DAILY) sobre a janela — devolve, por dia, a
 *      lista de feedback loop ids ativos naquele dia.
 *   2. `collectCampaignFeedbackLoopIds` (scripts/lib/postmaster-campaign-spam.ts)
 *      deduplica por campanha e filtra os ids que não são `{conta}_{campanha}`
 *      (conta sozinha, IP — nunca mapeiam pra campanha).
 *   3. Pra cada campanha encontrada, 1 query `FEEDBACK_LOOP_SPAM_RATE`
 *      filtrada por `feedback_loop_id="..."` (DAILY, mesma janela) —
 *      sequencial, não paralelo, pra não arriscar rajada de POSTs contra uma
 *      API cujo comportamento de rate-limit em paralelo não foi medido ao
 *      vivo (a v2 elimina os 429 estruturais do padrão "N GETs diários" da
 *      v1, mas isso não foi testado sob N chamadas SIMULTÂNEAS).
 *   4. Se `BREVO_CLARICE_API_KEY` estiver setada, tenta enriquecer cada linha
 *      com nome/assunto da campanha via `brevoGetCampaign` — best-effort,
 *      uma falha (campanha antiga sem histórico, key ausente, rede) nunca
 *      derruba o relatório: a linha cai pra "campanha #{id} (nome
 *      indisponível)".
 *
 * Uso:
 *   npx tsx scripts/postmaster-campaign-spam-report.ts [--window-days 10] [--account-id 11130585] [--json]
 *
 * Env:
 *   data/.credentials.json  com o scope `postmaster.traffic.readonly` (ou
 *                            `postmaster`) — mesmo requisito de
 *                            `postmaster-spam-sync.ts`. Ver scripts/oauth-setup.ts.
 *   BREVO_CLARICE_API_KEY   opcional — sem ela, o relatório sai só com
 *                            campaignId (sem nome/assunto).
 */

import { gFetch } from "./google-auth.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { brevoGetCampaign } from "./lib/brevo-client.ts";
import {
  queryDomainStatsV2,
  extractFeedbackLoopIdsV2,
  extractSpamRateReadingsV2,
  type DateRangeV2,
  type QueryDomainStatsResponseV2,
} from "./lib/postmaster-v2-client.ts";
import {
  collectCampaignFeedbackLoopIds,
  aggregateCampaignSpamReadings,
  sortCampaignSpamReport,
  type CampaignSpamAggregate,
  type ParsedFeedbackLoopId,
} from "./lib/postmaster-campaign-spam.ts";
import { buildWindowRange, parseWindowDaysArg } from "./postmaster-spam-sync.ts";

loadProjectEnv();

const POSTMASTER_DOMAIN = "clarice.ai";
/** Confirmado ao vivo (#4704, 260806, comentário do editor): prefixo de conta
 * ESP (Brevo) em todo feedback_loop_id de campanha (`{conta}_{campanha}`).
 * Overridable via `--account-id` — não é garantido que a conta nunca mude. */
const DEFAULT_ACCOUNT_ID = "11130585";
const FEEDBACK_LOOP_ID_METRIC_NAME = "feedback_loop_id";
const SPAM_RATE_METRIC_NAME = "spam_rate";

export interface CampaignSpamReportRow extends CampaignSpamAggregate {
  campaignName?: string;
  campaignSubject?: string;
}

/**
 * Pura: monta as linhas finais do relatório a partir das agregações por
 * campanha + um resolvedor de metadata opcional (injetável pra teste sem
 * rede). `resolveMetadata` nunca lança pro chamador — falhas individuais
 * viram `undefined` (linha some com só o campaignId), nunca derrubam o
 * relatório inteiro.
 */
export async function enrichWithCampaignMetadata(
  rows: CampaignSpamAggregate[],
  resolveMetadata: ((campaignId: number) => Promise<{ name?: string; subject?: string } | null>) | null,
): Promise<CampaignSpamReportRow[]> {
  if (!resolveMetadata) return rows.map((r) => ({ ...r }));
  const out: CampaignSpamReportRow[] = [];
  for (const row of rows) {
    let meta: { name?: string; subject?: string } | null = null;
    try {
      meta = await resolveMetadata(row.campaignId);
    } catch (e) {
      // best-effort — nunca derruba o relatório por 1 campanha problemática, mas
      // console.warn torna a falha visível: sem isso, um BREVO_CLARICE_API_KEY
      // inválido (401/403 sistemático) e uma campanha antiga não encontrada na
      // Brevo (404 pontual) ficam indistinguíveis — as duas viram silenciosamente
      // "nome indisponível" em toda linha, sem sinal de qual é a causa real.
      console.warn(
        `[postmaster-campaign-spam-report] falha ao buscar metadata da campanha #${row.campaignId}: ${e instanceof Error ? e.message : String(e)}`,
      );
      meta = null;
    }
    out.push({ ...row, campaignName: meta?.name, campaignSubject: meta?.subject });
  }
  return out;
}

/** Formata o relatório em texto simples pro terminal — 1 bloco por campanha, ordenado por severidade (pico desc). */
export function formatCampaignSpamReport(rows: CampaignSpamReportRow[], windowDays: number): string {
  if (rows.length === 0) {
    return `[postmaster-campaign-spam-report] Nenhuma campanha com feedback_loop_id no formato {conta}_{campanha} na janela de ${windowDays} dias.`;
  }
  const lines: string[] = [
    `[postmaster-campaign-spam-report] ${rows.length} campanha(s) com feedback loop id na janela de ${windowDays} dias (ordenado por pico desc):`,
    "",
  ];
  for (const r of rows) {
    const label = r.campaignName ? `#${r.campaignId} — ${r.campaignName}` : `#${r.campaignId} (nome indisponível)`;
    lines.push(label);
    if (r.campaignSubject) lines.push(`  assunto: ${r.campaignSubject}`);
    lines.push(`  feedback_loop_id: ${r.feedbackLoopId}`);
    lines.push(`  pico: ${r.peakSpamRatePct.toFixed(3)}% em ${r.peakDate}  |  média: ${r.avgSpamRatePct.toFixed(3)}%  |  ${r.daysWithData} dia(s) com dado`);
    lines.push(`  série: ${r.dailyReadings.map((d) => `${d.date}=${d.spamRatePct.toFixed(3)}%`).join(", ")}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

async function fetchFeedbackLoopIdsByDay(
  range: DateRangeV2,
): Promise<{ ids: string[] }[]> {
  const response = await queryDomainStatsV2(
    POSTMASTER_DOMAIN,
    [{ name: FEEDBACK_LOOP_ID_METRIC_NAME, standardMetric: "FEEDBACK_LOOP_ID" }],
    range,
    gFetch,
  );
  return extractFeedbackLoopIdsV2(response, FEEDBACK_LOOP_ID_METRIC_NAME);
}

async function fetchCampaignSpamReadings(
  range: DateRangeV2,
  parsed: ParsedFeedbackLoopId,
): Promise<CampaignSpamAggregate | null> {
  const response: QueryDomainStatsResponseV2 = await queryDomainStatsV2(
    POSTMASTER_DOMAIN,
    [
      {
        name: SPAM_RATE_METRIC_NAME,
        standardMetric: "FEEDBACK_LOOP_SPAM_RATE",
        filter: `feedback_loop_id="${parsed.feedbackLoopId}"`,
      },
    ],
    range,
    gFetch,
  );
  const readings = extractSpamRateReadingsV2(response, SPAM_RATE_METRIC_NAME);
  return aggregateCampaignSpamReadings(parsed.campaignId, parsed.feedbackLoopId, readings);
}

async function resolveBrevoCampaignMetadata(campaignId: number): Promise<{ name?: string; subject?: string } | null> {
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  if (!apiKey) return null;
  const detail = await brevoGetCampaign(apiKey, campaignId);
  // #4704 fleet review: `subject` é o que de fato distingue as variantes A/B/C
  // de teste (o `name` da campanha na Brevo é genérico) — era omitido aqui só
  // porque `brevoGetCampaign` não tipava o campo, não porque a API não devolve.
  return { name: detail.name, subject: detail.subject };
}

async function main(): Promise<void> {
  const windowArg = getStringArg(process.argv, "window-days", { example: "10" }) ?? "";
  const accountIdArg = getStringArg(process.argv, "account-id", { example: DEFAULT_ACCOUNT_ID });
  const asJson = hasFlag(process.argv, "json");

  let windowDays: number;
  try {
    windowDays = parseWindowDaysArg(windowArg);
  } catch (e) {
    console.error(`[postmaster-campaign-spam-report] ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const accountId = accountIdArg ?? DEFAULT_ACCOUNT_ID;
  const now = new Date();
  const range = buildWindowRange(windowDays, now);

  const idsByDay = await fetchFeedbackLoopIdsByDay(range);
  const campaigns = collectCampaignFeedbackLoopIds(idsByDay, accountId);

  if (campaigns.length === 0) {
    // Distingue "sem tráfego de feedback loop na janela" de "tráfego existe, mas
    // nenhum id bateu accountId" — sem isso, um DEFAULT_ACCOUNT_ID desatualizado
    // (constante hardcoded a partir de UMA observação ao vivo, ver docstring do
    // módulo) lê exatamente como "nada pra reportar", mascarando a premissa
    // stale em vez de sinalizá-la.
    const rawIdCount = idsByDay.reduce((n, day) => n + day.ids.length, 0);
    const matchedAnyAccount = collectCampaignFeedbackLoopIds(idsByDay).length;
    if (rawIdCount > 0 && matchedAnyAccount > 0) {
      console.log(
        `[postmaster-campaign-spam-report] ${matchedAnyAccount} campanha(s) com feedback_loop_id no formato ` +
          `{conta}_{campanha} na janela de ${windowDays} dias, mas NENHUMA da conta="${accountId}" ` +
          `(--account-id) — confira se DEFAULT_ACCOUNT_ID ainda é a conta ESP certa antes de assumir que não há campanha.`,
      );
    } else {
      console.log(
        `[postmaster-campaign-spam-report] Nenhum feedback_loop_id no formato {conta}_{campanha} (conta="${accountId}") ` +
          `na janela de ${windowDays} dias — nenhuma campanha atribuível encontrada.`,
      );
    }
    return;
  }

  // Sequencial de propósito — ver docstring do arquivo (comportamento de
  // rate-limit da v2 sob N chamadas simultâneas não foi medido ao vivo).
  // #4704 fleet review: try/catch POR CAMPANHA — sem isso, 1 falha (429/5xx/
  // timeout) numa query propagava até main().catch() e derrubava o processo
  // inteiro via process.exit(1), descartando os resultados de campanhas que
  // já tinham tido sucesso. Mesmo padrão best-effort de `enrichWithCampaignMetadata`
  // logo abaixo — best-effort só numa das duas fases não bastava.
  const aggregates: CampaignSpamAggregate[] = [];
  for (const parsed of campaigns) {
    try {
      const agg = await fetchCampaignSpamReadings(range, parsed);
      if (agg) aggregates.push(agg);
    } catch (e) {
      console.warn(
        `[postmaster-campaign-spam-report] falha ao consultar FEEDBACK_LOOP_SPAM_RATE da campanha #${parsed.campaignId} ` +
          `(feedback_loop_id="${parsed.feedbackLoopId}"): ${e instanceof Error ? e.message : String(e)} — pulando, resto do relatório segue.`,
      );
    }
  }

  const sorted = sortCampaignSpamReport(aggregates);
  const hasBrevoKey = Boolean(process.env.BREVO_CLARICE_API_KEY);
  const rows = await enrichWithCampaignMetadata(sorted, hasBrevoKey ? resolveBrevoCampaignMetadata : null);

  if (!hasBrevoKey) {
    console.log(
      "[postmaster-campaign-spam-report] BREVO_CLARICE_API_KEY ausente — relatório sem nome/assunto de campanha (só campaignId).",
    );
  }

  console.log(formatCampaignSpamReport(rows, windowDays));

  if (asJson) {
    console.log("");
    console.log(JSON.stringify({ windowDays, accountId, generatedAt: now.toISOString(), campaigns: rows }, null, 2));
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("[postmaster-campaign-spam-report] erro:", e);
    process.exit(1);
  });
}

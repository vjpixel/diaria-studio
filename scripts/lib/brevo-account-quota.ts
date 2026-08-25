/**
 * scripts/lib/brevo-account-quota.ts (#6146)
 *
 * Cota de envio da CONTA Brevo — o balde que `daily_send_cap` nunca olhou.
 *
 * ## Por que este módulo existe
 *
 * `checkDailySendCap` (`publish-daily-brevo.ts`) valida o tamanho da LISTA
 * contra um teto de negócio (`brevo_diaria.daily_send_cap`). Ele responde
 * "a fila de reativação cresceu demais?" — nunca "a conta ainda pode
 * enviar hoje?". São perguntas diferentes, e a segunda derrubou a edição
 * 260825 (#6146):
 *
 *   - 24/08: o mass-send de onboarding (#6042) disparou 585 e-mails
 *     TRANSACIONAIS na mesma conta free.
 *   - A Brevo não entregou os 585 na hora: enfileirou e foi liberando no
 *     teto do plano (300/dia).
 *   - 25/08 01:26 UTC: a fila consumiu os 300 do dia inteiro.
 *   - 25/08 09:00 UTC: a campanha de marketing da diária venceu com zero
 *     cota disponível. A Brevo a marcou `suspended` em vez de enviar.
 *
 * O plano free da Brevo tem **um balde único de 300 e-mails/dia
 * compartilhado entre transacional e marketing**. Nenhum guard do repo
 * conhecia esse acoplamento — `daily_send_cap` (295) passava tranquilo
 * porque a lista tinha 140 contatos, e a campanha era criada e agendada
 * para morrer suspensa horas depois, em silêncio.
 *
 * ## Escopo deliberado: só o termo transacional
 *
 * `checkAccountSendQuota` soma o consumo TRANSACIONAL do dia + os
 * destinatários prestes a receber. Não soma o que outras campanhas de
 * marketing já enviaram hoje, por duas razões:
 *
 * 1. O canal `brevo_diaria` manda no máximo 1 campanha/dia, e essa
 *    campanha é justamente a que está sendo guardada — o termo seria zero
 *    na esmagadora maioria dos dias.
 * 2. `globalStats.sent` da Brevo é **comprovadamente não confiável** nesta
 *    conta: a campanha 28 (260824), com `status: "sent"` e notificação de
 *    envio a 142 contatos por e-mail, reporta `globalStats.sent: 0` pela
 *    API. Somar um número que pode vir zerado transformaria o guard num
 *    falso "tem cota sobrando" — pior que não somar.
 *
 * Consequência aceita e explícita: se um dia a conta passar a mandar mais
 * de uma campanha de marketing por dia, este guard subestima o consumo. O
 * jeito certo de fechar isso é a Brevo expor um contador de cota
 * confiável, não empilhar heurística sobre `globalStats`.
 */

import { brevoGet } from "./brevo-client.ts";

/**
 * Teto diário do plano free da Brevo — balde único, transacional +
 * marketing. Mesmo valor já usado como fallback hardcoded em
 * `publish-daily-brevo.ts` (`?? 300`) e `sync-pending-to-brevo.ts`
 * (`DEFAULT_QUEUE_CAP`), mas ali representando outra coisa (teto da FILA);
 * aqui é o limite real da plataforma.
 */
export const BREVO_FREE_DAILY_SEND_LIMIT = 300;

export interface AccountQuotaSnapshot {
  /** Requisições transacionais já contabilizadas hoje pela Brevo. */
  transactionalRequestsToday: number;
  /** `plan[].type` de `GET /v3/account` (ex: "free", "subscription"). */
  planType: string | null;
  /** `plan[].credits` do item com `creditsType === "sendLimit"`, se houver. */
  planSendCredits: number | null;
}

export type AccountQuotaCheck =
  | { ok: true; consumed: number; available: number; warning?: string }
  | { ok: false; consumed: number; available: number; reason: string };

/**
 * Pura. `recipients` é quanto o envio prestes a acontecer vai consumir.
 *
 * Estado impossível é hard-stop, nunca sucesso silencioso (mesmo princípio
 * do piso `totalSubscribers < seedCount` em `checkDailySendCap` e de
 * `detectZeroAudienceAnomaly` em `clarice-reapply-scheduled-html.ts`): um
 * contador negativo ou não-finito significa leitura corrompida da API, e
 * uma leitura corrompida não pode virar "tem cota, pode enviar".
 */
export function checkAccountSendQuota(params: {
  dailyLimit: number;
  transactionalRequestsToday: number;
  recipients: number;
}): AccountQuotaCheck {
  const { dailyLimit, transactionalRequestsToday, recipients } = params;

  for (const [label, value] of [
    ["dailyLimit", dailyLimit],
    ["transactionalRequestsToday", transactionalRequestsToday],
    ["recipients", recipients],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      return {
        ok: false,
        consumed: 0,
        available: 0,
        reason:
          `${label} inválido (${value}) — leitura corrompida da cota da conta Brevo. ` +
          "Abortando: cota ilegível nunca vira permissão de envio.",
      };
    }
  }

  const consumed = transactionalRequestsToday;
  const available = Math.max(0, dailyLimit - consumed);

  if (recipients > available) {
    return {
      ok: false,
      consumed,
      available,
      reason:
        `cota da CONTA Brevo esgotada para hoje: o plano permite ${dailyLimit} e-mail(s)/dia (balde único, ` +
        `transacional + marketing) e ${consumed} já foram consumidos por envio transacional — sobram ` +
        `${available}, mas esta campanha precisa de ${recipients}. A Brevo NÃO envia uma campanha sem cota: ` +
        "ela a marca `suspended` no horário agendado, em silêncio (incidente 260825, #6146). " +
        "Investigue o que consumiu a cota (`GET /v3/smtp/statistics/aggregatedReport`) antes de reagendar.",
    };
  }

  return { ok: true, consumed, available };
}

/**
 * Pura. Sinal SECUNDÁRIO, nunca gate: `plan[].credits === 0` num plano
 * free correlacionou com a suspensão de 260825, mas não foi possível
 * provar que o campo significa "cota diária restante" (contas free podem
 * simplesmente reportar 0 sempre — a Brevo não documenta). Vira aviso pro
 * operador, e a decisão de bloquear continua vindo da aritmética de
 * `checkAccountSendQuota`, que é medível e foi verificada ao vivo.
 */
export function describeQuotaWarnings(snapshot: AccountQuotaSnapshot): string[] {
  const warnings: string[] = [];
  if (snapshot.planType === "free" && snapshot.planSendCredits === 0) {
    warnings.push(
      "GET /v3/account reporta plano free com `credits: 0` (creditsType sendLimit) — pode indicar cota " +
        "diária zerada. Sinal fraco (a Brevo não documenta o campo pra contas free), não bloqueia sozinho.",
    );
  }
  return warnings;
}

/** Pura — `YYYY-MM-DD` no fuso UTC, formato aceito pelo endpoint de stats. */
export function toStatsDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

interface AggregatedReportResponse {
  requests?: number;
}

/**
 * I/O — consumo transacional do dia via
 * `GET /v3/smtp/statistics/aggregatedReport`.
 *
 * `requests` é o contador certo (e não `delivered`): conta o que a Brevo
 * ACEITOU, que é o que debita da cota. `delivered` exclui bounce/deferred
 * e subestimaria o consumo.
 */
export async function fetchTransactionalRequestsToday(
  apiKey: string,
  day: string,
): Promise<number> {
  const { body } = await brevoGet(
    apiKey,
    `/smtp/statistics/aggregatedReport?startDate=${day}&endDate=${day}`,
  );
  const requests = (body as AggregatedReportResponse)?.requests;
  // Ausência do campo é leitura inutilizável, não "zero consumido" — devolver
  // 0 aqui faria o guard concluir "300 disponíveis" numa resposta vazia.
  if (typeof requests !== "number" || !Number.isFinite(requests)) {
    throw new Error(
      `GET /smtp/statistics/aggregatedReport (${day}) não devolveu \`requests\` numérico ` +
        `(recebido: ${JSON.stringify(requests)}) — cota da conta ilegível.`,
    );
  }
  return requests;
}

interface AccountPlanEntry {
  type?: string;
  credits?: number;
  creditsType?: string;
}
interface AccountResponse {
  plan?: AccountPlanEntry[];
}

/** I/O — plano/créditos declarados em `GET /v3/account` (best-effort). */
export async function fetchAccountPlan(
  apiKey: string,
): Promise<{ planType: string | null; planSendCredits: number | null }> {
  const { body } = await brevoGet(apiKey, "/account");
  const plans = (body as AccountResponse)?.plan ?? [];
  const sendLimit = plans.find((p) => p.creditsType === "sendLimit");
  return {
    planType: sendLimit?.type ?? plans[0]?.type ?? null,
    planSendCredits: typeof sendLimit?.credits === "number" ? sendLimit.credits : null,
  };
}

/**
 * I/O — snapshot completo. `fetchAccountPlan` é best-effort de propósito:
 * ele alimenta só o aviso secundário, então uma falha ali não pode derrubar
 * o guard cujo dado principal (`requests`) já foi lido com sucesso.
 */
export async function fetchAccountQuotaSnapshot(
  apiKey: string,
  day: string,
): Promise<AccountQuotaSnapshot> {
  const transactionalRequestsToday = await fetchTransactionalRequestsToday(apiKey, day);
  let planType: string | null = null;
  let planSendCredits: number | null = null;
  try {
    const plan = await fetchAccountPlan(apiKey);
    planType = plan.planType;
    planSendCredits = plan.planSendCredits;
  } catch {
    // best-effort — ver docstring.
  }
  return { transactionalRequestsToday, planType, planSendCredits };
}

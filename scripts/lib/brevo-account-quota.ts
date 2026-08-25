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
 * 2. `globalStats.sent` da Brevo se mostrou não confiável nesta conta —
 *    1 caso concreto, a campanha 28 (260824): `status: "sent"` e
 *    notificação de envio a 142 contatos por e-mail, mas `globalStats.sent:
 *    0` pela API. Um caso basta pra decidir não somar: um número que PODE
 *    vir zerado viraria um falso "tem cota sobrando" — pior que não somar.
 *
 * Consequência aceita e explícita: se um dia a conta passar a mandar mais
 * de uma campanha de marketing por dia, este guard subestima o consumo. O
 * jeito certo de fechar isso é a Brevo expor um contador de cota
 * confiável, não empilhar heurística sobre `globalStats`.
 *
 * ## O que este guard prova — e o que ele NÃO prova
 *
 * A cota da Brevo zera por dia de CALENDÁRIO UTC, e o consumo de um dia é
 * um número que só cresce. Então a checagem é uma **condição necessária**,
 * medida sobre o dia do ENVIO (`sendDay`), nunca sobre "hoje": ela pode
 * provar *"não cabe"*, jamais *"vai caber"*. Entre a checagem e o disparo o
 * consumo pode subir e a campanha ainda morrer suspensa.
 *
 * Isso importa porque o agendamento roda antes do envio, às vezes no dia
 * UTC anterior (a Etapa 6 costuma rodar por volta da virada: a campanha 27
 * foi criada 20/08 23:57 UTC pra enviar 21/08 09:00 UTC). Nesse caso o
 * balde do `sendDay` ainda está intacto — e a Brevo nem deixa perguntar
 * sobre ele (HTTP 400 pra data futura, medido ao vivo). O veredito então
 * passa de graça: é fraco por construção ali, não por bug.
 * `describeQuotaWarnings` diz isso em voz alta em vez de deixar o "cota OK"
 * parecer garantia.
 *
 * O que cobre essa janela não é este guard e sim o alarme de campanha
 * `suspended` em `check-brevo-diaria-guardrail.ts` (a cada 4h), que detecta
 * o estrago depois do fato. Um é prevenção parcial, o outro é detecção —
 * o incidente 260825 não tinha nenhum dos dois.
 *
 * O aviso de TRANSBORDO existe pelo mesmo motivo: a Brevo não rejeita o
 * excedente, ela **enfileira e drena no dia seguinte**. Foi exatamente
 * assim que 24/08 matou 25/08. Por isso, quando o envio é num dia futuro,
 * o consumo de HOJE também é lido — não pra bloquear (não dá pra saber
 * quanto transborda), mas pra avisar que provavelmente vai transbordar.
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
  /** Dia UTC (`YYYY-MM-DD`) do ENVIO — o balde que interessa. */
  sendDay: string;
  /** `sendDay` ainda não começou. A Brevo recusa consultá-lo (HTTP 400), e
   * o consumo dele é 0 por definição — o gate passa de graça, ver avisos. */
  sendDayIsFuture: boolean;
  /** Requisições transacionais contabilizadas pela Brevo no `sendDay`.
   * Sempre 0 quando `sendDayIsFuture` (não consultado). */
  transactionalRequestsOnSendDay: number;
  /**
   * Consumo do dia CORRENTE, quando ele é outro que não o `sendDay`
   * (agendamento feito antes da virada UTC). `null` quando os dois
   * coincidem — aí `transactionalRequestsOnSendDay` já é "hoje". Serve só
   * pro aviso de transbordo; nunca entra na aritmética do gate.
   */
  transactionalRequestsToday: number | null;
  /** `plan[].type` de `GET /v3/account` (ex: "free", "subscription"). */
  planType: string | null;
  /** `plan[].credits` do item com `creditsType === "sendLimit"`, se houver. */
  planSendCredits: number | null;
}

/**
 * `ok` é a ÚNICA coisa que decide se pode enviar.
 *
 * `consumed`/`available` existem nos dois braços de propósito (o operador
 * quer os números no log mesmo — e principalmente — quando reprova), e por
 * isso o TypeScript deixa lê-los sem estreitar por `ok`. **Isso não é
 * licença pra decidir a partir deles.** `available` pode ser positivo num
 * resultado reprovado (teto 300, consumido 200, campanha de 150: sobram 100
 * e ainda assim não cabe), então um `if (available > 0)` é um falso verde —
 * exatamente a classe de bug que este módulo existe pra fechar, uma camada
 * acima. Use `ok` pro controle de fluxo; `consumed`/`available` só pra
 * mensagem.
 */
export type AccountQuotaCheck =
  | { ok: true; consumed: number; available: number }
  | { ok: false; consumed: number; available: number; reason: string };

/**
 * Fatia da config de `brevo_diaria` que este módulo entende. Declarada aqui
 * (e não numa `interface BrevoDiariaConfig` local em cada script) porque é
 * este módulo que tem a semântica do campo — sem isso, `publish-daily-brevo.ts`
 * e `schedule-daily-brevo.ts` mantêm duas cópias que só a disciplina mantém
 * em sincronia.
 */
export interface BrevoAccountLimitConfig {
  /** Teto diário da CONTA (balde único transacional+marketing). Ausente →
   * `BREVO_FREE_DAILY_SEND_LIMIT`. NÃO confundir com `daily_send_cap`, que é
   * o teto da FILA de reativação. */
  account_daily_limit?: number;
}

/** Pura — resolve o teto da conta com o default do plano free. */
export function resolveAccountDailyLimit(config: BrevoAccountLimitConfig | undefined): number {
  return config?.account_daily_limit ?? BREVO_FREE_DAILY_SEND_LIMIT;
}

/**
 * Pura. `recipients` é quanto o envio prestes a acontecer vai consumir.
 *
 * Estado impossível é hard-stop, nunca sucesso silencioso (mesmo princípio
 * do piso `totalSubscribers < seedCount` em `checkDailySendCap` e de
 * `detectZeroAudienceAnomaly` em `clarice-reapply-scheduled-html.ts`): um
 * contador negativo ou não-finito significa leitura corrompida da API, e
 * uma leitura corrompida não pode virar "tem cota, pode enviar".
 */
/**
 * ## Limitação conhecida: consumo entre a checagem e o disparo é invisível
 *
 * Achado do review (PR #6147). Mesmo medindo o dia certo (acima), a
 * checagem é um instantâneo: consumo transacional que aconteça DEPOIS dela
 * e ANTES do envio não aparece. Não é hipotético — foi exatamente um
 * mass-send transacional (#6042/#6043) que esvaziou o balde.
 *
 * **Por que não é bloqueante:** o alarme `Diaria-Brevo-Diaria-Guardrail`
 * roda a cada 4h e detecta campanha `suspended`, então a janela de silêncio
 * cai de ~12h (o que se viu em 260825) pra no máximo ~4h. É mitigação, não
 * conserto — o conserto seria reavaliar a cota imediatamente antes do
 * disparo, que exigiria um hook que hoje não existe (quem dispara é o
 * servidor da Brevo).
 *
 * **Corolário operacional:** volume transacional novo nesta conta sai do
 * mesmo balde da newsletter. Antes de ligar qualquer envio transacional
 * aqui, conferir o consumo — não basta a fila caber em `daily_send_cap`.
 */
export function checkAccountSendQuota(params: {
  dailyLimit: number;
  /** Consumo transacional já contabilizado no dia UTC do ENVIO. */
  transactionalRequestsOnSendDay: number;
  recipients: number;
}): AccountQuotaCheck {
  const { dailyLimit, transactionalRequestsOnSendDay, recipients } = params;

  for (const [label, value] of [
    ["dailyLimit", dailyLimit],
    ["transactionalRequestsOnSendDay", transactionalRequestsOnSendDay],
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

  const consumed = transactionalRequestsOnSendDay;
  const available = Math.max(0, dailyLimit - consumed);

  if (recipients > available) {
    return {
      ok: false,
      consumed,
      available,
      reason:
        `cota da CONTA Brevo esgotada para hoje: o plano permite ${dailyLimit} e-mail(s)/dia (balde único, ` +
        `transacional + marketing) e ${consumed} já foram consumidos por envio transacional no dia do envio — sobram ` +
        `${available}, mas esta campanha precisa de ${recipients}. A Brevo NÃO envia uma campanha sem cota: ` +
        "ela a marca `suspended` no horário agendado, em silêncio (incidente 260825, #6146). " +
        "Investigue o que consumiu a cota (`GET /v3/smtp/statistics/aggregatedReport`) antes de reagendar.",
    };
  }

  return { ok: true, consumed, available };
}

/**
 * Pura. Avisos que acompanham o veredito — nenhum deles bloqueia; todos
 * existem pra o "cota OK" não ser lido como garantia.
 *
 * 1. **Envio em dia futuro.** A checagem é sobre o balde do `sendDay`, que
 *    ainda está intacto — ela passa quase de graça. É limite inferior, não
 *    garantia (ver "O que este guard prova" no topo do módulo).
 * 2. **Transbordo.** Consumo de HOJE no teto (ou acima) com envio marcado
 *    pra outro dia: a Brevo não rejeita o excedente, enfileira e drena no
 *    dia seguinte. Foi assim que 24/08 esvaziou o balde de 25/08 antes das
 *    01:26 UTC. Não dá pra saber QUANTO transborda, então avisa em vez de
 *    bloquear.
 * 3. **`plan.credits === 0`.** Sinal fraco: correlacionou com a suspensão
 *    de 260825, mas não foi possível provar que o campo significa "cota
 *    restante" (contas free podem reportar 0 sempre — a Brevo não
 *    documenta). Por isso é aviso, e o gate continua sendo a aritmética de
 *    `checkAccountSendQuota`, que é medível.
 */
export function describeQuotaWarnings(snapshot: AccountQuotaSnapshot, dailyLimit: number): string[] {
  const warnings: string[] = [];

  if (snapshot.sendDayIsFuture) {
    warnings.push(
      `o envio é em ${snapshot.sendDay}, dia UTC que ainda não começou — a Brevo nem aceita consultar o ` +
        "consumo dele (HTTP 400), e o balde está intacto por definição, então este veredito NÃO é " +
        "verificação: passa de graça. O que cobre a janela entre agendar e enviar é o alarme de campanha " +
        "`suspended` do check-brevo-diaria-guardrail.",
    );
    if (snapshot.transactionalRequestsToday !== null && snapshot.transactionalRequestsToday >= dailyLimit) {
      warnings.push(
        `TRANSBORDO PROVÁVEL: hoje já foram ${snapshot.transactionalRequestsToday} requisição(ões) ` +
          `transacional(is) contra o teto de ${dailyLimit}. A Brevo não rejeita o excedente — enfileira e ` +
          `drena nos dias seguintes, podendo consumir o balde de ${snapshot.sendDay} antes do envio. ` +
          "Foi exatamente esse mecanismo que suspendeu a campanha em 260825 (#6146).",
      );
    }
  }

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
export async function fetchTransactionalRequests(
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
 * I/O — snapshot pro dia do ENVIO.
 *
 * **A Brevo recusa data futura**: `GET /smtp/statistics/aggregatedReport`
 * com `startDate` amanhã devolve HTTP 400 `"Start/End date should not be
 * greater than current date"` (medido ao vivo, 25/08/2026). Consultar o
 * `sendDay` cegamente derrubaria TODO agendamento feito na véspera — que é
 * o caso comum da Etapa 6.
 *
 * Então: dia de envio futuro **não é consultado**, e o consumo dele é 0 por
 * definição (o balde ainda não começou). O gate passa de graça ali, e é
 * `describeQuotaWarnings` que diz isso em voz alta. O consumo de HOJE ainda
 * é lido, porque é ele que alimenta o aviso de transbordo — o mecanismo que
 * de fato matou 25/08 foi a fila de 24/08 drenando na virada.
 *
 * `todayDay` é injetável pra teste; em produção é o dia UTC corrente.
 */
export async function fetchAccountQuotaSnapshot(
  apiKey: string,
  sendDay: string,
  todayDay: string = toStatsDay(new Date()),
): Promise<AccountQuotaSnapshot> {
  // `YYYY-MM-DD` compara lexicograficamente = cronologicamente.
  const sendDayIsFuture = sendDay > todayDay;

  let transactionalRequestsOnSendDay: number;
  let transactionalRequestsToday: number | null;

  if (sendDayIsFuture) {
    transactionalRequestsOnSendDay = 0;
    transactionalRequestsToday = await fetchTransactionalRequests(apiKey, todayDay);
  } else {
    transactionalRequestsOnSendDay = await fetchTransactionalRequests(apiKey, sendDay);
    transactionalRequestsToday =
      sendDay === todayDay ? null : await fetchTransactionalRequests(apiKey, todayDay);
  }

  let planType: string | null = null;
  let planSendCredits: number | null = null;
  try {
    const plan = await fetchAccountPlan(apiKey);
    planType = plan.planType;
    planSendCredits = plan.planSendCredits;
  } catch (e) {
    process.stderr.write(
      `[brevo-account-quota] AVISO: GET /v3/account falhou (best-effort, não bloqueia) — o aviso de ` +
        `plano/créditos fica indisponível nesta rodada: ${(e as Error).message}\n`,
    );
  }

  return {
    sendDay,
    sendDayIsFuture,
    transactionalRequestsOnSendDay,
    transactionalRequestsToday,
    planType,
    planSendCredits,
  };
}

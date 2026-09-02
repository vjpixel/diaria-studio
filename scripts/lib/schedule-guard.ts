/**
 * scripts/lib/schedule-guard.ts (#7047)
 *
 * Guard COMPARTILHADO de antecedência mínima de agendamento + aviso de
 * horário fora do canônico, pra qualquer script que faça `PUT
 * /emailCampaigns/{id} { scheduledAt }` real contra a Brevo.
 *
 * Origem: `resolveScheduleAtArg` em `scripts/clarice-schedule-group.ts`
 * (#7042) foi o PRIMEIRO lugar a fechar esse guard, endurecido ao vivo pelo
 * incidente de 01/09/2026 — 3 campanhas Clarice (#208/209/210) destinadas ao
 * dia SEGUINTE saíram no MESMO dia porque o guard existente só checava "no
 * futuro" (`d > now`), e "no futuro" sozinho aceita 30s à frente. O review
 * daquela PR (`code-reviewer`) apontou que o MESMO guard incompleto ("rejeita
 * passado, não tem antecedência mínima") existia em outros 3 scripts de
 * agendamento — #7047 fecha essa lacuna extraindo a parte GENERICAMENTE
 * reusável pra cá, em vez de copiar a checagem uma 4ª vez (o que produziria
 * a MESMA divergência que motivou esta issue).
 *
 * Histórico da classe de bug (mesma forma: campanha real sai antes do que o
 * operador pretendia, e o guard existente disse que estava tudo certo):
 *   #4662 (05/08/2026) — `YYYY-MM-DD` sem hora → meia-noite UTC → 9h adiantado
 *   #5939               — `PUT status:queued` sem `scheduledAt` → envio na hora
 *   #7042 (01/09/2026)  — `--schedule-at` pra daqui a minutos → envio imediato de fato
 *   #7047               — generaliza o fix do #7042 pros outros 3 scripts
 *
 * ESCOPO DELIBERADO — o que este módulo NÃO faz:
 *   - Não valida formato ISO 8601 solto/data-sem-hora/calendário inexistente
 *     (2026-02-31 etc.) — essa validação de TEXTO CRU digitado por um
 *     operador só existe em `clarice-schedule-group.ts` (`--schedule-at`
 *     como string livre). Os 3 callers deste módulo (`clarice-schedule-sends.ts`,
 *     `clarice-schedule-ramp.ts`, `publish-monthly.ts`) derivam a data de um
 *     PLANO (`sends-summary.json`, `--dates D1,D2,D3`, ou — em
 *     publish-monthly.ts — um `--schedule-at` que já passou pelo `new
 *     Date(raw)`/"no futuro" ali mesmo) — a validação de formato/calendário
 *     já aconteceu antes de chegar aqui.
 *   - Não checa "está no passado" — cada caller já tem esse guard (#2101 em
 *     clarice-schedule-sends.ts, #3593 em clarice-schedule-ramp.ts, o check
 *     inline em publish-monthly.ts) e ele roda ANTES deste módulo. Rodar
 *     este módulo sobre uma data já-no-passado ainda funciona (antecedência
 *     negativa < antecedência mínima → falha), mas a MENSAGEM de erro é
 *     sempre "antecedência insuficiente", não "no passado" — por isso os
 *     guards existentes continuam sendo a primeira linha de defesa.
 *
 * DELIBERADAMENTE NÃO retrofitado em `clarice-schedule-group.ts`: aquele
 * módulo já está testado/em produção (#7042/#7046, mergeado) e sua superfície
 * (`--schedule-at` como texto cru digitado, sugestão de horário via
 * `scheduledAtForDate`, mensagem citando `--send-now`/`--allow-imminent`
 * específicos daquele CLI) é genuinamente diferente da dos 3 scripts que
 * `--dates`/plano derivam. Unificar à força arriscaria regredir 12+
 * asserções de mensagem já travadas em `test/clarice-schedule-group-4662-4668.test.ts`
 * pra um ganho de DRY marginal — decisão de escopo, não descuido (#7047).
 *
 * `canonicalHourUtc` é SEMPRE um parâmetro, nunca um default fixo — a
 * Clarice News é 09:00 UTC (`SEND_HOUR_UTC`, `scripts/lib/clarice-wave-plan.ts`),
 * mas `publish-monthly.ts` é outro fluxo sem convenção documentada; passar
 * `undefined` desliga o aviso de horário sem afetar a antecedência mínima.
 */

/** Antecedência mínima entre "agora" e o `scheduledAt` de uma campanha real — mesmo valor/rationale do #7042. Ajustável numa linha. */
export const SCHEDULE_AT_MIN_LEAD_MS = 2 * 60 * 60 * 1000; // 2h

/** Prefixo estável do aviso de horário fora do canônico — mesmo padrão de `clarice-schedule-group.ts`, pra callers automatizados reconhecerem a linha no stderr sem promover o stderr inteiro. */
export const SCHEDULE_AT_WARNING_PREFIX = "⚠ AVISO:";

/**
 * Formata uma duração em ms como string curta e legível ("30s", "5 min",
 * "1h30min"). Puro, sem locale ICU — determinístico entre máquinas (mesma
 * disciplina de `scheduledAtForDate`/`clarice-wave-plan.ts`).
 */
export function formatLeadTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h${minutes}min` : `${hours}h`;
}

export interface ScheduleLeadTimeOk {
  ok: true;
  /** Aviso NOMEADO de horário fora do canônico — não bloqueia (mesma semântica de `resolveScheduleAtArg`). */
  warning?: string;
}

export interface ScheduleLeadTimeFail {
  ok: false;
  error: string;
}

export interface CheckScheduleLeadTimeOptions {
  /** Clock injetável pra testes (default: `new Date()`). */
  now?: Date;
  /** Antecedência mínima exigida (default: `SCHEDULE_AT_MIN_LEAD_MS`, 2h). */
  minLeadMs?: number;
  /** Pula SÓ a checagem de antecedência mínima — nunca a de "no passado" (que roda antes, no caller). Caminho nomeado, nunca silencioso. */
  allowImminent?: boolean;
  /** Hora canônica em UTC (0-23) pra emitir aviso quando `scheduledAt` divergir. `undefined` desliga o aviso — caller sem convenção documentada (ex: publish-monthly.ts) nunca deve inventar um canônico. */
  canonicalHourUtc?: number;
  /** Rótulo em prosa do horário canônico pro texto do aviso (ex: "06:00 BRT"). Só usado quando `canonicalHourUtc` é passado. */
  canonicalHourLabel?: string;
  /** Trilha de issues pra citar na mensagem de erro (ex: "#7042, #7047") — nomeia o padrão de incidente sem hardcodar números no módulo genérico. */
  contextIssues?: string;
  /** Constrói a sugestão de horário canônico do PRÓXIMO dia a partir de `YYYY-MM-DD` (ex: `scheduledAtForDate` de clarice-wave-plan.ts). Omitir = mensagem de erro sem sugestão. */
  suggestNextCanonical?: (tomorrowUtcDate: string) => string;
  /** Nome do flag de disparo imediato deste script, pra mensagem de erro nomear o caminho certo (ex: "--send-now"). Default: nenhuma menção. */
  immediateDispatchFlagName?: string;
}

/**
 * Núcleo puro/sem I/O do guard: dado um `scheduledAt` ISO (já validado como
 * data real pelo caller) e `now`, decide se a antecedência é suficiente e se
 * o horário é canônico. Nunca lança — devolve resultado discriminado, mesmo
 * padrão de `resolveScheduleAtArg` (clarice-schedule-group.ts).
 */
export function checkScheduleLeadTime(
  scheduledAtIso: string,
  opts: CheckScheduleLeadTimeOptions = {},
): ScheduleLeadTimeOk | ScheduleLeadTimeFail {
  const now = opts.now ?? new Date();
  const minLeadMs = opts.minLeadMs ?? SCHEDULE_AT_MIN_LEAD_MS;

  const d = new Date(scheduledAtIso);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: `schedule-guard: scheduledAt não é ISO 8601 válido: "${scheduledAtIso}"` };
  }

  const leadMs = d.getTime() - now.getTime();
  if (!opts.allowImminent && leadMs < minLeadMs) {
    let suggestionText = "";
    if (opts.suggestNextCanonical) {
      const tomorrowUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const tomorrowIso = tomorrowUtc.toISOString().slice(0, 10);
      suggestionText = ` Sugestão pro horário canônico do PRÓXIMO dia: "${opts.suggestNextCanonical(tomorrowIso)}".`;
    }
    const dispatchHint = opts.immediateDispatchFlagName
      ? ` Se o disparo IMEDIATO é intencional, use ${opts.immediateDispatchFlagName} (caminho nomeado pra isso), não agendar perto de agora.`
      : ` Se o disparo IMEDIATO é intencional, use o caminho de disparo imediato do script, não agendar perto de agora.`;
    return {
      ok: false,
      error:
        `scheduledAt "${d.toISOString()}" está a ${formatLeadTime(Math.max(leadMs, 0))} de "agora" (${now.toISOString()}) — ` +
        `antecedência mínima exigida: ${formatLeadTime(minLeadMs)}` +
        (opts.contextIssues ? ` (${opts.contextIssues})` : "") +
        `.${suggestionText}${dispatchHint} Pra pular só esta checagem (não recomendado), use --allow-imminent.`,
    };
  }

  if (opts.canonicalHourUtc !== undefined) {
    const isCanonicalHour =
      d.getUTCHours() === opts.canonicalHourUtc &&
      d.getUTCMinutes() === 0 &&
      d.getUTCSeconds() === 0 &&
      d.getUTCMilliseconds() === 0;
    if (!isCanonicalHour) {
      return {
        ok: true,
        warning:
          `${SCHEDULE_AT_WARNING_PREFIX} scheduledAt "${d.toISOString()}" está FORA do horário canônico ` +
          `(${String(opts.canonicalHourUtc).padStart(2, "0")}:00 UTC` +
          `${opts.canonicalHourLabel ? ` = ${opts.canonicalHourLabel}` : ""}). ` +
          `Isso não bloqueia — pode ser intencional — mas confirme antes de prosseguir.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Wrapper que LANÇA em vez de devolver `{ ok: false }` — pro padrão que
 * `assertScheduledAtFuture`/`assertDatesFuture` já usam nos 3 scripts-alvo
 * do #7047 (`clarice-schedule-sends.ts`, `clarice-schedule-ramp.ts`). Em
 * sucesso com `warning`, chama `logFn` (default `console.error`) — mesmo
 * papel de `surfaceScheduleWarning` em `clarice-schedule-group.ts`, mas
 * embutido aqui pra evitar um 2º ponto que os call sites teriam que lembrar
 * de chamar.
 */
export function assertScheduleLeadTime(
  scheduledAtIso: string,
  opts: CheckScheduleLeadTimeOptions = {},
  logFn: (msg: string) => void = (m) => console.error(m),
): void {
  const result = checkScheduleLeadTime(scheduledAtIso, opts);
  if (!result.ok) throw new Error(result.error);
  if (result.warning) logFn(result.warning);
}

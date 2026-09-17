/**
 * scripts/lib/edition-scheduled-at.ts (#8207)
 *
 * Deriva o `scheduled_at` (ISO 8601 UTC) da Etapa 6 SEMPRE a partir da DATA
 * DA EDIÇÃO (AAMMDD), nunca do relógio de parede ("amanhã"). Fecha #8207:
 * `.claude/agents/orchestrator-stage-6.md` calculava a data de dois jeitos —
 * o ramo default (`sim`) já derivava de `{AAMMDD}` corretamente (linha ~60),
 * mas o ramo `sim HH:MM` dizia em prosa livre "`scheduled_at` = amanhã
 * `HH:MM` BRT", que o LLM resolvia contra o RELÓGIO. Rodando a Etapa 6 depois
 * da meia-noite BRT, "amanhã" segundo o relógio já é D+1 da própria edição —
 * a newsletter (Kit) e a Brevo diária saíram agendadas um dia atrasado na
 * edição 260917 (Kit broadcast 25955349, Brevo campanha 44), enquanto os
 * posts sociais (que já usam `compute-social-schedule.ts::parseEditionDate`,
 * mesma disciplina "nunca `today()`", #270) saíram certos.
 *
 * `resolveEditionScheduledAt` é o ÚNICO lugar que deveria fazer essa conta —
 * usado tanto pelo default quanto pelo ramo `sim HH:MM` do playbook (ver
 * `.claude/agents/orchestrator-stage-6.md` §6a/§6c).
 *
 * `checkScheduledAtMatchesEditionDate` é o guard consumido pelos 3 scripts de
 * agendamento (`schedule-newsletter-kit.ts`, `schedule-daily-brevo.ts`,
 * `schedule-kit-diaria.ts`, item 2 da correção proposta em #8207): recusa
 * `--scheduled-at` cuja data-calendário EM BRT diverge da data da edição,
 * salvo `--allow-other-date` explícito.
 */

import { basename, resolve } from "node:path";
import { parseEditionDate } from "../compute-social-schedule.ts";

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;
const AAMMDD_RE = /^\d{6}$/;

/** BRT = UTC-3, fixo (sem DST desde 2019) — mesmo fato usado em `clarice-wave-plan.ts`/`ads-rolling-window.ts`. */
export const BRT_UTC_OFFSET_HOURS = 3;

/** Horário default de agendamento da Etapa 6 (06:00 BRT) — mesmo default já documentado em `orchestrator-stage-6.md` §6c. */
export const DEFAULT_EDITION_SCHEDULE_HHMM = "06:00";

/**
 * `AAMMDD` (data da edição) + `HH:MM` (horário BRT, default
 * `DEFAULT_EDITION_SCHEDULE_HHMM`) → ISO 8601 UTC.
 *
 * Puro: `Date.UTC` absorve o overflow de hora (`hourBrt + 3 >= 24`)
 * automaticamente como virada de dia UTC — não precisa de um guard de "hora
 * não pode passar das 21h BRT" como `brtHourToUtcHourSameDay`
 * (`clarice-wave-plan.ts`, que serve um caso de uso DIFERENTE: célula de
 * teste A/B intraday da Clarice, onde virar de dia seria um bug de outro
 * tipo). Aqui virar de dia UTC é o comportamento CORRETO: 22:00 BRT é
 * 01:00 UTC do dia seguinte, e é exatamente esse instante que se quer.
 *
 * Lança em `AAMMDD`/`HH:MM` malformados ou calendário inválido (ex:
 * "260631") — nunca produz um ISO silenciosamente errado.
 */
export function resolveEditionScheduledAt(
  editionAammdd: string,
  hhmm: string = DEFAULT_EDITION_SCHEDULE_HHMM,
): string {
  // parseEditionDate já valida 6 dígitos + mês/dia dentro do range + round-trip
  // de calendário (rejeita 260631/260229 em ano não-bissexto) — reusado em vez
  // de duplicar essa validação aqui (mesma checagem que compute-social-schedule.ts
  // já faz pro schedule social, #270).
  const { year, month, day } = parseEditionDate(editionAammdd);

  const timeMatch = HHMM_RE.exec(hhmm);
  if (!timeMatch) {
    throw new Error(`resolveEditionScheduledAt: HH:MM inválido: "${hhmm}" (esperado "HH:MM", ex: "06:00").`);
  }
  const hourBrt = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (hourBrt < 0 || hourBrt > 23 || minute < 0 || minute > 59) {
    throw new Error(`resolveEditionScheduledAt: HH:MM fora do intervalo válido: "${hhmm}" (HH 0-23, MM 0-59).`);
  }

  const utcMs = Date.UTC(year, month - 1, day, hourBrt + BRT_UTC_OFFSET_HOURS, minute, 0, 0);
  return new Date(utcMs).toISOString();
}

/**
 * Extrai `AAMMDD` do basename de um `--edition-dir` (flat OU nested — o
 * diretório da edição em si sempre se chama `AAMMDD`, seja ele
 * `data/editions/{AAMMDD}/` ou `data/editions/{YYMM}/{AAMMDD}/`). `null` se
 * o basename não bater no padrão de 6 dígitos.
 */
export function editionAammddFromDir(editionDir: string): string | null {
  const base = basename(resolve(editionDir));
  return AAMMDD_RE.test(base) ? base : null;
}

export interface ScheduledAtEditionCheckOk {
  ok: true;
}
export interface ScheduledAtEditionCheckFail {
  ok: false;
  reason: string;
}

/**
 * Guard dos 3 scripts de agendamento (#8207 item 2): recusa `--scheduled-at`
 * cuja data-calendário EM BRT diverge da data da edição — salvo
 * `allowOtherDate` (`--allow-other-date` no CLI de cada script), pro caso
 * raro em que agendar pra outro dia é de fato intencional.
 *
 * Escopo deliberadamente estreito (mesmo espírito de `schedule-guard.ts`):
 * não valida formato ISO nem "está no passado" — só a divergência de DIA
 * civil-BRT contra a edição, que é a classe de bug do #8207 (o valor
 * ISO em si era válido e no futuro; só caiu no dia errado).
 */
export function checkScheduledAtMatchesEditionDate(
  editionAammdd: string,
  scheduledAtIso: string,
  allowOtherDate: boolean = false,
): ScheduledAtEditionCheckOk | ScheduledAtEditionCheckFail {
  if (allowOtherDate) return { ok: true };

  const scheduledMs = Date.parse(scheduledAtIso);
  if (Number.isNaN(scheduledMs)) {
    return { ok: false, reason: `--scheduled-at não é ISO 8601 válido: "${scheduledAtIso}".` };
  }

  // Dia civil BRT do scheduledAt: desloca o instante pra UTC-3 e lê os
  // componentes UTC do resultado deslocado (mesmo truque usado em vários
  // pontos do repo pra converter instante → dia-calendário BRT sem depender
  // de Intl/tabela de timezone — BRT é offset fixo, #8207 mesma disciplina
  // do resto do módulo).
  const shifted = new Date(scheduledMs - BRT_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const scheduledAammddBrt =
    String(shifted.getUTCFullYear() - 2000).padStart(2, "0") +
    String(shifted.getUTCMonth() + 1).padStart(2, "0") +
    String(shifted.getUTCDate()).padStart(2, "0");

  if (scheduledAammddBrt !== editionAammdd) {
    return {
      ok: false,
      reason:
        `--scheduled-at "${scheduledAtIso}" cai em ${scheduledAammddBrt} (data civil BRT), divergindo da data ` +
        `da edição (${editionAammdd}). #8207: a Etapa 6 rodada depois da meia-noite BRT com "amanhã" resolvido ` +
        `contra o relógio produz exatamente este erro (edição agendada 1 dia atrasada, em 2 canais, sem aviso). ` +
        `Se agendar pra outro dia é intencional, use --allow-other-date.`,
    };
  }
  return { ok: true };
}

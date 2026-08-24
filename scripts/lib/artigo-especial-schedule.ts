/**
 * artigo-especial-schedule.ts (#5979)
 *
 * Resolve o `--at` (agendamento LinkedIn) da skill `/diaria-artigo-especial`.
 * Default = **D+1 17:30 BRT a partir de HOJE** (decisão do editor, 23/08/2026
 * — mesmo horário `d3_time` de `publishing.social.fallback_schedule`, "os
 * posts de edição").
 *
 * **Reusa `computeScheduledAt` (`scripts/compute-social-schedule.ts`), não
 * reimplementa** — mas essa função é parametrizada por `editionDate` (AAMMDD)
 * + `destaque` (d1/d2/d3), que não é bem o vocabulário do artigo especial
 * (não há "edição" nem "destaque" aqui). Este módulo faz só a ponte: converte
 * "hoje + 1 dia, 17:30 BRT" pro vocabulário que `computeScheduledAt` entende
 * (`editionDate = AAMMDD de hoje`, `dayOffset = 1`, `destaque = "d3"` — é o
 * slot cujo horário configurado, `d3_time`, já é 17:30) e devolve o ISO
 * pronto. Escolher `destaque: "d3"` aqui é só uma forma de apontar pro slot
 * de horário certo em `fallback_schedule` — não implica nenhuma relação com
 * um "3º destaque" de edição.
 *
 * **`toAammdd` deriva "hoje" no fuso configurado via `Intl` (`datePartsInTz`,
 * reusado de `scripts/lib/next-edition-date.ts`), nunca via `Date.getFullYear/
 * getMonth/getDate` locais.** Achado do review do #5979 (PR #6000, code-
 * reviewer + comment-analyzer, independentemente): a versão anterior lia os
 * componentes de data no fuso LOCAL do processo — correto só quando o
 * processo já roda em BRT (verdade hoje, já que a skill é `windows`-only,
 * máquina do editor), mas silenciosamente incorreto num processo rodando em
 * outro fuso (ex: CI `ubuntu-latest`, default UTC) durante a janela
 * 21:00-23:59 BRT, quando "hoje" em UTC já é "amanhã" em BRT — mesma classe
 * de bug que `scripts/compute-social-schedule.ts` já documenta e evita
 * (`timezoneOffsetIso`, incidente 260428 citado lá). Corrigido reusando o
 * mesmo padrão `Intl.DateTimeFormat` já provado em `next-edition-date.ts`,
 * em vez de reintroduzir a mesma classe de bug numa 2ª implementação.
 */

import { computeScheduledAt } from "../compute-social-schedule.ts";
import { datePartsInTz, toAammdd as datePartsToAammdd } from "./next-edition-date.ts";

interface ScheduleConfig {
  publishing?: {
    social?: {
      fallback_schedule?: { d3_time?: string; day_offset?: number };
      timezone?: string;
    };
  };
}

/** Fallback quando `config.publishing.social.timezone` está ausente —
 *  mesmo default de `next-edition-date.ts::BRT_TIMEZONE`. */
const DEFAULT_TIMEZONE = "America/Sao_Paulo";

/** Pura: formata um `Date` como `AAMMDD` (2 dígitos de ano), no fuso
 *  informado (default BRT) — via `Intl`, nunca componentes locais do
 *  processo (ver docstring do módulo). */
export function toAammdd(date: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  return datePartsToAammdd(datePartsInTz(date, timeZone));
}

/**
 * Valida que uma string `--at` é um ISO 8601 parseável e no futuro (relativo
 * a `now`). Lança com mensagem acionável se não for — nunca aceita silenciosamente
 * uma data no passado (agendar um post no passado falha na plataforma de
 * forma confusa).
 */
export function validateExplicitAt(at: string, now: number = Date.now()): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) {
    throw new Error(`--at inválido: "${at}" não é um ISO 8601 parseável (ex: 2026-09-02T17:30:00-03:00).`);
  }
  if (ms <= now) {
    throw new Error(`--at "${at}" está no passado (agora: ${new Date(now).toISOString()}).`);
  }
  return at;
}

/**
 * Resolve o `scheduled_at` final:
 *   - `at` explícito (já validado por `validateExplicitAt`) → usa como está.
 *   - omitido → D+1 17:30 BRT a partir de `now` (default `Date.now()`),
 *     via `computeScheduledAt` (reuso, ver docstring do módulo). "Hoje" é
 *     derivado no fuso de `config.publishing.social.timezone` (fallback BRT
 *     se ausente) — mesmo fuso que `computeScheduledAt` usa pro resto do
 *     cálculo, nunca o fuso local do processo.
 */
export function resolveArtigoEspecialScheduledAt(
  config: ScheduleConfig,
  input: { at?: string; now?: number } = {},
): string {
  if (input.at) return validateExplicitAt(input.at, input.now ?? Date.now());

  const now = input.now ?? Date.now();
  const timeZone = config.publishing?.social?.timezone ?? DEFAULT_TIMEZONE;
  const today = toAammdd(new Date(now), timeZone);
  return computeScheduledAt({
    config,
    editionDate: today,
    destaque: "d3",
    platform: "linkedin",
    dayOffsetOverride: 1,
    now,
  });
}

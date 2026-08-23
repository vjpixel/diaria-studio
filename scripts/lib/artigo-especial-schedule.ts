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
 */

import { computeScheduledAt } from "../compute-social-schedule.ts";

interface ScheduleConfig {
  publishing?: {
    social?: {
      fallback_schedule?: { d3_time?: string; day_offset?: number };
      timezone?: string;
    };
  };
}

/** Pura: formata um `Date` como `AAMMDD` (2 dígitos de ano). */
export function toAammdd(date: Date): string {
  const yy = String(date.getFullYear() % 100).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
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
 *     via `computeScheduledAt` (reuso, ver docstring do módulo).
 */
export function resolveArtigoEspecialScheduledAt(
  config: ScheduleConfig,
  input: { at?: string; now?: number } = {},
): string {
  if (input.at) return validateExplicitAt(input.at, input.now ?? Date.now());

  const now = input.now ?? Date.now();
  const today = toAammdd(new Date(now));
  return computeScheduledAt({
    config,
    editionDate: today,
    destaque: "d3",
    platform: "linkedin",
    dayOffsetOverride: 1,
    now,
  });
}

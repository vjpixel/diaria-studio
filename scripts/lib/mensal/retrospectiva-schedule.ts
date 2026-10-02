/**
 * scripts/lib/mensal/retrospectiva-schedule.ts (#9474)
 *
 * Agenda dos posts PÚBLICOS de LinkedIn da Retrospectiva do Mês
 * (`/diaria-mensal-apoiadores`). Mesma regra do Artigo Especial (#6014),
 * decidida pelo editor no #9474:
 *
 *   - **Página diar.ia.br: D+1 09:00 BRT**
 *   - **Perfil pessoal:    D+2 09:30 BRT**
 *
 * Agenda do dia resultante: `09:00 retrospectiva-pagina | 10:00 d1 | 12:30 d2
 * | 17:30 d3` — não colide com a diária.
 *
 * **A diferença pro Artigo Especial é a âncora "D"**: aqui D é a data do
 * ENVIO do e-mail pros apoiadores, não o dia em que a skill rodou. Hoje o
 * envio é decidido pelo editor (`--schedule` do publisher Kit); a regra fixa
 * do 1º sábado do mês 06:00 BRT é a #9473 (issue separada). Por isso
 * `baseDate` é parâmetro explícito — quando a #9473 entrar, o caller passa a
 * data derivada dela sem mudar este módulo. Omitido = hoje (mesmo default do
 * Artigo Especial), com banner no caller (#5321).
 *
 * Reusa `resolveArtigoEspecialScheduledAts` (que reusa `computeScheduledAt`) —
 * nenhuma aritmética de data/fuso reimplementada aqui.
 */

import { resolveArtigoEspecialScheduledAts, validateExplicitAt } from "../artigo-especial-schedule.ts";

type ScheduleConfig = Parameters<typeof resolveArtigoEspecialScheduledAts>[0];

export interface RetrospectivaScheduleInput {
  /** ISO explícito — vale pros dois canais (mesma semântica do `--at` do Artigo Especial). */
  at?: string;
  /** Data do envio do e-mail (`AAAA-MM-DD` ou `AAMMDD`) — âncora do D+1/D+2. */
  baseDate?: string;
  now?: number;
}

/**
 * Resolve `{ pagina, perfil }`. Lança em `at` passado/inválido ou `baseDate`
 * inválida. Se a data resultante já passou (ex: `baseDate` antiga),
 * `computeScheduledAt` aplica o shift de slot-no-passado de sempre.
 */
export function resolveRetrospectivaScheduledAts(
  config: ScheduleConfig,
  input: RetrospectivaScheduleInput = {},
): { pagina: string; perfil: string } {
  if (input.at) {
    const at = validateExplicitAt(input.at, input.now ?? Date.now());
    return { pagina: at, perfil: at };
  }
  return resolveArtigoEspecialScheduledAts(config, { now: input.now, baseDate: input.baseDate });
}

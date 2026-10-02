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
 * `baseDate` é parâmetro explícito; com a #9473 em produção o caller deriva a
 * data da regra via `ruleBaseDateForCycle` (abaixo). Omitido = hoje (mesmo default do
 * Artigo Especial), com banner no caller (#5321).
 *
 * Reusa `resolveArtigoEspecialScheduledAts` (que reusa `computeScheduledAt`) —
 * nenhuma aritmética de data/fuso reimplementada aqui.
 */

import { resolveArtigoEspecialScheduledAts, validateExplicitAt } from "../artigo-especial-schedule.ts";
import { decideMonthlySendAt, DEFAULT_MONTHLY_SEND_SCHEDULE, type MonthlySendScheduleRule } from "./monthly-send-schedule.ts";

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
 * inválida.
 *
 * **`baseDate` no passado LANÇA** em vez de deixar `computeScheduledAt` aplicar
 * o shift de slot-no-passado (#2552, que move o horário pra `agora + 15min`):
 * aqui a âncora é a data do ENVIO do e-mail, que pode ser de dias atrás (ex:
 * retentar um `linkedin_pagina` que falhou), e o shift transformaria isso num
 * post público quase imediato, fora da agenda e possivelmente colado no d1 da
 * diária — passaria pelo guard "no futuro" do publisher sem erro nenhum
 * (achado do review do PR #9475). Sem `baseDate` (âncora = hoje) o
 * comportamento é o do Artigo Especial, inalterado.
 */
export function resolveRetrospectivaScheduledAts(
  config: ScheduleConfig,
  input: RetrospectivaScheduleInput = {},
): { pagina: string; perfil: string } {
  if (input.at) {
    const at = validateExplicitAt(input.at, input.now ?? Date.now());
    return { pagina: at, perfil: at };
  }
  if (!input.baseDate) return resolveArtigoEspecialScheduledAts(config, { now: input.now });
  const now = input.now ?? Date.now();
  const ats = resolveArtigoEspecialScheduledAts(config, { now, baseDate: input.baseDate, disablePastSlotShift: true });
  const passados = (["pagina", "perfil"] as const).filter((k) => !(Date.parse(ats[k]) > now));
  if (passados.length > 0) {
    throw new Error(
      `--base-date ${input.baseDate}: horário(s) ${passados.map((k) => `${k}=${ats[k]}`).join(", ")} já passaram ` +
        `(agora: ${new Date(now).toISOString()}). Passe --at com um horário futuro explícito — nunca reagendar ` +
        "automaticamente pra daqui a minutos.",
    );
  }
  return ats;
}

/**
 * Pura (#9473): data (`AAAA-MM-DD`, BRT) do envio do e-mail do ciclo segundo a
 * regra do 1º sábado 06:00 BRT — a âncora D dos posts LinkedIn quando o e-mail
 * sai AGENDADO pelo publisher Kit. `null` quando a regra já não vale pra este
 * ciclo (faltam menos que `minLeadHours` ou o sábado passou): o publisher cai
 * pra rascunho, a data real do envio é desconhecida, e o caller deve manter o
 * comportamento anterior (âncora = hoje, com banner, ou `--base-date`/`--at`).
 */
export function ruleBaseDateForCycle(
  cycle: string,
  now: Date = new Date(),
  rule: MonthlySendScheduleRule = DEFAULT_MONTHLY_SEND_SCHEDULE,
): string | null {
  const d = decideMonthlySendAt(cycle, now, rule);
  return d.kind === "schedule" ? d.sendAt.slice(0, 10) : null;
}

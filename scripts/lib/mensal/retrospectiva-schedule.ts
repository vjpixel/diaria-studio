/**
 * scripts/lib/mensal/retrospectiva-schedule.ts (#9474, #9508)
 *
 * Agenda dos posts PÚBLICOS da Retrospectiva do Mês
 * (`/diaria-mensal-apoiadores`). Âncora com a mesma regra do Artigo Especial
 * (#6014), decidida pelo editor no #9474:
 *
 *   - **Post único da página (#9474, legado): D+1 09:30 BRT** (09:00 até
 *     25/11/2026; acompanha `ARTIGO_ESPECIAL_PAGINA_TIME`, #10305)
 *   - **Perfil pessoal LinkedIn (manual): D+2 09:30 BRT**
 *
 * Os 15 posts por história (#9508, abaixo) saem em D+1 nos MESMOS horários
 * da diária (`fallback_schedule`: 18:00 | 12:00 | 21:00 desde 25/11/2026,
 * #10305; antes 09:45 | 12:15 | 17:15), mas em ordem CRESCENTE por história
 * desde o #14080: a história 1 fica com o horário mais cedo (12:00), a 2 com o
 * do meio (18:00) e a 3 com o último (21:00). A numeração d1/d2/d3 da diária
 * deixou de ser crescente com a grade do #10305, e a Retrospectiva é lida na
 * ordem das histórias.
 *
 * **A diferença pro Artigo Especial é a âncora "D"**: aqui D é a data do
 * ENVIO do e-mail pros apoiadores, não o dia em que a skill rodou — explícita
 * (`--base-date`, a data do `--schedule` do publisher Kit) ou derivada da regra
 * do 1º sábado do mês 06:00 BRT (#9473) via `ruleBaseDateForCycle`/
 * `resolveRetrospectivaBaseDate` (abaixo). Sem nenhuma = hoje (mesmo default
 * do Artigo Especial), com banner no caller (#5321).
 *
 * Reusa `resolveArtigoEspecialScheduledAts` (que reusa `computeScheduledAt`) —
 * nenhuma aritmética de data/fuso reimplementada aqui.
 *
 * #9508: os posts por história (LinkedIn página, Facebook, Instagram, Threads,
 * X × D1/D2/D3) saem no dia D+1 (`resolveRetrospectivaPostScheduledAts`,
 * abaixo), nos slots da diária e nas 5 redes ao mesmo tempo. A aritmética
 * nova é só montar "dia + HH:MM no fuso" (`localIsoAt`).
 */

import { normalizeBaseDate, resolveArtigoEspecialScheduledAts, validateExplicitAt } from "../artigo-especial-schedule.ts";
import { decideMonthlySendAt, DEFAULT_MONTHLY_SEND_SCHEDULE, type MonthlySendScheduleRule } from "./monthly-send-schedule.ts";
import {
  RETROSPECTIVA_HISTORIAS,
  RETROSPECTIVA_POST_CHANNELS,
  type RetrospectivaHistoria,
  type RetrospectivaPostChannel,
} from "./retrospectiva-divulgacao.ts";

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

// ── #9508: um post por (rede × história), os 3 no mesmo dia ─────────────

/**
 * Horário de cada história — decisão do editor no #9508 (02/10/2026): os
 * MESMOS horários dos dias de semana da diária
 * (`publishing.social.fallback_schedule.d{1,2,3}_time`, a fonte de
 * `compute-social-schedule.ts`), com as 5 redes ao mesmo tempo, sem
 * escalonar. Este é o default da grade da diária (#10305) quando o config não
 * traz um `d{N}_time`; desde o #14080 os 3 horários são redistribuídos em
 * ordem crescente por história (`retrospectivaSlots`).
 */
const DAILY_FALLBACK_SLOTS: Record<RetrospectivaHistoria, string> = { d1: "18:00", d2: "12:00", d3: "21:00" };

/** Pura: `HH:MM` (ou `H:MM`) em minutos do dia, pra ordenar sem depender do zero à esquerda. */
function hhmmMinutes(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`horário inválido no fallback_schedule: "${hhmm}" (esperado HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * Pura (#14080): os horários da diária redistribuídos em ordem crescente por
 * história. Pega os 3 `d{N}_time` do `fallback_schedule` (cada um ausente cai
 * no slot da diária de mesmo número, `DAILY_FALLBACK_SLOTS`), ordena e dá o
 * mais cedo à história 1. Com a grade do #10305 (d1 18:00, d2 12:00, d3 21:00)
 * sai 12:00 | 18:00 | 21:00; uma grade já crescente fica como está.
 */
export function retrospectivaSlots(
  fallback: Partial<Record<"d1_time" | "d2_time" | "d3_time", string>> | undefined,
): Record<RetrospectivaHistoria, string> {
  const times = RETROSPECTIVA_HISTORIAS.map((h) => fallback?.[`${h}_time`] ?? DAILY_FALLBACK_SLOTS[h]);
  const sorted = [...times].sort((a, b) => hhmmMinutes(a) - hhmmMinutes(b));
  return Object.fromEntries(RETROSPECTIVA_HISTORIAS.map((h, i) => [h, sorted[i]])) as Record<RetrospectivaHistoria, string>;
}

/**
 * Pura (#14080): reordena, por rede, os horários que o planner do #10819
 * escolheu para que a história 1 saia antes da 2 e a 2 antes da 3. O planner
 * decide cada post sozinho e espalha os 3 da mesma conta pelo dia sem olhar a
 * ordem (no domingo, com o carrossel semanal das 19:00 na grade, a história 3
 * caía de manhã). Aqui o CONJUNTO de horários de cada rede fica o mesmo, então
 * o espaçamento contra a grade e entre os 3 posts continua o que o planner
 * garantiu; só muda qual história fica com qual horário. `keys` são as chaves
 * planejadas (`{rede}:d{N}`): história fora delas (já publicada, ou pulada)
 * mantém o horário e não entra na troca.
 */
export function orderRetrospectivaScheduleByHistoria(
  schedule: RetrospectivaPostSchedule,
  keys: readonly { channel: RetrospectivaPostChannel; historia: RetrospectivaHistoria }[],
): RetrospectivaPostSchedule {
  const out = Object.fromEntries(RETROSPECTIVA_HISTORIAS.map((h) => [h, { ...schedule[h] }])) as RetrospectivaPostSchedule;
  for (const ch of RETROSPECTIVA_POST_CHANNELS) {
    const hs = RETROSPECTIVA_HISTORIAS.filter((h) => keys.some((k) => k.channel === ch && k.historia === h));
    const ats = hs.map((h) => schedule[h][ch]).sort((a, b) => Date.parse(a) - Date.parse(b));
    hs.forEach((h, i) => {
      out[h][ch] = ats[i];
    });
  }
  return out;
}

export type RetrospectivaPostSchedule = Record<RetrospectivaHistoria, Record<RetrospectivaPostChannel, string>>;

/**
 * Pura: soma `minutes` a um ISO e devolve no fuso `timeZone` com offset
 * explícito (`…-03:00`, o formato que `computeScheduledAt` devolve e os
 * publicadores gravam). Aceita offset, `Z` e milissegundos (o `--at` do
 * LinkedIn aceita tudo isso). Lança em ISO SEM fuso — reinterpretar no fuso do
 * processo é a classe de bug do #270.
 */
export function addMinutesIso(iso: string, minutes: number, timeZone = "America/Sao_Paulo"): string {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(iso) || Number.isNaN(Date.parse(iso))) {
    throw new Error(`ISO sem offset explícito: "${iso}" (esperado AAAA-MM-DDTHH:MM[:SS]±HH:MM ou …Z).`);
  }
  const instant = new Date(Date.parse(iso) + minutes * 60_000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const tzName = get("timeZoneName"); // "GMT-03:00" (ou "GMT" em UTC)
  const offset = tzName === "GMT" ? "+00:00" : tzName.replace(/^GMT/, "");
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}${offset}`;
}

/** Pura: `AAAA-MM-DD` do instante no fuso informado (via `Intl`, nunca o fuso do processo). */
export function localDateInTz(instant: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(instant));
}

/** Pura: `AAAA-MM-DD` + `days` dias de calendário. */
export function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Pura: ISO com offset explícito de `date` às `hhmm` no fuso `timeZone`
 * (`2026-10-04` + `10:00` → `2026-10-04T10:00:00-03:00`). Corrige o palpite
 * UTC pelo offset do fuso naquele instante (`addMinutesIso` formata), então
 * vale também em fuso com horário de verão.
 */
export function localIsoAt(date: string, hhmm: string, timeZone = "America/Sao_Paulo"): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(hhmm)) {
    throw new Error(`localIsoAt: data/hora inválida (${date} ${hhmm})`);
  }
  const [h, mi] = hhmm.split(":").map(Number);
  if (h > 23 || mi > 59) throw new Error(`localIsoAt: horário fora da faixa (${hhmm}) — horas 0-23, minutos 0-59`);
  const guess = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}:00Z`);
  const offsetOf = (instant: number): number => {
    const m = /([+-])(\d{2}):(\d{2})$/.exec(addMinutesIso(new Date(instant).toISOString(), 0, timeZone))!;
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  };
  // 2 passadas: o offset do palpite UTC pode diferir do offset do instante
  // corrigido quando a transição de horário de verão cai entre os dois.
  let instant = guess - offsetOf(guess) * 60_000;
  instant = guess - offsetOf(instant) * 60_000;
  return addMinutesIso(new Date(instant).toISOString(), 0, timeZone);
}

/**
 * Pura: o DIA dos posts por história (`AAAA-MM-DD`, no fuso do config).
 * `--at` (ISO com offset): o dia local dele — só o dia conta, os horários
 * são os slots. Senão D+1 de `baseDate` (`AAAA-MM-DD`/`AAMMDD`, a data do
 * envio do e-mail). Sem nenhum: amanhã (D = hoje, mesmo default do #9474).
 */
export function retrospectivaPostDay(input: RetrospectivaScheduleInput, timeZone = "America/Sao_Paulo"): string {
  if (input.at) {
    if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.at) || Number.isNaN(Date.parse(input.at))) {
      throw new Error(`--at inválido: "${input.at}" (esperado ISO com offset, ex: 2026-10-04T10:00:00-03:00).`);
    }
    return localDateInTz(Date.parse(input.at), timeZone);
  }
  if (input.baseDate) {
    const n = normalizeBaseDate(input.baseDate); // AAMMDD, valida calendário
    return addDaysToDate(`20${n.slice(0, 2)}-${n.slice(2, 4)}-${n.slice(4, 6)}`, 1);
  }
  return addDaysToDate(localDateInTz(input.now ?? Date.now(), timeZone), 1);
}

/**
 * Resolve o horário de cada post (rede × história) — decisão do editor no
 * #9508: o dia é D+1 do envio (`retrospectivaPostDay`); os horários são os da
 * diária (`fallback_schedule`) em ordem crescente por história (#14080,
 * `retrospectivaSlots`: 12:00 | 18:00 | 21:00) e as 5 redes de uma história
 * saem no MESMO horário (preferência; o planner do #10819 pode mover por rede,
 * e `orderRetrospectivaScheduleByHistoria` refaz a ordem depois dele). Não lança por horário no
 * passado: quem decide é o pré-voo do publisher, por post (≥10 min), pra que
 * `--skip {rede}:d1` destrave as histórias 2/3 quando só a 1 já passou.
 *
 * Como os horários SÃO os da diária, o dia não pode ter edição diária
 * agendada — guard no publisher (`dailyEditionConflict`), não aqui.
 */
export function resolveRetrospectivaPostScheduledAts(
  config: ScheduleConfig,
  input: RetrospectivaScheduleInput = {},
): RetrospectivaPostSchedule {
  const social = config.publishing?.social as
    | { timezone?: string; fallback_schedule?: Partial<Record<"d1_time" | "d2_time" | "d3_time", string>> }
    | undefined;
  const tz = social?.timezone ?? "America/Sao_Paulo";
  const day = retrospectivaPostDay(input, tz);
  const slots = retrospectivaSlots(social?.fallback_schedule);
  return Object.fromEntries(
    RETROSPECTIVA_HISTORIAS.map((h) => {
      const at = localIsoAt(day, slots[h], tz);
      return [h, Object.fromEntries(RETROSPECTIVA_POST_CHANNELS.map((ch) => [ch, at]))];
    }),
  ) as RetrospectivaPostSchedule;
}

/**
 * Pura: âncora D (`--base-date`) efetiva — a explícita; senão (sem `--at`) a
 * data do 1º sábado pela regra #9473, se o e-mail ainda sai agendado por ela;
 * senão `undefined` (= hoje, com banner no caller). Usada por
 * `publish-retrospectiva-social.ts` (#9508).
 */
export function resolveRetrospectivaBaseDate(
  cycle: string,
  opts: { baseDate?: string; at?: string; now?: Date; rule?: MonthlySendScheduleRule },
): { baseDate: string | undefined; fromRule: boolean } {
  if (opts.baseDate) return { baseDate: opts.baseDate, fromRule: false };
  if (opts.at) return { baseDate: undefined, fromRule: false };
  const ruled = ruleBaseDateForCycle(cycle, opts.now ?? new Date(), opts.rule ?? DEFAULT_MONTHLY_SEND_SCHEDULE);
  return { baseDate: ruled ?? undefined, fromRule: ruled !== null };
}

/**
 * Pura (#9473): data (`AAAA-MM-DD`, BRT) do envio do e-mail do ciclo segundo a
 * regra do 1º sábado 06:00 BRT — a âncora D dos posts públicos quando o e-mail
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

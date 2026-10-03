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
 *
 * #9508: os posts por história (LinkedIn página, Facebook, Instagram, Threads,
 * X × D1/D2/D3) saem no mesmo D+1 (`resolveRetrospectivaPostScheduledAts`,
 * abaixo) — a âncora e o fuso continuam vindo de lá; a única aritmética nova é
 * somar minutos a um ISO com offset explícito (`addMinutesIso`). O post da
 * página LinkedIn deixou de ser 1 só: `pagina` abaixo virou só a âncora.
 */

import { resolveArtigoEspecialScheduledAts, validateExplicitAt } from "../artigo-especial-schedule.ts";
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
 * Minutos depois da âncora (D+1 09:00 BRT, ou `--at`) em que sai cada
 * história — decisão do editor no #9508: os 3 posts de cada rede no MESMO
 * dia, em horários livres, longe (≥15 min) dos slots da diária (10:00 d1 |
 * 12:30 d2 | 17:30 d3): história 1 às 09:00, 2 às 14:30, 3 às 20:00.
 */
export const RETROSPECTIVA_HISTORIA_OFFSET_MIN: Record<RetrospectivaHistoria, number> = {
  d1: 0,
  d2: 5 * 60 + 30,
  d3: 11 * 60,
};

/**
 * Minutos depois do horário da história em que sai cada rede — uma a cada 10
 * min, pra não saírem no mesmo minuto: `:00 linkedin | :10 facebook | :20
 * instagram | :30 threads | :40 x` (o mesmo escalonamento do #9500).
 */
export const RETROSPECTIVA_CHANNEL_STAGGER_MIN: Record<RetrospectivaPostChannel, number> = {
  linkedin_pagina: 0,
  facebook: 10,
  instagram: 20,
  threads: 30,
  x: 40,
};

export type RetrospectivaPostSchedule = Record<RetrospectivaHistoria, Record<RetrospectivaPostChannel, string>>;

/** Margem mínima até um slot da diária (`d{1,2,3}_time`) — post colado no d1 compete com ele no feed. */
export const DAILY_SLOT_MARGIN_MIN = 15;

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

/** Pura: `HH:MM` de um ISO no fuso informado (via `Intl`, nunca o fuso do processo). */
function hhmmInTz(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(
    new Date(iso),
  );
  const get = (t: string) => Number(parts.find((x) => x.type === t)?.value);
  return get("hour") * 60 + get("minute");
}

/**
 * Pura: horários que caem a menos de `DAILY_SLOT_MARGIN_MIN` de um slot da
 * diária (`publishing.social.fallback_schedule.d{1,2,3}_time`, no fuso de
 * `publishing.social.timezone`). Lista vazia = sem colisão. Compara só a HORA
 * do dia: a diária sai todo dia, então qualquer data conta.
 */
export function dailySlotCollisions(isos: Record<string, string>, config: ScheduleConfig): string[] {
  const social = config.publishing?.social as
    | { timezone?: string; fallback_schedule?: Partial<Record<"d1_time" | "d2_time" | "d3_time", string>> }
    | undefined;
  const tz = social?.timezone ?? "America/Sao_Paulo";
  const sched = social?.fallback_schedule ?? {};
  const slots = (["d1_time", "d2_time", "d3_time"] as const)
    .map((k) => ({ k, v: sched[k] }))
    .filter((s): s is { k: "d1_time" | "d2_time" | "d3_time"; v: string } => typeof s.v === "string" && /^\d{1,2}:\d{2}$/.test(s.v));
  const out: string[] = [];
  for (const [label, iso] of Object.entries(isos)) {
    const t = hhmmInTz(iso, tz);
    for (const s of slots) {
      const [h, mi] = s.v.split(":").map(Number);
      if (Math.abs(t - (h * 60 + mi)) < DAILY_SLOT_MARGIN_MIN) out.push(`${label}=${iso} a <${DAILY_SLOT_MARGIN_MIN}min do ${s.k.slice(0, 2)} (${s.v})`);
    }
  }
  return out;
}

/**
 * Resolve o horário de cada post (rede × história): a âncora é o horário que
 * a PÁGINA LinkedIn tinha no #9474 (`resolveRetrospectivaScheduledAts` —
 * D+1 09:00 BRT, mesma âncora D/`--at`/guard de passado) + o deslocamento da
 * história + o escalonamento da rede. Com `--at`, tudo parte dele. Lança se
 * algum horário colidir com a diária (`dailySlotCollisions`) — nunca agenda
 * colado num d1/d2/d3.
 */
export function resolveRetrospectivaPostScheduledAts(
  config: ScheduleConfig,
  input: RetrospectivaScheduleInput = {},
): RetrospectivaPostSchedule {
  const { pagina: anchor } = resolveRetrospectivaScheduledAts(config, input);
  const tz = config.publishing?.social?.timezone ?? "America/Sao_Paulo";
  const out = Object.fromEntries(
    RETROSPECTIVA_HISTORIAS.map((h) => [
      h,
      Object.fromEntries(
        RETROSPECTIVA_POST_CHANNELS.map((ch) => [
          ch,
          addMinutesIso(anchor, RETROSPECTIVA_HISTORIA_OFFSET_MIN[h] + RETROSPECTIVA_CHANNEL_STAGGER_MIN[ch], tz),
        ]),
      ),
    ]),
  ) as RetrospectivaPostSchedule;
  const flat = Object.fromEntries(
    RETROSPECTIVA_HISTORIAS.flatMap((h) => RETROSPECTIVA_POST_CHANNELS.map((ch) => [`${ch}:${h}`, out[h][ch]])),
  );
  const collisions = dailySlotCollisions(flat, config);
  if (collisions.length > 0) {
    throw new Error(`agenda dos posts da Retrospectiva colide com a diária: ${collisions.join("; ")}. Passe outro --at.`);
  }
  return out;
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

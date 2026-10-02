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
 * #9500: Facebook/Instagram/Threads/X saem no mesmo D+1, escalonados 10 min
 * depois da página (`resolveRetrospectivaSocialScheduledAts`, abaixo) — a
 * âncora e o fuso continuam vindo de lá; a única aritmética nova é somar
 * minutos a um ISO com offset explícito (`addMinutesIso`).
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

// ── #9500: Facebook, Instagram, Threads e X ─────────────────────────────

/** Canais sociais fora do LinkedIn, na ordem do escalonamento. */
export const RETROSPECTIVA_SOCIAL_CHANNELS = ["facebook", "instagram", "threads", "x"] as const;
export type RetrospectivaSocialChannel = (typeof RETROSPECTIVA_SOCIAL_CHANNELS)[number];

/**
 * Minutos depois da PÁGINA LinkedIn (D+1 09:00 BRT) — um canal a cada 10 min,
 * pra não saírem no mesmo minuto: `09:10 facebook | 09:20 instagram | 09:30
 * threads | 09:40 x`, tudo antes do `d1` das 10:00 (premissa do #9500).
 */
export const RETROSPECTIVA_SOCIAL_STAGGER_MIN: Record<RetrospectivaSocialChannel, number> = {
  facebook: 10,
  instagram: 20,
  threads: 30,
  x: 40,
};

/** Margem mínima até um slot da diária (`d{1,2,3}_time`) — post colado no d1 compete com ele no feed. */
export const DAILY_SLOT_MARGIN_MIN = 15;

/**
 * Pura: soma `minutes` a um ISO com offset explícito (`…-03:00`) preservando o
 * offset (o formato que `computeScheduledAt` devolve e os publicadores gravam).
 * Lança em ISO sem offset — reinterpretar no fuso do processo é a classe de bug
 * do #270.
 */
export function addMinutesIso(iso: string, minutes: number): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)([+-])(\d{2}):(\d{2})$/.exec(iso);
  if (!m) throw new Error(`ISO sem offset explícito: "${iso}" (esperado AAAA-MM-DDTHH:MM[:SS]±HH:MM).`);
  const offsetMin = (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
  const local = new Date(Date.parse(iso) + (minutes + offsetMin) * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}${m[2]}${m[3]}:${m[4]}`
  );
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
 * Resolve o horário de cada canal social: horário da PÁGINA LinkedIn
 * (`resolveRetrospectivaScheduledAts`, mesma âncora D/`--at`/guard de passado)
 * + o escalonamento acima. Com `--at`, o escalonamento parte dele. Lança se
 * algum horário colidir com a diária (`dailySlotCollisions`) — nunca agenda
 * colado num d1/d2/d3.
 */
export function resolveRetrospectivaSocialScheduledAts(
  config: ScheduleConfig,
  input: RetrospectivaScheduleInput = {},
): Record<RetrospectivaSocialChannel, string> {
  const { pagina } = resolveRetrospectivaScheduledAts(config, input);
  const out = Object.fromEntries(
    RETROSPECTIVA_SOCIAL_CHANNELS.map((ch) => [ch, addMinutesIso(pagina, RETROSPECTIVA_SOCIAL_STAGGER_MIN[ch])]),
  ) as Record<RetrospectivaSocialChannel, string>;
  const collisions = dailySlotCollisions(out, config);
  if (collisions.length > 0) {
    throw new Error(`agenda dos posts sociais colide com a diária: ${collisions.join("; ")}. Passe outro --at.`);
  }
  return out;
}

/**
 * Pura: âncora D (`--base-date`) efetiva — a explícita; senão (sem `--at`) a
 * data do 1º sábado pela regra #9473, se o e-mail ainda sai agendado por ela;
 * senão `undefined` (= hoje, com banner no caller). Mesma decisão que o
 * `publish-retrospectiva-linkedin.ts` aplica, num lugar só.
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

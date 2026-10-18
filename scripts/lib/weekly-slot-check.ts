/**
 * weekly-slot-check.ts (#10389) — detecta cedo, antes da etapa de imagens,
 * que o horário de agendamento de um carrossel semanal
 * (`publish-weekly-social.ts`) já passou ou está perto demais de `now`.
 *
 * Antes disto, `/diaria-retro-semanal` invocada tarde no sábado (depois das
 * 11:00 do `highlights`) só descobria o problema no `--images-only` do Passo
 * 2a, via `validateScheduledTime` (`publish-facebook.ts`), com uma mensagem
 * que nem citava `--time`. Aqui a classificação é pura (`now` injetado) e
 * usa os MESMOS limiares de `validateScheduledTime` — o teste trava essa
 * paridade — pra o script (`--check-slot` e o banner do preview) e a skill
 * (Passo 0) avisarem com as opções reais antes de gastar qualquer passo.
 */

/** Margem mínima da Graph API — mesmo default de `validateScheduledTime`. */
export const WEEKLY_SLOT_MIN_OFFSET_SECONDS = 600;

export type WeeklySlotStatus = "ok" | "expired" | "too-soon";

export interface WeeklySlotCheck {
  scheduledAt: string;
  status: WeeklySlotStatus;
  /** Minutos entre `now` e `scheduledAt` — negativo quando já passou. */
  minutesFromNow: number;
}

/** Pure: classifica um `scheduledAt` ISO contra `now`. Lança se a data for inválida. */
export function checkWeeklySlot(
  scheduledAt: string,
  now: Date,
  minOffsetSeconds: number = WEEKLY_SLOT_MIN_OFFSET_SECONDS,
): WeeklySlotCheck {
  const unixTs = Math.floor(new Date(scheduledAt).getTime() / 1000);
  if (Number.isNaN(unixTs)) {
    throw new Error(`scheduledAt "${scheduledAt}" é uma data inválida.`);
  }
  const nowUnix = Math.floor(now.getTime() / 1000);
  const minutesFromNow = Math.round((unixTs - nowUnix) / 60);
  let status: WeeklySlotStatus = "ok";
  if (unixTs <= nowUnix) status = "expired";
  else if (unixTs < nowUnix + minOffsetSeconds) status = "too-soon";
  return { scheduledAt, status, minutesFromNow };
}

/**
 * Pure: próximo horário `HH:MM` viável no MESMO dia de `scheduledAt` (fuso
 * do próprio `scheduledAt`), arredondado pro quarto de hora seguinte a
 * `now + leadMinutes`. `null` quando não cabe mais no mesmo dia — aí só
 * `--day-offset` resolve.
 */
export function suggestSameDayTime(scheduledAt: string, now: Date, leadMinutes = 30): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?([+-]\d{2}):?(\d{2})$/.exec(scheduledAt);
  if (!m) return null;
  const [, , , , offH, offM] = m;
  const sign = offH.startsWith("-") ? -1 : 1;
  const offsetMin = sign * (Math.abs(Number(offH)) * 60 + Number(offM));
  // Relógio local (do fuso do slot) de `now + lead`, como se fosse UTC.
  const localNow = new Date(now.getTime() + (offsetMin + leadMinutes) * 60_000);
  const slotDay = m[1];
  const nowDay = localNow.toISOString().slice(0, 10);
  // Só sugere no MESMO dia do slot: se `now + lead` já virou o dia (ou o
  // slot é de um dia futuro), `--time` sozinho não resolve.
  if (nowDay !== slotDay) return null;
  let minutes = localNow.getUTCHours() * 60 + localNow.getUTCMinutes();
  minutes = Math.ceil(minutes / 15) * 15;
  if (minutes >= 24 * 60) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Pure: aviso legível com as opções de saída pra um slot não-`ok`. Vazio
 * quando o slot está ok. `saturday`/`mode` entram nos comandos sugeridos.
 */
export function formatSlotAdvice(opts: {
  mode: string;
  saturday: string;
  check: WeeklySlotCheck;
  now: Date;
  /** Offset de dias em uso pelo modo (default do modo ou `--day-offset`). */
  dayOffset: number;
}): string[] {
  const { mode, saturday, check, now, dayOffset } = opts;
  if (check.status === "ok") return [];
  const what =
    check.status === "expired"
      ? `já passou (${Math.abs(check.minutesFromNow)}min atrás)`
      : `está a ${check.minutesFromNow}min de agora (margem mínima ${WEEKLY_SLOT_MIN_OFFSET_SECONDS / 60}min)`;
  const base = `npx tsx scripts/publish-weekly-social.ts --saturday ${saturday} --mode ${mode}`;
  const lines = [`AVISO: o slot do modo ${mode} (${check.scheduledAt}) ${what} — agendar assim aborta.`, "Opções:"];
  const sameDay = suggestSameDayTime(check.scheduledAt, now);
  if (sameDay) lines.push(`  - outro horário no mesmo dia: ${base} --time ${sameDay}`);
  lines.push(`  - dia seguinte, mesmo horário: ${base} --day-offset ${dayOffset + 1}`);
  lines.push(`  - pular o modo ${mode} nesta semana (rodar só o outro com --mode explícito)`);
  lines.push("  (--day-offset não compõe com --mode both: rode cada modo separado.)");
  return lines;
}

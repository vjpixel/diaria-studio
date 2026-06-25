/**
 * compute-social-schedule.ts (#270)
 *
 * Calcula o `scheduled_at` (ISO 8601 com offset do timezone) pra agendamentos
 * de posts sociais (LinkedIn, Facebook). Compartilhado entre `publish-facebook.ts`
 * (Graph API) e `publish-linkedin.ts` (Worker queue + Make webhook) pra
 * garantir que ambos respeitem o invariante:
 *
 *   target_date = parse(editionDate AAMMDD) + day_offset
 *
 * **Nunca** `today() + day_offset`. Quando Stage 5/6 roda na madrugada da data
 * da edição, `today()` ainda é a data anterior, e `today + 0` agendaria pra
 * D-1 (dessincronizando newsletter e social). Vide caso 260428.
 *
 * Uso CLI:
 *   npx tsx scripts/compute-social-schedule.ts \
 *     --edition 260428 --destaque d1 --platform linkedin [--day-offset 0]
 *
 * Output (stdout): ISO 8601 datetime com offset (ex: 2026-04-28T09:00:00-03:00)
 *
 * Uso programático:
 *   import { computeScheduledAt } from './compute-social-schedule.ts'
 *   const iso = computeScheduledAt({ config, editionDate, destaque, platform })
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface ScheduleConfig {
  d1_time?: string;
  d2_time?: string;
  d3_time?: string;
  day_offset?: number;
  [k: string]: unknown;
}

interface SocialConfig {
  fallback_schedule?: ScheduleConfig;
  timezone?: string;
  [k: string]: unknown;
}

interface PlatformConfig {
  publishing?: {
    social?: SocialConfig;
  };
}

export interface ComputeScheduleInput {
  config: PlatformConfig;
  editionDate: string;
  destaque: "d1" | "d2" | "d3";
  /** Mantido para compatibilidade de API. O schedule é atualmente unificado entre
   *  plataformas (#345). Pode ser usado no futuro para overrides por plataforma. */
  platform: "linkedin" | "facebook";
  dayOffsetOverride?: number;
  /**
   * Injetável para testes (#2552). Defaults para `Date.now()`.
   * Usado pela lógica de past-slot: se o slot calculado estiver no passado
   * ou abaixo da margem mínima de 10min (piso do Facebook), o slot é
   * shiftado para `now + 15min` com warn visível no stderr.
   */
  now?: number;
  /**
   * Margem mínima de segurança em ms (#2552). Defaults para 10 min (600_000ms —
   * piso exigido pelo Facebook Graph API). Slots calculados com menos que
   * essa margem relativa a `now` são shiftados para `now + pastSlotShiftMs`.
   */
  minFutureMs?: number;
  /**
   * Offset do shift quando o slot está no passado ou abaixo do piso (#2552).
   * Defaults para 15 min (900_000ms) — acima do piso de 10min do Facebook.
   */
  pastSlotShiftMs?: number;
}

/**
 * Pure: parseia "AAMMDD" (com check de 6 dígitos) e retorna { year, month, day }.
 * Lança erro com mensagem acionável em formato inválido — caller deve catch.
 */
export function parseEditionDate(editionDate: string): {
  year: number;
  month: number;
  day: number;
} {
  if (!/^\d{6}$/.test(editionDate)) {
    throw new Error(
      `editionDate inválida: '${editionDate}' (esperado 6 dígitos AAMMDD).`,
    );
  }
  const yy = parseInt(editionDate.slice(0, 2), 10);
  const mm = parseInt(editionDate.slice(2, 4), 10);
  const dd = parseInt(editionDate.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) {
    throw new Error(
      `editionDate fora do range: '${editionDate}' (mm=${mm}, dd=${dd}).`,
    );
  }
  // Validação round-trip: rejeita datas impossíveis como Fev-31 que Date() rolaria silenciosamente (#291).
  const year = 2000 + yy;
  const target = new Date(year, mm - 1, dd);
  if (target.getFullYear() !== year || target.getMonth() !== mm - 1 || target.getDate() !== dd) {
    throw new Error(
      `editionDate inválida (data não existe): '${editionDate}' (${year}-${mm}-${dd} → ${target.toISOString().slice(0, 10)}).`,
    );
  }
  return { year, month: mm, day: dd };
}

/**
 * Pure: deriva o offset do timezone (ex: "-03:00") em formato ISO,
 * relativo a uma data específica (handles DST). Usa Intl.DateTimeFormat —
 * cross-platform e não depende de tabelas externas.
 */
export function timezoneOffsetIso(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    timeZoneName: "longOffset",
  });
  const parts = fmt.formatToParts(date);
  const tzName = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const m = tzName.match(/GMT([+-]\d+(?::\d+)?)/);
  if (!m) return "+00:00";
  const raw = m[1];
  if (raw.includes(":")) return raw.padStart(6, "0");
  return `${raw}:00`;
}

/**
 * Calcula o ISO datetime do agendamento. **Sempre** baseado em `editionDate`
 * (parse de AAMMDD), nunca `Date.now()` (#270).
 *
 * (#2552) Quando o slot calculado está no passado (ou abaixo da margem mínima
 * de 10min exigida pelo Facebook), o slot é shiftado para `now + 15min` com
 * um WARN explícito no stderr. Isso evita:
 *   - LinkedIn caindo silenciosamente em `make_now` (post ao vivo imediato)
 *   - Facebook retornando `status: failed` (rejeita scheduled_publish_time no passado)
 *
 * `now`, `minFutureMs` e `pastSlotShiftMs` são injetáveis para testes (DI).
 */
export function computeScheduledAt(input: ComputeScheduleInput): string {
  // platform mantido na assinatura por compat (#345 — schedule unificado)
  const {
    config,
    editionDate,
    destaque,
    platform,
    dayOffsetOverride,
    now: nowOverride,
    minFutureMs = 10 * 60 * 1000,    // 10 min — piso do Facebook Graph API
    pastSlotShiftMs = 15 * 60 * 1000, // 15 min — acima do piso de 10min (#2552)
  } = input;

  const social = config.publishing?.social;
  if (!social) throw new Error("config.publishing.social ausente.");
  const sched = social.fallback_schedule;
  if (!sched) {
    throw new Error(
      `config.publishing.social.fallback_schedule ausente.`,
    );
  }
  const tz = social.timezone;
  if (!tz) throw new Error("config.publishing.social.timezone ausente.");

  const timeKey = `${destaque}_time` as keyof ScheduleConfig;
  const time = sched[timeKey] as string | undefined;
  if (!time || !/^\d{1,2}:\d{2}$/.test(time)) {
    throw new Error(
      `time inválido para ${platform}.${timeKey}: '${time}' (esperado HH:MM).`,
    );
  }

  const dayOffset = dayOffsetOverride ?? sched.day_offset ?? 0;
  if (!Number.isInteger(dayOffset)) {
    throw new Error(`day_offset não é inteiro: ${dayOffset}`);
  }

  const { year, month, day } = parseEditionDate(editionDate);
  // new Date(year, month-1, day) usa local TZ do runner — usamos só pra
  // aplicar offset de dias corretamente. O dateStr final é montado a partir
  // dos componentes (sem dependência da TZ local). #270.
  const target = new Date(year, month - 1, day);
  target.setDate(target.getDate() + dayOffset);

  const dateStr =
    `${target.getFullYear()}-` +
    String(target.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(target.getDate()).padStart(2, "0");

  // #1140 — Observability: log quando dayOffset != 0 (caminho não-trivial).
  // Inclui editionDate + target final pra diagnóstico de off-by-one (incident
  // 260512 onde 3 posts foram agendados pra 13/05 com edição "260512").
  // Suprimir com env var DIARIA_QUIET_SCHEDULE_LOG=1 (usado em CI/teste).
  if (dayOffset !== 0 && process.env.DIARIA_QUIET_SCHEDULE_LOG !== "1") {
    console.error(
      `[compute-schedule] non-zero dayOffset=${dayOffset} for edition=${editionDate} ` +
      `(${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}) ` +
      `${platform}/${destaque} → target=${dateStr}`,
    );
  }

  // #1140 — Safety guard: editionDate no passado + dayOffset >= 1 é fortemente
  // suspeito de typo (editor passou --day-offset 1 em edição já passada).
  // Avisa loud (stderr), não bloqueia — caller decide.
  if (dayOffset >= 1 && process.env.DIARIA_QUIET_SCHEDULE_LOG !== "1") {
    const todayIso = new Date().toISOString().slice(0, 10);
    const editionIso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (editionIso < todayIso) {
      console.error(
        `[compute-schedule] WARN: dayOffset=${dayOffset} aplicado a editionDate ` +
        `${editionIso} (no passado, hoje=${todayIso}). Suspeita de typo — ` +
        `target seria ${dateStr}. Se intencional, ignore este aviso.`,
      );
    }
  }

  const [h, m] = time.split(":");
  const offsetStr = timezoneOffsetIso(target, tz);
  const calculatedIso = `${dateStr}T${h.padStart(2, "0")}:${m}:00${offsetStr}`;

  // (#2552) Past-slot guard: se o slot calculado está no passado ou abaixo do
  // piso mínimo de plataforma (10min — Facebook Graph API), shiftar para
  // now + 15min (acima do piso) e emitir WARN explícito no stderr.
  //
  // Evita 2 falhas silenciosas observadas na edição 260625:
  //   - LinkedIn d1 caiu em `make_now` (post ao vivo imediato, sem agendamento)
  //   - Facebook d1 retornou `status: failed` (rejeita scheduled_publish_time no passado)
  //
  // (#2565) O shift é controlado por DIARIA_DISABLE_PASTSLOT_SHIFT (separado de
  // DIARIA_QUIET_SCHEDULE_LOG que controla apenas logs). Isso evita o footgun de
  // alguém setar QUIET_LOG=1 em prod pra reduzir ruído de log e desativar o
  // guard de segurança silenciosamente.
  //
  // DIARIA_DISABLE_PASTSLOT_SHIFT=1: suprime o shift (usado em CI/testes legados
  // que usam editionDates históricas que ficariam sempre no passado). Nunca setar
  // em produção — desativa o guard de segurança contra slots no passado.
  // Testes de regressão do #2552 injetam `now` explicitamente pra testar o
  // comportamento correto sem precisar dessa var.
  //
  // O log do WARN é controlado separadamente por DIARIA_QUIET_SCHEDULE_LOG !== "1".
  const nowMs = nowOverride ?? Date.now();
  const calculatedMs = Date.parse(calculatedIso);
  const minFutureCutoffMs = nowMs + minFutureMs;

  if (calculatedMs < minFutureCutoffMs && process.env.DIARIA_DISABLE_PASTSLOT_SHIFT !== "1") {
    const shiftedMs = nowMs + pastSlotShiftMs;
    const shiftedDate = new Date(shiftedMs);
    // Calcular offset do timezone pra data shiftada (pode diferir por DST)
    const shiftedOffsetStr = timezoneOffsetIso(shiftedDate, tz);
    // Converter shiftedDate pra hora local do timezone alvo via Intl.DateTimeFormat
    // (mesmo padrão de timezoneOffsetIso — não usa .getHours() que retorna local do runner)
    const localFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const parts = localFmt.formatToParts(shiftedDate);
    const getP = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    const localDateStr = `${getP("year")}-${getP("month")}-${getP("day")}`;
    const localTimeStr = `${getP("hour").replace("24", "00")}:${getP("minute")}:${getP("second")}`;
    const finalShiftedIso = `${localDateStr}T${localTimeStr}${shiftedOffsetStr}`;

    const minsAhead = Math.round((shiftedMs - nowMs) / 60_000);
    const reason =
      calculatedMs <= nowMs
        ? `slot no passado (${calculatedIso})`
        : `slot a ${Math.round((calculatedMs - nowMs) / 60_000)}min de now, abaixo do piso mínimo de ${Math.round(minFutureMs / 60_000)}min`;

    // Log do WARN é controlado por DIARIA_QUIET_SCHEDULE_LOG (só-log, independente do shift)
    if (process.env.DIARIA_QUIET_SCHEDULE_LOG !== "1") {
      console.error(
        `[compute-schedule] WARN (#2552): ${platform}/${destaque} — ${reason}. ` +
        `Slot shiftado para now+${minsAhead}min → ${finalShiftedIso}. ` +
        `(slot original: ${calculatedIso}, edition: ${editionDate})`,
      );
    }

    return finalShiftedIso;
  }

  return calculatedIso;
}

// ── CLI ──────────────────────────────────────────────────────────────

interface CliFlags {
  edition: string;
  destaque: "d1" | "d2" | "d3";
  platform: "linkedin" | "facebook";
  dayOffset?: number;
  configPath?: string;
}

export function parseCliArgs(argv: string[]): CliFlags | { error: string } {
  let edition: string | undefined;
  let destaque: string | undefined;
  let platform: string | undefined;
  let dayOffset: number | undefined;
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--edition" && argv[i + 1]) {
      edition = argv[++i];
    } else if (a === "--destaque" && argv[i + 1]) {
      destaque = argv[++i];
    } else if (a === "--platform" && argv[i + 1]) {
      platform = argv[++i];
    } else if (a === "--day-offset" && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n)) return { error: `--day-offset inválido` };
      dayOffset = n;
    } else if (a === "--config" && argv[i + 1]) {
      configPath = argv[++i];
    }
  }

  if (!edition) return { error: "missing --edition AAMMDD" };
  if (!destaque || !/^d[123]$/.test(destaque)) {
    return { error: "missing/invalid --destaque (d1|d2|d3)" };
  }
  if (!platform || !/^(linkedin|facebook)$/.test(platform)) {
    return { error: "missing/invalid --platform (linkedin|facebook)" };
  }
  return {
    edition,
    destaque: destaque as "d1" | "d2" | "d3",
    platform: platform as "linkedin" | "facebook",
    dayOffset,
    configPath,
  };
}

function main(): void {
  const ROOT = resolve(import.meta.dirname, "..");
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`Erro: ${parsed.error}`);
    console.error(
      "Uso: compute-social-schedule.ts --edition AAMMDD --destaque d1|d2|d3 --platform linkedin|facebook [--day-offset N] [--config path]",
    );
    process.exit(2);
  }

  const cfgPath = parsed.configPath
    ? resolve(parsed.configPath)
    : resolve(ROOT, "platform.config.json");
  const config = JSON.parse(readFileSync(cfgPath, "utf8")) as PlatformConfig;

  try {
    const iso = computeScheduledAt({
      config,
      editionDate: parsed.edition,
      destaque: parsed.destaque,
      platform: parsed.platform,
      dayOffsetOverride: parsed.dayOffset,
    });
    process.stdout.write(iso);
  } catch (err) {
    console.error(`Erro: ${(err as Error).message}`);
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}

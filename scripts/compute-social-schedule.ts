/**
 * compute-social-schedule.ts (#270)
 *
 * Calcula o `scheduled_at` (ISO 8601 com offset do timezone) pra agendamentos
 * de posts sociais (LinkedIn, Facebook). Compartilhado entre `publish-facebook.ts`
 * (Graph API) e `.claude/agents/publish-social.md` (LinkedIn via Chrome) pra
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
  platform: "linkedin" | "facebook";
  dayOffsetOverride?: number;
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
 */
export function computeScheduledAt(input: ComputeScheduleInput): string {
  const { config, editionDate, destaque, platform, dayOffsetOverride } = input;

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

  const [h, m] = time.split(":");
  const offsetStr = timezoneOffsetIso(target, tz);
  return `${dateStr}T${h.padStart(2, "0")}:${m}:00${offsetStr}`;
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

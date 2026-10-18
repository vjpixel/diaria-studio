/**
 * social-schedule-rotation.ts (#10305) — CLI do teste rotativo de horários.
 *
 * Fino sobre `scripts/lib/social-schedule-rotation.ts` (lógica pura). O plano
 * é determinístico e sai só de `platform.config.json` → `publishing.social`
 * (`rotation`, `fallback_schedule`, `use_melhor_time`,
 * `linkedin_weekly_article_time`), então pode ser reconstruído a qualquer
 * momento — é o registro consultável de "qual horário/tipo cada post recebeu"
 * pra medição (cruzar com `scheduled_at` real de `06-social-published.json` /
 * `06-weekly-published.json`).
 *
 * Uso:
 *   # plano inteiro da janela do teste (default: start_date..end_date)
 *   npx tsx scripts/social-schedule-rotation.ts --plan [--from AAAA-MM-DD] [--to AAAA-MM-DD] [--json]
 *
 *   # o que cada post de um dia recebe (AAAA-MM-DD ou AAMMDD)
 *   npx tsx scripts/social-schedule-rotation.ts --date 261020 [--json]
 *
 *   # só o horário (HH:MM) do artigo semanal do LinkedIn da segunda — Passo 9 de /diaria-linkedin-semanal
 *   npx tsx scripts/social-schedule-rotation.ts --linkedin-article --date 261026
 *
 *   # grava as linhas do dia em data/social-schedule-rotation.jsonl (idempotente)
 *   npx tsx scripts/social-schedule-rotation.ts --record --date 261020 [--kind weekday|weekend|linkedin_article] [--log path]
 *
 * Nunca publica nem agenda nada — só lê o config e (com `--record`) escreve
 * um arquivo local.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import {
  type CivilDate,
  type RotationPlanRow,
  ROTATION_POST_TYPES,
  baseTimesFromSocial,
  buildRotationPlan,
  civilDayNumber,
  civilFromDayNumber,
  formatCivilDate,
  parseIsoCivilDate,
  readSocialRotation,
  resolveLinkedinArticleTime,
  weekdayCoverage,
} from "./lib/social-schedule-rotation.ts";
import {
  DEFAULT_ROTATION_LOG,
  filterUseMelhorRowsByPublished,
  newRowsToRecord,
  recordRotationRows,
  rowKey,
} from "./lib/social-schedule-rotation-record.ts";

// Reexport: a lógica de gravação mora na lib (os publicadores também gravam, #10417 finding 3).
export { DEFAULT_ROTATION_LOG, newRowsToRecord, rowKey };

const ROOT = resolve(import.meta.dirname, "..");

/** Pure: aceita "AAAA-MM-DD" ou "AAMMDD". */
export function parseCliDate(s: string): CivilDate {
  if (/^\d{6}$/.test(s)) return parseIsoCivilDate(`20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}`);
  return parseIsoCivilDate(s);
}

function formatTable(rows: RotationPlanRow[]): string {
  const lines = ["data        dia  tipo              horário  fonte"];
  const wdName = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
  for (const r of rows) {
    const d = parseIsoCivilDate(r.date);
    const wd = wdName[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()];
    const tipo = r.kind === "weekday" ? r.type : r.kind === "weekend" ? `carrossel-${r.day}` : "artigo-linkedin";
    lines.push(`${r.date}  ${wd}  ${tipo.padEnd(16)}  ${r.time}    ${r.source}`);
  }
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (k: string) => argv.includes(k);

  const config = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const social = config?.publishing?.social;
  const rot = readSocialRotation(social);
  const base = baseTimesFromSocial(social);

  if (has("--linkedin-article")) {
    const ds = get("--date");
    if (!ds) throw new Error("--linkedin-article exige --date (a segunda-feira de publicação).");
    const r = resolveLinkedinArticleTime(social, parseCliDate(ds));
    if (has("--json")) console.log(JSON.stringify(r));
    else console.log(r.time);
    if (r.source === "rotation") console.error(`[rotação #10305] artigo semanal do LinkedIn: ${r.time} (semana #${r.weekIndex})`);
    return;
  }

  let from: CivilDate;
  let to: CivilDate;
  if (has("--plan")) {
    if (!rot && !get("--from")) throw new Error("rotação desligada no config — passe --from/--to pra ver o plano dos horários fixos.");
    from = get("--from") ? parseCliDate(get("--from") as string) : (rot as NonNullable<typeof rot>).start;
    to = get("--to")
      ? parseCliDate(get("--to") as string)
      : rot?.end ?? civilFromDayNumber(civilDayNumber(from) + 34);
  } else {
    const ds = get("--date");
    if (!ds) throw new Error("passe --plan, --date ou --linkedin-article --date.");
    from = to = parseCliDate(ds);
  }

  let rows = buildRotationPlan(rot, base, from, to);
  const kind = get("--kind");
  if (kind) rows = rows.filter((r) => r.kind === kind);

  if (has("--record")) {
    const logPath = resolve(ROOT, get("--log") ?? DEFAULT_ROTATION_LOG);
    // #10427 (review #10432): a linha `um` só é gravada se o post existiu.
    const n = recordRotationRows(logPath, filterUseMelhorRowsByPublished(rows, social, ROOT));
    console.log(`[social-schedule-rotation] ${n} linha(s) nova(s) em ${logPath} (${rows.length - n} já gravada(s)).`);
    return;
  }

  if (has("--json")) {
    console.log(JSON.stringify({ from: formatCivilDate(from), to: formatCivilDate(to), rotation_enabled: rot !== null, rows }, null, 2));
    return;
  }
  console.log(formatTable(rows));
  if (rot && has("--plan")) {
    const cov = weekdayCoverage(rot, rows);
    console.log(`\nCobertura dia útil (posts por horário × tipo):`);
    console.log(`horário  ${ROTATION_POST_TYPES.join("  ")}`);
    for (const [t, c] of Object.entries(cov)) {
      console.log(`${t}    ${ROTATION_POST_TYPES.map((k) => String(c[k]).padStart(2)).join("  ")}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`Erro: ${(e as Error).message}`);
    process.exit(1);
  }
}

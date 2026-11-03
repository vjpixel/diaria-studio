#!/usr/bin/env npx tsx
/**
 * Append um evento ao log estruturado de execução.
 *
 * Uso:
 *   npx tsx scripts/log-event.ts \
 *     --edition 260418 \
 *     --stage 1 \
 *     --agent source-researcher \
 *     --level error \
 *     --message "fonte X retornou 403" \
 *     --details '{"url":"...","status":403}'
 *
 * Níveis: info | warn | error
 *
 * Flag opcional `--informational` (#565): marca o warn como por-design /
 * informativo (não é regressão). Injeta `informational: true` no details.
 * O `auto-reporter` filtra esses warns automaticamente, evitando issues
 * GitHub falsas em /diaria-test ou /diaria-edicao com warns conhecidos.
 * Substituí o tag textual `(informativo)` no message (acoplamento frágil).
 *
 * Grava em `data/run-log.jsonl` (ou no path definido em platform.config.json > logging.path).
 * Formato: 1 linha JSON por evento. Append-only.
 */

import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { appendFileWithRetry } from "./lib/source-runs.ts";
import { recordUnitTimeline } from "./lib/overnight-unit-timeline.ts";
import { readPlanJson } from "./lib/plan-safe-backup.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";

type Level = "info" | "warn" | "error";

interface LogEvent {
  timestamp: string;
  edition: string | null;
  stage: number | null;
  agent: string | null;
  level: Level;
  message: string;
  details: unknown;
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith("--")) {
        out[key] = "true";
      } else {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

function getLogPath(): string {
  const cfgPath = resolve(process.cwd(), "platform.config.json");
  if (!existsSync(cfgPath)) return resolve(process.cwd(), "data/run-log.jsonl");
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    return resolve(process.cwd(), cfg?.logging?.path ?? "data/run-log.jsonl");
  } catch {
    return resolve(process.cwd(), "data/run-log.jsonl");
  }
}

const args = parseArgs(process.argv.slice(2));

const level = (args.level ?? "info") as Level;
if (!["info", "warn", "error"].includes(level)) {
  console.error(`level inválido: ${level}. Use info|warn|error.`);
  process.exit(2);
}

if (!args.message) {
  console.error("--message é obrigatório");
  process.exit(2);
}

let details: unknown = null;
if (args.details) {
  try {
    details = JSON.parse(args.details);
  } catch {
    details = args.details;
  }
}

// #565 — `--informational` injeta flag estruturada em details.
if (args.informational === "true") {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    (details as Record<string, unknown>).informational = true;
  } else {
    details = { informational: true };
  }
}

const event: LogEvent = {
  timestamp: new Date().toISOString(),
  edition: args.edition ?? null,
  stage: args.stage ? Number(args.stage) : null,
  agent: args.agent ?? null,
  level,
  message: args.message,
  details,
};

const logPath = getLogPath();
// Lifecycle events already emitted by the coordinator also persist the timeline.
// Never create a plan or infer the round from the current date (#12011).
if ((event.agent === "overnight" || event.agent === "develop") &&
    event.edition && /^\d{6}[a-z0-9-]*$/i.test(event.edition) &&
    details && typeof details === "object" && !Array.isArray(details)) {
  const d = details as Record<string, unknown>;
  const name = event.message === "fix_iteration" && Number.isInteger(d.tentativa) && Number(d.tentativa) > 0
    ? `fix_iteration_${d.tentativa}` : event.message;
  if (/^(dispatch|pr_opened|ci_green|merged|draft|pulada|fix_iteration_[1-9]\d*)$/.test(name) &&
      Array.isArray(d.issues) && d.issues.every((id) => typeof id === "number" || typeof id === "string")) {
    const planPath = resolve(process.cwd(), "data", event.agent, event.edition, "plan.json");
    try {
      const read = readPlanJson(planPath);
      if (read.status !== "ok") throw new Error(read.message);
      const next = recordUnitTimeline(read.plan as Record<string, unknown>, d.issues, name, event.timestamp);
      if (JSON.stringify(next) !== JSON.stringify(read.plan)) writeFileAtomic(planPath, JSON.stringify(next, null, 2) + "\n");
    } catch (err) {
      console.warn(`[log-event] timeline não persistida: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
mkdirSync(dirname(logPath), { recursive: true });
// #8634: retry curto com backoff (3x) no append — OneDrive Files On-Demand
// pode retornar UNKNOWN (errno=-4094)/EPERM/EBUSY/EACCES quando o sync agent
// tem o arquivo locked. Se persistir, degrada pra warn no stderr sem lançar
// (log nunca deve derrutar o stage).
try {
  appendFileWithRetry(logPath, JSON.stringify(event) + "\n");
} catch (err) {
  console.warn(`[log-event] falha persistente ao gravar em ${logPath}: ${err instanceof Error ? err.message : String(err)} — evento perdido (não bloqueia stage)`);
}

console.log(`logged ${level} → ${logPath}`);

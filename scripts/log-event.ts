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
 * Grava em `data/run-log.jsonl` (ou no path definido em platform.config.json > logging.path).
 * Formato: 1 linha JSON por evento. Append-only.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
mkdirSync(dirname(logPath), { recursive: true });
appendFileSync(logPath, JSON.stringify(event) + "\n", "utf8");

console.log(`logged ${level} → ${logPath}`);

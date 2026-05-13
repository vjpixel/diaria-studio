#!/usr/bin/env tsx
/**
 * log-runtime-fix.ts (#1210)
 *
 * Append-only logger pra "runtime fixes" — correções que o orchestrator
 * (top-level Claude) faz manualmente durante o pipeline pra contornar
 * regressões. Sem isso, esses fixes ficam invisíveis pro auto-reporter
 * (collect-edition-signals.ts só lê source-health, unfixed_issues, run-log
 * warns — fixes in-flight escapam).
 *
 * Caso real /diaria-test 260517: o orchestrator fixou 5 bugs in-flight
 * (title-picker structure, bold link format, coverage line, destaque
 * min-chars, links multilinhas) sem logar — nenhum virou issue automática.
 * Eu (Pixel) só descobri os bugs pesquisando depois. Esta infra fecha
 * o gap.
 *
 * Uso:
 *   npx tsx scripts/log-runtime-fix.ts \
 *     --edition 260517 \
 *     --stage 2 \
 *     --fix-type structural \
 *     --component title-picker \
 *     --description "remontei ordem de seções pós-title-picker; removeu --- entre OUTRAS NOTÍCIAS e SORTEIO" \
 *     --severity P2
 *
 * Output: append em `data/editions/{AAMMDD}/_internal/runtime-fixes.jsonl`.
 * Cada linha = 1 fix. Lido por `collect-edition-signals.ts` como sinal
 * `kind: "runtime_fix"`.
 *
 * Severities: P0 (fire), P1 (urgent), P2 (default — vira issue), P3
 * (cleanup, não vira issue automática).
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type FixType =
  | "structural"   // estrutura do MD/arquivo corrompida e restaurada
  | "format"       // formato wrong (link multilinhas, regex falhou)
  | "content"      // conteúdo wrong (char count, coverage line)
  | "config"       // env var ausente, secret faltando
  | "tooling"      // bug em script/agent que precisou workaround
  | "other";

export type Severity = "P0" | "P1" | "P2" | "P3";

export interface RuntimeFixEntry {
  timestamp: string;
  edition: string;
  stage: number;
  fix_type: FixType;
  component: string;
  description: string;
  severity: Severity;
  context?: Record<string, unknown>;
}

export function appendRuntimeFix(
  editionDir: string,
  entry: Omit<RuntimeFixEntry, "timestamp">,
): RuntimeFixEntry {
  const full: RuntimeFixEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  const outPath = resolve(editionDir, "_internal", "runtime-fixes.jsonl");
  mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  appendFileSync(outPath, JSON.stringify(full) + "\n", "utf8");
  return full;
}

const VALID_FIX_TYPES: ReadonlyArray<FixType> = [
  "structural", "format", "content", "config", "tooling", "other",
];

const VALID_SEVERITIES: ReadonlyArray<Severity> = ["P0", "P1", "P2", "P3"];

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const required = ["edition", "stage", "fix-type", "component", "description"];
  const missing = required.filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(
      "Uso: log-runtime-fix.ts --edition AAMMDD --stage N --fix-type <type> --component <name> --description \"...\" [--severity P0|P1|P2|P3] [--context '<json>']\n" +
        `Faltam: ${missing.join(", ")}`,
    );
    process.exit(2);
  }

  const fixType = args["fix-type"] as FixType;
  if (!VALID_FIX_TYPES.includes(fixType)) {
    console.error(`fix-type inválido: ${fixType}. Aceitos: ${VALID_FIX_TYPES.join(", ")}`);
    process.exit(2);
  }

  const severity = (args.severity ?? "P2") as Severity;
  if (!VALID_SEVERITIES.includes(severity)) {
    console.error(`severity inválida: ${severity}. Aceitos: ${VALID_SEVERITIES.join(", ")}`);
    process.exit(2);
  }

  const stage = parseInt(args.stage, 10);
  if (isNaN(stage) || stage < 0 || stage > 5) {
    console.error(`stage inválido: ${args.stage} (esperado 0-5)`);
    process.exit(2);
  }

  let context: Record<string, unknown> | undefined;
  if (args.context) {
    try {
      context = JSON.parse(args.context);
    } catch {
      console.error(`--context não é JSON válido: ${args.context}`);
      process.exit(2);
    }
  }

  const editionDir = resolve(ROOT, "data", "editions", args.edition);
  if (!existsSync(editionDir)) {
    console.error(`Edition dir não existe: ${editionDir}`);
    process.exit(2);
  }

  const entry = appendRuntimeFix(editionDir, {
    edition: args.edition,
    stage,
    fix_type: fixType,
    component: args.component,
    description: args.description,
    severity,
    context,
  });

  console.log(JSON.stringify({ ok: true, entry }, null, 2));
}

const _argv1 = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (/\/scripts\/log-runtime-fix\.ts$/.test(_argv1)) {
  main();
}

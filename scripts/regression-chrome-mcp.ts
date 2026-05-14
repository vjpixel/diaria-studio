#!/usr/bin/env tsx
/**
 * regression-chrome-mcp.ts (#1243)
 *
 * Helper CLI pra observabilidade do bug Chrome MCP `javascript_tool`
 * intermitente em Beehiiv (#1211 — "Cannot access a chrome-extension://
 * URL of different extension"). Como o bug é externo (depende do fix da
 * extensão Chrome da Anthropic), precisamos de uma forma sustentável de
 * saber quando o fix landed sem testar manualmente toda semana.
 *
 * **A interação MCP real (`tabs_create_mcp`, `navigate`, `javascript_tool`)
 * acontece dentro de uma sessão Claude Code com extensão ativa.** Este
 * script é apenas o helper que grava resultado + reporta trend.
 *
 * ## Uso (CLI direto)
 *
 *   # Gravar resultado
 *   npx tsx scripts/regression-chrome-mcp.ts record \
 *     --result pass --note "javascript_tool funcionou em https://app.beehiiv.com"
 *
 *   npx tsx scripts/regression-chrome-mcp.ts record \
 *     --result fail --error "Cannot access a chrome-extension:// URL"
 *
 *   # Status — analisa últimas N execuções e diz se bug tá active/fixed/intermitente
 *   npx tsx scripts/regression-chrome-mcp.ts status
 *   npx tsx scripts/regression-chrome-mcp.ts status --window 10
 *
 * ## Uso via Claude Code session
 *
 * Editor abre Claude Code com extensão claude-in-chrome ativa e roda:
 *
 *   "Reproduza bug #1211: crie tab, navegue pra Beehiiv, tente javascript_tool.
 *    Grave resultado via scripts/regression-chrome-mcp.ts record."
 *
 * Claude executa MCP calls + invoca record com pass/fail. Resultado fica em
 * data/regression-log.jsonl. Editor checa periodicamente via `status`.
 *
 * ## Alerta de fix landed
 *
 * Quando últimas 5 execuções (configurable via --window) retornaram pass,
 * status reporta com sugestão de desbloquear #1211 e #1238 (que dependem
 * dele).
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = resolve(ROOT, "data/regression-log.jsonl");

export type Result = "pass" | "fail" | "intermittent";

export interface RegressionEntry {
  ts: string;
  test: string;
  result: Result;
  note?: string;
  error?: string;
  /** Versão do Claude Code reportada pelo editor / runtime, se disponível. */
  claude_code_version?: string;
}

export interface StatusSummary {
  total_entries: number;
  window: number;
  last_n: RegressionEntry[];
  passed_in_window: number;
  failed_in_window: number;
  intermittent_in_window: number;
  trend: "all_pass" | "all_fail" | "mixed" | "no_data";
  recommendation: string;
}

export function readLog(path: string = LOG_PATH): RegressionEntry[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const entries: RegressionEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && typeof parsed.result === "string") {
        entries.push(parsed as RegressionEntry);
      }
    } catch {
      // skip malformed lines (best-effort)
    }
  }
  return entries;
}

export function appendEntry(entry: RegressionEntry, path: string = LOG_PATH): void {
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(path, line, "utf8");
}

export function computeStatus(
  entries: RegressionEntry[],
  window: number,
): StatusSummary {
  const chromeEntries = entries.filter((e) => e.test === "chrome_mcp_js_tool");
  const lastN = chromeEntries.slice(-window);
  const passed = lastN.filter((e) => e.result === "pass").length;
  const failed = lastN.filter((e) => e.result === "fail").length;
  const intermittent = lastN.filter((e) => e.result === "intermittent").length;

  let trend: StatusSummary["trend"];
  let recommendation: string;
  if (lastN.length === 0) {
    trend = "no_data";
    recommendation =
      "Nenhuma execução registrada ainda. Rode a regression dentro de Claude Code (ver docstring).";
  } else if (passed === lastN.length) {
    trend = "all_pass";
    recommendation = `Últimas ${lastN.length} execuções passaram — bug pode estar fixed. Considere desbloquear #1211 e #1238 (atualmente external-blocker).`;
  } else if (failed === lastN.length) {
    trend = "all_fail";
    recommendation = `Últimas ${lastN.length} execuções falharam — bug ainda ativo. Continue workaround manual.`;
  } else {
    trend = "mixed";
    recommendation = `Resultados mistos (${passed} pass / ${failed} fail / ${intermittent} intermitente) — bug pode estar parcialmente fixed ou intermitente. Aumente window e re-execute.`;
  }

  return {
    total_entries: chromeEntries.length,
    window,
    last_n: lastN,
    passed_in_window: passed,
    failed_in_window: failed,
    intermittent_in_window: intermittent,
    trend,
    recommendation,
  };
}

interface CliArgs {
  command?: "record" | "status";
  result?: Result;
  note?: string;
  error?: string;
  window?: number;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  if (argv[0] && !argv[0].startsWith("--")) {
    out.command = argv[0] as CliArgs["command"];
    argv = argv.slice(1);
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--result") out.result = argv[++i] as Result;
    else if (a === "--note") out.note = argv[++i];
    else if (a === "--error") out.error = argv[++i];
    else if (a === "--window") out.window = parseInt(argv[++i], 10);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage(): string {
  return [
    "Uso:",
    "  regression-chrome-mcp.ts record --result pass|fail|intermittent [--note <str>] [--error <str>]",
    "  regression-chrome-mcp.ts status [--window N]",
    "",
    "Log fica em data/regression-log.jsonl (append-only).",
  ].join("\n");
}

export function mainCli(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help || !args.command) {
    console.log(usage());
    return args.help ? 0 : 2;
  }

  if (args.command === "record") {
    if (!args.result || !["pass", "fail", "intermittent"].includes(args.result)) {
      console.error("Erro: --result pass|fail|intermittent obrigatório.\n");
      console.error(usage());
      return 2;
    }
    const entry: RegressionEntry = {
      ts: new Date().toISOString(),
      test: "chrome_mcp_js_tool",
      result: args.result,
      ...(args.note && { note: args.note }),
      ...(args.error && { error: args.error }),
    };
    appendEntry(entry);
    console.log(`OK: gravado ${args.result} em ${LOG_PATH}`);
    return 0;
  }

  if (args.command === "status") {
    const window = args.window ?? 5;
    if (window < 1) {
      console.error("Erro: --window deve ser >= 1.");
      return 2;
    }
    const entries = readLog();
    const summary = computeStatus(entries, window);
    console.log(JSON.stringify(summary, null, 2));
    // Exit non-zero quando bug ativo (pra integração com CI / scripts upstream)
    return summary.trend === "all_fail" ? 1 : 0;
  }

  console.error(`Comando desconhecido: ${args.command}`);
  console.error(usage());
  return 2;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/regression-chrome-mcp\.ts$/.test(_argv1)) {
  process.exit(mainCli(process.argv.slice(2)));
}

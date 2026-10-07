#!/usr/bin/env npx tsx
/**
 * resolve-mcp-connector.ts (#9823)
 *
 * CLI do resolvedor determinístico de prefixo de conector claude.ai
 * (`scripts/lib/mcp-connector-resolve.ts`). Usado no §5f passo 0 do
 * `orchestrator-stage-5.md`: o top-level roda um `ToolSearch` amplo, cola os
 * nomes devolvidos aqui e recebe o nome EXATO de cada tool pra chamar — em vez
 * de decidir "de olho" qual `mcp__<uuid>__search_threads` é o Gmail.
 *
 * Uso:
 *   npx tsx scripts/resolve-mcp-connector.ts --connector gmail \
 *     --tools "mcp__claude_ai_Gmail__search_threads,mcp__claude_ai_Gmail__get_thread,..."
 *   (ou --tools-file <path> com os nomes separados por vírgula/espaço/linha)
 *
 * Stdout: JSON `ResolveResult` (`status`, `prefix`, `tools`, `select`, `candidates`).
 * Exit: 0 = stable|renamed (usar `tools.*`); 1 = missing (nenhum prefixo com
 * as tools exigidas → `reason: "mcp_unavailable"`); 3 = ambiguous (mais de um
 * candidato sem assinatura que desempate — tratar como missing, nunca chutar);
 * 2 = uso.
 */

import { readFileSync } from "node:fs";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { CONNECTORS, parseToolNames, resolveConnectorTools } from "./lib/mcp-connector-resolve.ts";

export function exitCodeFor(status: string): number {
  if (status === "stable" || status === "renamed") return 0;
  if (status === "ambiguous") return 3;
  return 1;
}

function main(): void {
  const args = parseArgsSimple(process.argv.slice(2));
  const spec = CONNECTORS[args.connector ?? ""];
  if (!spec) {
    console.error(`--connector obrigatório (${Object.keys(CONNECTORS).join("|")})`);
    process.exit(2);
  }
  let raw = args.tools ?? "";
  if (args["tools-file"]) raw += "\n" + readFileSync(args["tools-file"], "utf8");
  if (!raw.trim()) {
    console.error("--tools ou --tools-file obrigatório");
    process.exit(2);
  }
  const result = resolveConnectorTools(parseToolNames(raw), spec);
  console.log(JSON.stringify(result, null, 2));
  process.exit(exitCodeFor(result.status));
}

if (isMainModule(import.meta.url)) main();

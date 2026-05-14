#!/usr/bin/env tsx
/**
 * scripts/poll-kv-put.ts (#1237)
 *
 * CLI wrapper pra `wranglerKvPut` em `scripts/lib/poll-kv.ts`. Útil pra
 * edição interativa de keys no KV do Worker `diar-ia-poll` sem cair na
 * armadilha de shell escape do `wrangler kv key put` direto.
 *
 * Uso:
 *   npx tsx scripts/poll-kv-put.ts --key <key> --value <string-bruta>
 *   npx tsx scripts/poll-kv-put.ts --key <key> --json <json-string>
 *   npx tsx scripts/poll-kv-put.ts --key <key> --path <arquivo>
 *
 * Diferença vs `wrangler kv key put` direto:
 *   - Passa value via tmpfile + --path (sem shell escape problem)
 *   - --json valida JSON antes (evita gravar string inválida)
 *   - Mensagem de erro clara se wrangler falhar
 *
 * Caso real que motivou (#1237): em 2026-05-13, editor tentou:
 *   wrangler kv key put "stats:260512" '{"total":2,...}' ...
 *   → resultou em backslashes literais no KV (\"total\":2...) — JSON inválido.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { wranglerKvPut } from "./lib/poll-kv.ts";

interface CliArgs {
  key?: string;
  value?: string;
  json?: string;
  path?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--key") out.key = argv[++i];
    else if (a === "--value") out.value = argv[++i];
    else if (a === "--json") out.json = argv[++i];
    else if (a === "--path") out.path = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage(): string {
  return [
    "Uso: poll-kv-put.ts --key <key> (--value <str> | --json <json-str> | --path <file>)",
    "",
    "Flags:",
    "  --key   <string>   Key no KV (obrigatório)",
    "  --value <string>   Value bruto (qualquer string)",
    "  --json  <string>   Value JSON (validado antes do PUT)",
    "  --path  <file>     Lê value do arquivo",
    "",
    "Exatamente UM de --value/--json/--path deve ser passado.",
  ].join("\n");
}

export function main(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.key) {
    console.error("Erro: --key é obrigatório.\n");
    console.error(usage());
    return 2;
  }
  const sources = [args.value, args.json, args.path].filter((x) => x !== undefined);
  if (sources.length !== 1) {
    console.error("Erro: passe exatamente UM de --value/--json/--path.\n");
    console.error(usage());
    return 2;
  }

  let value: string;
  if (args.value !== undefined) {
    value = args.value;
  } else if (args.json !== undefined) {
    // Valida JSON antes de gravar — pega malformação no cliente, não no KV.
    try {
      JSON.parse(args.json);
    } catch (e) {
      console.error(`Erro: --json não é JSON válido: ${(e as Error).message}`);
      return 2;
    }
    value = args.json;
  } else {
    const path = resolve(process.cwd(), args.path!);
    try {
      value = readFileSync(path, "utf8");
    } catch (e) {
      console.error(`Erro lendo --path ${path}: ${(e as Error).message}`);
      return 2;
    }
  }

  try {
    wranglerKvPut(args.key, value);
    console.log(`OK: key=${args.key} (${value.length} bytes) escrito no KV`);
    return 0;
  } catch (e) {
    console.error(`Erro escrevendo KV: ${(e as Error).message}`);
    return 1;
  }
}

// Run quando invocado direto (não importado).
// Windows/POSIX-safe: normaliza separadores antes de comparar.
const argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
const isMain = /\/scripts\/poll-kv-put\.ts$/.test(argv1);
if (isMain) {
  process.exit(main(process.argv.slice(2)));
}

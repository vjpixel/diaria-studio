#!/usr/bin/env npx tsx
/**
 * pipeline-sentinel.ts (#780, #1330) — CLI wrapper para pipeline-state.ts.
 *
 * Subcomandos (step-level — gate approvals):
 *   write  --edition AAMMDD --step N --outputs "file1,file2"
 *   assert --edition AAMMDD --step N [--outputs "file1,file2"]
 *   exists --edition AAMMDD --step N
 *
 * Subcomandos (sub-step markers — invariantes intra-stage, #1330):
 *   write-marker  --edition AAMMDD --name <kebab-case> [--details '{"k":"v"}']
 *   assert-marker --edition AAMMDD --name <kebab-case>
 *
 * Exit codes para `assert`:
 *   0 — sentinel presente + todos os outputs existem (pass)
 *   1 — sentinel ausente (hard fail); com --outputs, só retorna 1 se algum
 *       output também estiver ausente (caso sem --outputs → sempre 1)
 *   2 — sentinel presente mas outputs ausentes (hard fail)
 *   3 — sentinel ausente MAS todos os arquivos em --outputs existem (legacy/migração — warn)
 *
 * Exit codes para `assert-marker`:
 *   0 — marker presente (pass)
 *   1 — marker ausente (hard fail)
 *
 * Exit codes para `write` / `write-marker`:  0 = ok, 1 = erro
 * Exit codes para `exists`: 0 = presente, 1 = ausente
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertMarker,
  assertSentinel,
  sentinelExists,
  writeMarker,
  writeSentinel,
} from "./lib/pipeline-state.js";

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

const [, , subcmd, ...rest] = process.argv;
const args = parseArgs(rest);

if (!args.edition) {
  console.error("[error] --edition é obrigatório");
  process.exit(1);
}

const editionDir = resolve(process.cwd(), "data", "editions", args.edition);

// Marker subcmds só precisam de --name. Step subcmds precisam de --step.
const isMarkerCmd = subcmd === "write-marker" || subcmd === "assert-marker";

if (!isMarkerCmd && !args.step) {
  console.error("[error] --step é obrigatório (use --name para sub-step markers)");
  process.exit(1);
}

if (isMarkerCmd && !args.name) {
  console.error("[error] --name é obrigatório para write-marker/assert-marker");
  process.exit(1);
}

const step = isMarkerCmd ? -1 : Number(args.step);

if (!isMarkerCmd && (Number.isNaN(step) || step < 1)) {
  console.error(`[error] --step inválido: ${args.step}`);
  process.exit(1);
}

switch (subcmd) {
  case "write": {
    if (!args.outputs) {
      console.error("[error] --outputs é obrigatório para write");
      process.exit(1);
    }
    const outputs = args.outputs.split(",").map((s) => s.trim()).filter(Boolean);
    try {
      writeSentinel(editionDir, step, outputs);
      console.log(`sentinel step ${step} escrito em ${editionDir}/_internal/.step-${step}-done.json`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[error] falha ao escrever sentinel: ${msg}`);
      process.exit(1);
    }
    break;
  }

  case "assert": {
    const result = assertSentinel(editionDir, step);
    if (result.ok) {
      process.exit(0);
    }
    if (result.reason === "sentinel_missing") {
      if (args.outputs) {
        const files = args.outputs.split(",").map((s) => s.trim()).filter(Boolean);
        const missingFiles = files.filter((f) => !existsSync(resolve(editionDir, f)));
        if (missingFiles.length === 0) {
          console.warn(
            `[warn] sentinel step ${step} ausente mas outputs encontrados em disco (legado) — logar e continuar`,
          );
          process.exit(3);
        }
        // Some outputs missing — list them for actionable diagnosis
        console.error(
          `[error] sentinel step ${step} ausente e outputs faltando: ${missingFiles.join(", ")}`,
        );
        process.exit(1);
      }
      console.error(`[error] sentinel step ${step} ausente em ${editionDir}`);
      process.exit(1);
    }
    // outputs_missing
    const missing = result.missingOutputs.join(", ");
    console.error(`[error] sentinel step ${step} presente mas outputs ausentes: ${missing}`);
    process.exit(2);
  }

  case "exists": {
    process.exit(sentinelExists(editionDir, step) ? 0 : 1);
  }

  case "write-marker": {
    let details: Record<string, unknown> | undefined;
    if (args.details) {
      try {
        details = JSON.parse(args.details) as Record<string, unknown>;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[error] --details JSON inválido: ${msg}`);
        process.exit(1);
      }
    }
    try {
      writeMarker(editionDir, args.name, details);
      console.log(`marker '${args.name}' escrito em ${editionDir}/_internal/.marker-${args.name}.json`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[error] falha ao escrever marker: ${msg}`);
      process.exit(1);
    }
    break;
  }

  case "assert-marker": {
    const result = assertMarker(editionDir, args.name);
    if (result.ok) {
      process.exit(0);
    }
    console.error(`[error] marker '${args.name}' ausente em ${editionDir}/_internal/`);
    process.exit(1);
  }

  default: {
    console.error(`[error] subcomando desconhecido: ${subcmd}. Use write|assert|exists|write-marker|assert-marker`);
    process.exit(1);
  }
}

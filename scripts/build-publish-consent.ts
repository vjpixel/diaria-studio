#!/usr/bin/env tsx
/**
 * build-publish-consent.ts (#1238 follow-up)
 *
 * CLI wrapper que escreve `_internal/05-publish-consent.json` invocando
 * o helper `scripts/lib/publish-consent.ts`. Substitui o JSON literal
 * inline no bash do orchestrator-stage-5.md (review session 2026-05-14:
 * helper TS estava criado mas nunca chamado em prod — layering issue).
 *
 * Uso:
 *   # Auto-approve mode (--no-gates)
 *   npx tsx scripts/build-publish-consent.ts --edition AAMMDD --auto-approve
 *
 *   # Editor response do gate interativo
 *   npx tsx scripts/build-publish-consent.ts --edition AAMMDD --editor-response "1,3,5"
 *   npx tsx scripts/build-publish-consent.ts --edition AAMMDD --editor-response "all"
 *
 *   # Default manual (editor não respondeu)
 *   npx tsx scripts/build-publish-consent.ts --edition AAMMDD --default-manual
 *
 * Output: grava JSON em `data/editions/{AAMMDD}/_internal/05-publish-consent.json`
 * + escreve mesmo JSON no stdout pra encadeamento.
 *
 * Exit codes:
 *   0 = consent escrito
 *   1 = editor response inválida
 *   2 = erro de uso
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  autoApproveConsent,
  defaultAutoConsent,
  defaultManualConsent,
  parseEditorResponse,
  parseSkipFlag,
  type PublishConsent,
} from "./lib/publish-consent.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CliArgs {
  edition?: string;
  autoApprove?: boolean;
  defaultAuto?: boolean;
  defaultManual?: boolean;
  editorResponse?: string;
  skip?: string;
  outPath?: string;
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--edition") out.edition = argv[++i];
    else if (a === "--auto-approve") out.autoApprove = true;
    else if (a === "--default-auto") out.defaultAuto = true;
    else if (a === "--default-manual") out.defaultManual = true;
    else if (a === "--editor-response") out.editorResponse = argv[++i];
    else if (a === "--skip") out.skip = argv[++i];
    else if (a === "--out") out.outPath = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function usage(): string {
  return [
    "Uso:",
    "  build-publish-consent.ts --edition AAMMDD <mode>",
    "",
    "Modes (exatamente um):",
    "  --auto-approve              auto em todos os canais (source: auto_approve_default)",
    "  --default-auto              tudo auto, default de Stage 5 (#1326) — source: default_auto",
    "  --default-manual            manual em todos os canais (LEGACY — source: default_manual)",
    "  --skip <channels>           tudo auto exceto canais listados (--skip newsletter,linkedin)",
    "                              canais válidos: newsletter, linkedin, facebook, instagram, threads",
    "  --editor-response <input>   parse resposta do gate ('all', 'none', '1,3,5,7,9')",
    "                              9=Threads auto, 10=Threads manual",
    "",
    "Opcional:",
    "  --out <path>                override do default data/editions/{AAMMDD}/_internal/05-publish-consent.json",
  ].join("\n");
}

export function mainCli(argv: string[]): number {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (!args.edition) {
    console.error("Erro: --edition obrigatório.\n");
    console.error(usage());
    return 2;
  }
  const modeFlags = [
    args.autoApprove,
    args.defaultAuto,
    args.defaultManual,
    args.editorResponse != null,
    args.skip != null,
  ].filter(Boolean).length;
  if (modeFlags !== 1) {
    console.error(
      "Erro: exatamente UM de --auto-approve / --default-auto / --default-manual / --editor-response / --skip.\n",
    );
    console.error(usage());
    return 2;
  }

  let consent: PublishConsent;
  if (args.autoApprove) {
    consent = autoApproveConsent();
  } else if (args.defaultAuto) {
    consent = defaultAutoConsent();
  } else if (args.defaultManual) {
    consent = defaultManualConsent();
  } else if (args.skip != null) {
    const parsed = parseSkipFlag(args.skip);
    if (!parsed) {
      console.error(
        `Erro: --skip inválido: ${JSON.stringify(args.skip)}. Use lista CSV de canais: newsletter, linkedin, facebook, instagram.`,
      );
      return 1;
    }
    consent = parsed;
  } else {
    const parsed = parseEditorResponse(args.editorResponse!);
    if (!parsed) {
      console.error(`Erro: --editor-response inválida: ${JSON.stringify(args.editorResponse)}`);
      return 1;
    }
    consent = parsed;
  }

  const outPath = args.outPath
    ? resolve(ROOT, args.outPath)
    : resolve(ROOT, "data", "editions", args.edition, "_internal", "05-publish-consent.json");
  const outDir = dirname(outPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const json = JSON.stringify(consent, null, 2);
  writeFileSync(outPath, json + "\n", "utf8");
  console.log(json);
  return 0;
}

const _argv1 = (process.argv[1] ?? "").replace(/\\/g, "/");
if (/\/scripts\/build-publish-consent\.ts$/.test(_argv1)) {
  process.exit(mainCli(process.argv.slice(2)));
}

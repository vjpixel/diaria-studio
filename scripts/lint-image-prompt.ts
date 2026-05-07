#!/usr/bin/env npx tsx
/**
 * lint-image-prompt.ts (#810)
 *
 * Pre-flight lint pra prompts de imagem da Diar.ia. Roda antes de
 * `image-generate.ts` pra detectar violações da regra editorial
 * (`context/editorial-rules.md`) ANTES de gastar API call:
 *
 *   - Sem referências a "Noite Estrelada" / "The Starry Night"
 *   - Sem resolução em pixels (1024x1024, 800x600, etc.)
 *   - Sem mentions de DPI ou pixel count
 *
 * Uso:
 *   npx tsx scripts/lint-image-prompt.ts data/editions/{AAMMDD}/02-d1-prompt.md
 *   npx tsx scripts/lint-image-prompt.ts --text "prompt inline aqui"
 *
 * Exit codes:
 *   0 = prompt OK (pode prosseguir pra image-generate)
 *   1 = violações encontradas (stderr lista as violações; orchestrator
 *       deve pausar e pedir fix do editor antes de retry)
 *   2 = erro de uso (arquivo não existe, args malformados)
 */

import { readFileSync } from "node:fs";
import {
  findForbiddenPhrases,
  formatIssues,
  CATEGORY_RULES,
  type ForbiddenIssue,
} from "./lib/lint-image-prompt.ts";

interface CliFlags {
  file: string | null;
  text: string | null;
}

function parseArgs(argv: string[]): CliFlags {
  let file: string | null = null;
  let text: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text" && i + 1 < argv.length) {
      text = argv[i + 1];
      i++;
    } else if (a.startsWith("--")) {
      // Unknown flag — ignore (tolerant pra ruído na CLI)
      continue;
    } else if (file === null) {
      // Primeiro positional = path do arquivo
      file = a;
    }
  }
  return { file, text };
}

function loadPrompt(flags: CliFlags): string | null {
  if (flags.text !== null) return flags.text;
  if (flags.file === null) return null;
  try {
    return readFileSync(flags.file, "utf8");
  } catch (e) {
    process.stderr.write(
      `Erro ao ler ${flags.file}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(2);
  }
}

function reportCategoryRules(issues: ForbiddenIssue[]): void {
  const seen = new Set<string>();
  for (const issue of issues) {
    if (seen.has(issue.category)) continue;
    seen.add(issue.category);
    process.stderr.write(`    Regra: ${CATEGORY_RULES[issue.category]}\n`);
  }
}

function main(): number {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  const prompt = loadPrompt(flags);

  if (prompt === null) {
    process.stderr.write(
      "Uso: lint-image-prompt.ts <prompt-file.md> | --text <prompt>\n",
    );
    process.stderr.write("Exit codes: 0 ok | 1 violações | 2 erro de uso\n");
    return 2;
  }

  const issues = findForbiddenPhrases(prompt);
  if (issues.length === 0) {
    // Limpo — orchestrator pode prosseguir pra image-generate
    process.stdout.write(JSON.stringify({ ok: true, issues: [] }, null, 2) + "\n");
    return 0;
  }

  // Stderr: human-readable formatado
  process.stderr.write(formatIssues(prompt, issues) + "\n");
  reportCategoryRules(issues);

  // Stdout: JSON estruturado pra orchestrator parsear
  process.stdout.write(
    JSON.stringify({ ok: false, issues }, null, 2) + "\n",
  );
  return 1;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  process.exit(main());
}

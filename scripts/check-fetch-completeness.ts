#!/usr/bin/env tsx
/**
 * scripts/check-fetch-completeness.ts (#2317)
 *
 * CLI wrapper para classifyFetchCompleteness.
 *
 * Uso:
 *   npx tsx scripts/check-fetch-completeness.ts --email-len <N> --html-path <abs-path>
 *
 * Saída (stdout):
 *   "complete"   — corpo do email é grande o suficiente para ser considerado completo
 *   "incomplete" — corpo do email é muito menor que o HTML local (provavelmente truncado)
 *
 * Exit codes:
 *   0 — classificação bem-sucedida (qualquer resultado — "complete" ou "incomplete")
 *   1 — erro de uso: argumento inválido, ausente ou arquivo HTML não encontrado
 *
 * CLI guard: a função main() só roda quando este arquivo é o entry point.
 * Importar este módulo em testes NÃO dispara main() (padrão do repo — CLAUDE.md #CLI-guard).
 *
 * @module
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyFetchCompleteness,
  DEFAULT_COMPLETENESS_THRESHOLD,
} from "./lib/email-fetch-completeness.ts";

export { classifyFetchCompleteness, DEFAULT_COMPLETENESS_THRESHOLD };

function parseArgs(argv: string[]): { emailLen: number; htmlPath: string } | null {
  let emailLen: number | undefined;
  let htmlPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--email-len" && i + 1 < argv.length) {
      const raw = argv[i + 1];
      const parsed = parseInt(raw, 10);
      if (isNaN(parsed)) {
        process.stderr.write(`Erro: --email-len requer um inteiro, obtido: '${raw}'\n`);
        return null;
      }
      emailLen = parsed;
      i++;
    } else if (argv[i] === "--html-path" && i + 1 < argv.length) {
      htmlPath = argv[i + 1];
      i++;
    }
  }

  if (emailLen === undefined) {
    process.stderr.write("Erro: --email-len é obrigatório\n");
    return null;
  }
  if (htmlPath === undefined) {
    process.stderr.write("Erro: --html-path é obrigatório\n");
    return null;
  }

  return { emailLen, htmlPath };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(
      `Uso: npx tsx scripts/check-fetch-completeness.ts --email-len <N> --html-path <caminho-absoluto>\n`,
    );
    process.exit(1);
  }

  const { emailLen, htmlPath } = args;
  const absPath = resolve(htmlPath);

  let finalHtmlLen: number;
  try {
    const stat = statSync(absPath);
    finalHtmlLen = stat.size;
  } catch (err) {
    process.stderr.write(
      `Erro: não foi possível ler o arquivo HTML '${absPath}': ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  if (finalHtmlLen <= 0) {
    // Arquivo presente mas vazio: sem referência válida.
    // Fail-safe conservador: assume complete (não bloqueia quando HTML local está vazio).
    process.stderr.write(
      `Aviso: arquivo HTML '${absPath}' está vazio (${finalHtmlLen} bytes) — sem referência válida, assumindo complete\n`,
    );
    process.stdout.write("complete\n");
    process.exit(0);
  }

  const result = classifyFetchCompleteness(emailLen, finalHtmlLen);
  process.stdout.write(`${result}\n`);
  process.exit(0);
}

// CLI guard: padrão do repo (scripts/lint-test-email.ts e outros).
// Garante que main() só roda quando este arquivo é invocado diretamente —
// importar em testes não dispara main().
const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}

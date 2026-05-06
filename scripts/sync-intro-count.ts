/**
 * sync-intro-count.ts (#743)
 *
 * Lê um MD de newsletter, calcula a contagem real de URLs editoriais e,
 * se o número declarado na intro ("Selecionamos os N mais relevantes")
 * divergir da contagem real, corrige cirurgicamente o número.
 *
 * Uso:
 *   npx tsx scripts/sync-intro-count.ts --md <md-path>
 *
 * Exit codes:
 *   0  OK (com ou sem correção)
 *   1  Erro de leitura / parse
 *
 * Output JSON em stdout: { changed, claimed_before, actual, path }
 * Warn em stderr se o número foi corrigido.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { lintIntroCount } from "./lint-newsletter-md.ts";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const ROOT = process.cwd();
  const args = parseArgs(process.argv.slice(2));
  if (!args.md) {
    console.error("Uso: sync-intro-count.ts --md <md-path>");
    process.exit(1);
  }
  const mdPath = resolve(ROOT, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(1);
  }

  const md = readFileSync(mdPath, "utf8");
  const check = lintIntroCount(md);

  // Se ok ou se não há número declarado (claimed undefined), não há nada a fazer
  if (check.ok || check.claimed === undefined || check.actual === undefined) {
    console.log(
      JSON.stringify({ changed: false, claimed_before: check.claimed, actual: check.actual, path: mdPath }),
    );
    return;
  }

  // Substituição cirúrgica: apenas o número na frase da intro
  const claimedStr = String(check.claimed);
  const actualStr = String(check.actual);

  // Pattern: "Selecionamos os N mais relevantes" — substitui só a 1ª ocorrência
  const patternRe = new RegExp(
    `(Selecionamos os )${claimedStr}( mais relevantes)`,
    "i",
  );
  if (!patternRe.test(md)) {
    // Fallback: substituição mais genérica (não deve ocorrer dado que lintIntroCount encontrou)
    console.error(
      `warn: não consegui localizar o padrão exato para substituição — arquivo não modificado.`,
    );
    console.log(
      JSON.stringify({ changed: false, claimed_before: check.claimed, actual: check.actual, path: mdPath }),
    );
    return;
  }

  const fixed = md.replace(patternRe, `$1${actualStr}$2`);
  writeFileSync(mdPath, fixed, "utf8");

  console.error(
    `warn: sync-intro-count: intro dizia ${check.claimed} mas contagem real é ${check.actual} — corrigido em ${mdPath}`,
  );
  console.log(
    JSON.stringify({
      changed: true,
      claimed_before: check.claimed,
      actual: check.actual,
      path: mdPath,
    }),
  );
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}

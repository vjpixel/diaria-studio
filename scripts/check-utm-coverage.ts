/**
 * check-utm-coverage.ts (#5514)
 *
 * Wrapper de CLI de `scripts/lib/shared/utm-link-check.ts` — roda ANTES de
 * publicar copy de campanha (post social ad-hoc, mensagem de divulgação em
 * grupo, etc.) para pegar link `diar.ia.br` sem `utm_source`/`utm_campaign`
 * antes de sair pro ar, não depois (ver #5514: 45% da coorte de lançamento
 * entrou sem atribuição nenhuma por causa exatamente disso).
 *
 * Advisory por padrão — imprime os achados e sai 0; `--strict` sai 1 se
 * achar algo, para uso em ponto de gate (ex: um playbook que queira travar
 * publicação nisso).
 *
 * ## Uso
 *
 *   npx tsx scripts/check-utm-coverage.ts --text "confira https://diar.ia.br/?utm_source=x"
 *   npx tsx scripts/check-utm-coverage.ts --file caminho/para/copy.md
 *   npx tsx scripts/check-utm-coverage.ts --file copy.md --strict
 *
 * Exatamente uma de `--text`/`--file` é obrigatória.
 */

import { readFileSync } from "node:fs";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { checkUtmCoverage } from "./lib/shared/utm-link-check.ts";

export function main(argv: string[] = process.argv.slice(2)): void {
  const { flags, values } = parseArgs(argv);
  const text = values["text"] ?? (values["file"] ? readFileSync(values["file"], "utf-8") : null);

  if (text === null) {
    console.error("[check-utm-coverage] uso: --text \"...\" ou --file <path> (exatamente um)");
    process.exitCode = 2;
    return;
  }

  const issues = checkUtmCoverage(text);
  if (issues.length === 0) {
    console.error("[check-utm-coverage] OK — todo link diar.ia.br tem utm_source + utm_campaign");
    return;
  }

  console.error(`[check-utm-coverage] ${issues.length} link(s) diar.ia.br sem UTM completo:`);
  for (const issue of issues) {
    console.error(`  - ${issue.url}\n    faltando: ${issue.missing.join(", ")}`);
  }
  console.error(
    "  → use um perfil de scripts/lib/shared/utm-registry.ts em vez de montar a URL à mão (#5514)",
  );

  if (flags.has("strict")) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}

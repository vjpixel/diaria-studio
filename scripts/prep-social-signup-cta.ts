#!/usr/bin/env npx tsx
/** #12038: gera JSON no stdout, sem escrita, publicação ou agendamento.
 * npx tsx scripts/prep-social-signup-cta.ts --edition 261104 --start 2026-11-04
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { editionDir } from "./lib/edition-paths.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { civilDate, prepareSocialSignup } from "./lib/social-signup-preparation.ts";

export function editionCivilDate(edition: string): string {
  if (!/^\d{6}$/.test(edition)) throw new Error("--edition deve ser AAMMDD explícito.");
  const date = `20${edition.slice(0, 2)}-${edition.slice(2, 4)}-${edition.slice(4, 6)}`;
  civilDate(date);
  return date;
}

if (isMainModule(import.meta.url)) {
  try {
    const { values } = parseArgs(process.argv.slice(2));
    if (!values.edition || !values.start) throw new Error("Informe --edition AAMMDD e --start AAAA-MM-DD (início real do teste).");
    const date = editionCivilDate(values.edition);
    const path = resolve(editionDir(values.edition), "03-social.md");
    const prepared = prepareSocialSignup(readFileSync(path, "utf8"), date, values.start);
    process.stdout.write(JSON.stringify(prepared, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`prep-social-signup-cta: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

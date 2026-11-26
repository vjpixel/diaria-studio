/**
 * lib/lint-checks/cli/title-length.ts
 *
 * CLI handlers dos checks de limite de título de lint-newsletter-md.ts.
 * Extraído de main() (#5895).
 *
 * #11254: o antigo teto fixo de 52 chars saiu. São dois checks distintos
 * (`title-limits.ts`): `--check title-card-4x5` (cabe no card 4x5 em 3
 * linhas a 62px) e `--check title-email-subject` (título do D1 ≤70, vira o
 * assunto do e-mail). `--check title-length` continua aceito e roda os dois,
 * para quem já o chama no Stage 2.
 */

import { readMdArg } from "./_shared.ts";
import {
  checkTitleCardFit,
  checkTitleEmailSubject,
  checkTitleLimits,
  formatTitleLimitError,
  type TitleLimitReport,
} from "../title-limits.ts";

function runWith(checkName: string, check: (md: string) => TitleLimitReport) {
  return (args: Record<string, string>, root: string): void => {
    const { md } = readMdArg(args, root, checkName);
    const result = check(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.errors.length} título(s) fora do limite (${checkName}):`);
      for (const e of result.errors) console.error(`  ${formatTitleLimitError(e)}`);
      process.exit(1);
    }
  };
}

// Modo --check title-length (#701; desde #11254 = card 4x5 + assunto do e-mail)
export const runCli = runWith("title-length", checkTitleLimits);
// Modo --check title-card-4x5 (#11254)
export const runCardCli = runWith("title-card-4x5", checkTitleCardFit);
// Modo --check title-email-subject (#11254)
export const runSubjectCli = runWith("title-email-subject", checkTitleEmailSubject);

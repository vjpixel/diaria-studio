/**
 * lib/lint-checks/cli/_shared.ts
 *
 * Prólogo comum dos handlers `--check` de lint-newsletter-md.ts (#14063):
 * exige `--md`, resolve o caminho contra `root`, confere que o arquivo
 * existe e (em `readMdArg`) lê o conteúdo. Os dois erros de uso saem com
 * exit 2 e as mesmas mensagens que cada handler imprimia antes da fatoração:
 *
 *   Uso: lint-newsletter-md.ts --check {check} --md <md-path>
 *   Arquivo não existe: {caminho absoluto}
 *
 * Handlers com prólogo diferente (outra mensagem de uso, `--approved`,
 * `--snippet`, ou sem `existsSync` porque o check trata a ausência) ficam
 * fora daqui de propósito. Caracterização: test/lint-checks-cli-md-prologue-14063.test.ts.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Valida `--md` e a existência do arquivo; devolve o caminho absoluto. */
export function resolveMdArg(args: Record<string, string>, root: string, check: string): string {
  if (!args.md) {
    console.error(`Uso: lint-newsletter-md.ts --check ${check} --md <md-path>`);
    process.exit(2);
  }
  const mdPath = resolve(root, args.md);
  if (!existsSync(mdPath)) {
    console.error(`Arquivo não existe: ${mdPath}`);
    process.exit(2);
  }
  return mdPath;
}

/** `resolveMdArg` + leitura do arquivo em UTF-8. */
export function readMdArg(
  args: Record<string, string>,
  root: string,
  check: string,
): { mdPath: string; md: string } {
  const mdPath = resolveMdArg(args, root, check);
  return { mdPath, md: readFileSync(mdPath, "utf8") };
}

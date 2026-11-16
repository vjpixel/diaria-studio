#!/usr/bin/env npx tsx
/**
 * check-git-identity.ts (#13259)
 *
 * Confere que a identidade git efetiva do checkout (`user.name`/`user.email`)
 * não é vazia nem placeholder de teste (`Test <test@test.com>` assinou os
 * commits da rodada 261115f). Lógica em `scripts/lib/git-identity-guard.ts`.
 *
 * Uso: npx tsx scripts/check-git-identity.ts [--cwd DIR]
 * Exit 0 = identidade ok (imprime `nome <email>`); exit 1 = placeholder/vazia
 * (imprime o problema e a correção em stderr). Somente leitura: nunca grava
 * `git config`.
 */
import { evaluateGitIdentity, formatGitIdentityProblem, readGitIdentity } from "./lib/git-identity-guard.ts";
import { getArg, isMainModule } from "./lib/cli-args.ts";

export function main(argv: string[] = process.argv.slice(2)): number {
  const cwd = getArg(argv, "cwd") || process.cwd();
  const { name, email } = readGitIdentity(cwd);
  const verdict = evaluateGitIdentity(name, email);
  if (verdict.ok) {
    console.log(`git-identity: ok — ${verdict.name} <${verdict.email}>`);
    return 0;
  }
  console.error(`git-identity: ${formatGitIdentityProblem(verdict)}`);
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}

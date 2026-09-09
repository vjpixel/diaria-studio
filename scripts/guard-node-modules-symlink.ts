/**
 * guard-node-modules-symlink.ts (#7763)
 *
 * CLI do guard: roda como `preinstall` do `package.json`, ou seja, o npm o
 * executa ANTES de cada `npm ci` / `npm install` na raiz do repo. É o que
 * transforma `scripts/lib/worktree-node-modules-guard.ts` de biblioteca
 * testável em recusa mecânica de verdade — sem isto, o `npm ci` que as
 * skills (`diaria-overnight`, `diaria-develop`, `diaria-continuo`) mandam o
 * agente rodar num worktree é um comando bash literal que nunca passa perto
 * da função, e o #7763 se repete.
 *
 * Roda com `node` puro (type-stripping nativo, Node ≥22.18 — o mesmo piso já
 * exigido pelo projeto): no `preinstall` as dependências ainda não existem,
 * então `tsx` não pode ser assumido.
 *
 * Saída: 0 quando pode instalar; 1 com a mensagem do guard quando o
 * `node_modules` do diretório é symlink pra fora do worktree (ou quando a
 * inspeção é inconclusiva — EACCES e afins).
 */
import { guardBeforeNpmInstall } from "./lib/worktree-node-modules-guard.ts";
import { isMainModule } from "./lib/cli-args.ts";

export function main(cwd?: string): void {
  try {
    guardBeforeNpmInstall(cwd);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

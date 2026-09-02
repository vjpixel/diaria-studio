/**
 * resolve-wrangler-bin.ts (#7117)
 *
 * `scripts/purge-leaderboard.ts` precisa do caminho absoluto do binário do
 * `wrangler` pra invocar via `execFileSync(process.execPath, [bin, ...])`
 * (sem npx/shell, #2265). Antes do #7117 (workers/ virou npm workspace), o
 * caminho era hardcoded como `workers/poll/node_modules/wrangler/bin/
 * wrangler.js` — funcionava porque `workers/poll` tinha seu PRÓPRIO
 * `node_modules` (12 lockfiles independentes). Com `workspaces:
 * ["workers/*"]` na raiz, `npm install` hoista `wrangler` pro `node_modules`
 * da RAIZ (resolução única, sem conflito de versão entre os 12 workers) —
 * `workers/poll/node_modules` deixa de existir, e o caminho hardcoded quebra
 * em silêncio (`ENOENT` só na hora de rodar, não no import).
 *
 * `require.resolve("wrangler/bin/wrangler.js")` não serve: o `package.json`
 * do wrangler declara `exports`, que bloqueia esse subpath (`ERR_PACKAGE_PATH_NOT_EXPORTED`)
 * — só `wrangler/package.json` é exposto. A resolução correta é resolver o
 * `package.json` (sempre exportado) e derivar o binário a partir do campo
 * `bin.wrangler` dele, igual o próprio `npm`/`npx` fazem internamente.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

export interface WranglerPackageJson {
  bin?: Record<string, string> | string;
}

/**
 * Resolve o caminho absoluto do bin `wrangler` a partir de `fromModuleUrl`
 * (tipicamente `import.meta.url` do módulo chamador) — funciona tanto com
 * `wrangler` hoistado na raiz (comum, pós-#7117) quanto, se algum dia
 * reaparecer, com uma cópia própria dentro de um workspace member (a
 * resolução Node caminha do módulo chamador pra cima até achar
 * `node_modules/wrangler`).
 */
export function resolveWranglerBin(fromModuleUrl: string): string {
  const req = createRequire(fromModuleUrl);
  const pkgPath = req.resolve("wrangler/package.json");
  const pkg = req(pkgPath) as WranglerPackageJson;
  const bin = pkg.bin;
  const binRel = typeof bin === "string" ? bin : bin?.wrangler;
  if (!binRel) {
    throw new Error(`wrangler/package.json não declara um bin "wrangler" resolvível (lido de ${pkgPath})`);
  }
  return resolve(dirname(pkgPath), binRel);
}

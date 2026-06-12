/**
 * generate-worker-tokens.ts (#2107, updated #2132)
 *
 * Gera `workers/{worker}/src/ds-tokens.generated.ts` a partir dos
 * tokens canônicos de `scripts/lib/design-tokens.ts`.
 *
 * Elimina o espelho manual: nenhum Worker precisa ter cópias inline dos
 * valores do DS. Este script é a única fonte de verdade para os tokens no bundle
 * dos Workers.
 *
 * Executado:
 *   - Automaticamente via `[build]` no wrangler.toml de cada worker (garante
 *     que deploy nunca sai com tokens stale — wrangler roda o build step antes
 *     de compilar o Worker). Passar `--out-dir workers/{worker}/src` para um
 *     destino específico.
 *   - Via `npm run pretest` (raiz) — garante que o arquivo existe antes dos
 *     testes rodarem (gera para todos os workers).
 *   - Manualmente: `npx tsx scripts/generate-worker-tokens.ts`
 *
 * O arquivo gerado tem header "GERADO — não editar" para deixar claro que
 * mudanças devem ser feitas em `scripts/lib/design-tokens.ts`, não aqui.
 *
 * Flag opcional: --out-dir <dir>
 *   Gera apenas no diretório especificado (relativo ao repo root).
 *   Sem a flag: gera em TODOS os workers listados em OUT_DIRS (comportamento padrão).
 */

import { COLORS, FONTS } from "./lib/design-tokens.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Workers que recebem ds-tokens.generated.ts
const DEFAULT_OUT_DIRS = [
  "workers/brevo-dashboard/src",
  "workers/diaria-dashboard/src",
];

// Suporte a --out-dir para o wrangler.toml de cada worker
const outDirFlag = (() => {
  const idx = process.argv.indexOf("--out-dir");
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

const outDirs = outDirFlag ? [outDirFlag] : DEFAULT_OUT_DIRS;

const content = `/**
 * ds-tokens.generated.ts — GERADO AUTOMATICAMENTE. NÃO EDITAR.
 *
 * Gerado por scripts/generate-worker-tokens.ts (#2107) a partir de
 * scripts/lib/design-tokens.ts (fonte canônica do DS Diar.ia).
 *
 * Para atualizar tokens: editar scripts/lib/design-tokens.ts e rodar:
 *   npx tsx scripts/generate-worker-tokens.ts
 * (ou simplesmente: npm test / wrangler deploy — ambos disparam o build step)
 */

/**
 * Tokens de cor do DS (espelho de COLORS em design-tokens.ts).
 *
 * Exclusão intencional: paperEmail, ruleStrong e onInk existem em COLORS mas
 * NÃO são gerados — o dashboard não os usa. Se o dashboard passar a usar um
 * deles, adicione-o no template de scripts/generate-worker-tokens.ts e
 * regenere (senão fica undefined em runtime sem
 * erro de tipo).
 */
export const DS_COLORS = {
  brand:    ${JSON.stringify(COLORS.brand)},
  ink:      ${JSON.stringify(COLORS.ink)},
  paper:    ${JSON.stringify(COLORS.paper)},
  paperAlt: ${JSON.stringify(COLORS.paperAlt)},
  rule:     ${JSON.stringify(COLORS.rule)},
} as const;

/** Tokens de fonte do DS (espelho de FONTS em design-tokens.ts). */
export const DS_FONTS = {
  sans: ${JSON.stringify(FONTS.sans)},
} as const;
`;

for (const outDir of outDirs) {
  const outPath = resolve(repoRoot, outDir, "ds-tokens.generated.ts");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, content, "utf8");
  console.log(`[generate-worker-tokens] Gerado: ${outPath}`);
}

/**
 * generate-worker-tokens.ts (#2107)
 *
 * Gera `workers/brevo-dashboard/src/ds-tokens.generated.ts` a partir dos
 * tokens canônicos de `scripts/lib/design-tokens.ts`.
 *
 * Elimina o espelho manual: o Worker nunca mais precisa ter cópias inline dos
 * valores do DS. Este script é a única fonte de verdade para os tokens no bundle
 * do Worker.
 *
 * Executado:
 *   - Automaticamente via `[build]` no wrangler.toml (garante que deploy nunca
 *     sai com tokens stale — wrangler roda o build step antes de compilar o
 *     Worker).
 *   - Via `npm run pretest` (raiz) — garante que o arquivo existe antes dos
 *     testes rodarem.
 *   - Manualmente: `npx tsx scripts/generate-worker-tokens.ts`
 *
 * O arquivo gerado tem header "GERADO — não editar" para deixar claro que
 * mudanças devem ser feitas em `scripts/lib/design-tokens.ts`, não aqui.
 */

import { COLORS, FONTS } from "./lib/design-tokens.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "../workers/brevo-dashboard/src/ds-tokens.generated.ts");

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

/** Tokens de cor do DS (espelho de COLORS em design-tokens.ts). */
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

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, content, "utf8");
console.log(`[generate-worker-tokens] Gerado: ${outPath}`);

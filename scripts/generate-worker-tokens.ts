/**
 * generate-worker-tokens.ts (#2107, updated #2132, #2125)
 *
 * Gera `workers/{worker}/src/ds-tokens.generated.ts` a partir dos
 * tokens canônicos de `scripts/lib/shared/design-tokens.ts`.
 *
 * Elimina o espelho manual: nenhum Worker precisa ter cópias inline dos
 * valores do DS. Este script é a única fonte de verdade para os tokens no bundle
 * dos Workers.
 *
 * Por que o arquivo gerado é commitado? (#2125)
 * O `npm run pretest` regenera sempre antes dos testes, mas o arquivo precisa
 * estar no repo para que `wrangler deploy` funcione sem depender de Node.js em
 * tempo de build no ambiente do Cloudflare (que não tem tsx disponível no step
 * de bundle). Commitado = CI lê direto sem regenerar; wrangler deploy usa o
 * arquivo já presente. O teste `brevo-dashboard-ds-drift.test.ts` garante que o
 * arquivo commitado não drifta de `design-tokens.ts` nem do template aqui.
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
 * mudanças devem ser feitas em `scripts/lib/shared/design-tokens.ts`, não aqui.
 *
 * Flag opcional: --out-dir <dir>
 *   Gera apenas no diretório especificado (relativo ao repo root).
 *   Sem a flag: gera em TODOS os workers listados em OUT_DIRS (comportamento padrão).
 */

import { COLORS, FONTS } from "./lib/shared/design-tokens.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * Gera o conteúdo do arquivo ds-tokens.generated.ts a partir dos tokens canônicos.
 * Exportado para uso no check de sync (test/brevo-dashboard-ds-drift.test.ts #2125).
 */
export function generateTokensContent(colors: typeof COLORS, fonts: typeof FONTS): string {
  return `/**
 * ds-tokens.generated.ts — GERADO AUTOMATICAMENTE. NÃO EDITAR.
 *
 * Gerado por scripts/generate-worker-tokens.ts (#2107) a partir de
 * scripts/lib/shared/design-tokens.ts (fonte canônica do DS Diar.ia).
 *
 * Para atualizar tokens: editar scripts/lib/shared/design-tokens.ts e rodar:
 *   npx tsx scripts/generate-worker-tokens.ts
 * (ou simplesmente: npm test / wrangler deploy — ambos disparam o build step)
 *
 * Este arquivo é commitado intencionalmente — ver generate-worker-tokens.ts para
 * a justificativa. O check de sync em brevo-dashboard-ds-drift.test.ts garante
 * que o arquivo commitado não drifta da fonte (#2125).
 */

/**
 * Tokens de cor do DS (espelho de COLORS em design-tokens.ts).
 *
 * Exclusão intencional: ruleStrong e onInk existem em COLORS mas NÃO são
 * gerados — nenhum worker os usa. Se algum worker passar a usar um deles,
 * adicione-o no template de scripts/generate-worker-tokens.ts e regenere
 * (senão fica undefined em runtime sem erro de tipo).
 *
 * paperEmail (#2991): incluído a partir da Clarice News Dashboard, que usa
 * branco puro como fundo de "card" sobre o --paper cream (mesmo par usado
 * nos e-mails, ver COLORS.paperEmail em design-tokens.ts).
 */
export const DS_COLORS = {
  brand:      ${JSON.stringify(colors.brand)},
  ink:        ${JSON.stringify(colors.ink)},
  paper:      ${JSON.stringify(colors.paper)},
  paperAlt:   ${JSON.stringify(colors.paperAlt)},
  rule:       ${JSON.stringify(colors.rule)},
  paperEmail: ${JSON.stringify(colors.paperEmail)},
} as const;

/** Tokens de fonte do DS (espelho de FONTS em design-tokens.ts). */
export const DS_FONTS = {
  sans: ${JSON.stringify(fonts.sans)},
} as const;
`;
}

// Guard de main-module: só escreve arquivos quando executado como script (não no import).
// Sem este guard, qualquer `import { generateTokensContent }` do módulo sobrescreveria
// os arquivos gerados em disco — tornando o teste de drift auto-realizável (sempre passa).
// process.argv[1] pode ser undefined quando executado via `node --input-type=module` ou eval —
// nesse caso o módulo está definitivamente sendo importado, não executado como script.
if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const content = generateTokensContent(COLORS, FONTS);

  for (const outDir of outDirs) {
    const outPath = resolve(repoRoot, outDir, "ds-tokens.generated.ts");
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content, "utf8");
    console.log(`[generate-worker-tokens] Gerado: ${outPath}`);
  }
}

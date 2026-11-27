/**
 * gen-social-card-4x5.ts
 *
 * CLI de `scripts/lib/social-card-4x5.ts` (#14001): a composição do card
 * 1080x1350 (overlay do título, kicker, data, `generateCard`) mora na lib,
 * com a documentação do módulo. Este arquivo só lê os argumentos, valida os
 * títulos da edição e chama a lib, e reexporta tudo dela para os
 * importadores de sempre.
 *
 * Uso:
 *   npx tsx scripts/gen-social-card-4x5.ts --edition-dir data/editions/2607/260727/
 *   npx tsx scripts/gen-social-card-4x5.ts --edition-dir ... --destaque d2
 *
 * Saída: `04-d{N}-4x5.jpg` na raiz da edição (junto dos demais assets de
 * imagem). Imprime JSON com os paths gerados.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { assertBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";
import { parseDestaques } from "./lib/destaques-parse.ts";
import { DAILY_CAROUSEL_BODY_SIZE } from "./lib/daily-carousel-body-size.ts";
import { computeCarouselTitleFontSize, dailyCardTitleFits, generateCard } from "./lib/social-card-4x5.ts";

export * from "./lib/social-card-4x5.ts";

async function main(): Promise<void> {
  // #4090: aborta se Georgia não resolve nesta máquina — sem isso o card sai
  // com fallback de fonte, fora da marca, EM SILÊNCIO.
  await assertBrandSerifAvailable("gen-social-card-4x5");
  const args = parseCliArgs(process.argv.slice(2));
  const editionDir = args.values["edition-dir"] ?? "";
  if (!editionDir) {
    console.error("uso: gen-social-card-4x5.ts --edition-dir <dir> [--destaque d1]");
    process.exit(1);
  }
  const only = args.values.destaque ?? null;
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) {
    console.error(`02-reviewed.md ausente em ${editionDir}`);
    process.exit(1);
  }
  const destaques = parseDestaques(readFileSync(mdPath, "utf8"));
  // #5852: tamanho de fonte COMPARTILHADO entre todos os cards da edição —
  // o menor overlayFittingFontSize do conjunto (o mais restritivo governa).
  // Computado sobre TODOS os títulos do arquivo (não só o filtrado por
  // --destaque), pra regeneração parcial manter consistência com os já
  // gerados. O mecanismo já existia pro carrossel semanal (#5330); aqui
  // nunca foi ligado.
  const sharedFontSize = computeCarouselTitleFontSize(
    destaques.map((d) => d.title ?? ""),
  );
  const generated: string[] = [];
  const generatedKeys: string[] = [];
  for (let i = 0; i < destaques.length; i++) {
    const key = `d${i + 1}`;
    if (only && only !== key) continue;
    const d = destaques[i] as { title?: string; category?: string };
    if (!dailyCardTitleFits(d.title ?? "")) {
      console.error(`[gen-social-card-4x5] ${key}: título não cabe a ${DAILY_CAROUSEL_BODY_SIZE}px em 1-3 linhas — reescreva: "${d.title}" (#8589)`);
      process.exit(1);
    }
    const out = await generateCard(
      editionDir, key, d.title ?? "", d.category ?? "", "4x5",
      { fontSizeOverride: sharedFontSize },
    );
    if (out) {
      generated.push(out);
      generatedKeys.push(key);
    } else console.error(`[gen-social-card-4x5] pulado ${key}: 04-${key}-2x1.jpg ausente`);
  }
  // #12109: card recomposto (troca de título no gate) deixa a revisão de crop
  // do 4:5 para trás. Import tardio: quem importa este módulo pelas funções
  // de overlay (carrossel semanal, cards sob demanda) não carrega o revisor.
  const { buildCardCropReviewRerun } = await import("./run-image-crop-reviewer.ts");
  const cropReviewRerun = buildCardCropReviewRerun(resolve(editionDir), editionDir, generatedKeys);
  if (cropReviewRerun) {
    console.error(
      `[gen-social-card-4x5] revisão de crop desatualizada para ${cropReviewRerun.targets.join(", ")} — ` +
        (cropReviewRerun.full_review_required
          ? `veredito persistido ilegível: re-rodar o image-crop-reviewer COMPLETO (todos os pares): `
          : `re-rodar o image-crop-reviewer só nesses alvos: `) +
        `${cropReviewRerun.discover_command} (#12109)`,
    );
  }
  console.log(
    JSON.stringify(
      { generated, count: generated.length, ...(cropReviewRerun ? { crop_review_rerun: cropReviewRerun } : {}) },
      null,
      2,
    ),
  );
}

if (isMainModule(import.meta.url)) {
  // Sem top-level await (#12109): o import tardio do revisor em main() fecha um
  // ciclo de volta a este módulo (invariant-checks → carrossel → overlay), e
  // com `await main()` no topo o módulo nunca termina de avaliar — o node sai
  // com 13 ("unsettled top-level await").
  main().catch((e) => {
    console.error("[gen-social-card-4x5] ERRO:", e);
    process.exit(1);
  });
}

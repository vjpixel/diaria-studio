/** #13927: troca explícita do 4º post no gate. Textos continuam sob revisão editorial.
 * Uso: npx tsx scripts/swap-use-melhor-post.ts --edition-dir data/editions/AAMMDD --url <url>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { loadUseMelhorPostConfigState } from "./lib/use-melhor-post.ts";
import { runSelectionWithSteps } from "./select-use-melhor-post.ts";
import { useMelhorUmShapeInstruction } from "./lib/use-melhor-isca.ts";
import { refreshUseMelhorTempo } from "./lib/use-melhor-tempo-refresh.ts";
import { fetchBodyForCache } from "./stitch-newsletter.ts";
import { genUseMelhorCarousel } from "./gen-carousel-cards.ts";
import { renderUseMelhorSlides } from "./lib/use-melhor-carousel.ts";
import { assertBrandSerifAvailable } from "./lib/shared/assert-brand-font.ts";

export async function swapUseMelhorPost(editionDir: string, url: string) {
  const config = loadUseMelhorPostConfigState(resolve(import.meta.dirname, ".."), basename(resolve(editionDir)));
  if (!config.enabled) throw new Error("4º post desligado — nada gravado");
  const selected = await runSelectionWithSteps(editionDir, config, { useReviewed: true, pickUrl: url });
  // Persistir antes das etapas derivadas: falha no render não pode apagar a pendência editorial.
  writeFileSync(resolve(editionDir, "_internal/use-melhor-refresh-pending.json"), JSON.stringify({ url: selected.state.item!.url }));
  console.log(
    "Reescreva # Social ## um e # Curto ## um para a nova fonte; depois regenere carrossel e preview e rode refresh-use-melhor-post.ts --done. " +
      useMelhorUmShapeInstruction(selected.state.item, basename(resolve(editionDir))),
  );
  const tempo = await refreshUseMelhorTempo(editionDir, fetchBodyForCache, { write: true });
  await assertBrandSerifAvailable("swap-use-melhor-post");
  const carousel = await genUseMelhorCarousel(editionDir, readFileSync(resolve(editionDir, "03-social.md"), "utf8"), {
    force: true, render: renderUseMelhorSlides,
  });
  return { selected: selected.state, tempo, carousel };
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.values["edition-dir"], url = args.values.url;
  if (!dir || !url) {
    console.error("Uso: swap-use-melhor-post.ts --edition-dir <dir> --url <item do USE MELHOR>");
    process.exitCode = 2;
  } else {
    swapUseMelhorPost(dir, url).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
      console.error(`swap-use-melhor-post: ${error.message}`);
      process.exitCode = 1;
    });
  }
}

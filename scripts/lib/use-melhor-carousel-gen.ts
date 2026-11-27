/**
 * scripts/lib/use-melhor-carousel-gen.ts — geração do carrossel do 4º post
 *
 * Movida do CLI `scripts/gen-carousel-cards.ts` em #14001, sem mudança de
 * comportamento: `genUseMelhorCarousel` (#9568) e
 * `refreshStaleUseMelhorCarousel` (#10834), com os tipos de que dependem. O
 * upload (`lib/public-images-upload.ts`) regera o carrossel defasado por esta
 * função, e lib não importa CLI de topo. O CLI reexporta este módulo e segue
 * com os slides de D1/D2/D3 (`genCarouselCards`) e o `main()`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  USE_MELHOR_POST_ID,
  loadUseMelhorPostConfigState,
  readApprovedForUseMelhor,
  readUseMelhorPostState,
  resolveUseMelhorCoverTitle,
  type UseMelhorPostConfigState,
} from "./use-melhor-post.ts"; // #9568
import {
  buildUseMelhorSlides,
  findOverflowingUseMelhorSlides,
  hashUseMelhorSlides,
  isUseMelhorCarouselStale, // #10834
  readUseMelhorCarouselStamp,
  removeStaleUseMelhorSlides,
  renderUseMelhorSlides,
  useMelhorSlideFilename,
  writeUseMelhorCarouselStamp,
} from "./use-melhor-carousel.ts"; // #9568
import { pruneStaleUseMelhorPublicImages, type UseMelhorCarouselRefresh } from "./use-melhor-slide-files.ts"; // #9795, #14001
import { readUseMelhorBlock } from "./use-melhor-status.ts"; // #10834
import { assertBrandSerifAvailable } from "./shared/assert-brand-font.ts";
import { extractSection, extractDestaqueBlock } from "./extract-section.ts";
import { readInstagramTestOverride, type CarouselCtaOverride } from "./instagram-test-override.ts"; // #8681

export type { UseMelhorCarouselRefresh };

export interface UseMelhorCarouselOutcome {
  status: "generated" | "unchanged" | "skipped";
  slots?: string[];
  files?: string[];
  reason?: string;
  /** #9795: chaves `um_carousel_*` removidas de `06-public-images.json` (slides que não existem mais). */
  pruned_image_keys?: string[];
}

export type RenderUseMelhorSlidesFn = typeof renderUseMelhorSlides;

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * (#9568) Carrossel do 4º post. FAIL-SOFT de ponta a ponta: sem item
 * selecionado, sem `## um`, ou texto que não cabe → `skipped` com motivo
 * (o publisher cai pro post de imagem única / pula), nunca lança — o 4º post
 * não pode bloquear a edição. Falha do RENDER em si (sharp/fonte) continua
 * propagando, mesma severidade dos destaques: se a fonte de marca falta,
 * nenhum card sai certo.
 */
export async function genUseMelhorCarousel(
  editionDir: string,
  socialMd: string,
  opts: { force?: boolean; ctaOverride?: CarouselCtaOverride | null; render: RenderUseMelhorSlidesFn },
): Promise<UseMelhorCarouselOutcome> {
  const state = readUseMelhorPostState(editionDir);
  if (!state?.item) {
    return { status: "skipped", reason: state?.reason ?? "_internal/use-melhor-post.json ausente — Stage 2 não selecionou o item" };
  }
  const section = extractSection(socialMd, "Social");
  const umText = section ? extractDestaqueBlock(section, USE_MELHOR_POST_ID) : null;
  if (!umText || !umText.trim()) {
    return { status: "skipped", reason: `bloco '## ${USE_MELHOR_POST_ID}' não encontrado em '# Social' de 03-social.md` };
  }
  // #9600: capa com o título da EDIÇÃO (cover_title manual > título editado >
  // título do item em 02-reviewed.md > título da fonte), não o da fonte cru.
  const coverTitle = resolveUseMelhorCoverTitle(state.item, {
    reviewedMd: existsSync(resolve(editionDir, "02-reviewed.md"))
      ? readFileSync(resolve(editionDir, "02-reviewed.md"), "utf8")
      : null,
    approved: readApprovedForUseMelhor(editionDir),
  });
  const slides = buildUseMelhorSlides(umText.trim(), coverTitle, opts.ctaOverride);
  if (slides.length === 0) {
    return { status: "skipped", reason: `'## ${USE_MELHOR_POST_ID}' sem corpo` };
  }
  const overflow = findOverflowingUseMelhorSlides(umText.trim(), coverTitle, opts.ctaOverride);
  if (overflow.length > 0) {
    return {
      status: "skipped",
      reason:
        `slide(s) do 4º post não cabem no card: ` +
        overflow.map((o) => `${o.slot} (${o.chars} chars, ${o.excessPx}px além)`).join("; ") +
        ` — reescrever '## ${USE_MELHOR_POST_ID}' em 03-social.md`,
    };
  }
  const slots = slides.map((s) => s.slot);
  const files = slots.map((slot) => resolve(editionDir, useMelhorSlideFilename(slot)));
  const hash = hashUseMelhorSlides(slides);
  const stamp = readUseMelhorCarouselStamp(editionDir);
  const allExist = files.every((f) => existsSync(f));
  if (!opts.force && allExist && stamp?.hash === hash) {
    // #9630: carimbo anterior ao campo — mesmo hash implica mesmo título, então
    // só completa o `cover_title` sem re-renderizar.
    if (stamp.cover_title !== coverTitle) writeUseMelhorCarouselStamp(editionDir, { hash, slots, cover_title: coverTitle });
    removeStaleUseMelhorSlides(editionDir, slots);
    const prunedKeys = pruneStaleUseMelhorPublicImages(editionDir, slots); // #9795
    return { status: "unchanged", slots, files, ...(prunedKeys.length > 0 && { pruned_image_keys: prunedKeys }) };
  }
  await opts.render(editionDir, slides);
  // #9630: grava o título da capa — a conferência pós-gate compara contra ele.
  writeUseMelhorCarouselStamp(editionDir, { hash, slots, cover_title: coverTitle });
  // Self-review #9572 (findings 2/3): `## um` com menos parágrafos que o render
  // anterior deixaria `p{k}` antigos no disco — apaga a sobra.
  removeStaleUseMelhorSlides(editionDir, slots);
  // #9795: e as chaves desses slides antigos em `06-public-images.json` — sem
  // isso o upload/preview seguiam listando `um_carousel_p{k}` de slide apagado.
  const prunedKeys = pruneStaleUseMelhorPublicImages(editionDir, slots);
  return { status: "generated", slots, files, ...(prunedKeys.length > 0 && { pruned_image_keys: prunedKeys }) };
}

/**
 * (#10834) Regera SÓ o carrossel do 4º post quando o carimbo do Stage 3 está
 * defasado em relação ao `## um` atual — caso real 261022: o `## um` foi
 * editado depois do Stage 3, o carimbo ficou para trás e os publicadores
 * pularam o 4º post no LinkedIn, Facebook e Instagram (X saiu só com texto).
 * Chamado por `uploadPublicImages` (`lib/public-images-upload.ts`, modo
 * social/all) ANTES de decidir quais slides subir, então vale no pré-render do
 * Stage 4 e no Stage 5.
 *
 * Nunca lança: o 4º post é fail-soft e o upload de D1/D2/D3 não pode cair por
 * causa dele. Sem carimbo (carrossel nunca gerado) é `noop` de propósito: isso
 * é falta do Stage 3, já avisada no gate 4, não defasagem.
 */
export async function refreshStaleUseMelhorCarousel(
  editionDir: string,
  opts: {
    useMelhorConfig?: UseMelhorPostConfigState;
    render?: RenderUseMelhorSlidesFn;
    assertFont?: (scriptName: string) => Promise<void>;
  } = {},
): Promise<UseMelhorCarouselRefresh> {
  try {
    const stamp = readUseMelhorCarouselStamp(editionDir);
    if (!stamp) return { status: "noop", reason: "carrossel do 4º post sem carimbo" };
    const umConfig = opts.useMelhorConfig ?? loadUseMelhorPostConfigState(REPO_ROOT);
    if (!umConfig.enabled) return { status: "noop", reason: umConfig.reason ?? "4º post desligado" };
    const socialMdPath = resolve(editionDir, "03-social.md");
    if (!existsSync(socialMdPath)) return { status: "noop", reason: "03-social.md ausente" };
    const socialMd = readFileSync(socialMdPath, "utf8");
    const state = readUseMelhorPostState(editionDir);
    const socialUm = readUseMelhorBlock(socialMd, "Social");
    if (!state?.item || !socialUm) return { status: "noop", reason: "sem item ou sem '## um'" };
    const reviewedPath = resolve(editionDir, "02-reviewed.md");
    const coverTitle = resolveUseMelhorCoverTitle(state.item, {
      reviewedMd: existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : null,
      approved: readApprovedForUseMelhor(editionDir),
    });
    let ctaOverride: CarouselCtaOverride | null = null;
    try {
      ctaOverride = readInstagramTestOverride(editionDir)?.cta_slide ?? null;
    } catch {
      ctaOverride = null;
    }
    if (!isUseMelhorCarouselStale(stamp, socialUm, coverTitle, ctaOverride)) {
      return { status: "fresh", slots: stamp.slots };
    }
    // Mesmo guard do `main()` de gen-carousel-cards.ts — sem a fonte de marca a arte sairia fora da marca em silêncio.
    // #10879: a falha de fonte sai marcada (`cause`), pra o upload avisar com o conserto certo.
    try {
      await (opts.assertFont ?? assertBrandSerifAvailable)("gen-carousel-cards (4º post, #10834)");
    } catch (e) {
      return { status: "failed", cause: "font_missing", reason: (e as Error).message };
    }
    const outcome = await genUseMelhorCarousel(editionDir, socialMd, {
      ctaOverride,
      render: opts.render ?? renderUseMelhorSlides,
    });
    if (outcome.status === "skipped") return { status: "skipped", reason: outcome.reason };
    return { status: outcome.status === "generated" ? "regenerated" : "fresh", slots: outcome.slots };
  } catch (e) {
    return { status: "failed", reason: (e as Error).message };
  }
}

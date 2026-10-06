/**
 * use-melhor-status.ts (#9568)
 *
 * Helper de I/O que junta, do disco, tudo que `describeUseMelhorPostStatus`
 * precisa. Mora em `scripts/lib/` (e não no CLI `select-use-melhor-post.ts`)
 * porque tem dois consumidores além do CLI — `render-social-html.ts` e o
 * preview do Studio (`studio-review.ts`) — self-review #9572, finding 5.
 * Módulo separado de `use-melhor-post.ts` porque depende também do carimbo
 * do carrossel (`use-melhor-carousel.ts`, que já importa `use-melhor-post.ts`)
 * — juntar os dois criaria ciclo.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractSection, extractDestaqueBlock } from "./extract-section.ts";
import {
  USE_MELHOR_POST_ID,
  readApprovedForUseMelhor,
  readUseMelhorPostState,
  resolveUseMelhorCoverTitle,
  useMelhorUmMentionsBrand,
  type UseMelhorPostConfigState,
  type UseMelhorPostStatusInput,
} from "./use-melhor-post.ts";
import {
  describeUseMelhorCoverTitleDrift,
  isUseMelhorCarouselStale,
  readUseMelhorCarouselStamp,
  useMelhorCoverTitleDrift,
} from "./use-melhor-carousel.ts";
import { readInstagramTestOverride, type CarouselCtaOverride } from "./instagram-test-override.ts";

function readIfExists(p: string): string | null {
  return existsSync(p) ? readFileSync(p, "utf8") : null;
}

/** Bloco `## um` não-vazio da seção `# {title}` de `03-social.md`, ou `null`. */
export function readUseMelhorBlock(socialMd: string | null, title: "Social" | "Curto"): string | null {
  if (!socialMd) return null;
  const section = extractSection(socialMd, title);
  const block = section ? extractDestaqueBlock(section, USE_MELHOR_POST_ID) : null;
  return block && block.trim().length > 0 ? block : null;
}

/** Junta, do disco, tudo que `describeUseMelhorPostStatus` precisa. */
export function gatherUseMelhorStatusInput(
  editionDir: string,
  config: UseMelhorPostConfigState,
): UseMelhorPostStatusInput {
  const socialMd = readIfExists(resolve(editionDir, "03-social.md"));
  const state = config.enabled ? readUseMelhorPostState(editionDir) : null;
  const socialUm = readUseMelhorBlock(socialMd, "Social");
  const stamp = readUseMelhorCarouselStamp(editionDir);
  const reviewedMd = readIfExists(resolve(editionDir, "02-reviewed.md"));
  const approved = readApprovedForUseMelhor(editionDir);
  let carouselStale = false;
  let coverTitleDrift: string | null = null;
  if (config.enabled && stamp && state?.item && socialUm) {
    // Fail-soft: override de teste malformado não pode derrubar o status.
    let ctaOverride: CarouselCtaOverride | null = null;
    try {
      ctaOverride = readInstagramTestOverride(editionDir)?.cta_slide ?? null;
    } catch {
      ctaOverride = null;
    }
    const coverTitle = resolveUseMelhorCoverTitle(state.item, { reviewedMd, approved }); // #9600
    carouselStale = isUseMelhorCarouselStale(stamp, socialUm, coverTitle, ctaOverride);
    // #9635: capa em dia com o `## um`, mas com título diferente do item atual.
    const drift = carouselStale ? null : useMelhorCoverTitleDrift(stamp, coverTitle);
    if (drift) coverTitleDrift = describeUseMelhorCoverTitleDrift(drift, editionDir);
  }
  return {
    config,
    state,
    reviewedMd,
    approved,
    hasSocialSection: socialUm !== null,
    hasCurtoSection: readUseMelhorBlock(socialMd, "Curto") !== null,
    socialUmMentionsBrand: useMelhorUmMentionsBrand(socialUm), // #9756
    carouselSlots: stamp?.slots ?? null,
    carouselStale,
    coverTitleDrift,
  };
}

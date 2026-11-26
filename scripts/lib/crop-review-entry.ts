/**
 * scripts/lib/crop-review-entry.ts
 *
 * Helpers de uma entrada do veredito do revisor de crop
 * (`_internal/04-crop-review.json`): variante carimbada (#10325), entrada
 * desatualizada (#9598) e aviso silenciado (#12226). Extraídos de
 * `invariant-checks/stage-4.ts` no #13997 (que os reexporta) para que
 * `run-image-crop-reviewer.ts`, importado por `gen-social-card-4x5.ts`, não
 * carregue o stage-4 inteiro e, por ele, a edição diária (fronteira
 * mensal/diária do test/lib-boundary.test.ts, #13998).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { md5OfFile } from "./shared/file-md5.ts";

/**
 * #10325: arquivos alternativos contra os quais uma entrada pode ser carimbada
 * (`04-{destaque}-{variante}.jpg`). O achado de Noite Estrelada no 4:5 julga a
 * ARTE de fundo, não o card com título por cima — carimbar o card fazia a
 * entrada virar "desatualizada" só porque o título mudou e o card foi
 * recomposto, e o erro `image-starry-night-detected` sumia com a mesma arte.
 */
export const CROP_REVIEW_IMAGE_VARIANTS = ["4x5-nativo", "master", "2x1"] as const;
export type CropReviewImageVariant = (typeof CROP_REVIEW_IMAGE_VARIANTS)[number];

export function isCropReviewImageVariant(v: unknown): v is CropReviewImageVariant {
  return typeof v === "string" && (CROP_REVIEW_IMAGE_VARIANTS as readonly string[]).includes(v);
}

/** Sufixo do arquivo carimbado: a variante (#10325) quando houver, senão o ratio (#9598). */
export function cropReviewImageSuffix(entry: { ratio?: string; image_variant?: string }): string {
  return isCropReviewImageVariant(entry.image_variant) ? entry.image_variant : (entry.ratio ?? "");
}

export function isCropReviewEntryStale(
  editionDir: string,
  entry: { destaque?: string; ratio?: string; image_md5?: string; image_variant?: string },
): boolean {
  if (typeof entry.image_md5 !== "string" || !entry.destaque || !entry.ratio) return false;
  // #10333: a variante é escolhida uma vez, no persist (`cropReviewStampVariant`,
  // ordem nativo → master → 2x1). Se depois nasce uma variante anterior na
  // ordem (ex.: `image-generate --ratio 4x5 --force` cria o nativo sem apagar o
  // master), o card passa a usar a arte nova sem o arquivo carimbado mudar — a
  // entrada já não fala da arte atual e não pode valer (nem um falso positivo
  // marcado sobre o md5 antigo).
  if (isCropReviewImageVariant(entry.image_variant)) {
    const destaque = entry.destaque;
    const current = CROP_REVIEW_IMAGE_VARIANTS.find((v) =>
      existsSync(resolve(editionDir, `04-${destaque}-${v}.jpg`)),
    );
    if (current !== entry.image_variant) return true;
  }
  const imgPath = resolve(editionDir, `04-${entry.destaque}-${cropReviewImageSuffix(entry)}.jpg`);
  if (!existsSync(imgPath)) return true;
  try {
    return md5OfFile(imgPath) !== entry.image_md5;
  } catch {
    return false; // ilegível agora — não descarta o aviso por falha de I/O
  }
}

/**
 * #12226: achado de CROP (categoria `crop`, default) sobre o ratio `1x1`
 * (veredito legado) ou `2x1` não chega ao gate. O 1:1 não vai ao leitor (e
 * deixou de ser gerado); o par `2x1` é a arte original da newsletter, sem
 * corte a julgar. O 4:5 continua avisando, e o achado de ESTILO (Noite
 * Estrelada, #8989) vale em qualquer ratio — o par `2x1` existe justamente pra
 * ele olhar a imagem da newsletter.
 */
export function isSilencedCropWarn(entry: { ratio?: string; categoria?: string }): boolean {
  return (entry.ratio === "1x1" || entry.ratio === "2x1") && (entry.categoria ?? "crop") === "crop";
}

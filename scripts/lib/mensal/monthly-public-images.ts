/**
 * scripts/lib/mensal/monthly-public-images.ts (#14049)
 *
 * Leitura do manifest de imagens públicas de um ciclo mensal
 * (`_internal/public-images.json`, escrito por `monthly-preview-cloudflare.ts`,
 * #3392) e checagem das chaves esperadas. Canal-agnóstico: veio de
 * `scripts/render-monthly-beehiiv.ts` (#7121) para
 * `scripts/render-monthly-apoiadores-brevo.ts`, e saiu de lá quando o canal
 * Brevo dos apoiadores foi apagado (#14049). Consumidor hoje:
 * `scripts/render-monthly-apoiadores-kit.ts`.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
/** Imagem pública de um ciclo mensal (antes definida em `monthly-preview-cloudflare.ts`, que reexporta daqui). */
export interface MonthlyPublicImage {
  url: string;
  filename: string;
  mime_type: string;
}

interface PublicImagesManifest {
  images?: Record<string, MonthlyPublicImage>;
}

/**
 * Lê `_internal/public-images.json` — fonte das URLs de imagem JÁ publicadas
 * pro Cloudflare KV pra este ciclo. Aborta com instrução clara se ausente:
 * sem ele não há URL pública pra imagem nenhuma (o render não faz upload).
 */
export function readPublicImages(monthlyDir: string): Record<string, MonthlyPublicImage> {
  const path = resolve(monthlyDir, "_internal", "public-images.json");
  if (!existsSync(path)) {
    console.error(
      `[monthly-public-images] ERRO: ${path} não encontrado.\n` +
        "Rode a Etapa 3/4 do /diaria-mensal (monthly-preview-cloudflare.ts) neste ciclo antes " +
        "de renderizar a variante apoiadores — o render reusa as imagens já publicadas, não faz upload novo.",
    );
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(path, "utf8")) as PublicImagesManifest;
  return manifest.images ?? {};
}

/**
 * #4510 (achado silent-failure-hunter, review pré-merge): chaves de imagem
 * esperadas no manifest — 3 destaques + par A/B do É IA? + capa da
 * curadoria de livros.
 */
export const EXPECTED_IMAGE_KEYS = ["d1", "d2", "d3", "eia_a", "eia_b", "livros_promo"] as const;

/**
 * Enumera quais chaves esperadas estão ausentes (sem `url`) no manifest.
 * Pure. Fail-soft (o render não aborta: a Etapa 3/4 pode legitimamente ainda
 * não ter gerado alguma imagem) — o call site só emite warning explícito.
 */
export function missingImageKeys(images: Record<string, MonthlyPublicImage>): string[] {
  return EXPECTED_IMAGE_KEYS.filter((k) => !images[k]?.url);
}

/**
 * scripts/lib/social-image-url.ts (#1635)
 *
 * Resolve a URL de imagem pro preview social SEM fabricar uma key Cloudflare.
 *
 * Bug original (260601): quando faltava `cloudflare_url` e a `url` era Drive
 * (mode=social sobe d2/d3 só pro Drive), `render-social-html` montava
 * `img-{edition}-04-dN-1x1.jpg` SEM o sufixo md5 — uma key que nunca foi
 * escrita no KV (uploads usam md5 suffix desde #1584) → 404 silencioso em
 * d2/d3. A correção: usar `cloudflare_url` quando existe; senão a `url` real
 * (o Drive `uc?id=...&export=view` serve a imagem inline no preview), nunca
 * chutar uma key Cloudflare.
 */

export interface SocialImageEntry {
  url: string;
  filename?: string;
  md5?: string;
  cloudflare_url?: string;
}

/**
 * Resolve a `src` da imagem de um destaque no preview social.
 *
 * - `cloudflare_url` presente → usa (inclui md5 suffix, cache-stable).
 * - senão `url` (Drive `uc?export=view` serve inline) → usa direto + `warn`
 *   quando é Drive sem CF (nudge pra rodar upload pra Cloudflare).
 * - sem entry / sem url → `""`.
 *
 * Nunca constrói uma key Cloudflare por adivinhação (era a causa do 404 #1635).
 */
export function resolveSocialImageUrl(
  entry: SocialImageEntry | undefined,
  warn: (msg: string) => void = () => {},
): string {
  if (!entry) return "";
  if (entry.cloudflare_url) return entry.cloudflare_url;
  if (entry.url) {
    if (entry.url.includes("drive.google.com")) {
      warn(
        "[render-social-html] cloudflare_url ausente — usando Drive url direto. " +
          "Rode upload-images-public (--mode newsletter/social) pra gravar " +
          "cloudflare_url com md5 suffix e evitar dependência do Drive (#1635).",
      );
    }
    return entry.url;
  }
  return "";
}

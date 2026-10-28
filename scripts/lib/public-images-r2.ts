/**
 * public-images-r2.ts (#11412, fatia 1)
 *
 * Imagens públicas da edição no R2 em vez do KV `POLL`. O KV divide o
 * namespace com o estado do jogo É IA?, tem teto de 25 MB por valor, não tem
 * poda e o Worker lê cada objeto inteiro na memória. O bucket R2 de mídia
 * (`diaria-shorts`, público em `https://media.diar.ia.br`, #10772) já existe.
 *
 * O que esta fatia faz, atrás da flag `platform.config.json →
 * public_images_r2.enabled` (default `false`, comportamento de antes):
 *   - `scripts/upload-images-public.ts` sobe as imagens content-addressed
 *     (`img-{AAMMDD}-{base}-{md5short}.{ext}`) para o R2 em
 *     `img/{AAMMDD}/{base}-{md5short}.{ext}` (`r2KeyForImageKey`), com
 *     `Cache-Control: immutable` no objeto;
 *   - a URL gravada em `06-public-images.json` continua no formato de sempre,
 *     `{poll.worker_url}/img/img-{AAMMDD}-…`: e-mail, página do acervo, home
 *     (reescrita same-origin do #7657) e lints que leem a forma da URL não
 *     mudam nada;
 *   - `/img/{key}` (`scripts/lib/shared/kv-image.ts`, Workers `poll` e
 *     `site`) lê o KV primeiro e, se a key não está lá, o R2 pelo binding
 *     `MEDIA`. URL antiga segue no KV, sem mudança.
 *
 * Ficam no KV, sempre: as imagens do É IA? (`noCacheBust`, key de convenção
 * fixa que o `/vote` monta) e as chaves do jogo. Poda do KV e os uploaders
 * semanal/mensal/anual são fatias seguintes da #11412.
 *
 * ATIVAÇÃO (ordem recomendada; desde o F1 da #11456 o uploader confere a URL
 * do Worker depois do PUT e cai no KV se ela não vier 200, então ligar a flag
 * antes do binding não deixa imagem em 404, só mantém tudo no KV):
 *   1. Descomentar o bloco `[[r2_buckets]] binding = "MEDIA"` em
 *      `workers/poll/wrangler.toml` e `workers/site/wrangler.toml` e mergear
 *      (o deploy dos dois é automático no push).
 *   2. Conferir: subir um objeto de teste em `img/{AAMMDD}/x-{8hex}.jpg` e
 *      pedir `https://eia.diar.ia.br/img/img-{AAMMDD}-x-{8hex}.jpg` e
 *      `https://diar.ia.br/img/…` (200, `Content-Type` certo, `immutable`).
 *   3. Env do R2 com escrita no bucket (as mesmas do vertical: `R2_ACCOUNT_ID`,
 *      `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`/`SHORTS_R2_BUCKET`,
 *      `R2_PUBLIC_BASE`/`SHORTS_R2_PUBLIC_BASE`).
 *   4. `public_images_r2.enabled = true`.
 *
 * Fail-soft: flag ligada sem as env vars → aviso e KV, como antes. Falha no
 * PUT de uma imagem → aviso e essa imagem vai pro KV. A edição nunca fica sem
 * imagem por causa do R2.
 */

import { readFileSync } from "node:fs";
import { loadR2UploadConfig, uploadToR2, type R2UploadConfig, type R2UploadDeps } from "./r2-object-upload.ts";
import { r2KeyForImageKey } from "./shared/kv-image.ts";

export { r2KeyForImageKey };

/** Metadado do objeto: as keys que sobem pro R2 são todas content-addressed. */
export const PUBLIC_IMAGE_R2_CACHE_CONTROL = "public, max-age=31536000, immutable";

export interface PublicImagesR2Settings {
  enabled: boolean;
}

/** Lê `public_images_r2` do `platform.config.json` já parseado. Ausente ou malformado → desligado. */
export function readPublicImagesR2Settings(platformConfig: unknown): PublicImagesR2Settings {
  const block = (platformConfig as { public_images_r2?: { enabled?: unknown } } | null)?.public_images_r2;
  return { enabled: block?.enabled === true };
}

/** Uploader de uma imagem: sobe o arquivo e devolve a URL pública a gravar no cache. */
export type R2ImageUploader = (imagePath: string, kvKey: string, contentType: string) => Promise<string>;

/** URL `/img/` no host do Worker — a mesma forma que o upload pro KV devolve. */
export function workerImageUrl(workerUrl: string, kvKey: string): string {
  return `${workerUrl.replace(/\/+$/, "")}/img/${encodeURIComponent(kvKey)}`;
}

/**
 * Monta o uploader real. Lança se a key não tem forma R2 (o caller só chama
 * para key com `r2KeyForImageKey` não-nulo).
 */
export function makeR2ImageUploader(
  config: R2UploadConfig,
  workerUrl: string,
  deps: R2UploadDeps = { fetch: (u, i) => fetch(u, i), now: () => new Date() },
): R2ImageUploader {
  return async (imagePath, kvKey, contentType) => {
    const r2Key = r2KeyForImageKey(kvKey);
    if (!r2Key) throw new Error(`public-images-r2: key "${kvKey}" não tem forma img-{AAMMDD}-… (fica no KV)`);
    await uploadToR2(deps, config, r2Key, readFileSync(imagePath), contentType, { cacheControl: PUBLIC_IMAGE_R2_CACHE_CONTROL });
    const url = workerImageUrl(workerUrl, kvKey);
    await assertWorkerServesImage(deps, url);
    return url;
  };
}

/**
 * #11412 F1 (review da #11456): o HEAD de `uploadToR2` confere só a URL
 * pública do bucket (`media.diar.ia.br/img/…`), mas a URL que vai pro e-mail
 * é a do Worker (`{worker_url}/img/img-…`), que só serve o objeto com o
 * binding `MEDIA` no ar. Conferir essa URL aqui torna a flag segura em
 * qualquer ordem de ativação: sem o binding o Worker responde 404, o
 * uploader lança e `upload-images-public.ts` cai no KV para essa imagem.
 */
async function assertWorkerServesImage(deps: R2UploadDeps, url: string): Promise<void> {
  let res: Response;
  try {
    // UA explícito: request sem UA pode levar challenge da Cloudflare.
    res = await deps.fetch(url, { method: "HEAD", headers: { "User-Agent": "diaria-studio/public-images-r2" } });
  } catch (err) {
    throw new Error(`public-images-r2: HEAD ${url} falhou (${err instanceof Error ? err.message : String(err)}) — imagem fica no KV`);
  }
  if (res.status !== 200) {
    throw new Error(`public-images-r2: Worker devolveu HTTP ${res.status} em ${url} (binding MEDIA no ar?) — imagem fica no KV`);
  }
}

/**
 * Resolve o uploader R2 a partir da flag e do env. `null` = KV (flag
 * desligada, ou ligada sem credencial — esse caso devolve o aviso).
 */
export function resolveR2ImageUploader(
  settings: PublicImagesR2Settings,
  env: Record<string, string | undefined>,
  workerUrl: string,
): { uploader: R2ImageUploader | null; warning?: string } {
  if (!settings.enabled) return { uploader: null };
  const r2 = loadR2UploadConfig(env);
  if (!r2.ready) {
    return {
      uploader: null,
      warning: `public_images_r2.enabled = true, mas falta ${r2.missing.join(", ")} — imagens vão pro KV, como antes (#11412).`,
    };
  }
  return { uploader: makeR2ImageUploader(r2.config, workerUrl) };
}

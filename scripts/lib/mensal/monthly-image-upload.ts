/**
 * monthly-image-upload.ts (#1914)
 *
 * Extraído de `scripts/publish-monthly.ts` pra ser compartilhado entre o
 * publicador Brevo e o preview Cloudflare (`monthly-preview-cloudflare.ts`).
 * Ambos sobem as imagens do É IA? mensal pro KV do Worker poll com a MESMA
 * convenção de key, então a lógica precisa morar num único lugar (senão um
 * diverge do outro e a imagem quebra pós-voto — exatamente o bug do #1908).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { uploadImageToWorkerKV } from "../cloudflare-kv-upload.ts";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Pure (#1908): key da imagem É IA? mensal no KV. Convenção
 * `img-{edition}-{basename}` — IDÊNTICA à do diário (upload-images-public.ts)
 * e ao que a result page do voto monta em `renderResultImagesHtml`
 * (`/img/img-{edition}-01-eia-{A|B}.jpg`). Antes era `img-monthly-*`, key que a
 * result page nunca encontrava → imagens quebradas pós-voto no mensal.
 */
export function monthlyEiaImageKey(edition: string, filePath: string): string {
  const filename = filePath.split(/[\\/]/).pop() ?? "image.jpg";
  return `img-${edition}-${filename}`;
}

/**
 * Faz upload de uma imagem do digest mensal pro KV do Worker.
 * Wrapper sobre `uploadImageToWorkerKV` (lib/cloudflare-kv-upload.ts) que
 * resolve o `kvNamespaceId` de `platform.config.json` e usa a key
 * `img-{edition}-{basename}` (ver `monthlyEiaImageKey`).
 *
 * A função genérica de upload vive em lib desde #1119; esta camada mensal foi
 * extraída em #1914 (antes era local em publish-monthly).
 */
export async function uploadMonthlyImage(
  filePath: string,
  edition: string,
  root: string = DEFAULT_ROOT,
): Promise<string> {
  const cfg = JSON.parse(readFileSync(resolve(root, "platform.config.json"), "utf8"));
  const kvNamespaceId: string = cfg?.poll?.kv_namespace_id;
  if (!kvNamespaceId) throw new Error("platform.config.json → poll.kv_namespace_id não configurado");

  const workerUrl = process.env.POLL_WORKER_URL ?? cfg?.poll?.worker_url ?? "https://poll.diaria.workers.dev";
  const key = monthlyEiaImageKey(edition, filePath);

  return uploadImageToWorkerKV(filePath, key, {
    kvNamespaceId,
    workerUrl,
  });
}

/**
 * #1916: sobe as imagens 2x1 dos destaques (D1/D2/D3) do digest mensal pro KV e
 * devolve o map `{ 1: url, 2: url, 3: url }` (só os que existem). Usa
 * `uploadMonthlyImage` (mesma convenção de key `img-{edition}-04-d{N}-2x1.jpg`).
 * Compartilhado entre o preview Cloudflare e o publish-monthly (Brevo).
 *
 * `eiaEdition` = AAMMDD do É IA? (último dia do mês) — mesma usada pras imagens
 * do É IA?, pra manter todas as imagens da edição sob a mesma `edition` no KV.
 */
export async function uploadDestaqueImages(
  monthlyDir: string,
  eiaEdition: string,
  root: string = DEFAULT_ROOT,
): Promise<Record<number, string>> {
  // Uploads independentes → paralelos (#1922 review, consistente com uploadEiaImages).
  const present = [1, 2, 3].filter((n) =>
    existsSync(resolve(monthlyDir, `04-d${n}-2x1.jpg`)),
  );
  const urls = await Promise.all(
    present.map((n) =>
      uploadMonthlyImage(resolve(monthlyDir, `04-d${n}-2x1.jpg`), eiaEdition, root),
    ),
  );
  const out: Record<number, string> = {};
  present.forEach((n, i) => {
    out[n] = urls[i];
  });
  return out;
}

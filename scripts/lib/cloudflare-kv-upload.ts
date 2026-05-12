/**
 * cloudflare-kv-upload.ts (#1119)
 *
 * Upload de imagens pro KV do Worker `diar-ia-poll` via Cloudflare API.
 * Worker serve via `/img/{key}` com Content-Type: image/jpeg e Cache-Control
 * imutável — apropriado pra hotlink em email (Beehiiv, Brevo).
 *
 * Originalmente embutido em `publish-monthly.ts` (só pro digest Brevo).
 * Extraído pra lib em #1119 quando foi adicionado suporte pra newsletter
 * daily (publish via Beehiiv).
 *
 * Por que NÃO usar Google Drive:
 * - `drive.google.com/uc?id=...` retorna HTML wrapper na primeira request
 *   (proxy quirk), só serve bytes na 2ª. Clientes de email não esperam.
 * - Sem Cache-Control adequado.
 * - Throttle agressivo pra hotlink em volume.
 *
 * Cloudflare Worker KV é estável, imutável após upload (key-based), CDN-cached.
 */

import { readFileSync } from "node:fs";
import https from "node:https";

export interface CloudflareKVConfig {
  /** Account ID Cloudflare. Lê de process.env.CLOUDFLARE_ACCOUNT_ID por default. */
  accountId?: string;
  /** API token com permissão Workers KV. Lê de process.env.CLOUDFLARE_WORKERS_TOKEN. */
  token?: string;
  /** Namespace ID do KV (do wrangler.toml `[[kv_namespaces]] id`). */
  kvNamespaceId: string;
  /** URL pública do Worker (sem trailing slash). Default: https://diar-ia-poll.diaria.workers.dev */
  workerUrl?: string;
}

/**
 * Faz upload de um arquivo pro KV do Worker e retorna a URL pública servida
 * via `/img/{key}`. A chave (`key`) é fornecida pelo caller — deve ser única
 * por edição pra evitar colisão entre meses/dias.
 *
 * @param filePath caminho local do arquivo (jpg/png)
 * @param key chave KV única (ex: `img-260512-04-d1-2x1.jpg`)
 * @param cfg credenciais + namespace
 * @returns URL pública (`https://{workerUrl}/img/{key}`)
 *
 * @throws Error se credenciais faltam, ou se upload retorna status != 2xx
 */
export async function uploadImageToWorkerKV(
  filePath: string,
  key: string,
  cfg: CloudflareKVConfig,
): Promise<string> {
  const accountId = cfg.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = cfg.token ?? process.env.CLOUDFLARE_WORKERS_TOKEN;
  const workerUrl = cfg.workerUrl ?? "https://diar-ia-poll.diaria.workers.dev";

  if (!accountId || !token) {
    throw new Error(
      "uploadImageToWorkerKV: CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_WORKERS_TOKEN não definidos. " +
        "Passar via cfg ou env.",
    );
  }
  if (!cfg.kvNamespaceId) {
    throw new Error("uploadImageToWorkerKV: cfg.kvNamespaceId obrigatório");
  }

  const buf = readFileSync(filePath);

  // https nativo (evita chunked-encoding quirk do fetch global em alguns Node builds)
  await new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.cloudflare.com",
        path: `/client/v4/accounts/${accountId}/storage/kv/namespaces/${cfg.kvNamespaceId}/values/${encodeURIComponent(key)}`,
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          "Content-Length": buf.length,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve();
          } else {
            reject(
              new Error(
                `Cloudflare KV upload de '${key}' falhou (${res.statusCode}): ${body}`,
              ),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.write(buf);
    req.end();
  });

  return `${workerUrl}/img/${encodeURIComponent(key)}`;
}

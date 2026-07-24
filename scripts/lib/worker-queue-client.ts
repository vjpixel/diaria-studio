/**
 * worker-queue-client.ts (#3944 Parte B)
 *
 * Cliente compartilhado do endpoint `/queue` do Worker Cloudflare
 * `diaria-linkedin-cron`, usado por qualquer canal que agenda via esse
 * Worker além do LinkedIn (Instagram #3817, Threads #3944 Parte B).
 *
 * Extraído de `publish-instagram.ts` (onde vivia como `postToWorkerQueue` /
 * `InstagramQueuePayload`) no momento em que Threads passou a precisar do
 * MESMO cliente — evita a 2ª cópia que a extração original (#3817) já tinha
 * evitado ao reusar o endpoint/schema de resposta do LinkedIn.
 *
 * `image_url` é opcional aqui (Threads publica posts só-texto; Instagram
 * exige imagem — a exigência é validada no caller e no Worker, não neste
 * cliente HTTP genérico).
 */

import { CONFIG } from "./config.ts";
import { parseWorkerQueueResponse } from "./schemas/linkedin-payload.ts";

export interface WorkerQueuePayload {
  text: string;
  image_url?: string | null;
  scheduled_at: string;
  destaque: string;
  channel: "instagram" | "threads";
}

export async function postToWorkerQueue(
  workerUrl: string,
  token: string,
  payload: WorkerQueuePayload,
  maxAttempts = 2,
  logPrefix = "worker-queue-client",
): Promise<{ queued: true; key: string; scheduled_at: string; destaque: string }> {
  const queueUrl = workerUrl.replace(/\/+$/, "") + "/queue";
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(queueUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Diaria-Token": token,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CONFIG.timeouts.makeWebhook),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Worker queue HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      const text = await res.text();
      try {
        return parseWorkerQueueResponse(JSON.parse(text));
      } catch (parseErr) {
        throw new Error(
          `Worker response inválido (schema ou JSON): ${text.slice(0, 200)} — ${(parseErr as Error).message}`,
        );
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      console.error(`[${logPrefix}] worker attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  throw lastError ?? new Error("worker_queue_failed");
}

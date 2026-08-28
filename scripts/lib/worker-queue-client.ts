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
  // #4146 — carrossel Instagram (pré-requisito #4153, já implementado no
  // Worker): lista de N URLs (1-10, validada no Worker) usada no lugar de
  // `image_url` quando o post tem mais de 1 imagem (ex: post semanal com 1
  // card 4:5 por dia). Opcional — omitido/`undefined` preserva o caminho de
  // imagem única (`image_url`) para LinkedIn/Threads/Instagram diário.
  image_urls?: string[] | null;
  scheduled_at: string;
  destaque: string;
  // #4101 — "linkedin" adicionado: o Worker (workers/linkedin-cron/src/index.ts)
  // já aceita `channel: "linkedin"` explícito desde sempre (é o default quando
  // omitido, ver dispatch.ts `entry.channel ?? "linkedin"`) — só o tipo local
  // deste cliente compartilhado era mais restrito que o contrato real do
  // servidor. Usado por `publish-weekly-social.ts` pra enfileirar o post
  // semanal de LinkedIn pelo mesmo endpoint `/queue` (Make.com scenario).
  channel: "linkedin" | "instagram" | "threads";
}

/**
 * deleteFromWorkerQueue (#6607)
 *
 * Cliente para `DELETE /queue/:key` — usado por qualquer fluxo de
 * reagendamento ad-hoc que precisa remover uma entry já enfileirada antes
 * de re-enfileirar com novo horário/conteúdo.
 *
 * O Worker (`workers/linkedin-cron/src/index.ts` `handleQueueDelete`)
 * responde `404 { error: "key not found" }` quando a key já não existe —
 * seja porque o post já disparou (o cron deleta a entry após postar) seja
 * porque já foi cancelado/deletado antes. Achado ao vivo (#6607): um
 * reagendamento chamou DELETE, ignorou o status da resposta, e seguiu para
 * o re-enqueue mesmo quando o DELETE não achou a key — criando uma entry
 * DUPLICADA na fila (o post original já tinha disparado). Esta função
 * retorna `alreadyGone: true` em vez de lançar nesse caso, para que o
 * caller trate 404 como sinal de ABORTAR o re-enqueue (opção 2 da issue —
 * mais simples que adicionar um `GET /queue/:key` novo no Worker).
 *
 * `alreadyGone: true` NÃO é sucesso silencioso — o caller deve reportar
 * isto ao editor/log antes de decidir o que fazer (o post pode já ter sido
 * publicado, então reagendar de novo pode duplicar de outra forma se o
 * conteúdo for postado por outro canal).
 */
export async function deleteFromWorkerQueue(
  workerUrl: string,
  token: string,
  key: string,
  logPrefix = "worker-queue-client",
): Promise<{ deleted: boolean; alreadyGone: boolean; key: string }> {
  const deleteUrl = workerUrl.replace(/\/+$/, "") + "/queue/" + encodeURIComponent(key).replace(/%3A/g, ":");
  const res = await fetch(deleteUrl, {
    method: "DELETE",
    headers: { "X-Diaria-Token": token },
    signal: AbortSignal.timeout(CONFIG.timeouts.makeWebhook),
  });
  if (res.status === 404) {
    console.warn(
      `[${logPrefix}] DELETE ${key} → 404 (key not found — post já disparou ou já foi removido antes). ` +
        `Abortando re-enqueue para evitar entry duplicada.`,
    );
    return { deleted: false, alreadyGone: true, key };
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Worker queue DELETE HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return { deleted: true, alreadyGone: false, key };
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

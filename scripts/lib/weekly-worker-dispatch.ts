/**
 * scripts/lib/weekly-worker-dispatch.ts (#8310)
 *
 * Lógica PURA de reconciliação pós-dispatch da retrospectiva SEMANAL contra o
 * Worker Cloudflare `diaria-linkedin-cron` — o mesmo papel que
 * `verify-social-worker-dispatch.ts` cumpre pro diário, estendido pra
 * `data/weekly/{key}/06-weekly-published.json`.
 *
 * ## O problema que isto resolve (#8310)
 *
 * `verify-social-worker-dispatch.ts` só lê `data/editions/{AAMMDD}/06-social-published.json`
 * — os posts DIÁRIOS. A semanal (escrita por `publish-weekly-social.ts`) grava
 * em `data/weekly/{saturday}/06-weekly-published.json` e nunca foi reconciliada:
 * um DLQ do Worker (token expirado, erro de API, payload recusado na hora do
 * disparo) morria em silêncio, com o store local afirmando `scheduled`. A #8303
 * fechou a causa específica do LinkedIn sem credencial (o enqueue agora é
 * recusado no Worker e o store grava `skipped`), mas cobre SÓ UMA causa —
 * qualquer outra continua invisível.
 *
 * ## Mesma garantia, mesmo código, canal diferente
 *
 * Reusa `reconcileWorkerEntry`/`verifyWorkerDispatch` de
 * `verify-social-worker-dispatch.ts` (não reimplanta a lógica — a única
 * diferença é o path do store: `data/weekly/{key}/06-weekly-published.json`
 * em vez de `data/editions/{AAMMDD}/...`). Ver `resolveWeeklyPublishedPath`
 * abaixo.
 *
 * ## Nível de garantia por canal — idêntico ao diário
 *
 * - **Instagram/Threads**: `fired` do Worker é confirmação REAL de entrega
 *   (Graph API media_publish/threads_publish já respondeu com `id`).
 * - **LinkedIn**: `fired` é só aceite do webhook Make (fire-and-forget) —
 *   `verification_note` de confiança mais fraca, nunca a mesma dos outros dois.
 * - **DLQ**: falha real, qualquer canal, vira `failed` com
 *   `failure_reason` genérico apontando pra limitação conhecida do DLQ
 *   (motivo detalhado só nos logs do Cloudflare, ver #5766).
 *
 * ## Fail-soft
 *
 * O script caller (`verify-weekly-worker-dispatch.ts`) é fail-soft: ausência
 * de credenciais, Worker indisponível, JSON corrompido → warning + exit 0,
 * nunca bloqueia. Mesmo padrão de `verify-social-worker-dispatch.ts` (0k).
 */

import {
  reconcileWorkerEntry,
  verifyWorkerDispatch,
  type PostEntry,
  type SocialPublished,
  type FetchJsonFn,
} from "../verify-social-worker-dispatch.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve o path canônico de `06-weekly-published.json` de uma semana —
 * `data/weekly/{saturday}/06-weekly-published.json`. O `saturday` aqui é a
 * data de sábado em `YYYY-MM-DD` (mesma convenção de `publish-weekly-social.ts`,
 * que grava em `data/weekly/{saturday}/06-weekly-published.json`).
 *
 * Não há fallback `_internal/` como no diário (a semanal escreve no root da
 * pasta da semana, ver `publish-weekly-social.ts:941`) — mas a checagem de
 * existência é fail-soft: path ausente → o caller skipa, nunca bloqueia.
 */
export function resolveWeeklyPublishedPath(rootDir: string, saturday: string): string {
  return resolve(rootDir, "data", "weekly", saturday, "06-weekly-published.json");
}

/** True se o store da semana existe no disco. */
export function weeklyPublishedExists(rootDir: string, saturday: string): boolean {
  return existsSync(resolveWeeklyPublishedPath(rootDir, saturday));
}

/** Re-export dos tipos e funções puras pra testes e pra callers que quebram
 * o acoplamento com `verify-social-worker-dispatch.ts`. */
export type { PostEntry, SocialPublished, FetchJsonFn };

/** Reconcilia uma entry pura contra queue+dlq — ver
 * `verify-social-worker-dispatch.ts::reconcileWorkerEntry`. */
export { reconcileWorkerEntry };

/**
 * Reconcilia o store da semana inteira — orquestra `GET /list` + `GET /dlq`
 * (com retry de lag de KV, #6016) e atualiza cada entry reconciliável.
 *
 * Thin wrapper: repassa pra `verifyWorkerDispatch` sem customizar o `fetchJson`
 * (usa o default do módulo, que é `fetch` real). `now`/`retry` são
 * injetáveis pra teste, como no diário.
 */
export async function verifyWeeklyWorkerDispatch(
  published: SocialPublished,
  workerUrl: string,
  token: string,
  now: Date = new Date(),
  retry: Parameters<typeof verifyWorkerDispatch>[5] = {},
): Promise<{ updated: SocialPublished; changes: number }> {
  return verifyWorkerDispatch(published, workerUrl, token, undefined, now, retry);
}
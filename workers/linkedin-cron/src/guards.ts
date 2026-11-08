import type { WebhookTarget, QueueAction } from "./index";

// ── Guards compartilhados entre fire.ts (cron) e durable-object.ts (alarm) ──

/**
 * (#3667) Decisão pura: uma entry `action="comment"` com `webhookTarget !=
 * "pixel"` nunca deve ser disparada pro Make — o módulo LinkedIn "diaria" do
 * Make não suporta "Create Comment" (só o webhook "pixel" aceita), então o
 * Make sempre rejeitaria com `Missing value of required parameter 'url'`,
 * esgotando os 5 retries até DLQ + email de erro pro editor. Não adianta
 * re-tentar — o payload é sempre o mesmo.
 *
 * Extraído do guard original de `fire.ts` (#3662) pra ser reusado também no
 * caminho `alarm()` do Durable Object (#3667 — o guard de #3662 só cobria
 * `fireDueItems`/cron, deixando o disparo PRIMÁRIO via `alarm()` sem
 * proteção equivalente).
 *
 * Função pura, sem I/O — a MECÂNICA de mover a entry pra DLQ é local a cada
 * caller:
 *   - `fire.ts` (`fireDueItems`) tem acesso a `env.LINKEDIN_QUEUE` (KV) e
 *     escreve a entry em `dlq:` diretamente.
 *   - `durable-object.ts` (`alarm()`) só tem acesso ao DO storage (sem KV) —
 *     libera o claim e retorna sem postar, deixando a entry no KV intocada
 *     pro próximo ciclo do cron aplicar o MESMO guard e escrever no DLQ.
 */
export function isUnsupportedCommentTarget(action: QueueAction, webhookTarget: WebhookTarget): boolean {
  return action === "comment" && webhookTarget !== "pixel";
}

/**
 * #11121/#10983 — a entry sai pela API DIRETA do LinkedIn como a página?
 * `repost` sempre; `comment` quando não é do webhook "pixel" e traz alvo
 * (`target_post_urn` ou `parent_scheduled_at`). `comment` sem alvo segue no
 * guard acima (caminho antigo, DLQ). Pura, sem I/O.
 */
export function isPageApiAction(entry: {
  action?: QueueAction;
  webhook_target?: WebhookTarget;
  target_post_urn?: string;
  parent_scheduled_at?: string;
}): boolean {
  if (entry.action === "repost") return true;
  return (
    entry.action === "comment" &&
    (entry.webhook_target ?? "diaria") !== "pixel" &&
    (Boolean(entry.target_post_urn) || Boolean(entry.parent_scheduled_at))
  );
}

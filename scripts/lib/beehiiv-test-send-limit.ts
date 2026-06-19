/**
 * beehiiv-test-send-limit.ts (#2376)
 *
 * Tracking do limite de test emails por post no Beehiiv (limite por post,
 * distinto do rate limit por hora de beehiiv-send-count.ts/#1419).
 *
 * Problema (incidente 260619): Beehiiv limita envios de test email por post.
 * Ao atingir o limite, "Send test email" retorna "Test send limit exceeded"
 * sem aviso proativo — a verificação final cai pro draft link sem garantia
 * de render igual ao email. O loop verify→fix iterorou 4× + 2 sem email =
 * ~90min perdidos porque o agente não sabia do limite.
 *
 * Solução:
 * - Rastrear `test_email_count` em `05-published.json` (campo no schema Zod).
 * - Alertar proativamente quando count >= ALERT_THRESHOLD (3) antes de enviar.
 * - Ao atingir o limite, logar `warn: test_send_limit_reached` no run-log e
 *   marcar `draft_verified: true` em `05-published.json` pra indicar que a
 *   verificação foi via draft link + checklist explícita (não via test email).
 *
 * NOTA: este módulo gerencia apenas a contagem por post persistida em
 * `05-published.json`. A contagem por hora (rate limit do Beehiiv) ainda vive
 * em `beehiiv-send-count.ts` (#1419) — ambas as guards devem ser consultadas
 * antes de cada "Send test email".
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Limiar de alerta proativo: ao atingir ou superar esse número de test emails
 * enviados para este post, alertar antes de enviar o próximo.
 * Conservador (3) para cobrir casos onde o Beehiiv tem limite variável por plano.
 */
export const TEST_SEND_ALERT_THRESHOLD = 3;

export type TestSendLimitDecision =
  | { action: "ok"; count: number }
  | { action: "alert"; count: number; message: string }
  | { action: "use_draft_fallback"; count: number; message: string };

/**
 * Lê `test_email_count` atual de `05-published.json`.
 * Retorna 0 se arquivo não existe, campo ausente, ou count inválido.
 */
export function readTestEmailCount(editionDir: string): number {
  const path = resolve(editionDir, "_internal", "05-published.json");
  if (!existsSync(path)) return 0;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const count = data["test_email_count"];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
      return Math.floor(count);
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Incrementa `test_email_count` em `05-published.json` in-place.
 * Preserva todos os outros campos via merge. Idempotente se o arquivo não
 * existe (cria campo com count 1 se não havia campo antes).
 *
 * Retorna o novo valor do counter.
 *
 * IMPORTANTE: esta função não cria `05-published.json` se ele não existir —
 * o playbook só deve chamar `incrementTestEmailCount` após o arquivo ter sido
 * gravado inicialmente (passo 8 do beehiiv-playbook.md).
 */
export function incrementTestEmailCount(editionDir: string): number {
  const path = resolve(editionDir, "_internal", "05-published.json");
  if (!existsSync(path)) {
    // Arquivo não existe: não criar; o orchestrator deve gravar antes
    // de chamar este helper. Retornar 0 para sinalizar que o increment não
    // persistiu — o caller deve logar aviso.
    return 0;
  }
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    const prev =
      typeof data["test_email_count"] === "number" ? Math.floor(data["test_email_count"]) : 0;
    const next = prev + 1;
    data["test_email_count"] = next;
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
    return next;
  } catch {
    return 0;
  }
}

/**
 * Marca `draft_verified: true` em `05-published.json` para indicar que a
 * verificação final foi feita via draft link + checklist (não via test email).
 * Preserva todos os outros campos.
 */
export function markDraftVerified(editionDir: string): void {
  const path = resolve(editionDir, "_internal", "05-published.json");
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    data["draft_verified"] = true;
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch {
    // swallow — não pode mascarar erro original
  }
}

/**
 * Pure: decide a ação baseado no count atual de test emails.
 *
 * - count < ALERT_THRESHOLD: ok, seguir normal
 * - count === ALERT_THRESHOLD: alert, avisar que próximo pode atingir limite
 * - count > ALERT_THRESHOLD: use_draft_fallback — não enviar; usar draft link
 */
export function decideTestSendAction(count: number): TestSendLimitDecision {
  if (count > TEST_SEND_ALERT_THRESHOLD) {
    return {
      action: "use_draft_fallback",
      count,
      message:
        `Test send limit possivelmente atingido (${count} test emails enviados para este post). ` +
        `Beehiiv limita test emails por post — "Send test email" pode retornar ` +
        `"Test send limit exceeded" silenciosamente (o email não chega mas UI mostra sucesso). ` +
        `Verificar via draft link com checklist em vez de outro send.`,
    };
  }
  if (count >= TEST_SEND_ALERT_THRESHOLD) {
    return {
      action: "alert",
      count,
      message:
        `Alerta: ${count} test emails já enviados para este post. ` +
        `Beehiiv tem limite de test emails por post — próximo send pode atingir o limite. ` +
        `Se o email não chegar em ~2min, verificar via draft link com checklist.`,
    };
  }
  return { action: "ok", count };
}

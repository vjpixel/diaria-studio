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
 *
 * Writes usam `writeFileAtomic` (#1132) — `05-published.json` é output crítico
 * listado em `atomic-write.ts`; crash mid-write deixaria o resume detector lendo
 * um arquivo truncado (exatamente o bug que #2376 tenta prevenir).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

/**
 * Path do `05-published.json` da edição. Centralizado pra evitar 3 cópias
 * do literal `_internal/05-published.json` espalhadas pelo módulo.
 */
function publishedJsonPath(editionDir: string): string {
  return resolve(editionDir, "_internal", "05-published.json");
}

/**
 * Lê + parseia `05-published.json` como objeto solto. Retorna `null` quando o
 * arquivo não existe ou é JSON inválido (caller decide o fallback). Não usa o
 * Zod schema de propósito: este helper precisa funcionar mesmo quando o arquivo
 * está parcialmente preenchido durante o pipeline (ex: antes de `status` ser
 * setado), o que falharia o parse strict.
 */
function readPublishedRaw(editionDir: string): Record<string, unknown> | null {
  const path = publishedJsonPath(editionDir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Coerção defensiva de `test_email_count` lido de disco para um inteiro >= 0.
 * Valores não-numéricos, NaN, Infinity ou negativos viram 0 — um arquivo
 * corrompido (ou editado à mão) com count negativo não pode neutralizar
 * silenciosamente a guard (incrementar a partir de um negativo levaria muitos
 * sends pra cruzar o threshold).
 */
function coerceCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

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
  const data = readPublishedRaw(editionDir);
  if (data === null) return 0;
  return coerceCount(data["test_email_count"]);
}

/**
 * Incrementa `test_email_count` em `05-published.json` in-place e persiste
 * atomicamente. Preserva todos os outros campos via merge.
 *
 * Retorna o novo valor do counter, ou `null` se não conseguiu persistir
 * (arquivo ausente ou JSON inválido) — o caller DEVE tratar `null` como
 * "increment perdido" e logar aviso. Distinguir `null` de um número permite o
 * orchestrator saber que o counter não avançou (vs. um `0` que era ambíguo na
 * versão anterior — #2376 review).
 *
 * Em **modo create**, `05-published.json` ainda não existe quando o primeiro
 * test email é enviado (passo 7 < passo 8). Use `setTestEmailCount` no passo 8
 * para gravar a contagem inicial; `incrementTestEmailCount` é pro **modo fix**,
 * onde o arquivo já existe da run de create anterior.
 */
export function incrementTestEmailCount(editionDir: string): number | null {
  const data = readPublishedRaw(editionDir);
  if (data === null) {
    // Arquivo ausente ou corrompido: não criar do zero (faltariam draft_url,
    // status, etc. — o passo 8 do playbook é o dono dessa criação). Sinalizar
    // falha com null em vez de 0 ambíguo.
    return null;
  }
  const next = coerceCount(data["test_email_count"]) + 1;
  data["test_email_count"] = next;
  try {
    writeFileAtomic(publishedJsonPath(editionDir), JSON.stringify(data, null, 2) + "\n");
  } catch {
    return null;
  }
  return next;
}

/**
 * Seta `test_email_count` em `05-published.json` com um valor explícito,
 * persistindo atomicamente. Usado no passo 8 do playbook (modo create) para
 * gravar a contagem de sends feitos no passo 7 — quando o arquivo é criado pela
 * primeira vez. Retorna `true` se persistiu, `false` se falhou.
 */
export function setTestEmailCount(editionDir: string, count: number): boolean {
  const data = readPublishedRaw(editionDir);
  if (data === null) return false;
  data["test_email_count"] = coerceCount(count);
  try {
    writeFileAtomic(publishedJsonPath(editionDir), JSON.stringify(data, null, 2) + "\n");
  } catch {
    return false;
  }
  return true;
}

/**
 * Marca `draft_verified: true` em `05-published.json` para indicar que a
 * verificação final foi feita via draft link + checklist (não via test email).
 * Preserva todos os outros campos. Persiste atomicamente.
 *
 * Retorna `true` se persistiu, `false` se falhou (arquivo ausente/corrompido ou
 * erro de escrita) — o caller deve logar aviso quando `false`, senão a flag fica
 * inconsistente com o que foi reportado ao editor.
 */
export function markDraftVerified(editionDir: string): boolean {
  const data = readPublishedRaw(editionDir);
  if (data === null) return false;
  data["draft_verified"] = true;
  try {
    writeFileAtomic(publishedJsonPath(editionDir), JSON.stringify(data, null, 2) + "\n");
  } catch {
    return false;
  }
  return true;
}

/**
 * Pure: decide a ação baseado no count atual de test emails.
 *
 * - count < ALERT_THRESHOLD: ok, seguir normal
 * - count === ALERT_THRESHOLD: alert, avisar que próximo pode atingir limite
 * - count > ALERT_THRESHOLD: use_draft_fallback — não enviar; usar draft link
 *
 * Sequência efetiva (increment ocorre APÓS cada send): sends com count
 * pré-envio 0,1,2 são "ok"; o send com count 3 é "alert" (último permitido);
 * a partir de count 4 a guard cai para `use_draft_fallback` e bloqueia o send.
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

/**
 * workers/anual/src/gate.ts (#7581)
 *
 * Lógica PURA do gate de CADASTRO da retrospectiva anual — decide se um
 * e-mail tem acesso à edição completa. Sem I/O: `index.ts` resolve o estado
 * de verificação (chamada à API Kit) e passa o resultado já classificado
 * aqui, mesmo padrão de `workers/artigo-mensal/src/gate.ts` (#3940).
 *
 * ## Diferença central em relação ao artigo mensal (#3940)
 *
 * O artigo mensal gateia por APOIO (allowlist de e-mails de apoiadores R$10+,
 * lida de um KV próprio). A anual gateia por CADASTRO simples — decisão do
 * editor (07/09/2026, comentário-marcador da #7581): "coerente com a anual
 * não ser benefício de apoiador". A verificação é contra o Kit (base própria
 * da newsletter), não contra um allowlist de nível de apoio.
 *
 * ## Fail-closed + anti-probing (invariante central, igual ao #3940)
 *
 * `state: "not_registered"` cobre TRÊS situações distintas — e-mail
 * confirmadamente não-cadastrado, estado desconhecido/ambíguo, e falha de
 * verificação (API fora do ar, key rotacionada) — de propósito. Não
 * distinguir os três aqui é o que fecha o anti-probing: um atacante testando
 * e-mails em massa não consegue diferenciar "este não existe" de "não
 * consegui confirmar" a partir da resposta. `index.ts` nunca vaza a
 * distinção pro leitor — a MESMA página (trecho + convite de cadastro) sai
 * nos três casos.
 */
import type { SubscriberVerifyState } from "../../../scripts/lib/shared/subscriber-verify.ts";

/** Normaliza e-mail pra comparação/lookup: trim + lowercase. `null`/`undefined` → "". */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

export type GateDecision =
  | { state: "allowed" }
  | { state: "no_email" }
  | { state: "not_registered" };

/**
 * Decide o acesso a partir do estado de verificação do Kit já resolvido.
 *
 * `kitState === "active"` é o ÚNICO caminho para `"allowed"` — fail-closed:
 * `"inactive"` (cancelou/bounce/complaint), `"unknown"` (não encontrado) e
 * `"verification_failed"` (API indisponível) caem TODOS em
 * `"not_registered"`, nunca em `"allowed"`. Uma falha de verificação nunca
 * concede acesso por omissão.
 */
export function decideGate(
  email: string | null | undefined,
  kitState: SubscriberVerifyState | null,
): GateDecision {
  const normalized = normalizeEmail(email);
  if (!normalized) return { state: "no_email" };
  if (kitState === "active") return { state: "allowed" };
  return { state: "not_registered" };
}

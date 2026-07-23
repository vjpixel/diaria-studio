/**
 * workers/artigo-mensal/src/gate.ts (#3940)
 *
 * Lógica PURA do gate de paywall do artigo mensal — decide se um e-mail tem
 * acesso ao artigo completo. Sem I/O: o caller (index.ts) resolve o KV e
 * passa o resultado já parseado (`string[] | null`) — mesmo padrão de
 * `workers/draft/src/index.ts` (handleGet/legacyKeyFromNew), que mantém a
 * lógica testável sem mockar `KVNamespace` real.
 *
 * Invariante fail-closed (#3940, decisão do editor — Opção B da issue):
 * QUALQUER ambiguidade — allowlist ausente/corrompida (`null`), e-mail
 * ausente/vazio, e-mail não encontrado na allowlist — resolve para "sem
 * acesso". Nenhum caminho de erro serve o artigo completo. O artigo só é
 * servido quando a allowlist foi lida com sucesso E o e-mail normalizado
 * está nela.
 */

/** Normaliza e-mail pra comparação: trim + lowercase. `null`/`undefined` → "". */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/**
 * Parseia o valor bruto lido de `env.ALLOWLIST.get("emails")`.
 *
 * Retorna `null` (fail-closed) se: ausente, JSON inválido, shape inesperado
 * (não-array, ou array com QUALQUER elemento não-string). Nunca lança —
 * qualquer erro de parsing vira "allowlist indisponível", nunca uma
 * allowlist parcial silenciosa.
 */
export function parseAllowlist(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((e) => typeof e === "string")) return null;
  return parsed.map((e) => normalizeEmail(e));
}

/**
 * Decide se `email` tem acesso ao artigo completo.
 *
 * `allowlist === null` significa "KV indisponível, ausente ou corrompido" —
 * fail-closed, NUNCA concede acesso independente do valor de `email`.
 */
export function isEmailAllowed(
  email: string | null | undefined,
  allowlist: string[] | null,
): boolean {
  if (!allowlist) return false; // fail-closed: allowlist indisponível/corrompida
  const normalized = normalizeEmail(email);
  if (!normalized) return false; // fail-closed: sem e-mail
  return allowlist.includes(normalized);
}

export type GateDecision =
  | { state: "allowed" }
  | { state: "no_email" }
  | { state: "not_backer" };

/**
 * Versão "explicada" de `isEmailAllowed` — devolve POR QUE o acesso foi
 * negado, pra `index.ts` escolher a página certa (form de e-mail quando
 * nenhum e-mail foi informado ainda vs. paywall "não é apoiador" quando o
 * e-mail informado não está na allowlist). O caminho de acesso concedido é
 * idêntico ao de `isEmailAllowed` — esta função nunca é MENOS restritiva.
 */
export function decideGate(
  email: string | null | undefined,
  allowlist: string[] | null,
): GateDecision {
  const normalized = normalizeEmail(email);
  if (!normalized) return { state: "no_email" };
  if (isEmailAllowed(normalized, allowlist)) return { state: "allowed" };
  return { state: "not_backer" };
}

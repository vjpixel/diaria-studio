/**
 * publish-state.ts (#782)
 *
 * State machine normalizado pra estado de publicação externa
 * (Beehiiv, LinkedIn, Facebook). Centraliza a lógica de "este post está
 * agendado ou já saiu?" pra evitar que cada caller re-derive isso (ou
 * pior, deixe pra um subagente Haiku descobrir e errar).
 *
 * Caso canônico (#573): Beehiiv API retorna `status: "confirmed"` tanto pra
 * posts agendados pro futuro quanto pra posts já publicados. A diferença é
 * `publish_date` vs `now`. Sem normalização, orchestrator afirmou "3 edições
 * publicadas" mas uma estava 16h no futuro.
 *
 * Regra (CLAUDE.md): orchestrator usa esses helpers antes de qualquer log
 * ou relay de estado de publicação ao editor — nunca inspeciona `status`
 * raw da API.
 */

export type PublishState =
  /** Post existe mas não foi agendado nem publicado. */
  | "draft"
  /** Agendado pro futuro (publish_date > now ou scheduled_at > now). */
  | "scheduled"
  /** Já publicado/enviado (publish_date <= now). */
  | "published"
  /** Estado não-mapeado (failed, error, schema desconhecido). */
  | "unknown";

// #833: removido `'sent'` — era dead code. Nenhum resolve* retorna `'sent'`;
// `resolveLinkedInState` aceita `status: "sent"` como input mas mapeia pra
// `"published"`. Callers que queriam exhaustive switch escreviam branch dead.
// "published" cobre o caso semanticamente.

// ─── Beehiiv ───────────────────────────────────────────────────────────────

export interface BeehiivPostLike {
  /** Beehiiv status raw: "draft" | "confirmed" | "archived" | etc. */
  status?: string;
  /** Unix timestamp em segundos. Pode ser null (draft) ou 0 (não agendado). */
  publish_date?: number | null;
}

/**
 * Normaliza o estado de um post Beehiiv contra `now`.
 *
 * Beehiiv usa `status: "confirmed"` ambiguamente:
 * - `confirmed` + publish_date no futuro → "scheduled"
 * - `confirmed` + publish_date no passado → "published"
 * - `confirmed` sem publish_date → "unknown" (defensive)
 *
 * Outros statuses ("draft", "archived", "failed") mapeiam diretamente
 * ou caem em "unknown" sem comparar com `now`.
 */
export function resolveBeehiivState(
  post: BeehiivPostLike,
  now: Date = new Date(),
): PublishState {
  const status = (post.status ?? "").toLowerCase();
  if (status === "draft") return "draft";
  // #833: archived é "unknown" porque o helper alvo é current-edition relay
  // (status atual ao editor). Posts archived foram publicados em algum
  // momento, mas isso é past-edition reporting — fora do escopo.
  if (status === "archived") return "unknown";
  if (status !== "confirmed") return "unknown";

  // status === "confirmed" → desambiguar via publish_date
  const publishDate = post.publish_date;
  if (publishDate == null || publishDate === 0) return "unknown";

  const publishMs = publishDate * 1000;
  return publishMs > now.getTime() ? "scheduled" : "published";
}

// ─── LinkedIn (formato local Diar.ia, não API LinkedIn) ────────────────────

export interface LinkedInPostLike {
  /** Status local (escrito por publish-linkedin.ts): "draft" | "scheduled" | "published" | "failed". */
  status?: string;
  /** ISO 8601 string. Set quando status === "scheduled". */
  scheduled_at?: string | null;
}

/**
 * Normaliza o estado de um post LinkedIn (formato local em
 * `06-social-published.json`). Diferentemente do Beehiiv, o formato local
 * já distingue draft/scheduled/published explicitamente — esta função
 * existe pra:
 *   1. Validar que `scheduled` com `scheduled_at` no passado é, na verdade, "published" (drift).
 *   2. Mapear "failed" pra "unknown" (estado terminal de erro).
 */
export function resolveLinkedInState(
  post: LinkedInPostLike,
  now: Date = new Date(),
): PublishState {
  const status = (post.status ?? "").toLowerCase();
  if (status === "draft") return "draft";
  if (status === "published" || status === "sent") return "published";
  if (status === "failed" || status === "error") return "unknown";

  if (status === "scheduled") {
    const scheduledAt = post.scheduled_at;
    // #833: alinhado ao Beehiiv defensive default — sem timestamp,
    // não dá pra confirmar se é futuro ou drift pra "published". Retornar
    // "unknown" é mais seguro que trust no status raw (mesma motivação do
    // #573 incident). Caller deve resolver o estado real antes de relayar.
    if (!scheduledAt) return "unknown";
    const scheduledMs = Date.parse(scheduledAt);
    if (Number.isNaN(scheduledMs)) return "unknown";
    return scheduledMs > now.getTime() ? "scheduled" : "published";
  }

  return "unknown";
}

// ─── Facebook (formato local Diar.ia, mesmo shape que LinkedIn) ────────────

export interface FacebookPostLike {
  status?: string;
  scheduled_at?: string | null;
}

/**
 * Mesma semântica que `resolveLinkedInState` — formato local em
 * `06-social-published.json` é compartilhado entre os dois.
 */
export function resolveFacebookState(
  post: FacebookPostLike,
  now: Date = new Date(),
): PublishState {
  return resolveLinkedInState(post, now);
}

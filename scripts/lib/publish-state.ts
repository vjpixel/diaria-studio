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
  // #2104: guard > 0 rejeita null, 0 e negativos (timestamp pré-1970 seria
  // "published" falso — ex: -1 de campo API mal populado).
  const publishDate = post.publish_date;
  if (publishDate == null || publishDate <= 0) return "unknown";

  const publishMs = publishDate * 1000;
  return publishMs > now.getTime() ? "scheduled" : "published";
}

// ─── LinkedIn (formato local diar.ia.br, não API LinkedIn) ────────────────────

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

// ─── Facebook (formato local diar.ia.br, mesmo shape que LinkedIn) ────────────

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

// ─── Threads (formato local diar.ia.br) ──────────────────────────────────────────

export interface ThreadsPostLike {
  /** Status local (escrito por publish-threads.ts): "published" | "failed". */
  status?: string;
  /** Threads media_id do post publicado. Presente quando status === "published". */
  threads_media_id?: string | null;
}

/**
 * Normaliza o estado de um post Threads (formato local em
 * `06-social-published.json`).
 *
 * Diferente de Beehiiv/LinkedIn/Facebook, o Threads não suporta agendamento
 * via API — o post é publicado imediatamente (2 passos: create container →
 * threads_publish). Portanto, os estados possíveis são:
 *   - "published": threads_media_id presente (passo 2 bem-sucedido)
 *   - "draft": nunca ocorre (Threads publica imediato, não armazena rascunho)
 *   - "scheduled": nunca ocorre (Threads não tem agendamento via API)
 *   - "unknown": status desconhecido, threads_media_id ausente, ou "failed"
 *
 * CLAUDE.md invariant #573: orchestrator usa este helper antes de relayar
 * estado de publicação Threads ao editor — nunca lê o campo status raw.
 */
export function resolveThreadsState(post: ThreadsPostLike): PublishState {
  const status = (post.status ?? "").toLowerCase();
  if (status === "published" && post.threads_media_id) return "published";
  // "failed" ou qualquer outro status → "unknown" (não houve publicação confirmada)
  return "unknown";
}

// ─── Brevo (email campaigns — `GET /v3/emailCampaigns/{id}`) ────────────────

export interface BrevoCampaignLike {
  /** Status raw da Brevo: "draft" | "queued" | "suspended" | "in_review" |
   *  "sent" | "inProcess"/"in_process" (ver `brevo-client.ts`,
   *  `BrevoCampaignStatus`/`isTerminalSendStatus`). */
  status?: string;
  /** ISO — presente quando a campanha tem agendamento (`scheduledAt` do
   *  corpo do `GET`). Não usado pra desambiguar hoje (ver docstring), mas
   *  aceito na assinatura pra o caller não precisar montar 2 formatos
   *  diferentes de payload pra `resolveBrevoCampaignState`/`pollTerminalSendStatus`. */
  scheduledAt?: string | null;
}

/**
 * Normaliza o estado de uma campanha Brevo (#7917 — onboarding e-mail 3
 * D+10, criado sempre como rascunho, #5908/#7599) pro mesmo `PublishState`
 * usado por Beehiiv/LinkedIn/Facebook (CLAUDE.md #573: nunca relayar
 * `status` raw da API sem passar por um `resolve*State`).
 *
 * `"queued"` mapeia pra `"scheduled"` mesmo sem comparar contra `now`
 * (diferente de `resolveBeehiivState`) — a memória operacional do projeto
 * (`brevo-status-queued-dispara-na-hora.md`) documenta que uma campanha
 * Brevo em `queued` já está comprometida a disparar a qualquer momento, não
 * "agendada pro futuro" no sentido Beehiiv; tratar como rascunho reversível
 * seria a leitura errada. `"sent"`/`"inProcess"`/`"in_process"` (mesmo
 * conjunto de `isTerminalSendStatus`) mapeiam pra `"published"`.
 * `"suspended"`/`"in_review"`/ausente/desconhecido → `"unknown"` — estados
 * ambíguos ou não-observados nunca são promovidos a `"draft"` por default
 * (um `"unknown"` aqui é o sinal correto pro caller pedir reconsulta, não
 * assumir "ainda é rascunho").
 */
export function resolveBrevoCampaignState(campaign: BrevoCampaignLike): PublishState {
  const status = (campaign.status ?? "").toLowerCase();
  if (status === "draft") return "draft";
  if (status === "queued") return "scheduled";
  if (status === "sent" || status === "inprocess" || status === "in_process") return "published";
  return "unknown";
}

/**
 * publish-state.ts (#782)
 *
 * State machine normalizado pra estado de publicação externa
 * (Beehiiv, LinkedIn, Facebook, Threads, Brevo, YouTube, fila do Worker, Circle da Stack). Centraliza a lógica de "este post está
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

// ─── Fila do Worker diaria-linkedin-cron (Reels/Instagram agendado, #10823) ──

export interface WorkerQueueEntryLike {
  /** `key` devolvido pelo `POST /queue` (202). Ausente = nunca enfileirou. */
  key?: string | null;
  /** ISO do disparo programado. */
  scheduled_at?: string | null;
  /** Id da mídia publicada, quando algum caller já o confirmou na plataforma. */
  media_id?: string | null;
}

/**
 * Normaliza o estado de um post agendado pela FILA do Worker (#10823 — o
 * Instagram não agenda mídia pela Graph API; quem agenda é a fila). O `202`
 * do enqueue só prova que a entry está na fila, não que saiu:
 *
 *   - `media_id` presente → "published" (confirmado na plataforma);
 *   - `key` + `scheduled_at` futuro → "scheduled";
 *   - `key` + `scheduled_at` passado → "unknown" — pode ter disparado, pode
 *     estar em retry ou na DLQ; afirmar "publicado" aqui é o erro do #573;
 *   - sem `key` → "draft" (nada na fila).
 */
export function resolveWorkerQueueState(
  entry: WorkerQueueEntryLike,
  now: Date = new Date(),
): PublishState {
  if (entry.media_id) return "published";
  if (!entry.key) return "draft";
  const ms = Date.parse(entry.scheduled_at ?? "");
  if (Number.isNaN(ms)) return "unknown";
  return ms > now.getTime() ? "scheduled" : "unknown";
}

// ─── YouTube (resource `videos` da YouTube Data API v3, #10659) ──────────────

export interface YouTubeVideoLike {
  /** `status` do resource `videos` (`part=status`). */
  status?: {
    /** "uploaded" | "processed" | "failed" | "rejected" | "deleted". */
    uploadStatus?: string;
    /** "public" | "private" | "unlisted". */
    privacyStatus?: string;
    /** ISO 8601 — só existe com `privacyStatus: "private"` agendado. */
    publishAt?: string | null;
  } | null;
}

/**
 * Normaliza o estado de um vídeo do YouTube (#10659, mesma disciplina do #573:
 * nunca relayar `privacyStatus` raw). Armadilha específica: projeto GCP não
 * auditado força `privacyStatus=private` em TODO upload via API — um vídeo
 * `private` sem `publishAt` foi subido mas o leitor não vê, então é "draft",
 * nunca "published".
 *
 *   - `uploadStatus` failed/rejected/deleted → "unknown" (terminal de erro);
 *   - `public` → "published";
 *   - `private` + `publishAt` futuro → "scheduled";
 *   - `private` + `publishAt` passado → "unknown" (o YouTube deveria ter virado
 *     público; continuar privado é drift — reconsultar, não afirmar);
 *   - `private` sem `publishAt` → "draft";
 *   - `unlisted` ou ausente/desconhecido → "unknown" (acessível por link mas
 *     fora do canal: nem rascunho nem publicado no sentido do editor).
 */
export function resolveYouTubeState(
  video: YouTubeVideoLike,
  now: Date = new Date(),
): PublishState {
  const st = video.status ?? {};
  const upload = (st.uploadStatus ?? "").toLowerCase();
  if (upload === "failed" || upload === "rejected" || upload === "deleted") return "unknown";
  const privacy = (st.privacyStatus ?? "").toLowerCase();
  if (privacy === "public") return "published";
  if (privacy === "private") {
    if (!st.publishAt) return "draft";
    const ms = Date.parse(st.publishAt);
    if (Number.isNaN(ms)) return "unknown";
    return ms > now.getTime() ? "scheduled" : "unknown";
  }
  return "unknown";
}

// ─── Circle da Stack (state local de idempotência, #10904) ────────────────────

export interface CircleStackPublishedLike {
  /** Ciclo `{YY}w{WW}` — gravado por `publish-circle-stack.ts` ANTES do envio (tentativa). */
  cycle?: string | null;
  /** ISO da tentativa — gravado antes de chamar o webhook (`attempted_at` sem
   * `published_at` = envio que pode ter saído sem confirmação → "unknown"). */
  attempted_at?: string | null;
  /** ISO da confirmação — regravado só depois do 200 `{ok:true}` do webhook. */
  published_at?: string | null;
}

/**
 * Shape que `publish-circle-stack.ts` GRAVA (#10977: tipo compartilhado entre o
 * escritor e o leitor). Leitura continua pelo `CircleStackPublishedLike`
 * (tudo opcional), porque o arquivo pode estar truncado ou editado à mão.
 */
export interface CircleStackPublishedState {
  cycle: string;
  title: string;
  attempted_at: string;
  published_at?: string;
}

/**
 * Normaliza o estado de publicação de um ciclo no Radar de Notícias Stack
 * (#10904, mesma disciplina do #573). O webhook n8n da Stack publica NA HORA —
 * não existe rascunho nem agendamento do lado de lá, e não há endpoint de
 * leitura: a única evidência é o state local
 * `data/weekly/{cycle}/_internal/circle-stack-published.json`, gravado em
 * dois tempos — `{cycle, title, attempted_at}` ANTES do envio e
 * `published_at` acrescentado só depois do `{"ok": true}`.
 *
 *   - state ausente (`null`/`undefined`) → "draft" (nada enviado; a prévia
 *     `.md` do dry-run é o rascunho);
 *   - `cycle` igual ao esperado + `published_at` ISO válido → "published";
 *   - qualquer outra coisa (ciclo divergente, `published_at` ausente — ex.:
 *     tentativa gravada e envio que rejeitou/estourou o timeout — ou
 *     inválido, JSON ilegível que o caller passou como `{}`) → "unknown" — o
 *     arquivo existe, então algo foi tentado; nunca rebaixar pra "draft" e
 *     arriscar post duplicado numa comunidade de terceiro.
 */
export function resolveCircleStackState(
  state: CircleStackPublishedLike | null | undefined,
  expectedCycle: string,
): PublishState {
  if (state == null) return "draft";
  if (state.cycle !== expectedCycle) return "unknown";
  if (!state.published_at || Number.isNaN(Date.parse(state.published_at))) return "unknown";
  return "published";
}

// ─── Vertical (`_internal/06-shorts-published.json`, #10769/#10772) ──────────

export interface ShortEntryLike {
  status?: string | null;
  scheduled_at?: string | null;
}

/**
 * Normaliza uma entrada do registro do vertical (#573). O registro só diz o
 * que o SCRIPT fez:
 *   - `published` → "published";
 *   - `scheduled` com horário futuro → "scheduled"; com horário passado ou
 *     sem horário (X agendado na Buffer, fila do Worker) → "unknown": deveria
 *     ter saído, mas nada aqui confirma — conferir na rede antes de dizer
 *     "publicado";
 *   - `send_unknown` (timeout/5xx na criação do post) ou qualquer outro →
 *     "unknown".
 */
export function resolveShortEntryState(entry: ShortEntryLike, now: Date = new Date()): PublishState {
  if (entry.status === "published") return "published";
  if (entry.status === "scheduled") {
    const ms = Date.parse(entry.scheduled_at ?? "");
    if (Number.isNaN(ms)) return "unknown";
    return ms > now.getTime() ? "scheduled" : "unknown";
  }
  return "unknown";
}

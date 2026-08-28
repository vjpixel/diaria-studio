/**
 * beehiiv-engagement-manifest.ts (#6465, fatia 1 do epic #6464)
 *
 * Helpers puros pro manifest de cobertura da extração de per-subscriber
 * engagement (`list_post_subscriber_engagement` MCP) — o cruzamento
 * assinante × edição que NUNCA foi capturado por nenhum backup até esta
 * issue (ver `MCP_ONLY_GAPS` em `scripts/backup-beehiiv.ts`, item 2).
 *
 * Por que um manifest dedicado, separado do manifest do `backup-beehiiv.ts`
 * (que é gerado do zero a cada corrida): esta extração drena ~254 posts via
 * MCP, cada um custando 1+ chamadas paginadas — é lenta e sujeita a
 * interrupção (rate limit, sessão encerrada no meio). Precisa ser
 * **retomável**: rodar de novo só busca o que ainda não tem `status: "ok"`,
 * nunca refaz o que já foi confirmado. O manifest também é a fonte de
 * verdade sobre se o gap `mcp_only_gaps` foi fechado (nem que
 * parcialmente) — consumido por `scripts/backup-beehiiv.ts`.
 *
 * Fluxo:
 *   1. `mergeManifestPosts` — descobre novos post_ids (de um backup local
 *      ou de qualquer fonte), preserva o status de quem já foi processado.
 *   2. `pendingEntries` — lista o que falta drenar (nunca reprocessa "ok").
 *   3. `upsertEntry` — grava o resultado de 1 post depois do drain via MCP.
 *   4. `coverageSummary` — conta status; `closed: true` só quando 100% "ok".
 *
 * Tudo aqui é puro (sem IO) — o I/O (ler/escrever `manifest.json`) fica nos
 * scripts que consomem este módulo (`apply-mcp-subscriber-engagement.ts`,
 * `list-posts-for-engagement-backup.ts`).
 */

/**
 * `pending`   — descoberto, nunca tentado.
 * `ok`        — drenado com sucesso, todas as páginas confirmadas.
 * `partial`   — drenado parcialmente (paginação truncada — rate limit,
 *               timeout, sessão encerrada no meio). Conta como pendente
 *               pra efeitos de retomada.
 * `error`     — tentativa falhou (MCP indisponível, erro de escrita).
 *               Conta como pendente pra efeitos de retomada.
 */
export type EngagementEntryStatus = "pending" | "ok" | "partial" | "error";

export interface EngagementManifestEntry {
  post_id: string;
  title?: string;
  status: EngagementEntryStatus;
  /** Nº de registros de engagement gravados no JSONL deste post. */
  count?: number;
  pages_fetched?: number;
  total_pages?: number;
  /** ISO timestamp da última tentativa (sucesso ou falha). */
  fetched_at?: string;
  error?: string;
}

export interface EngagementManifest {
  generated_at: string;
  posts: EngagementManifestEntry[];
}

/**
 * Cria um manifest do zero — todo post nasce `pending`. Usado no 1º bootstrap
 * (nenhum manifest anterior em disco).
 */
export function buildInitialManifest(
  posts: Array<{ id: string; title?: string }>,
  generatedAt: string,
): EngagementManifest {
  return {
    generated_at: generatedAt,
    posts: posts.map((p) => ({ post_id: p.id, title: p.title, status: "pending" as const })),
  };
}

/**
 * Funde uma lista de posts recém-descobertos (de um backup local, por
 * exemplo) num manifest existente. Pure — nunca rebaixa o status de um post
 * já processado (`ok`/`partial`/`error` permanecem intocados), só adiciona
 * entries novas como `pending` e preenche `title` que faltava.
 *
 * Sem isso, cada re-scan do diretório de posts reconstruiria o manifest do
 * zero e apagaria o progresso já confirmado — o oposto de "retomável".
 */
export function mergeManifestPosts(
  existing: EngagementManifest,
  discovered: Array<{ id: string; title?: string }>,
  generatedAt: string,
): EngagementManifest {
  const byId = new Map<string, EngagementManifestEntry>(existing.posts.map((e) => [e.post_id, e]));
  for (const p of discovered) {
    const current = byId.get(p.id);
    if (!current) {
      byId.set(p.id, { post_id: p.id, title: p.title, status: "pending" });
    } else if (!current.title && p.title) {
      byId.set(p.id, { ...current, title: p.title });
    }
  }
  return { generated_at: generatedAt, posts: [...byId.values()] };
}

/**
 * Registra o resultado de 1 post (substitui a entry existente por post_id,
 * ou adiciona se não existia — cobre o caso do post ter sido processado
 * antes de qualquer `mergeManifestPosts` ter enumerado ele).
 */
export function upsertEntry(manifest: EngagementManifest, entry: EngagementManifestEntry): EngagementManifest {
  const posts = manifest.posts.filter((p) => p.post_id !== entry.post_id);
  posts.push(entry);
  return { ...manifest, posts };
}

/**
 * Posts que ainda precisam de trabalho — `pending`, `partial` (paginação
 * truncada) ou `error` (tentativa anterior falhou). `ok` nunca aparece aqui:
 * é justamente o que torna a extração retomável sem reprocessar o que já
 * foi confirmado.
 */
export function pendingEntries(manifest: EngagementManifest): EngagementManifestEntry[] {
  return manifest.posts.filter((p) => p.status !== "ok");
}

export interface EngagementCoverageSummary {
  total: number;
  ok: number;
  partial: number;
  error: number;
  pending: number;
  /** `true` somente quando TODO post do manifest está `ok` — sinaliza que o gap está fechado. */
  closed: boolean;
}

/**
 * Sumariza a cobertura — usado por `backup-beehiiv.ts` pra registrar no
 * PRÓPRIO manifest do backup se o gap `list_post_subscriber_engagement` foi
 * (ou não) fechado, sem tocar a MCP (leitura pura do manifest em disco).
 */
export function coverageSummary(manifest: EngagementManifest): EngagementCoverageSummary {
  const summary: EngagementCoverageSummary = { total: manifest.posts.length, ok: 0, partial: 0, error: 0, pending: 0, closed: false };
  for (const p of manifest.posts) {
    if (p.status === "ok") summary.ok++;
    else if (p.status === "partial") summary.partial++;
    else if (p.status === "error") summary.error++;
    else summary.pending++;
  }
  summary.closed = summary.total > 0 && summary.ok === summary.total;
  return summary;
}

/**
 * Extrai `{id, title}` de um arquivo de post salvo em disco — tolera os 2
 * shapes existentes no repo:
 *   - `data/beehiiv-backup/{date}/posts/{id}.json` — resposta CRUA da API
 *     REST (`backup-beehiiv.ts`), shape `{data: {id, title, ...}}` OU plano
 *     dependendo do `expand[]` pedido.
 *   - `data/beehiiv-cache/posts/{id}.json` — já desembrulhado por
 *     `beehiiv-sync.ts`, shape `{id, title, stats: {...}}`.
 * Retorna `null` se nenhum shape reconhecido tiver um `id` string.
 */
export function extractPostRefFromBackupFile(raw: unknown): { id: string; title?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const nested = obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : null;
  const id = (typeof obj.id === "string" && obj.id) || (nested && typeof nested.id === "string" && nested.id) || null;
  if (!id) return null;
  const title =
    (typeof obj.title === "string" && obj.title) ||
    (nested && typeof nested.title === "string" && nested.title) ||
    undefined;
  return { id, title };
}

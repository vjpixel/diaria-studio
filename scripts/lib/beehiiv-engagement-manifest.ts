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
 * `not_applicable` — post NUNCA foi enviado (rascunho, `publish_date: null`):
 *               não existe engajamento assinante × post pra drenar, e a MCP
 *               responde `Resource not found` (#6465, achado 01/09/2026 com
 *               `post_569ba7e3`, o único do acervo nessa condição). NÃO conta
 *               como pendente — senão a cobertura nunca fecha esperando um
 *               dado que não existe. Derivado mecanicamente do arquivo de
 *               backup do post (`isNeverSentPost`), nunca a dedo.
 */
export type EngagementEntryStatus = "pending" | "ok" | "partial" | "error" | "not_applicable";

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
  discovered: Array<{ id: string; title?: string; neverSent?: boolean }>,
  generatedAt: string,
): EngagementManifest {
  const byId = new Map<string, EngagementManifestEntry>(existing.posts.map((e) => [e.post_id, e]));
  for (const p of discovered) {
    const current = byId.get(p.id);
    // Post nunca enviado nasce (e permanece) `not_applicable` — exceto se
    // uma corrida anterior já drenou dado real dele (`ok`), que nunca é
    // rebaixado. Idempotente: re-scan reafirma o mesmo estado.
    const naStatus: EngagementManifestEntry["status"] = "not_applicable";
    if (!current) {
      byId.set(p.id, {
        post_id: p.id,
        title: p.title,
        status: p.neverSent ? naStatus : "pending",
        ...(p.neverSent ? { error: NEVER_SENT_REASON } : {}),
      });
    } else if (p.neverSent && current.status !== "ok" && current.status !== naStatus) {
      byId.set(p.id, { ...current, title: current.title ?? p.title, status: naStatus, error: NEVER_SENT_REASON });
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
  return manifest.posts.filter((p) => p.status !== "ok" && p.status !== "not_applicable");
}

export interface EngagementCoverageSummary {
  total: number;
  ok: number;
  partial: number;
  error: number;
  pending: number;
  /** Posts que nunca foram enviados — não há engajamento a drenar. */
  not_applicable: number;
  /**
   * `true` quando não sobra nada a drenar: todo post está `ok` ou
   * `not_applicable`. Rascunho nunca enviado não pode manter o gap "aberto"
   * pra sempre — mas `not_applicable` é derivado mecanicamente do arquivo de
   * backup, nunca de uma falha de MCP, então isso não mascara buraco real.
   */
  closed: boolean;
}

/**
 * Sumariza a cobertura — usado por `backup-beehiiv.ts` pra registrar no
 * PRÓPRIO manifest do backup se o gap `list_post_subscriber_engagement` foi
 * (ou não) fechado, sem tocar a MCP (leitura pura do manifest em disco).
 */
export function coverageSummary(manifest: EngagementManifest): EngagementCoverageSummary {
  const summary: EngagementCoverageSummary = { total: manifest.posts.length, ok: 0, partial: 0, error: 0, pending: 0, not_applicable: 0, closed: false };
  for (const p of manifest.posts) {
    if (p.status === "ok") summary.ok++;
    else if (p.status === "partial") summary.partial++;
    else if (p.status === "error") summary.error++;
    else if (p.status === "not_applicable") summary.not_applicable++;
    else summary.pending++;
  }
  summary.closed = summary.total > 0 && summary.ok + summary.not_applicable === summary.total;
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
export function extractPostRefFromBackupFile(raw: unknown): { id: string; title?: string; neverSent?: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const nested = obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : null;
  const id = (typeof obj.id === "string" && obj.id) || (nested && typeof nested.id === "string" && nested.id) || null;
  if (!id) return null;
  const title =
    (typeof obj.title === "string" && obj.title) ||
    (nested && typeof nested.title === "string" && nested.title) ||
    undefined;
  // `neverSent` só aparece quando VERDADEIRO — manter o shape `{id, title}`
  // pro caso comum evita que todo consumidor precise saber do campo novo.
  return isNeverSentPost(raw) ? { id, title, neverSent: true } : { id, title };
}

/**
 * 1 entrada por post `ok` que a reconciliação rebaixou — usada pro relatório
 * de `scripts/audit-engagement-manifest.ts` (#7197).
 */
export interface ManifestDowngrade {
  post_id: string;
  from: "ok";
  to: EngagementEntryStatus;
  reason: string;
}

export interface ManifestReconcileResult {
  manifest: EngagementManifest;
  downgraded: ManifestDowngrade[];
}

/** Prefixo estável dos motivos de rebaixamento — usado em teste e no `error` gravado na entry. */
export const AUDIT_REASON_PREFIX = "auditoria #7197";

/**
 * Reconcilia o manifest contra a única fonte que não pode mentir sobre si
 * mesma: as linhas de fato gravadas em disco (#7197 — "255 de 256 posts
 * marcados ok, sendo que 7 têm count: 0 e 16 têm contagem menor do que as
 * páginas drenadas comportam"). Puro — `actualCounts` é o resultado de
 * `countExistingLines` por post_id, calculado pelo script chamador (I/O
 * fica fora daqui, mesmo padrão do resto deste módulo).
 *
 * Só entries `status: "ok"` são candidatas a rebaixamento — `partial`,
 * `error`, `pending` e `not_applicable` já são tratadas como "ainda precisa
 * de trabalho" (`pendingEntries`) ou mecanicamente corretas
 * (`not_applicable`), nada a reconciliar.
 *
 * TRÊS checagens, primeira que casa vence:
 *   1. `actual === 0` — nenhum registro real em disco. Um `ok` com 0
 *      registros só é legítimo quando `not_applicable` (post nunca
 *      enviado) — se chegou aqui como `ok` "normal", é o padrão de
 *      fabricação do #6496 (agent preencheu o schema sem ter chamado a
 *      MCP). Rebaixa pra `pending` — precisa ser redrenado do zero.
 *   2. `entry.count !== actual` — o manifest e o disco divergem (paginação
 *      truncada que nunca foi corrigida, escrita concorrente, manifest
 *      restaurado de um snapshot antigo). Rebaixa pra `partial` — o disco
 *      tem ALGUM dado real (`actual > 0`), então não precisa redrenar do
 *      zero, só completar; `entry.count` é corrigido pro valor real.
 *   3. `actual < recipients` — o disco é INTERNAMENTE consistente mas está
 *      abaixo do alcance real do post. Rebaixa pra `partial`.
 *
 * ─── Por que a checagem 3 é a que importa (medido, 03/09/2026) ────────────
 *
 * As checagens 1 e 2 sozinhas rebaixam **6 posts** do acervo real. As três
 * juntas rebaixam **191**. A diferença não é de calibragem: as duas
 * primeiras comparam o manifest com o disco, e esse par bate em **256 de
 * 256** (51.620 = 51.620). O drenador é honesto sobre o que gravou — ele só
 * não sabe que gravou uma fração.
 *
 * A causa raiz é que a resposta da MCP não tem `total_pages` (só `{page,
 * per_page, count}`, onde `count` é o tamanho DAQUELA página), e o agente
 * foi instruído a paginar enquanto `pagination.total_pages > 1`. Campo
 * inexistente ⇒ `undefined > 1` ⇒ `false` ⇒ para na 1ª página. O manifest
 * então grava `total_pages` do mesmo valor ausente, produzindo
 * `pages_fetched == total_pages`, que é exatamente a condição de `ok`. Sem
 * uma âncora EXTERNA, `ok` é estruturalmente auto-satisfeito.
 *
 * `email.recipients` é essa âncora: é o teto de quantos registros de
 * engajamento podem existir pra um post, e não vem do mesmo processo que
 * gravou o arquivo.
 *
 * ─── Por que `recipients` ausente NÃO rebaixa ─────────────────────────────
 *
 * `recipientsByPost` é opcional, e post sem entrada nele é deixado como
 * está. É a divisão fail-soft-em-infra / fail-closed-em-dado que o resto do
 * repo usa: rede indisponível não pode reescrever o manifest inteiro pra
 * `partial` (o chamador perderia o acervo bom junto com o ruim), mas dado
 * PRESENTE que contradiz o `ok` sempre rebaixa. Quem quiser o veredito
 * completo tem que passar o mapa — e a cobertura fica visível no relatório
 * do chamador, nunca escondida num default.
 */
export function reconcileManifestWithDisk(
  manifest: EngagementManifest,
  actualCounts: Map<string, number>,
  recipientsByPost?: Map<string, number>,
): ManifestReconcileResult {
  const downgraded: ManifestDowngrade[] = [];
  const posts = manifest.posts.map((entry) => {
    if (entry.status !== "ok") return entry;
    const actual = actualCounts.get(entry.post_id) ?? 0;
    if (actual === 0) {
      const reason = `${AUDIT_REASON_PREFIX}: 0 registros reais em disco (manifest dizia count=${entry.count ?? 0}) — nunca "ok" sem dado, redrenar do zero`;
      downgraded.push({ post_id: entry.post_id, from: "ok", to: "pending", reason });
      return { ...entry, status: "pending" as const, count: 0, error: reason };
    }
    if (entry.count !== actual) {
      const reason = `${AUDIT_REASON_PREFIX}: manifest.count=${entry.count ?? "undefined"} divergia das linhas reais em disco (${actual})`;
      downgraded.push({ post_id: entry.post_id, from: "ok", to: "partial", reason });
      return { ...entry, status: "partial" as const, count: actual, error: reason };
    }
    const recipients = recipientsByPost?.get(entry.post_id);
    if (typeof recipients === "number" && actual < recipients) {
      const reason = `${AUDIT_REASON_PREFIX}: ${actual} registros pra um post que alcançou ${recipients} — drenagem truncada (a resposta da MCP não tem total_pages; ver docstring)`;
      downgraded.push({ post_id: entry.post_id, from: "ok", to: "partial", reason });
      return { ...entry, status: "partial" as const, error: reason };
    }
    return entry;
  });
  return { manifest: { ...manifest, posts }, downgraded };
}

/** Motivo gravado em `error` das entries `not_applicable` — texto estável, usado em teste. */
export const NEVER_SENT_REASON = "post nunca enviado (rascunho) — sem engajamento a drenar";

/**
 * `true` quando o arquivo de backup do post indica que ele NUNCA foi enviado
 * — `status: "draft"` ou `publish_date` ausente/nulo. A MCP responde
 * `Resource not found` pra esses posts (não "0 registros"), então tratá-los
 * como pendentes deixaria a cobertura eternamente aberta. Tolera os mesmos 2
 * shapes de `extractPostRefFromBackupFile` (`{data: {...}}` ou plano).
 */
export function isNeverSentPost(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  const src = obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : obj;
  if (src.status === "draft") return true;
  // `publish_date` só é null/ausente em post não publicado; posts do cache
  // (`beehiiv-sync.ts`) podem não trazer o campo — nesse shape, ausência não
  // prova rascunho, então só conta quando o campo EXISTE e é nulo.
  return "publish_date" in src && src.publish_date == null;
}

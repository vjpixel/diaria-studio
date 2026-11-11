/**
 * d1-locks.ts (#12842, grupo G2a de `docs/onedrive-dependencias-cloudflare.md`)
 *
 * Locks entre máquinas no D1 da Cloudflare: merge lock (por repo), consumo de
 * concessão de merge (`merge_grant`) e `edition-lock`. O lock em arquivo de
 * `data/` (`O_CREAT|O_EXCL`/`rename`) só exclui dentro de UM sistema de
 * arquivos: entre máquinas cada uma tem sua cópia sincronizada e as duas
 * "ganham" (#6182); com o sync parado o guard lê dado velho (#12547).
 *
 * ## Consistência do D1 (conferido em 11/11/2026)
 *
 * - https://developers.cloudflare.com/d1/best-practices/read-replication/ :
 *   o D1 tem UM primário; "All write queries are still forwarded to the
 *   primary database instance"; e, sem a Sessions API, "all queries will
 *   continue to be executed only by the primary database". A Sessions API
 *   "is only available via the D1 Worker Binding", não pela REST.
 * - https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/ :
 *   `POST /accounts/{account_id}/d1/database/{database_id}/query`, corpo
 *   `{ sql, params: string[] }`, resposta com `meta.served_by_primary`.
 *
 * Conclusão: por REST, leitura E escrita rodam no primário, mesmo com a
 * replicação de leitura ligada. Cada statement é atômico no SQLite do
 * primário, então um `INSERT ... ON CONFLICT DO UPDATE ... WHERE ...
 * RETURNING` decide sozinho quem ganha: duas máquinas concorrentes, um vence
 * (a linha volta no RETURNING), o outro recebe zero linhas. `served_by_primary
 * === false` numa resposta seria quebra dessa premissa e vira erro (cai no
 * fallback local), nunca resultado.
 *
 * ## Tempo
 *
 * O relógio é o do D1 (`NOW_MS_SQL`), não o da máquina: o TTL deixa de
 * depender de skew entre Neo e `300` (o #5161 tolerava 60 s). Teste passa
 * `now` explícito; produção passa `""` e o SQL usa o relógio do servidor.
 *
 * ## Falha
 *
 * Toda operação devolve `D1LockResult`: `{ ok: false }` = o D1 não respondeu
 * (rede, timeout, HTTP, credencial, banco não configurado). O chamador cai no
 * lock LOCAL e avisa — nunca bloqueia merge legítimo por falha transitória.
 * Parâmetros vão como string porque a REST documenta `params: string[]`; o
 * SQL faz `CAST`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";

/** Tabela única de locks. `name` é o recurso; `holder` quem segura. */
export const D1_LOCKS_SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS locks (" +
  "name TEXT PRIMARY KEY, " +
  "holder TEXT NOT NULL, " +
  "acquired_at INTEGER NOT NULL, " +
  "expires_at INTEGER NOT NULL, " +
  "meta TEXT" +
  ")";

/** Milissegundos Unix no relógio do D1 (portável: sem `unixepoch('subsec')`). */
export const NOW_MS_SQL = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

/** `?n` de tempo: `""` = relógio do D1; número em string = relógio injetado (teste). */
function nowParam(n: number): string {
  return `(CASE WHEN ?${n} = '' THEN ${NOW_MS_SQL} ELSE CAST(?${n} AS INTEGER) END)`;
}

export interface D1QueryResult {
  results: Record<string, unknown>[];
  /** `false` só se a Cloudflare disser que outra instância respondeu. */
  servedByPrimary?: boolean;
}

/** Cliente mínimo: um statement por chamada. Lança em qualquer falha. */
export interface D1Client {
  query: (sql: string, params: string[]) => Promise<D1QueryResult>;
}

export type D1LockResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const D1_REST_TIMEOUT_MS = 4_000;
const API_BASE = "https://api.cloudflare.com/client/v4";

export interface D1RestConfig {
  accountId: string;
  token: string;
  databaseId: string;
  fetchFn?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

interface D1Envelope {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: Array<{ success?: boolean; results?: unknown; meta?: { served_by_primary?: boolean } }>;
}

/** Cliente REST do D1. Mensagens de erro nunca incluem o token. */
export function createD1RestClient(cfg: D1RestConfig): D1Client {
  if (!cfg.accountId || !cfg.token || !cfg.databaseId) {
    throw new Error("createD1RestClient: accountId, token e databaseId são obrigatórios");
  }
  const rawFetch = cfg.fetchFn ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = cfg.timeoutMs ?? D1_REST_TIMEOUT_MS;
  const url =
    `${API_BASE}/accounts/${encodeURIComponent(cfg.accountId)}` +
    `/d1/database/${encodeURIComponent(cfg.databaseId)}/query`;
  return {
    async query(sql, params) {
      const res = await rawFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: D1Envelope;
      try {
        json = JSON.parse(text) as D1Envelope;
      } catch {
        throw new Error(`D1 query: HTTP ${res.status} com corpo não-JSON: ${text.slice(0, 200)}`);
      }
      if (!res.ok || json?.success === false) {
        const msgs = (json?.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ");
        throw new Error(`D1 query: HTTP ${res.status} — ${msgs || text.slice(0, 200)}`);
      }
      const first = Array.isArray(json.result) ? json.result[0] : undefined;
      if (!first || first.success === false || !Array.isArray(first.results)) {
        throw new Error(`D1 query: envelope inválido: ${text.slice(0, 200)}`);
      }
      const served = first.meta?.served_by_primary;
      return {
        results: first.results as Record<string, unknown>[],
        ...(typeof served === "boolean" ? { servedByPrimary: served } : {}),
      };
    },
  };
}

// ─── configuração ──────────────────────────────────────────────────────────

export interface D1LocksSettings {
  accountId: string;
  token: string;
  databaseId: string;
}

/**
 * Por que não: `null` = D1 desligado ou incompleto, com o motivo.
 * `unconfigured` (sem `database_id` ou desligado) é o estado normal antes do
 * provisionamento e fica silencioso; `missing-credentials` com banco
 * configurado é configuração quebrada e o chamador avisa.
 */
export type D1LocksResolution =
  | { kind: "ready"; settings: D1LocksSettings }
  | { kind: "unconfigured"; reason: string }
  | { kind: "missing-credentials"; reason: string };

/**
 * Lê `platform.config.json` → `d1_locks` + ambiente. Token: `CLOUDFLARE_D1_TOKEN`
 * (dedicado, com permissão D1) e, na falta dele, `CLOUDFLARE_API_TOKEN`.
 * `DIARIA_D1_LOCKS=off` desliga (opt-out de emergência).
 */
export function resolveD1LocksSettings(
  platformConfig: unknown,
  env: Record<string, string | undefined>,
): D1LocksResolution {
  const optOut = (env.DIARIA_D1_LOCKS ?? "").trim().toLowerCase();
  if (optOut === "0" || optOut === "off" || optOut === "false") {
    return { kind: "unconfigured", reason: "DIARIA_D1_LOCKS=off" };
  }
  const section = (platformConfig as { d1_locks?: { database_id?: unknown; enabled?: unknown } } | null)?.d1_locks;
  if (!section || section.enabled === false) return { kind: "unconfigured", reason: "d1_locks desligado" };
  const databaseId = typeof section.database_id === "string" ? section.database_id.trim() : "";
  if (!databaseId) return { kind: "unconfigured", reason: "d1_locks.database_id vazio (banco não provisionado)" };
  const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  const token = (env.CLOUDFLARE_D1_TOKEN ?? "").trim() || (env.CLOUDFLARE_API_TOKEN ?? "").trim();
  if (!accountId || !token) {
    return {
      kind: "missing-credentials",
      reason: "CLOUDFLARE_ACCOUNT_ID e CLOUDFLARE_D1_TOKEN (ou CLOUDFLARE_API_TOKEN) ausentes no ambiente",
    };
  }
  return { kind: "ready", settings: { accountId, token, databaseId } };
}

/**
 * Cliente D1 do processo, a partir do checkout `repoRoot`. `null` = sem D1
 * (o motivo vai em `onUnavailable` quando não é o silencioso `unconfigured`).
 * Sob `node --test` nunca fala com a Cloudflare real.
 */
export function d1LocksClientFromRepo(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
  onUnavailable: (reason: string) => void = () => {},
): D1Client | null {
  if (env.NODE_TEST_CONTEXT) return null;
  let cfg: unknown = null;
  try {
    const p = join(repoRoot, "platform.config.json");
    if (existsSync(p)) cfg = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    cfg = null;
  }
  // `.env` do checkout completa o que o ambiente não tem (o CLI do
  // session-registry não carrega o `.env`); o ambiente sempre vence.
  let fileEnv: Record<string, string> = {};
  try {
    const envPath = join(repoRoot, ".env");
    if (existsSync(envPath)) fileEnv = parseDotenv(readFileSync(envPath, "utf8"));
  } catch {
    fileEnv = {};
  }
  const r = resolveD1LocksSettings(cfg, { ...fileEnv, ...env });
  if (r.kind === "unconfigured") return null;
  if (r.kind === "missing-credentials") {
    onUnavailable(r.reason);
    return null;
  }
  return createD1RestClient(r.settings);
}

// ─── operações ─────────────────────────────────────────────────────────────

export interface D1LockHolder {
  holder: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface AcquireOptions {
  /** Mesma `holder` com lock vivo: renova (edition-lock) em vez de recusar (merge lock, #6334). */
  reentrant?: boolean;
  /** Assume mesmo vivo de outro (edition-lock `--force`). */
  force?: boolean;
  /** Relógio injetado (teste). Omitido = relógio do D1. */
  now?: number;
  meta?: string;
}

export interface AcquireOutcome {
  acquired: boolean;
  /** Quem segura depois da tentativa (o próprio chamador quando `acquired`). */
  current: D1LockHolder | null;
  /** O lock já era deste `holder` antes (só com `reentrant`). */
  refreshed?: boolean;
}

function toHolder(row: Record<string, unknown> | undefined): D1LockHolder | null {
  if (!row || typeof row.holder !== "string") return null;
  const acquiredAt = Number(row.acquired_at);
  const expiresAt = Number(row.expires_at);
  if (!Number.isFinite(acquiredAt) || !Number.isFinite(expiresAt)) return null;
  return { holder: row.holder, acquiredAt, expiresAt };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function run(client: D1Client, sql: string, params: string[]): Promise<Record<string, unknown>[]> {
  const r = await client.query(sql, params);
  if (r.servedByPrimary === false) {
    throw new Error("D1 respondeu de uma réplica (served_by_primary=false): sem garantia de exclusão");
  }
  return r.results;
}

export const ACQUIRE_SQL =
  "INSERT INTO locks (name, holder, acquired_at, expires_at, meta) " +
  `VALUES (?1, ?2, ${nowParam(3)}, ${nowParam(3)} + CAST(?4 AS INTEGER), NULLIF(?5, '')) ` +
  "ON CONFLICT(name) DO UPDATE SET " +
  "holder = excluded.holder, " +
  "acquired_at = CASE WHEN locks.holder = excluded.holder AND locks.expires_at > excluded.acquired_at " +
  "THEN locks.acquired_at ELSE excluded.acquired_at END, " +
  "expires_at = excluded.expires_at, meta = excluded.meta " +
  "WHERE locks.expires_at <= excluded.acquired_at " +
  "OR (?6 = '1' AND locks.holder = excluded.holder) " +
  "OR ?7 = '1' " +
  "RETURNING holder, acquired_at, expires_at";

export const READ_SQL = `SELECT holder, acquired_at, expires_at, ${nowParam(2)} AS now_ms FROM locks WHERE name = ?1`;

/**
 * Tenta tomar `name` por `ttlMs`. Ganha quando não há linha, quando a linha
 * venceu (`expires_at <= agora`), ou nos casos de `reentrant`/`force`. Em
 * corrida, o primário serializa os dois statements e só um recebe a linha no
 * RETURNING.
 */
export async function d1AcquireLock(
  client: D1Client,
  name: string,
  holder: string,
  ttlMs: number,
  opts: AcquireOptions = {},
): Promise<D1LockResult<AcquireOutcome>> {
  const now = opts.now === undefined ? "" : String(opts.now);
  try {
    const before = opts.reentrant ? await d1ReadLockRaw(client, name, now) : null;
    const rows = await run(client, ACQUIRE_SQL, [
      name,
      holder,
      now,
      String(Math.max(0, Math.round(ttlMs))),
      opts.meta ?? "",
      opts.reentrant ? "1" : "0",
      opts.force ? "1" : "0",
    ]);
    const won = toHolder(rows[0]);
    if (won && won.holder === holder) {
      const refreshed = Boolean(before && before.live && before.row.holder === holder);
      return { ok: true, value: { acquired: true, current: won, ...(opts.reentrant ? { refreshed } : {}) } };
    }
    const current = await d1ReadLockRaw(client, name, now);
    return { ok: true, value: { acquired: false, current: current?.live ? current.row : null } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

async function d1ReadLockRaw(
  client: D1Client,
  name: string,
  now: string,
): Promise<{ row: D1LockHolder; live: boolean } | null> {
  const rows = await run(client, READ_SQL, [name, now]);
  const row = toHolder(rows[0]);
  if (!row) return null;
  const nowMs = Number(rows[0]?.now_ms);
  return { row, live: Number.isFinite(nowMs) ? row.expiresAt > nowMs : true };
}

/** Quem segura `name` agora (`null` = livre ou vencido). */
export async function d1ReadLock(
  client: D1Client,
  name: string,
  opts: { now?: number } = {},
): Promise<D1LockResult<D1LockHolder | null>> {
  try {
    const r = await d1ReadLockRaw(client, name, opts.now === undefined ? "" : String(opts.now));
    return { ok: true, value: r?.live ? r.row : null };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

const RENEW_SQL =
  `UPDATE locks SET acquired_at = ${nowParam(3)}, expires_at = ${nowParam(3)} + CAST(?4 AS INTEGER) ` +
  "WHERE name = ?1 AND holder = ?2 RETURNING holder, acquired_at, expires_at";

/** Estende o TTL de um lock que `holder` já segura. Nunca cria nem rouba. */
export async function d1RenewLock(
  client: D1Client,
  name: string,
  holder: string,
  ttlMs: number,
  opts: { now?: number } = {},
): Promise<D1LockResult<boolean>> {
  try {
    const now = opts.now === undefined ? "" : String(opts.now);
    const rows = await run(client, RENEW_SQL, [name, holder, now, String(Math.max(0, Math.round(ttlMs)))]);
    return { ok: true, value: toHolder(rows[0])?.holder === holder };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

const RELEASE_SQL = "DELETE FROM locks WHERE name = ?1 AND (holder = ?2 OR ?3 = '1') RETURNING holder";

export type D1ReleaseOutcome = "released" | "not_held" | "held_by_other";

/**
 * Solta `name` só se for de `holder` (ou com `force`). Lock de outro, vivo →
 * `held_by_other`, nada apagado. Lock de outro já vencido → `not_held` (está
 * livre), também sem apagar: quem não é dono nunca apaga.
 */
export async function d1ReleaseLock(
  client: D1Client,
  name: string,
  holder: string,
  opts: { force?: boolean; now?: number } = {},
): Promise<D1LockResult<D1ReleaseOutcome>> {
  try {
    const rows = await run(client, RELEASE_SQL, [name, holder, opts.force ? "1" : "0"]);
    if (rows.length > 0) return { ok: true, value: "released" };
    const current = await d1ReadLockRaw(client, name, opts.now === undefined ? "" : String(opts.now));
    return { ok: true, value: current?.live ? "held_by_other" : "not_held" };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// ─── nomes ─────────────────────────────────────────────────────────────────

/** Merge lock por repo (#10618): `merge-lock:owner/name`. */
export function mergeLockD1Name(repo: string): string {
  return `merge-lock:${repo.toLowerCase()}`;
}

/** Edição: `edition:{AAMMDD}` — o nome do diretório é o mesmo em toda máquina. */
export function editionLockD1Name(edition: string): string {
  return `edition:${edition}`;
}

/** Consumo único de uma concessão de merge, pela identidade (concedente, beneficiária, instante). */
export function mergeGrantConsumedD1Name(grant: { grantedBy: string; grantedTo: string; grantedAt: string }): string {
  return `merge-grant-consumed:${grant.grantedBy}|${grant.grantedTo}|${grant.grantedAt}`;
}

/** Retenção da marca de consumo (igual à do registro local, `MERGE_GRANT_LEDGER_RETENTION_MS`). */
export const MERGE_GRANT_CONSUMED_D1_TTL_MS = 24 * 60 * 60 * 1000;

/** Aviso padronizado de fallback para o lock local (stderr). */
export function d1FallbackWarning(what: string, error: string): string {
  return (
    `⚠️  d1-locks (#12842): D1 indisponível em ${what} (${error}) — seguindo com o lock LOCAL de data/, ` +
    "que NÃO exclui entre máquinas (#6182). Confira se outra máquina está no mesmo recurso antes de prosseguir.\n"
  );
}

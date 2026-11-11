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
 * ou respondeu com erro. O chamador cai no lock LOCAL e avisa — nunca bloqueia
 * merge legítimo por falha do D1. `permanent` separa as duas classes:
 * transitória (rede, timeout, HTTP 5xx/429) → aviso de fallback; permanente
 * (HTTP 4xx como 401/403/404, `no such table`, resposta de réplica, envelope
 * inesperado) → aviso de ERRO de configuração, que não se resolve sozinho
 * (`d1FallbackWarning(..., permanent)`), e o chamador registra no run-log.
 * Parâmetros vão como string porque a REST documenta `params: string[]`; o
 * SQL faz `CAST`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { logEvent } from "./run-log.ts";

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

export type D1LockResult<T> = { ok: true; value: T } | { ok: false; error: string; permanent: boolean };

/** Erro HTTP do D1 com o status, para classificar transitório × permanente. */
export class D1HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "D1HttpError";
    this.status = status;
  }
}

/**
 * `true` = erro que não se resolve sozinho (credencial, banco/tabela
 * inexistente, réplica, formato inesperado). `false` = transitório (rede,
 * timeout, 5xx, 429): o fallback com aviso é o comportamento certo.
 */
export function isPermanentD1Error(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (/no such table|served_by_primary|envelope inválido/i.test(msg)) return true;
  if (e instanceof D1HttpError) return e.status !== 429 && e.status >= 400 && e.status < 500;
  return false;
}

export const D1_REST_TIMEOUT_MS = 4_000;
const API_BASE = "https://api.cloudflare.com/client/v4";

export interface D1RestConfig {
  /** Base da API (fora do default, só loopback — ver `loopbackApiBase`). */
  apiBase?: string;
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
    `${cfg.apiBase ? `${cfg.apiBase}/client/v4` : API_BASE}/accounts/${encodeURIComponent(cfg.accountId)}` +
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
        throw new D1HttpError(`D1 query: HTTP ${res.status} com corpo não-JSON: ${text.slice(0, 200)}`, res.status);
      }
      if (!res.ok || json?.success === false) {
        const msgs = (json?.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ");
        throw new D1HttpError(`D1 query: HTTP ${res.status} — ${msgs || text.slice(0, 200)}`, res.status);
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
 * Base da API sobrescrita SÓ para loopback (`DIARIA_D1_API_BASE`, teste e2e
 * do CLI com um D1 falso em 127.0.0.1). Qualquer outro host é ignorado: a
 * variável nunca desvia o token para fora da Cloudflare. Mesma regra do
 * `loopbackApiBase` do lado hook (`lib/d1-locks.mjs`).
 */
export function loopbackApiBase(env: Record<string, string | undefined> = process.env): string | null {
  const v = String(env.DIARIA_D1_API_BASE ?? "").trim();
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(v) ? v : null;
}

/**
 * Cliente D1 do processo, a partir do checkout `repoRoot`. `null` = sem D1
 * (o motivo vai em `onUnavailable` quando não é o silencioso `unconfigured`).
 * Sob `node --test` nunca fala com a Cloudflare real: só com a base loopback
 * de `DIARIA_D1_API_BASE` (o D1 falso do teste).
 */
export function d1LocksClientFromRepo(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
  onUnavailable: (reason: string) => void = () => {},
): D1Client | null {
  const apiBase = loopbackApiBase(env);
  if (env.NODE_TEST_CONTEXT && apiBase === null) return null;
  let cfg: unknown = null;
  const p = join(repoRoot, "platform.config.json");
  try {
    if (existsSync(p)) cfg = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    // Config ilegível desliga o D1 — nunca em silêncio: o banco pode estar
    // provisionado e esta máquina voltar ao lock só-local sem ninguém saber.
    onUnavailable(`platform.config.json ilegível (${errMsg(e)})`);
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
  return createD1RestClient({ ...r.settings, ...(apiBase ? { apiBase } : {}) });
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
  /**
   * Quem segura depois da tentativa (o próprio chamador quando `acquired`).
   * Na recusa pode vir `null` com o lock tomado por outro: a leitura do
   * holder falhou depois de o INSERT ter respondido sem a nossa linha.
   */
  current: D1LockHolder | null;
  /** O lock já era deste `holder` antes (só com `reentrant`). */
  refreshed?: boolean;
  /** Relógio do D1 na leitura do holder (recusa), quando disponível. */
  serverNowMs?: number;
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

function failure(e: unknown): { ok: false; error: string; permanent: boolean } {
  return { ok: false, error: errMsg(e), permanent: isPermanentD1Error(e) };
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
 *
 * `{ ok: false }` (fallback local no chamador) só quando o próprio INSERT não
 * respondeu (#12842 review P1-a). INSERT respondido sem a nossa linha é
 * derrota definitiva: se a leitura seguinte do holder falhar, volta
 * `acquired: false, current: null` — nunca `ok: false`, que faria o
 * chamador cair no lock local e GANHAR o que acabou de perder no D1.
 */
export async function d1AcquireLock(
  client: D1Client,
  name: string,
  holder: string,
  ttlMs: number,
  opts: AcquireOptions = {},
): Promise<D1LockResult<AcquireOutcome>> {
  const now = opts.now === undefined ? "" : String(opts.now);
  let before: Awaited<ReturnType<typeof d1ReadLockRaw>> = null;
  let rows: Record<string, unknown>[];
  try {
    before = opts.reentrant ? await d1ReadLockRaw(client, name, now) : null;
    rows = await run(client, ACQUIRE_SQL, [
      name,
      holder,
      now,
      String(Math.max(0, Math.round(ttlMs))),
      opts.meta ?? "",
      opts.reentrant ? "1" : "0",
      opts.force ? "1" : "0",
    ]);
  } catch (e) {
    return failure(e);
  }
  const won = toHolder(rows[0]);
  if (won && won.holder === holder) {
    const refreshed = Boolean(before && before.live && before.row.holder === holder);
    return { ok: true, value: { acquired: true, current: won, ...(opts.reentrant ? { refreshed } : {}) } };
  }
  // O D1 respondeu e a linha não é nossa: perdemos. A leitura abaixo só diz
  // QUEM ganhou; se ela falhar, a derrota continua derrota.
  try {
    const current = await d1ReadLockRaw(client, name, now);
    return {
      ok: true,
      value: {
        acquired: false,
        current: current?.live ? current.row : null,
        ...(current?.nowMs !== undefined ? { serverNowMs: current.nowMs } : {}),
      },
    };
  } catch {
    return { ok: true, value: { acquired: false, current: null } };
  }
}

async function d1ReadLockRaw(
  client: D1Client,
  name: string,
  now: string,
): Promise<{ row: D1LockHolder; live: boolean; nowMs?: number } | null> {
  const rows = await run(client, READ_SQL, [name, now]);
  const row = toHolder(rows[0]);
  if (!row) return null;
  const nowMs = Number(rows[0]?.now_ms);
  if (!Number.isFinite(nowMs)) return { row, live: true };
  return { row, live: row.expiresAt > nowMs, nowMs };
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
    return failure(e);
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
    return failure(e);
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
    return failure(e);
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

/**
 * Aviso padronizado de fallback para o lock local (stderr). `permanent`
 * (credencial, tabela, réplica) troca o texto para ERRO: não é queda
 * passageira, e o lock só-local continua até alguém corrigir a config.
 */
export function d1FallbackWarning(what: string, error: string, permanent = false): string {
  if (permanent) {
    return (
      `❌ d1-locks (#12842): ERRO PERMANENTE do D1 em ${what} (${error}) — credencial, banco ou tabela ` +
      "com problema; não se resolve sozinho. Seguindo com o lock LOCAL de data/, que NÃO exclui entre máquinas " +
      "(#6182). Corrija a configuração (npx tsx scripts/d1-locks-setup.ts --check).\n"
    );
  }
  return (
    `⚠️  d1-locks (#12842): D1 indisponível em ${what} (${error}) — seguindo com o lock LOCAL de data/, ` +
    "que NÃO exclui entre máquinas (#6182). Confira se outra máquina está no mesmo recurso antes de prosseguir.\n"
  );
}

/**
 * Relata uma falha do D1 (`r.ok === false`): aviso em stderr (`warn`) e, se
 * o erro for permanente, um evento `error` no run-log (`d1_locks_permanent_error`)
 * — alarme que não depende de alguém ler o terminal. Transitório só avisa.
 */
export function reportD1Failure(
  repoRoot: string | null,
  what: string,
  r: { error: string; permanent: boolean },
  warn: (msg: string) => void,
): void {
  warn(d1FallbackWarning(what, r.error, r.permanent));
  if (r.permanent && repoRoot) {
    logEvent(
      {
        edition: null,
        stage: null,
        agent: "d1-locks",
        level: "error",
        message: "d1_locks_permanent_error",
        details: { what, error: r.error },
      },
      repoRoot,
    );
  }
}

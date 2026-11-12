// .claude/hooks/lib/d1-locks.mjs (#12842) — lado HOOK dos locks em D1.
//
// Espelho mínimo de `scripts/lib/d1-locks.ts` (fonte do desenho, da conclusão
// sobre a consistência do D1 e das operações completas). Hooks rodam em `node`
// puro, sem `tsx`, então não importam o `.ts`; aqui fica só o que os dois
// hooks de merge precisam:
//   - ler quem segura um lock (`block-gh-pr-merge-subagent.mjs`, merge lock);
//   - ler/gravar a marca de consumo único de uma concessão de merge
//     (`block-gh-pr-merge-subagent.mjs` lê, `consume-merge-grant-on-merge.mjs`
//     grava).
// O SQL é o MESMO texto do `.ts` — paridade travada por
// `test/d1-locks-hook-12842.test.ts` ("paridade TS × hook").
//
// Fail-open de propósito: credencial ausente, banco não provisionado, rede ou
// timeout devolvem `{ ok: false }` / cliente `null`, e o hook segue com o
// lock local de `data/sessions/` (o comportamento de antes). Nunca bloqueia
// merge por o D1 não responder — mas nunca em silêncio: a falha vem com
// `permanent` (4xx, tabela ausente, réplica = erro de configuração) e o hook
// a mostra ao usuário (`systemMessage`) além do run-log.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const NOW_MS_SQL = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000) AS INTEGER)";

function nowParam(n) {
  return `(CASE WHEN ?${n} = '' THEN ${NOW_MS_SQL} ELSE CAST(?${n} AS INTEGER) END)`;
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

/** Timeout por chamada nos hooks (o hook inteiro tem 10 s no settings). */
export const D1_HOOK_TIMEOUT_MS = 3_000;
export const MERGE_GRANT_CONSUMED_D1_TTL_MS = 24 * 60 * 60 * 1000;

export function mergeLockD1Name(repo) {
  return `merge-lock:${String(repo).toLowerCase()}`;
}

export function mergeGrantConsumedD1Name(grant) {
  return `merge-grant-consumed:${grant.grantedBy}|${grant.grantedTo}|${grant.grantedAt}`;
}

/**
 * Guard de merge, para UM repo: soma ao holder do ARQUIVO desse repo
 * (`localHolder`: sessão, `null` = livre, `undefined` = leitura
 * indeterminada) o que o D1 respondeu para o MESMO repo (`d1Holders`: `[]`
 * se a leitura falhou, `[holder|null]` se respondeu). O chamador combina
 * por repo ANTES de colapsar os repos com `combineMergeLockHolders` — somar
 * o D1 ao resultado já colapsado deixaria o lock do 1º repo cobrir o 2º
 * (#12842 review P1-b). Regras:
 *   - holder VIVO de outra sessão no D1 vence sempre: é o lock que o arquivo
 *     desta máquina não enxerga (outra máquina, sync atrasado);
 *   - D1 diz que é da própria chamadora: vale o D1, que é a autoridade
 *     quando responde (o arquivo que diz outra sessão é sync defasado ou
 *     hold de fallback — `acquireMergeLockShared` o regrava);
 *   - D1 livre (`null`) NUNCA apaga o que o arquivo diz: a chamadora pode
 *     ter tomado o lock no fallback, com o D1 fora do ar, e um "livre" do D1
 *     não pode transformar esse hold legítimo em "sem lock" (nem liberar um
 *     lock alheio que só o arquivo conhece).
 */
export function combineWithD1LockHolders(localHolder, d1Holders, callerSessionId) {
  const d1Other = d1Holders.find((h) => typeof h === "string" && h !== callerSessionId);
  if (d1Other !== undefined) return d1Other;
  if (d1Holders.some((h) => h === callerSessionId)) return callerSessionId;
  return localHolder;
}

/** `true` = erro que não se resolve sozinho (mesma regra de `isPermanentD1Error` no `.ts`). */
export function isPermanentD1Error(e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (/no such table|served_by_primary|envelope inválido/i.test(msg)) return true;
  const status = typeof e?.status === "number" ? e.status : undefined;
  return status !== undefined && status !== 429 && status >= 400 && status < 500;
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

/** Lê só as chaves pedidas de um `.env` (KEY=VALUE, aspas simples/duplas opcionais). */
export function readEnvKeys(envFile, keys) {
  const out = {};
  let text;
  try {
    if (!existsSync(envFile)) return out;
    text = readFileSync(envFile, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m || !keys.includes(m[1])) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

const ENV_KEYS = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_TOKEN", "CLOUDFLARE_API_TOKEN", "DIARIA_D1_LOCKS"];

/**
 * Base da API sobrescrita SÓ para loopback (teste e2e do hook com um D1 falso
 * em 127.0.0.1). Qualquer outro host é ignorado: a variável nunca desvia o
 * token para fora da Cloudflare.
 */
export function loopbackApiBase(env = process.env) {
  const v = String(env.DIARIA_D1_API_BASE ?? "").trim();
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(v) ? v : null;
}

/**
 * Cliente D1 para o hook a partir do checkout `repoRoot`. `{ client: null,
 * reason }`: `reason` vazio = desligado/não provisionado (silencioso);
 * preenchido = configuração quebrada (o hook avisa e registra no run-log).
 * Mesma resolução de `resolveD1LocksSettings` (scripts/lib/d1-locks.ts); o
 * ambiente do processo vence o `.env`.
 */
export function d1LocksClientForHook(repoRoot, env = process.env, fetchFn = undefined) {
  const apiBase = loopbackApiBase(env);
  if (env.NODE_TEST_CONTEXT && fetchFn === undefined && apiBase === null) return { client: null, reason: "" };
  let cfg = null;
  let cfgError = "";
  try {
    const p = join(repoRoot, "platform.config.json");
    if (existsSync(p)) cfg = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    // Config ilegível desliga o D1 — nunca em silêncio.
    cfgError = `platform.config.json ilegível (${errMsg(e)})`;
    cfg = null;
  }
  if (cfgError) return { client: null, reason: cfgError };
  const fileEnv = readEnvKeys(join(repoRoot, ".env"), ENV_KEYS);
  const get = (k) => String(env[k] ?? fileEnv[k] ?? "").trim();
  const optOut = get("DIARIA_D1_LOCKS").toLowerCase();
  if (optOut === "0" || optOut === "off" || optOut === "false") return { client: null, reason: "" };
  const section = cfg?.d1_locks;
  if (!section || section.enabled === false) return { client: null, reason: "" };
  const databaseId = typeof section.database_id === "string" ? section.database_id.trim() : "";
  if (!databaseId) return { client: null, reason: "" };
  const accountId = get("CLOUDFLARE_ACCOUNT_ID");
  const token = get("CLOUDFLARE_D1_TOKEN") || get("CLOUDFLARE_API_TOKEN");
  if (!accountId || !token) return { client: null, reason: "credenciais Cloudflare ausentes" };
  return {
    client: createD1RestClient({ accountId, token, databaseId, fetchFn, ...(apiBase ? { apiBase } : {}) }),
    reason: "",
  };
}

export function createD1RestClient({
  accountId,
  token,
  databaseId,
  fetchFn,
  timeoutMs = D1_HOOK_TIMEOUT_MS,
  apiBase = "https://api.cloudflare.com",
}) {
  const doFetch = fetchFn ?? ((url, init) => fetch(url, init));
  const url =
    `${apiBase}/client/v4/accounts/` +
    `${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`;
  return {
    async query(sql, params) {
      const res = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sql, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw httpError(`D1 query: HTTP ${res.status} com corpo não-JSON`, res.status);
      }
      if (!res.ok || json?.success === false) {
        const msgs = (json?.errors ?? []).map((e) => `${e.code ?? "?"}: ${e.message ?? ""}`).join("; ");
        throw httpError(`D1 query: HTTP ${res.status} — ${msgs}`, res.status);
      }
      const first = Array.isArray(json.result) ? json.result[0] : undefined;
      if (!first || first.success === false || !Array.isArray(first.results)) throw new Error("D1 query: envelope inválido");
      if (first.meta?.served_by_primary === false) throw new Error("D1 respondeu de uma réplica (served_by_primary=false)");
      return { results: first.results };
    },
  };
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

function failure(e) {
  return { ok: false, error: errMsg(e), permanent: isPermanentD1Error(e) };
}

/** Quem segura `name` agora: `{ ok: true, value: string | null }`; falha = `{ ok: false, error, permanent }`. */
export async function d1ReadLockHolder(client, name) {
  try {
    const { results } = await client.query(READ_SQL, [name, ""]);
    const row = results[0];
    if (!row || typeof row.holder !== "string") return { ok: true, value: null };
    const expiresAt = Number(row.expires_at);
    const nowMs = Number(row.now_ms);
    if (Number.isFinite(expiresAt) && Number.isFinite(nowMs) && expiresAt <= nowMs) return { ok: true, value: null };
    return { ok: true, value: row.holder };
  } catch (e) {
    return failure(e);
  }
}

/**
 * Marca de uso único: grava `name` se ainda não existir (ou se venceu).
 * `{ ok: true, value: "claimed" | "already" }` (`"already"` = consumo duplo,
 * o chamador alarma); falha = `{ ok: false, error, permanent }`.
 */
export async function d1ClaimOnce(client, name, holder, ttlMs) {
  try {
    const { results } = await client.query(ACQUIRE_SQL, [name, holder, "", String(ttlMs), "", "0", "0"]);
    return { ok: true, value: results[0]?.holder === holder ? "claimed" : "already" };
  } catch (e) {
    return failure(e);
  }
}

/** Texto do aviso de falha do D1 mostrado ao usuário pelos hooks. */
export function d1HookFailureNotice(what, error, permanent) {
  return permanent
    ? `d1-locks (#12842): ERRO PERMANENTE do D1 em ${what} (${error}) — credencial, banco ou tabela com problema; ` +
        "valeu só o lock LOCAL, que NÃO exclui entre máquinas. Corrija: npx tsx scripts/d1-locks-setup.ts --check"
    : `d1-locks (#12842): D1 sem resposta em ${what} (${error}) — valeu só o lock LOCAL de data/sessions/, ` +
        "que NÃO exclui entre máquinas (#6182). Confira se outra máquina está mergeando.";
}

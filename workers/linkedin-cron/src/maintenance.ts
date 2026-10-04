/**
 * maintenance.ts (#9569) — manutenção periódica do Worker, rodada no cron:
 *
 *  1. Refresh do token Threads (long-lived, 60 dias). O Worker não consegue
 *     reescrever o próprio secret, então o token renovado vive no KV
 *     (`meta:threads_token`) e sobrepõe `env.THREADS_ACCESS_TOKEN`
 *     (`withRefreshedThreadsToken`). O refresh SÓ funciona com o token ainda
 *     válido — token vencido não renova (exige novo OAuth manual); nesse caso
 *     só logamos e o alarme de DLQ avisa.
 *  2. Alarme de DLQ: avisa por `ALERT_WEBHOOK_URL` (opcional) quando entram
 *     entries novas no DLQ, de qualquer canal. Sem a var, só loga.
 */
import type { Env, QueueEntry } from "./index";

export const THREADS_TOKEN_KV_KEY = "meta:threads_token";
export const DLQ_ALERT_KV_KEY = "meta:dlq_alerted";
export const THREADS_REFRESH_AFTER_MS = 30 * 24 * 3600 * 1000; // renova a cada 30d (< 60d de vida)
export const THREADS_REFRESH_RETRY_MS = 6 * 3600 * 1000; // falha: tenta de novo em 6h
export const THREADS_MIN_TOKEN_AGE_MS = 24 * 3600 * 1000; // Threads recusa refresh de token <24h

interface StoredThreadsToken {
  access_token: string;
  refreshed_at: string;
  next_attempt_at: string;
  // token do secret que originou o registro — se o editor rotacionar o secret, descartamos o KV
  seeded_from: string;
}

async function fingerprint(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readStored(env: Env): Promise<StoredThreadsToken | null> {
  const raw = await env.LINKEDIN_QUEUE.get(THREADS_TOKEN_KV_KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as StoredThreadsToken;
    return p && typeof p.access_token === "string" ? p : null;
  } catch {
    return null;
  }
}

/** Env com o token Threads renovado (KV) sobrepondo o secret, se válido p/ este secret. */
export async function withRefreshedThreadsToken(env: Env): Promise<Env> {
  if (!env.THREADS_ACCESS_TOKEN) return env;
  const stored = await readStored(env);
  if (!stored || stored.seeded_from !== (await fingerprint(env.THREADS_ACCESS_TOKEN))) return env;
  return { ...env, THREADS_ACCESS_TOKEN: stored.access_token };
}

export async function maybeRefreshThreadsToken(
  env: Env,
  now = Date.now(),
): Promise<"skipped" | "refreshed" | "failed"> {
  if (!env.THREADS_ACCESS_TOKEN) return "skipped";
  const seed = await fingerprint(env.THREADS_ACCESS_TOKEN);
  let stored = await readStored(env);
  if (stored && stored.seeded_from !== seed) stored = null; // secret rotacionado
  if (stored && now < Date.parse(stored.next_attempt_at)) return "skipped";

  const current = stored?.access_token ?? env.THREADS_ACCESS_TOKEN;
  const url =
    `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token` +
    `&access_token=${encodeURIComponent(current)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
    if (!res.ok || !data.access_token) {
      // Sem logar o token. "<24h" é esperado logo após uma renovação manual: tenta de novo mais tarde.
      console.error(`[threads-refresh] falhou HTTP ${res.status}: ${data.error?.message ?? "sem access_token"}`);
      await persist(env, current, stored?.refreshed_at ?? new Date(0).toISOString(), now + THREADS_REFRESH_RETRY_MS, seed);
      return "failed";
    }
    await persist(env, data.access_token, new Date(now).toISOString(), now + THREADS_REFRESH_AFTER_MS, seed);
    console.log("[threads-refresh] token renovado");
    return "refreshed";
  } catch (e) {
    console.error(`[threads-refresh] erro de rede: ${(e as Error).message}`);
    await persist(env, current, stored?.refreshed_at ?? new Date(0).toISOString(), now + THREADS_REFRESH_RETRY_MS, seed);
    return "failed";
  }
}

async function persist(env: Env, token: string, refreshedAt: string, nextAttemptMs: number, seed: string) {
  const rec: StoredThreadsToken = {
    access_token: token,
    refreshed_at: refreshedAt,
    next_attempt_at: new Date(nextAttemptMs).toISOString(),
    seeded_from: seed,
  };
  await env.LINKEDIN_QUEUE.put(THREADS_TOKEN_KV_KEY, JSON.stringify(rec));
}

/**
 * Alerta de DLQ: notifica entries `dlq:` ainda não avisadas (cursor = maior key
 * já avisada; keys são lex-sortable por scheduled_at). Só avança o cursor se o
 * webhook respondeu 2xx, pra retentar na próxima rodada.
 */
export async function alertNewDlqEntries(env: Env): Promise<{ new_entries: number; alerted: boolean }> {
  const list = await env.LINKEDIN_QUEUE.list({ prefix: "dlq:" });
  const cursor = (await env.LINKEDIN_QUEUE.get(DLQ_ALERT_KV_KEY)) ?? "";
  const fresh = list.keys.map((k) => k.name).filter((n) => n > cursor);
  if (fresh.length === 0) return { new_entries: 0, alerted: false };

  const samples: { channel: string; destaque: string; reason: string }[] = [];
  for (const key of fresh.slice(-5)) {
    const raw = await env.LINKEDIN_QUEUE.get(key);
    if (!raw) continue;
    try {
      const e = JSON.parse(raw) as QueueEntry;
      samples.push({ channel: e.channel ?? "linkedin", destaque: e.destaque, reason: (e.last_error ?? "?").slice(0, 300) });
    } catch {
      /* entry ilegível: conta, mas sem amostra */
    }
  }
  const text = `diar.ia.br: ${fresh.length} item(ns) novo(s) na DLQ do Worker linkedin-cron (total ${list.keys.length}). ` +
    samples.map((s) => `[${s.channel}/${s.destaque}] ${s.reason}`).join(" | ");
  console.error(`[dlq-alert] ${text}`);

  if (!env.ALERT_WEBHOOK_URL) return { new_entries: fresh.length, alerted: false };
  try {
    const res = await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text, new_entries: fresh.length, total: list.keys.length, samples }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { new_entries: fresh.length, alerted: false };
  } catch {
    return { new_entries: fresh.length, alerted: false };
  }
  await env.LINKEDIN_QUEUE.put(DLQ_ALERT_KV_KEY, fresh[fresh.length - 1]);
  return { new_entries: fresh.length, alerted: true };
}

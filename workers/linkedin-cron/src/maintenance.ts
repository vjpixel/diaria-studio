/**
 * maintenance.ts (#9569) — manutenção periódica do Worker, rodada no cron:
 *
 *  1. Refresh do token Threads (long-lived, 60 dias). O Worker não consegue
 *     reescrever o próprio secret, então o token renovado vive no KV
 *     (`meta:threads_token`) e sobrepõe `env.THREADS_ACCESS_TOKEN`
 *     (`withRefreshedThreadsToken`). O refresh SÓ funciona com o token ainda
 *     válido — token vencido não renova (exige novo OAuth manual). Por isso
 *     falha PERSISTENTE alerta (#9618) assim que o token passa de
 *     `THREADS_STALE_ALERT_MS` (45d) sem renovar — ~15 dias antes de vencer,
 *     enquanto ainda dá pra agir — em vez de esperar os posts caírem na DLQ.
 *  2. Alarme de DLQ: avisa por `ALERT_WEBHOOK_URL` (opcional) quando entram
 *     entries novas no DLQ, de qualquer canal. Sem a var, só loga. A varredura
 *     custa KV `list` (free tier 1k/dia por CONTA) e por isso NÃO roda em todo
 *     cron `*\/5` (#9618, ver `shouldSweepDlq`).
 */
import type { Env, QueueEntry } from "./index";

export const THREADS_TOKEN_KV_KEY = "meta:threads_token";
export const DLQ_ALERT_KV_KEY = "meta:dlq_alerted";
export const THREADS_REFRESH_AFTER_MS = 30 * 24 * 3600 * 1000; // renova a cada 30d (< 60d de vida)
export const THREADS_REFRESH_RETRY_MS = 6 * 3600 * 1000; // falha: tenta de novo em 6h
// #9618 — token sem renovar há mais que isto (vida útil 60d) dispara alerta.
export const THREADS_STALE_ALERT_MS = 45 * 24 * 3600 * 1000;
// #9618 — re-alerta no máximo 1x/dia enquanto a falha persistir.
export const THREADS_STALE_REALERT_MS = 24 * 3600 * 1000;

interface StoredThreadsToken {
  access_token: string;
  refreshed_at: string;
  next_attempt_at: string;
  // token do secret que originou o registro — se o editor rotacionar o secret, descartamos o KV
  seeded_from: string;
  // #9618 — quando o registro foi semeado a partir do secret (baseline da idade
  // do token enquanto ele nunca renovou: `refreshed_at` fica no epoch).
  seeded_at?: string;
  // #9618 — último alerta de token envelhecendo (dedup diário).
  stale_alerted_at?: string;
}

/**
 * Envia um alerta pro `ALERT_WEBHOOK_URL` (Slack/Discord/etc., JSON com
 * `text`/`content`). Sem a var: só `console.error` e conta como entregue (o log
 * é o canal). Retorna false se o webhook existe e falhou — o caller não marca
 * como avisado e tenta de novo depois.
 */
async function sendAlert(env: Env, text: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  console.error(text);
  if (!env.ALERT_WEBHOOK_URL) return true;
  try {
    const res = await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text, ...extra }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok;
  } catch {
    return false;
  }
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
  // Token no header Authorization (guard #7893): nunca na query string.
  const url = `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${current}` }, signal: AbortSignal.timeout(15_000) });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
    if (!res.ok || !data.access_token) {
      // Sem logar o token. "<24h" é esperado logo após uma renovação manual: tenta de novo mais tarde.
      const reason = `HTTP ${res.status}: ${data.error?.message ?? "sem access_token"}`;
      console.error(`[threads-refresh] falhou ${reason}`);
      await recordFailure(env, stored, current, seed, now, reason);
      return "failed";
    }
    await persistRefreshed(env, data.access_token, now, seed, stored);
    console.log("[threads-refresh] token renovado");
    return "refreshed";
  } catch (e) {
    const reason = `erro de rede: ${(e as Error).name}`;
    console.error(`[threads-refresh] ${reason}`);
    await recordFailure(env, stored, current, seed, now, reason);
    return "failed";
  }
}

/**
 * Idade do token em uso (ms). Baseline = última renovação; enquanto o registro
 * nunca renovou (`refreshed_at` no epoch), conta desde a semeadura a partir do
 * secret. Limitação: a idade REAL do secret na semeadura é desconhecida — o
 * alerta pode chegar mais tarde que 45d se o secret já era velho ao semear.
 *
 * `null` = idade DESCONHECIDA (#9758): registro legado, gravado pelo
 * código do #9569 antes do #9618, que nunca renovou e não tem `seeded_at`. Não
 * dá pra contar a partir de `now` (zeraria a idade de um token que pode já ter
 * ~40 dias e o alerta de 45d só sairia depois de ele vencer aos 60).
 */
function tokenAgeMs(stored: StoredThreadsToken | null, now: number): number | null {
  const refreshed = stored ? Date.parse(stored.refreshed_at) : NaN;
  if (Number.isFinite(refreshed) && refreshed > 0) return now - refreshed;
  const seeded = stored?.seeded_at ? Date.parse(stored.seeded_at) : NaN;
  if (Number.isFinite(seeded)) return now - seeded;
  return stored ? null : 0;
}

/**
 * Falha do refresh (#9618): preserva o token atual, reagenda em 6h e — se o
 * token já passou de 45d sem renovar — alerta (no máximo 1x/24h). Falha
 * transitória num token novo (ex.: "<24h" logo após renovação manual) não alerta.
 * #9758: registro legado sem `seeded_at` (idade desconhecida) alerta já na
 * falha — conservador — e NÃO ganha `seeded_at = now` (isso zeraria a idade).
 */
async function recordFailure(
  env: Env,
  stored: StoredThreadsToken | null,
  current: string,
  seed: string,
  now: number,
  reason: string,
) {
  const rec: StoredThreadsToken = {
    access_token: current,
    refreshed_at: stored?.refreshed_at ?? new Date(0).toISOString(),
    next_attempt_at: new Date(now + THREADS_REFRESH_RETRY_MS).toISOString(),
    seeded_from: seed,
    // Só semeia a baseline quando o registro nasce AGORA (sem registro, ou
    // secret rotacionado — `stored` já veio null). Registro legado mantém a
    // ausência: a idade dele é desconhecida, não zero (#9758).
    seeded_at: stored ? stored.seeded_at : new Date(now).toISOString(),
    stale_alerted_at: stored?.stale_alerted_at,
  };
  const age = tokenAgeMs(rec, now);
  const lastAlert = rec.stale_alerted_at ? Date.parse(rec.stale_alerted_at) : NaN;
  const alertDue = !Number.isFinite(lastAlert) || now - lastAlert >= THREADS_STALE_REALERT_MS;
  if ((age === null || age > THREADS_STALE_ALERT_MS) && alertDue) {
    const days = age === null ? null : Math.floor(age / 86_400_000);
    const ageText =
      days === null
        ? "token sem renovar desde antes do #9618, idade desconhecida (pode estar perto de vencer)"
        : `token sem renovar há ${days} dias`;
    const text =
      `[threads-refresh] diar.ia.br: refresh do token Threads falhando há tempo — ${ageText} ` +
      `(vence aos 60). Último erro: ${reason}. Renove o token (OAuth manual) e rode ` +
      `\`wrangler secret put THREADS_ACCESS_TOKEN\` antes que vença.`;
    if (await sendAlert(env, text, { kind: "threads-token-stale", token_age_days: days })) {
      rec.stale_alerted_at = new Date(now).toISOString();
    }
  }
  await env.LINKEDIN_QUEUE.put(THREADS_TOKEN_KV_KEY, JSON.stringify(rec));
}

async function persistRefreshed(env: Env, token: string, now: number, seed: string, stored: StoredThreadsToken | null) {
  const rec: StoredThreadsToken = {
    access_token: token,
    refreshed_at: new Date(now).toISOString(),
    next_attempt_at: new Date(now + THREADS_REFRESH_AFTER_MS).toISOString(),
    seeded_from: seed,
    seeded_at: stored?.seeded_at ?? new Date(now).toISOString(),
  };
  await env.LINKEDIN_QUEUE.put(THREADS_TOKEN_KV_KEY, JSON.stringify(rec));
}

/**
 * #9618 — gate da varredura de DLQ. O cron roda a cada 5 min e `fireDueItems`
 * já gasta 1 KV `list` por disparo (288/dia); varrer `dlq:` em todo disparo
 * somaria ≥288 `list`/dia, comendo a margem do free tier (1k/dia por conta) que
 * o editor exigiu ao voltar de `*\/3` pra `*\/5` (decisão 2026-05-12,
 * wrangler.toml). Varre só:
 *  - quando ESTE disparo moveu item pra DLQ (`firedDlq > 0`) — aviso imediato; e
 *  - no disparo do topo da hora (minuto UTC < 5 de `scheduledTime`) — pega as
 *    entries que entram por outros caminhos (alarm() do Durable Object, o path
 *    primário desde o #1168), com atraso máximo de ~1h.
 * Custo: ~24 `list`/dia (+ 1 por disparo com DLQ), em vez de 288.
 */
export function shouldSweepDlq(scheduledTime: number, firedDlq: number): boolean {
  if (firedDlq > 0) return true;
  if (!Number.isFinite(scheduledTime)) return true; // sem horário confiável: fail-open
  return new Date(scheduledTime).getUTCMinutes() < 5;
}

async function listAllDlqKeys(env: Env): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = (await env.LINKEDIN_QUEUE.list({ prefix: "dlq:", cursor })) as {
      keys: { name: string }[];
      list_complete: boolean;
      cursor?: string;
    };
    names.push(...page.keys.map((k) => k.name));
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  return names;
}

/**
 * Alerta de DLQ: notifica entries `dlq:` ainda não avisadas. Controle por
 * IDENTIDADE (conjunto de keys já avisadas, podado às keys existentes): a key
 * ordena por scheduled_at, não por hora de entrada na DLQ, então um cursor
 * lex perderia entries que chegam tarde. Só marca como avisada se o webhook
 * respondeu 2xx; sem webhook, marca após logar (evita log repetido a cada cron).
 * Nota: o overlay do token não alcança alarms DO já armados (usam o token do
 * enqueue; o antigo segue válido até expirar, margem ~30d).
 */
export async function alertNewDlqEntries(env: Env): Promise<{ new_entries: number; alerted: boolean }> {
  const all = await listAllDlqKeys(env);
  let seen: string[] = [];
  try {
    seen = JSON.parse((await env.LINKEDIN_QUEUE.get(DLQ_ALERT_KV_KEY)) ?? "[]");
    if (!Array.isArray(seen)) seen = [];
  } catch {
    seen = [];
  }
  const seenSet = new Set(seen);
  const fresh = all.filter((n) => !seenSet.has(n));
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
  const text = `diar.ia.br: ${fresh.length} item(ns) novo(s) na DLQ do Worker linkedin-cron (total ${all.length}). ` +
    samples.map((s) => `[${s.channel}/${s.destaque}] ${s.reason}`).join(" | ");
  const delivered = await sendAlert(env, `[dlq-alert] ${text}`, { new_entries: fresh.length, total: all.length, samples });
  if (!delivered) return { new_entries: fresh.length, alerted: false };
  const alerted = Boolean(env.ALERT_WEBHOOK_URL);
  const existing = new Set(all);
  await env.LINKEDIN_QUEUE.put(DLQ_ALERT_KV_KEY, JSON.stringify([...seen.filter((k) => existing.has(k)), ...fresh]));
  return { new_entries: fresh.length, alerted };
}

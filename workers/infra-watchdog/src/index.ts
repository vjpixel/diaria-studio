/** #12981: external dead-man switch. KV is the public signal; DO serializes checks. */
export const HEARTBEAT_KEY = 'infra:heartbeat:300';
export const DOWN_KEY = 'infra:300:down-since';
export const MAX_AGE = 20 * 60_000;
export function classifyHeartbeat(raw: string | null, now: number): 'fresco' | 'atrasado' | 'ausente' {
  if (!raw) return 'ausente';
  try {
    const value = JSON.parse(raw);
    const at = Date.parse(value.timestamp);
    if (typeof value.timestamp !== 'string' || typeof value.hostname !== 'string' || !value.hostname.trim() || !Number.isFinite(at) || at > now + 60_000) return 'ausente';
    return now - at > MAX_AGE ? 'atrasado' : 'fresco';
  } catch { return 'ausente'; }
}
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
/**
 * `recoveryPending` (#14136): a "voltou" e-mail that still has to go out, kept apart from
 * `downSince`/`notified` so a failing send never leaves the episode marked as already alerted.
 */
interface State {
  downSince: string | null;
  notified: boolean;
  recoveryPending?: {downSince: string; recoveredAt: string} | null;
}
const recoveryMail = (env: Env, pending: {downSince: string; recoveredAt: string}, mail: typeof sendMail) =>
  mail(env, '[infra] 300 voltou', `Heartbeat retomado. Queda detectada em ${pending.downSince}. Retorno: ${pending.recoveredAt}.`);
export interface Env {
  OPS_STATE: { get(key: string): Promise<string | null>; put(key: string, value: string): Promise<void>; delete(key: string): Promise<void> };
  WATCHDOG: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REFRESH_TOKEN: string;
  EDITOR_EMAIL: string;
}
function encode(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}
export async function sendMail(env: Env, subject: string, body: string): Promise<void> {
  if (![env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN, env.EDITOR_EMAIL].every(Boolean)) throw new Error('Gmail configuration missing');
  if (/[\r\n]/.test(env.EDITOR_EMAIL)) throw new Error('Invalid recipient');
  const auth = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', signal: AbortSignal.timeout(8_000),
    body: new URLSearchParams({client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token'}),
  });
  if (!auth.ok) throw new Error(`Gmail OAuth HTTP ${auth.status}`);
  const token = await auth.json() as {access_token: string};
  const raw = encode(`To: ${env.EDITOR_EMAIL}\r\nSubject: =?UTF-8?B?${encode(subject)}?=\r\nContent-Type: text/plain; charset=utf-8\r\nMIME-Version: 1.0\r\n\r\n${body}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sent = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', signal: AbortSignal.timeout(8_000),
    headers: {Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json'}, body: JSON.stringify({raw}),
  });
  if (!sent.ok) throw new Error(`Gmail send HTTP ${sent.status}`);
}
/** Called only under the singleton DO's concurrency barrier. Never interpret a KV read error as absence. */
export async function check(env: Env, storage: Storage, now = Date.now(), mail = sendMail): Promise<void> {
  const raw = await env.OPS_STATE.get(HEARTBEAT_KEY);
  const status = classifyHeartbeat(raw, now);
  let heartbeatError: unknown = null;
  try { await checkHeartbeat(env, storage, raw, status, now, mail); } catch (e) { heartbeatError = e; }
  // #14368: probes only mean something on a fresh beat; a stale/absent one is already the
  // outage alarm above. Run even when the heartbeat branch threw, then surface that error.
  if (status === 'fresco') await checkProbes(env, storage, raw!, mail);
  if (heartbeatError) throw heartbeatError;
}
async function checkHeartbeat(env: Env, storage: Storage, raw: string | null, status: ReturnType<typeof classifyHeartbeat>, now: number, mail: typeof sendMail): Promise<void> {
  let state = await storage.get<State>('state') ?? {downSince: null, notified: false};
  if (status !== 'fresco') {
    if (!state.downSince) {
      // A new outage supersedes an unsent "voltou" of the previous one (#14136): the new
      // outage alert is what the editor needs, and the stale recovery mail is dropped.
      state = {downSince: new Date(now).toISOString(), notified: false, recoveryPending: null};
      await storage.put('state', state);
    }
    // Reconcile even after a previous KV write failed; publish before notifying.
    await env.OPS_STATE.put(DOWN_KEY, state.downSince!);
    if (!state.notified) {
      await mail(env, '[infra] 300 sem heartbeat', `Estado: ${status}. Detectado em ${state.downSince}. Último heartbeat: ${raw ?? 'ausente'}`);
      await storage.put('state', {...state, notified: true});
    }
  } else if (state.downSince) {
    await env.OPS_STATE.delete(DOWN_KEY);
    // Close the episode BEFORE mailing (#14136): if the "voltou" send fails, the next outage
    // still starts a fresh episode and alerts; only the recovery mail is retained for retry.
    const recoveryPending = state.notified ? {downSince: state.downSince, recoveredAt: new Date(now).toISOString()} : null;
    await storage.put('state', {downSince: null, notified: false, recoveryPending});
    if (recoveryPending) {
      await recoveryMail(env, recoveryPending, mail);
      await storage.put('state', {downSince: null, notified: false, recoveryPending: null});
    }
  } else if (state.recoveryPending) {
    await recoveryMail(env, state.recoveryPending, mail);
    await storage.put('state', {...state, recoveryPending: null});
  }
}
/**
 * #14368: partial network loss on the 300. The heartbeat carries `probes: {github, r2}`
 * (`scripts/infra-300-heartbeat.ts`); a probe that fails on PROBE_FAIL_BEATS consecutive
 * beats sends one e-mail (Gmail via the Worker, so it does not depend on the GitHub or on the
 * 300's own network), and one "voltou" when it answers again. Beats are counted by distinct
 * heartbeat timestamps, never by cron runs, so a beat read twice counts once. A heartbeat
 * without `probes` (older script) or a probe in `sem-config` never alarms and never resets.
 */
export const PROBE_NAMES = ['github', 'r2'] as const;
export type ProbeName = typeof PROBE_NAMES[number];
export const PROBE_FAIL_BEATS = 3;
export const PROBE_LABELS: Record<ProbeName, string> = {github: 'api.github.com', r2: 'endpoint S3 do R2'};
export type ProbeVerdict = 'ok' | 'falha' | 'sem-sinal';
export function readProbes(raw: string): Record<ProbeName, {verdict: ProbeVerdict; detail: string}> {
  let probes: Record<string, {status?: unknown; error?: unknown; http?: unknown}> = {};
  try { const value = JSON.parse(raw); if (value && typeof value.probes === 'object' && value.probes) probes = value.probes; } catch { /* classifyHeartbeat already rejected it */ }
  const out = {} as Record<ProbeName, {verdict: ProbeVerdict; detail: string}>;
  for (const name of PROBE_NAMES) {
    const p = probes[name];
    const verdict: ProbeVerdict = p?.status === 'ok' ? 'ok' : p?.status === 'falha' ? 'falha' : 'sem-sinal';
    out[name] = {verdict, detail: verdict === 'falha' ? String(p?.error ?? 'erro desconhecido').slice(0, 200) : verdict === 'ok' ? `HTTP ${String(p?.http)}` : ''};
  }
  return out;
}
interface ProbeState {
  lastBeat: string | null;
  failBeats: number;
  since: string | null;
  notified: boolean;
  recoveryPending: {since: string; recoveredAt: string} | null;
}
const emptyProbe = (): ProbeState => ({lastBeat: null, failBeats: 0, since: null, notified: false, recoveryPending: null});
async function checkProbes(env: Env, storage: Storage, raw: string, mail: typeof sendMail): Promise<void> {
  const beat = JSON.parse(raw).timestamp as string;
  const probes = readProbes(raw);
  const all = await storage.get<Record<ProbeName, ProbeState>>('probes') ?? {} as Record<ProbeName, ProbeState>;
  for (const name of PROBE_NAMES) {
    const st = {...emptyProbe(), ...all[name]};
    if (st.lastBeat !== beat) {
      const {verdict} = probes[name];
      if (verdict === 'falha') {
        st.failBeats += 1;
        st.since ??= beat;
      } else if (verdict === 'ok') {
        // Close the episode before mailing (#14136 pattern): a failing "voltou" is retried alone.
        if (st.notified && st.since) st.recoveryPending = {since: st.since, recoveredAt: beat};
        st.failBeats = 0; st.since = null; st.notified = false;
      }
      st.lastBeat = beat;
    }
    all[name] = st;
  }
  await storage.put('probes', all);
  const errors: unknown[] = [];
  for (const name of PROBE_NAMES) {
    const st = all[name];
    try {
      if (st.recoveryPending) {
        await mail(env, `[infra] 300 voltou a acessar ${PROBE_LABELS[name]}`, `Sonda ${name} respondeu de novo. Falha desde ${st.recoveryPending.since}. Retorno: ${st.recoveryPending.recoveredAt}.`);
        all[name] = {...st, recoveryPending: null};
        await storage.put('probes', all);
      }
      if (!all[name].notified && all[name].failBeats >= PROBE_FAIL_BEATS) {
        await mail(env, `[infra] 300 sem acesso a ${PROBE_LABELS[name]}`, `O heartbeat do 300 segue chegando, mas a sonda ${name} falhou em ${all[name].failBeats} batidas seguidas, desde ${all[name].since}. Último erro: ${probes[name].detail}. Queda parcial de rede: alarmes que dependem dessa saída podem não abrir.`);
        all[name] = {...all[name], notified: true};
        await storage.put('probes', all);
      }
    } catch (e) { errors.push(e); }
  }
  if (errors.length) throw errors[0];
}
export class InfraWatchdog {
  constructor(private state: {storage: Storage; blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>}, private env: Env) {}
  async fetch(): Promise<Response> {
    await this.state.blockConcurrencyWhile(() => check(this.env, this.state.storage));
    return new Response('ok');
  }
}
export default {
  // No public mutation endpoint. Cron alone can invoke the singleton.
  fetch(): Response { return new Response('Not found', {status: 404}); },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const response = await env.WATCHDOG.get(env.WATCHDOG.idFromName('300')).fetch(new Request('https://internal/check'));
    if (!response.ok) throw new Error(`Watchdog HTTP ${response.status}`);
  },
};

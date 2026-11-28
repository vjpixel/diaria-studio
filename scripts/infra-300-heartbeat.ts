#!/usr/bin/env node
/**
 * #12981. Writes only on the expected host; --dry-run performs no network I/O.
 *
 * #14368: besides proving the Cloudflare KV is reachable (the write itself), each beat probes
 * `api.github.com` and the R2 S3 endpoint with a short HEAD and records the outcome under
 * `probes`. The value becomes `{timestamp, hostname, probes: {github, r2}}`; the
 * `workers/infra-watchdog` alarms when a probe fails on N consecutive beats. A probe failure
 * never blocks the heartbeat write: partial network loss must still show up as a fresh
 * heartbeat with a failing probe, not as a missing heartbeat.
 */
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProjectEnv } from './lib/env-loader.ts';
import { createKvRestOps } from './lib/cloudflare-kv-rest.ts';
import { resolveOpsStateKvConfig } from './lib/diaria/short-related-kv.ts';
import { isMainModule } from './lib/cli-args.ts';

export const PROBE_TIMEOUT_MS = 5_000;
export const GITHUB_PROBE_URL = 'https://api.github.com/';

/**
 * Connectivity, not health: any HTTP response (even 4xx/5xx, the R2 endpoint answers an
 * unauthenticated HEAD with 400/403) proves DNS + TCP + TLS reached the host. Only a network
 * error or the timeout counts as `falha`. `sem-config` = no endpoint to probe; never alarms.
 */
export type ProbeResult =
  | { status: 'ok'; http: number }
  | { status: 'falha'; error: string }
  | { status: 'sem-config' };

export interface HeartbeatValue {
  timestamp: string;
  hostname: string;
  probes: { github: ProbeResult; r2: ProbeResult };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** R2 S3 endpoint for the account (`r2-object-upload.ts` uses the same host). */
export function r2ProbeUrl(env: Record<string, string | undefined>): string | null {
  const id = (env.R2_ACCOUNT_ID ?? '').trim() || (env.CLOUDFLARE_ACCOUNT_ID ?? '').trim();
  return /^[A-Za-z0-9]+$/.test(id) ? `https://${id}.r2.cloudflarestorage.com/` : null;
}

export async function probe(url: string | null, fetchImpl: FetchLike, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  if (!url) return { status: 'sem-config' };
  try {
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return { status: 'ok', http: res.status };
  } catch (e) {
    const err = e as Error;
    const cause = (err as { cause?: { code?: string } }).cause?.code;
    const error = err.name === 'TimeoutError' || err.name === 'AbortError' ? `timeout ${timeoutMs}ms` : (cause ?? err.message ?? 'erro de rede');
    return { status: 'falha', error: String(error).slice(0, 120) };
  }
}

export async function buildHeartbeat(host: string, env: Record<string, string | undefined>, fetchImpl: FetchLike, now = new Date()): Promise<HeartbeatValue> {
  const [github, r2] = await Promise.all([probe(GITHUB_PROBE_URL, fetchImpl), probe(r2ProbeUrl(env), fetchImpl)]);
  return { timestamp: now.toISOString(), hostname: host, probes: { github, r2 } };
}

export interface HeartbeatDeps {
  hostname: () => string;
  fetch: FetchLike;
  kvPut: (key: string, value: string) => Promise<void>;
  loadEnv: () => void;
  env: Record<string, string | undefined>;
}

function defaultKvPut(env: Record<string, string | undefined>) {
  return async (key: string, value: string) => {
    const config = resolveOpsStateKvConfig(JSON.parse(readFileSync(resolve('platform.config.json'), 'utf8')), env);
    if (!config.ok) throw new Error(`Configuração ausente: ${config.missing.join(', ')}`);
    await createKvRestOps(config.config).put(key, value);
  };
}

export async function main(argv = process.argv.slice(2), deps?: Partial<HeartbeatDeps>): Promise<void> {
  if (argv.some(a => a !== '--dry-run')) throw new Error('Use apenas --dry-run');
  (deps?.loadEnv ?? loadProjectEnv)();
  const env = deps?.env ?? process.env;
  const host = (deps?.hostname ?? hostname)();
  const expected = env.INFRA_300_HOSTNAME;
  if (!expected || host !== expected) throw new Error('INFRA_300_HOSTNAME deve corresponder ao hostname real do 300');
  if (argv.includes('--dry-run')) {
    // No network I/O: shows the shape and the probe targets without contacting them.
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), hostname: host, probes: { github: GITHUB_PROBE_URL, r2: r2ProbeUrl(env) ?? 'sem-config' } }));
    return;
  }
  const value = await buildHeartbeat(host, env, deps?.fetch ?? ((url, init) => fetch(url, init)));
  await (deps?.kvPut ?? defaultKvPut(env))('infra:heartbeat:300', JSON.stringify(value));
}
if (isMainModule(import.meta.url)) main().catch(e => { console.error((e as Error).message); process.exitCode = 1; });

/** #14368: heartbeat probes GitHub and R2; watchdog alarms on N consecutive failing beats. No real network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, probe, r2ProbeUrl, buildHeartbeat, GITHUB_PROBE_URL } from '../scripts/infra-300-heartbeat.ts';
import { check, readProbes, PROBE_FAIL_BEATS, HEARTBEAT_KEY, type Env } from '../workers/infra-watchdog/src/index.ts';

const offline = async (): Promise<Response> => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); };

test('sonda: qualquer resposta HTTP é conectividade; erro de rede e timeout são falha; sem endpoint é sem-config', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const answer = (status: number) => async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status }); };
  assert.deepEqual(await probe('https://x/', answer(403)), { status: 'ok', http: 403 });
  assert.equal(calls[0].init.method, 'HEAD');
  assert.ok(calls[0].init.signal);
  assert.deepEqual(await probe('https://x/', offline), { status: 'falha', error: 'ENOTFOUND' });
  const hang = (_u: string, init: RequestInit) => new Promise<Response>((_r, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
  assert.deepEqual(await probe('https://x/', hang, 20), { status: 'falha', error: 'timeout 20ms' });
  assert.deepEqual(await probe(null, answer(200)), { status: 'sem-config' });
});

test('endpoint do R2: R2_ACCOUNT_ID, depois CLOUDFLARE_ACCOUNT_ID; id inválido não vira host', () => {
  assert.equal(r2ProbeUrl({ R2_ACCOUNT_ID: 'abc123', CLOUDFLARE_ACCOUNT_ID: 'zzz' }), 'https://abc123.r2.cloudflarestorage.com/');
  assert.equal(r2ProbeUrl({ CLOUDFLARE_ACCOUNT_ID: ' def456 ' }), 'https://def456.r2.cloudflarestorage.com/');
  assert.equal(r2ProbeUrl({}), null);
  assert.equal(r2ProbeUrl({ R2_ACCOUNT_ID: 'evil.com/x' }), null);
});

test('queda parcial: GitHub fora ainda grava o heartbeat, com a sonda em falha', async () => {
  const writes: [string, string][] = [];
  const fetchImpl = async (url: string) => (url === GITHUB_PROBE_URL ? offline() : new Response(null, { status: 400 }));
  await main([], { loadEnv: () => {}, env: { INFRA_300_HOSTNAME: '300', R2_ACCOUNT_ID: 'acc1' }, hostname: () => '300', fetch: fetchImpl, kvPut: async (k, v) => { writes.push([k, v]); } });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'infra:heartbeat:300');
  const value = JSON.parse(writes[0][1]);
  assert.equal(value.hostname, '300');
  assert.deepEqual(value.probes, { github: { status: 'falha', error: 'ENOTFOUND' }, r2: { status: 'ok', http: 400 } });
});

test('--dry-run não toca a rede nem o KV', async () => {
  const fail = async (): Promise<never> => { throw new Error('rede chamada no dry-run'); };
  const log = console.log;
  const out: string[] = [];
  console.log = (s: string) => { out.push(s); };
  try {
    await main(['--dry-run'], { loadEnv: () => {}, env: { INFRA_300_HOSTNAME: '300' }, hostname: () => '300', fetch: fail, kvPut: fail });
  } finally { console.log = log; }
  assert.equal(JSON.parse(out[0]).probes.r2, 'sem-config');
});

const t0 = Date.parse('2026-11-28T12:00:00Z');
function fixture() {
  const kv = new Map<string, string>();
  const data = new Map<string, unknown>();
  const storage = { async get<T>(k: string) { return data.get(k) as T | undefined; }, async put(k: string, v: unknown) { data.set(k, v); } };
  const env = { OPS_STATE: { async get(k: string) { return kv.get(k) ?? null; }, async put(k: string, v: string) { kv.set(k, v); }, async delete(k: string) { kv.delete(k); } } } as Env;
  const emails: string[] = [];
  const ctl = { up: true };
  const mail = async (_e: Env, subject: string) => { if (!ctl.up) throw Error('gmail fora'); emails.push(subject); };
  return { kv, storage, env, emails, mail, ctl };
}
async function beat(f: ReturnType<typeof fixture>, minute: number, github: 'ok' | 'falha', checks = 1) {
  const at = t0 + minute * 60_000;
  const probes = { github: github === 'ok' ? { status: 'ok', http: 200 } : { status: 'falha', error: 'ENOTFOUND' }, r2: { status: 'ok', http: 403 } };
  f.kv.set(HEARTBEAT_KEY, JSON.stringify({ timestamp: new Date(at).toISOString(), hostname: '300', probes }));
  for (let i = 0; i < checks; i++) await check(f.env, f.storage, at + i * 1000, f.mail);
}

test(`watchdog: GitHub falhando ${PROBE_FAIL_BEATS} batidas seguidas manda 1 e-mail; retorno manda 1 "voltou"`, async () => {
  const f = fixture();
  await beat(f, 0, 'falha');
  await beat(f, 5, 'falha', 3); // a mesma batida lida 3 vezes conta 1
  assert.deepEqual(f.emails, []);
  await beat(f, 10, 'falha');
  assert.deepEqual(f.emails, ['[infra] 300 sem acesso a api.github.com']);
  await beat(f, 15, 'falha');
  assert.equal(f.emails.length, 1);
  await beat(f, 20, 'ok');
  assert.deepEqual(f.emails, ['[infra] 300 sem acesso a api.github.com', '[infra] 300 voltou a acessar api.github.com']);
  await beat(f, 25, 'ok');
  assert.equal(f.emails.length, 2);
});

test('watchdog: falha intercalada com sucesso não alarma (precisa ser seguida)', async () => {
  const f = fixture();
  for (const [m, s] of [[0, 'falha'], [5, 'falha'], [10, 'ok'], [15, 'falha'], [20, 'falha']] as const) await beat(f, m, s);
  assert.deepEqual(f.emails, []);
});

test('watchdog: e-mail da sonda falhando é retentado na próxima checagem, uma vez só', async () => {
  const f = fixture();
  await beat(f, 0, 'falha');
  await beat(f, 5, 'falha');
  f.ctl.up = false;
  await assert.rejects(beat(f, 10, 'falha'));
  f.ctl.up = true;
  await check(f.env, f.storage, t0 + 11 * 60_000, f.mail);
  await check(f.env, f.storage, t0 + 12 * 60_000, f.mail);
  assert.deepEqual(f.emails, ['[infra] 300 sem acesso a api.github.com']);
});

test('watchdog: "voltou" da sonda falhando é retentado sem reabrir o episódio', async () => {
  const f = fixture();
  for (const m of [0, 5, 10]) await beat(f, m, 'falha');
  f.ctl.up = false;
  await assert.rejects(beat(f, 15, 'ok'));
  f.ctl.up = true;
  await check(f.env, f.storage, t0 + 16 * 60_000, f.mail);
  await check(f.env, f.storage, t0 + 17 * 60_000, f.mail);
  assert.deepEqual(f.emails, ['[infra] 300 sem acesso a api.github.com', '[infra] 300 voltou a acessar api.github.com']);
});

test('watchdog: heartbeat do contrato antigo (sem probes) nunca alarma sonda', async () => {
  const f = fixture();
  for (const m of [0, 5, 10, 15]) {
    f.kv.set(HEARTBEAT_KEY, JSON.stringify({ timestamp: new Date(t0 + m * 60_000).toISOString(), hostname: '300' }));
    await check(f.env, f.storage, t0 + m * 60_000, f.mail);
  }
  assert.deepEqual(f.emails, []);
  assert.equal(readProbes('{"timestamp":"x","hostname":"300"}').github.verdict, 'sem-sinal');
});

test('watchdog: heartbeat atrasado não conta batida de sonda (a queda total já é o alarme)', async () => {
  const f = fixture();
  await beat(f, 0, 'falha');
  await beat(f, 5, 'falha');
  // a mesma batida falhando, lida 30 min depois: alarme de heartbeat, nunca o de sonda
  await check(f.env, f.storage, t0 + 35 * 60_000, f.mail);
  assert.deepEqual(f.emails, ['[infra] 300 sem heartbeat']);
});

test('watchdog: falha do e-mail de "voltou" do heartbeat não impede a sonda de ser avaliada', async () => {
  const f = fixture();
  f.kv.set(HEARTBEAT_KEY, JSON.stringify({ timestamp: new Date(t0 - 40 * 60_000).toISOString(), hostname: '300' }));
  await check(f.env, f.storage, t0, f.mail); // queda do heartbeat alertada
  // Gmail recusa só o "voltou" do heartbeat: cada checagem lança, e a sonda segue contando.
  const mail = async (e: Env, subject: string) => { if (subject === '[infra] 300 voltou') throw Error('recusado'); await f.mail(e, subject); };
  for (const m of [0, 5, 10]) {
    f.kv.set(HEARTBEAT_KEY, JSON.stringify({ timestamp: new Date(t0 + m * 60_000).toISOString(), hostname: '300', probes: { github: { status: 'falha', error: 'ENOTFOUND' } } }));
    await assert.rejects(check(f.env, f.storage, t0 + m * 60_000, mail), /recusado/);
  }
  assert.deepEqual(f.emails, ['[infra] 300 sem heartbeat', '[infra] 300 sem acesso a api.github.com']);
});

test('buildHeartbeat sonda as duas e grava o contrato {timestamp, hostname, probes}', async () => {
  const v = await buildHeartbeat('300', {}, async () => new Response(null, { status: 200 }), new Date(t0));
  assert.deepEqual(v, { timestamp: new Date(t0).toISOString(), hostname: '300', probes: { github: { status: 'ok', http: 200 }, r2: { status: 'sem-config' } } });
});

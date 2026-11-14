import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, classifyHeartbeat, MAX_AGE, HEARTBEAT_KEY, DOWN_KEY, type Env } from '../workers/infra-watchdog/src/index.ts';
const now = Date.parse('2026-11-14T12:00:00Z');
const heartbeat = (at: number) => JSON.stringify({timestamp: new Date(at).toISOString(), hostname: '300'});
test('classificador: limite, atraso, ausência, corrupção e relógio futuro', () => {
  assert.equal(classifyHeartbeat(heartbeat(now - MAX_AGE), now), 'fresco');
  assert.equal(classifyHeartbeat(heartbeat(now - MAX_AGE - 1), now), 'atrasado');
  for (const raw of [null, '{}', 'bad', heartbeat(now + 120_000)]) assert.equal(classifyHeartbeat(raw, now), 'ausente');
});
function fixture() {
  const kv = new Map<string, string>();
  const data = new Map<string, unknown>();
  const storage = {async get<T>(key: string) {return data.get(key) as T | undefined;}, async put(key: string, value: unknown) {data.set(key, value);}};
  const env = {OPS_STATE: {async get(key: string) {return kv.get(key) ?? null;}, async put(key: string, value: string) {kv.set(key, value);}, async delete(key: string) {kv.delete(key);}}} as Env;
  const emails: string[] = [];
  const mail = async (_env: Env, subject: string) => {emails.push(subject);};
  return {kv, storage, env, emails, mail};
}
test('30 minutos sem heartbeat: uma queda, um retorno, nova queda independente e estado persistente', async () => {
  const f = fixture();
  f.kv.set(HEARTBEAT_KEY, heartbeat(now));
  await check(f.env, f.storage, now, f.mail);
  for (const minutes of [25, 30, 35]) await check(f.env, f.storage, now + minutes * 60_000, f.mail);
  assert.equal(f.emails.length, 1);
  assert.equal(f.kv.get(DOWN_KEY), new Date(now + 25 * 60_000).toISOString());
  f.kv.set(HEARTBEAT_KEY, heartbeat(now + 36 * 60_000));
  for (const minutes of [36, 40]) await check(f.env, f.storage, now + minutes * 60_000, f.mail);
  assert.equal(f.emails.length, 2);
  assert.equal(f.kv.has(DOWN_KEY), false);
  await check(f.env, f.storage, now + 70 * 60_000, f.mail);
  assert.equal(f.emails.length, 3);
});
test('ausente alarma; falha de email preserva sinal e permite retry', async () => {
  const f = fixture();
  await assert.rejects(check(f.env, f.storage, now, async () => {throw Error('offline');}));
  assert.ok(f.kv.has(DOWN_KEY));
  await check(f.env, f.storage, now + 1, f.mail);
  await check(f.env, f.storage, now + 2, f.mail);
  assert.equal(f.emails.length, 1);
});
test('falha de leitura não vira queda nem retorno', async () => {
  const f = fixture();
  f.env.OPS_STATE.get = async () => {throw Error('KV unavailable');};
  await assert.rejects(check(f.env, f.storage, now, f.mail));
  assert.equal(f.emails.length, 0);
  assert.equal(f.kv.has(DOWN_KEY), false);
});
test('falha de escrita do sinal é reconciliada sem perder instante de queda', async () => {
  const f = fixture();
  const put = f.env.OPS_STATE.put;
  f.env.OPS_STATE.put = async () => {throw Error('write failed');};
  await assert.rejects(check(f.env, f.storage, now, f.mail));
  assert.equal(f.emails.length, 0);
  f.env.OPS_STATE.put = put;
  await check(f.env, f.storage, now + 60_000, f.mail);
  assert.equal(f.kv.get(DOWN_KEY), new Date(now).toISOString());
  assert.equal(f.emails.length, 1);
});
test('falha ao retirar sinal não confirma retorno nem envia antes de reconciliar', async () => {
  const f = fixture();
  await check(f.env, f.storage, now, f.mail);
  f.kv.set(HEARTBEAT_KEY, heartbeat(now));
  const del = f.env.OPS_STATE.delete;
  f.env.OPS_STATE.delete = async () => {throw Error('delete failed');};
  await assert.rejects(check(f.env, f.storage, now + 1, f.mail));
  assert.equal(f.emails.length, 1);
  f.env.OPS_STATE.delete = del;
  await check(f.env, f.storage, now + 2, f.mail);
  assert.equal(f.emails.length, 2);
  assert.equal(f.kv.has(DOWN_KEY), false);
});
test('Gmail OAuth e MIME usam APIs oficiais, sem expor secrets em erros', async () => {
  const {sendMail} = await import('../workers/infra-watchdog/src/index.ts');
  const original = globalThis.fetch;
  const calls: {url: string; init?: RequestInit}[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({url: String(url), init});
    return calls.length === 1 ? Response.json({access_token: 'fake-token'}) : Response.json({id: 'sent'});
  }) as typeof fetch;
  const env = {...fixture().env, GOOGLE_CLIENT_ID: 'fake-id', GOOGLE_CLIENT_SECRET: 'fake-secret', GOOGLE_REFRESH_TOKEN: 'fake-refresh', EDITOR_EMAIL: 'editor@example.com'};
  try {
    await sendMail(env, '300 voltou', 'Olá');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
    assert.equal(calls[1].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const {raw} = JSON.parse(calls[1].init!.body as string);
    const mime = Buffer.from(raw, 'base64url').toString('utf8');
    assert.match(mime, /To: editor@example.com/);
    assert.match(mime, /Olá/);
    globalThis.fetch = (async () => new Response('secret should not appear', {status: 401})) as typeof fetch;
    await assert.rejects(sendMail(env, 'test', 'test'), {message: 'Gmail OAuth HTTP 401'});
  } finally { globalThis.fetch = original; }
});

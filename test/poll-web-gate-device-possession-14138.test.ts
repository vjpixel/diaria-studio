/**
 * test/poll-web-gate-device-possession-14138.test.ts (#14138)
 *
 * Regressão: o gate do "É IA?" emitia sessão `confirmed` para QUALQUER
 * navegador que digitasse um e-mail que já tivesse provado posse uma vez.
 * O marcador era por e-mail (`gate-email-verified:{email}`, sem TTL), e
 * `POST /jogar/gate/verify` com `{"email":"v@x.com"}` bastava para herdar a
 * identidade de voto de V em `vote.ts` (`if (session && !session.pending)`).
 *
 * Desde o #14138 a prova é amarrada ao dispositivo: quem pede o link recebe um
 * nonce em cookie HttpOnly, o clique prova posse daquele nonce, e o navegador
 * que clicou sai `confirmed` na própria resposta do `/confirm-merge`.
 *
 * Tudo aqui passa pelo `worker.fetch` real (rotas, brand namespacing do KV,
 * cookies), com KV em memória e sem rede: Brevo sem secret (`not_configured`),
 * então o token do link é lido do KV em vez do e-mail.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const VICTIM = "vitima@example.com";
const ANON_VICTIM_DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa@web.eia.diaria.local";
const ANON_ATTACKER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb@web.eia.diaria.local";

function makeMapKV(initial: Record<string, string> = {}) {
  const m = new Map<string, string>(Object.entries(initial));
  return {
    async get(key: string) {
      const v = m.get(key);
      return v === undefined ? null : v;
    },
    async getWithMetadata(key: string) {
      const v = m.get(key);
      return { value: v ?? null, metadata: null };
    },
    async put(key: string, value: string) {
      m.set(key, value);
    },
    async delete(key: string) {
      m.delete(key);
    },
    async list({ prefix = "" }: { prefix?: string; cursor?: string } = {}) {
      const keys = [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
    _map: m,
  };
}

async function setup() {
  const worker = (await import("../workers/poll/src/index.ts")).default;
  const { subscriberKvKey } = await import("../scripts/lib/shared/subscriber-verify.ts");
  const subKey = await subscriberKvKey(VICTIM);
  // V já tem ranking sob o e-mail (é o que faz o identify cair no caminho
  // órfão e mandar o link mágico).
  const pollKv = makeMapKV({
    [`web:score:${VICTIM}`]: JSON.stringify({ total: 10, correct: 8, streak: 2, last_edition: "260601", nickname: "Vi" }),
  });
  const env = {
    POLL: pollKv,
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
    COOKIE_HMAC_SECRET: "cookie-secret",
    SUBSCRIBERS_KV: makeMapKV({ [subKey]: "1" }) as unknown as KVNamespace,
  };
  return { worker, env, pollKv };
}

function cookiePair(setCookie: string | null): string {
  assert.ok(setCookie, "esperado Set-Cookie");
  return setCookie.split(";")[0];
}

/** V pede o link no aparelho dela (identify órfão) e devolve o cookie de nonce + o token do link. */
async function victimRequestsLink(worker: { fetch: (r: Request, e: never) => Promise<Response> }, env: unknown, pollKv: ReturnType<typeof makeMapKV>) {
  const res = await worker.fetch(
    new Request("https://poll.test/jogar/identify?brand=web", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.1" },
      body: JSON.stringify({ name: "Vi", email: VICTIM, anonEmail: ANON_VICTIM_DEVICE, optin: false, edition: "" }),
    }),
    env as never,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, pending: true });
  const nonceCookie = cookiePair(res.headers.get("Set-Cookie"));
  assert.match(nonceCookie, /^diaria_jogar_possession_nonce=[0-9a-f-]{36}$/);
  const tokenKey = [...pollKv._map.keys()].find((k) => k.startsWith("web:magiclink:"));
  assert.ok(tokenKey, "pending merge criado sob o prefixo do brand web");
  return { nonceCookie, token: tokenKey.slice("web:magiclink:".length) };
}

async function gateVerify(worker: { fetch: (r: Request, e: never) => Promise<Response> }, env: unknown, email: string, cookie?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json", "CF-Connecting-IP": "10.0.0.9" };
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(
    new Request("https://poll.test/jogar/gate/verify", { method: "POST", headers, body: JSON.stringify({ email }) }),
    env as never,
  );
  assert.equal(res.status, 200);
  return cookiePair(res.headers.get("Set-Cookie"));
}

async function sessionOf(sessionCookie: string) {
  const { readWebSession } = await import("../workers/poll/src/web-gate.ts");
  return readWebSession("cookie-secret", sessionCookie);
}

describe("#14138: prova de posse do gate amarrada ao dispositivo", () => {
  it("cenário da issue: depois de V clicar no link, OUTRO navegador digitando o e-mail de V recebe só PENDING e não vota como V", async () => {
    const { worker, env, pollKv } = await setup();
    const { token } = await victimRequestsLink(worker, env, pollKv);
    const confirm = await worker.fetch(new Request(`https://poll.test/confirm-merge?token=${token}&brand=web`), env as never);
    assert.equal(confirm.status, 200);

    // Atacante: navegador sem nenhum cookie, só o e-mail de V.
    const attackerSession = await gateVerify(worker, env, VICTIM);
    assert.deepEqual(await sessionOf(attackerSession), { email: VICTIM, pending: true }, "e-mail que já provou posse em outro aparelho não basta");

    const vote = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(ANON_ATTACKER)}&edition=260701&choice=A&brand=web`, {
        headers: { Cookie: attackerSession },
      }),
      env as never,
    );
    assert.equal(vote.status, 200);
    assert.ok(!pollKv._map.has(`web:vote:260701:${VICTIM}`), "voto do atacante nunca grava sob a identidade de V");
    assert.ok(pollKv._map.has(`web:vote:260701:${ANON_ATTACKER}`), "voto fica sob o token anônimo do próprio atacante");
  });

  it("o navegador que PEDIU o link é promovido a CONFIRMED depois do clique (cross-device preservado, e lê o prefixo web: certo)", async () => {
    const { worker, env, pollKv } = await setup();
    const { nonceCookie, token } = await victimRequestsLink(worker, env, pollKv);

    const before = await gateVerify(worker, env, VICTIM, nonceCookie);
    assert.deepEqual(await sessionOf(before), { email: VICTIM, pending: true }, "antes do clique, o nonce não prova nada");

    await worker.fetch(new Request(`https://poll.test/confirm-merge?token=${token}&brand=web`), env as never);

    const after = await gateVerify(worker, env, VICTIM, nonceCookie);
    assert.deepEqual(await sessionOf(after), { email: VICTIM, pending: false }, "o desktop que pediu o link vira confirmed");
  });

  it("o navegador que CLICOU no link sai CONFIRMED na própria resposta do /confirm-merge", async () => {
    const { worker, env, pollKv } = await setup();
    const { token } = await victimRequestsLink(worker, env, pollKv);
    const confirm = await worker.fetch(new Request(`https://poll.test/confirm-merge?token=${token}&brand=web`), env as never);
    assert.equal(confirm.status, 200);
    assert.deepEqual(await sessionOf(cookiePair(confirm.headers.get("Set-Cookie"))), { email: VICTIM, pending: false });
  });

  it("nonce provado para OUTRO e-mail não promove o e-mail de V (o atacante não reaproveita a própria prova)", async () => {
    const { worker, env, pollKv } = await setup();
    const { nonceCookie, token } = await victimRequestsLink(worker, env, pollKv);
    await worker.fetch(new Request(`https://poll.test/confirm-merge?token=${token}&brand=web`), env as never);

    const { subscriberKvKey } = await import("../scripts/lib/shared/subscriber-verify.ts");
    const other = "outra-pessoa@example.com";
    await (env.SUBSCRIBERS_KV as unknown as { put: (k: string, v: string) => Promise<void> }).put(await subscriberKvKey(other), "1");
    const s = await gateVerify(worker, env, other, nonceCookie);
    assert.deepEqual(await sessionOf(s), { email: other, pending: true }, "a prova é do par (nonce, e-mail)");
  });

  it("cookie de nonce malformado ou inventado → PENDING", async () => {
    const { worker, env } = await setup();
    for (const forged of ["diaria_jogar_possession_nonce=nao-e-uuid", "diaria_jogar_possession_nonce=cccccccc-cccc-4ccc-8ccc-cccccccccccc"]) {
      const s = await gateVerify(worker, env, VICTIM, forged);
      assert.deepEqual(await sessionOf(s), { email: VICTIM, pending: true });
    }
  });

  it("o marcador por e-mail do #6293 (gate-email-verified:{email}) não promove mais ninguém", async () => {
    const { worker, env, pollKv } = await setup();
    pollKv._map.set(`gate-email-verified:${VICTIM}`, "1");
    pollKv._map.set(`web:gate-email-verified:${VICTIM}`, "1");
    const s = await gateVerify(worker, env, VICTIM);
    assert.deepEqual(await sessionOf(s), { email: VICTIM, pending: true });
  });
});

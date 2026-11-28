/**
 * #14223 — o link mágico do É IA? era consumido antes das escritas no KV.
 *
 * `handleConfirmMerge` apaga `magiclink:{token}` (`consumePendingMerge`) e só
 * depois grava o marcador de posse e roda `performIdentifyMerge`. Uma falha
 * nessas escritas respondia "Tente novamente em alguns minutos", mas o 2º
 * clique no mesmo link caía em "Link inválido, expirado ou já usado".
 *
 * Regressão: com um `put` falhando depois do consumo, o MESMO link volta a
 * funcionar (token restaurado) e o 2º clique mergeia; se até a restauração
 * falhar, a mensagem não manda clicar de novo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import {
  createPendingMerge,
  generateMagicLinkToken,
  handleConfirmMerge,
  hasDevicePossessionProof,
  hasPendingMerge,
  isIdentifyLinked,
} from "../workers/poll/src/magic-link.ts";
import type { Env } from "../workers/poll/src/index.ts";

const ANON = "33333333-3333-4333-8333-333333333333@web.eia.diaria.local";

/** KV em memória cujo `put` lança enquanto `failPrefixes` tiver um prefixo
 * que case com a chave (falha seletiva por chave, como um 429 do KV). */
function makeFlakyEnv(seed: Record<string, string>) {
  const kv = makeTrackedKv(seed);
  const failPrefixes = new Set<string>();
  const realPut = kv.put.bind(kv);
  (kv as { put: typeof kv.put }).put = (async (key: string, value: string, opts?: { expirationTtl?: number }) => {
    for (const p of failPrefixes) if (key.startsWith(p)) throw new Error(`KV 429 (${p})`);
    return realPut(key, value, opts);
  }) as typeof kv.put;
  const env = {
    POLL: kv,
    POLL_SECRET: "poll-secret",
    ADMIN_SECRET: "admin-secret",
    ALLOWED_ORIGINS: "*",
  } as unknown as Env & { POLL: typeof kv };
  return { env, failPrefixes };
}

function confirmUrl(token: string): URL {
  return new URL(`https://eia.diar.ia.br/confirm-merge?token=${token}&brand=web`);
}

const SEED = {
  "score:ana@x.com": JSON.stringify({ total: 10, correct: 8, streak: 3, last_edition: "260601", nickname: "Ana" }),
  [`score:${ANON}`]: JSON.stringify({ total: 2, correct: 1, streak: 1, last_edition: "260615" }),
};

async function silenceConsoleError<T>(fn: () => Promise<T>): Promise<T> {
  const orig = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = orig;
  }
}

describe("handleConfirmMerge restaura o token quando uma escrita falha depois do consumo (#14223)", () => {
  it("falha no merge de score: 1º clique diz 'tente novamente', 2º clique no MESMO link mergeia", async () => {
    const { env, failPrefixes } = makeFlakyEnv(SEED);
    const token = await createPendingMerge(env, { email: "ana@x.com", anonEmail: ANON, name: "Ana", edition: "", optin: false });

    failPrefixes.add("score:");
    const first = await silenceConsoleError(() => handleConfirmMerge(confirmUrl(token), env));
    assert.equal(first.status, 400);
    assert.match(await first.text(), /Tente novamente em alguns minutos/);
    assert.equal(await hasPendingMerge(env, "ana@x.com", ANON), true, "token e índice pending-for restaurados");

    failPrefixes.clear();
    const second = await handleConfirmMerge(confirmUrl(token), env);
    assert.equal(second.status, 200, "o mesmo link volta a funcionar depois da falha transitória");
    const merged = JSON.parse((await env.POLL.get("score:ana@x.com"))!);
    assert.equal(merged.total, 12, "merge aplicado uma vez (10 + 2)");
    assert.equal(await isIdentifyLinked(env, "ana@x.com", ANON), true);

    const third = await handleConfirmMerge(confirmUrl(token), env);
    assert.equal(third.status, 400, "depois do sucesso o link segue de uso único");
    assert.match(await third.text(), /inválido, expirado ou já usado/);
  });

  it("falha no marcador de posse: mesmo link continua utilizável e o 2º clique prova a posse", async () => {
    const { env, failPrefixes } = makeFlakyEnv(SEED);
    const nonce = generateMagicLinkToken();
    const token = await createPendingMerge(env, {
      email: "ana@x.com", anonEmail: ANON, name: "Ana", edition: "", optin: false, deviceNonce: nonce,
    });

    failPrefixes.add("gate-device-possession:");
    const first = await silenceConsoleError(() => handleConfirmMerge(confirmUrl(token), env));
    assert.equal(first.status, 400);
    assert.match(await first.text(), /Tente novamente em alguns minutos/);

    failPrefixes.clear();
    const second = await handleConfirmMerge(confirmUrl(token), env);
    assert.equal(second.status, 200);
    assert.equal(await hasDevicePossessionProof(env.POLL, nonce, "ana@x.com"), true);
  });

  it("se a própria restauração falha, a mensagem manda pedir um novo link, nunca clicar de novo", async () => {
    const { env, failPrefixes } = makeFlakyEnv(SEED);
    const token = await createPendingMerge(env, { email: "ana@x.com", anonEmail: ANON, name: "Ana", edition: "", optin: false });

    failPrefixes.add("score:");
    failPrefixes.add("magiclink:");
    const res = await silenceConsoleError(() => handleConfirmMerge(confirmUrl(token), env));
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.doesNotMatch(html, /Tente novamente/);
    assert.match(html, /peça um novo link/);
  });
});

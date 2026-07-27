/**
 * test/poll-seqstate-postgate-identity-4115-4116.test.ts (#4115, #4116)
 *
 * Achados do review completo do "É IA?" (260727). Ambos são regressões
 * introduzidas pelo gate por rodada (#4054) e pelo modo sequência (#3589)
 * não terem sido reconciliados.
 *
 * #4115 — `handleVote` reescreve o e-mail do voto pro e-mail real assim que a
 * request carrega cookie de sessão (#4054). `handleJogarSeqState` não recebia
 * `request`, então lia SEMPRE `vote:{ed}:{token}` e reportava `voted:false`
 * pra tudo que o jogador votou depois de se identificar no gate — ele
 * re-jogava os pares, o clique caía no caminho "já votou", e o client pulava
 * sem creditar. Placar final subestimado.
 *
 * O mesmo jogador legitimamente tem voto nas DUAS chaves: sob o token (a
 * rodada livre, pré-gate) e sob o e-mail real (pós-gate). Por isso o fix
 * consulta as duas identidades — trocar uma pela outra perderia a rodada livre.
 *
 * #4116 — `voteAndReveal` nunca checava `res.ok`; o veredito saía só do
 * prefixo da `.msg`. Como nenhuma mensagem de erro do `/vote` tem prefixo
 * check/x, todo erro (400/403/410/5xx) virava `correct:null` — o MESMO sinal
 * de "já votou" — e a rodada era descartada em silêncio logando
 * `seq_skip_already_voted_race`, mascarando falha real em produção.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSeqStateEditionsParam,
  renderJogarSequencePageHtml,
  SEQ_STATE_MAX_EDITIONS,
} from "../workers/poll/src/jogar.ts";
import { issueWebSessionCookie } from "../workers/poll/src/web-gate.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

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

const COOKIE_SECRET = "cookie-secret";
const makeEnv = (seed: Record<string, string> = {}): Env => ({
  POLL: makeMapKV(seed),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
  COOKIE_HMAC_SECRET: COOKIE_SECRET,
} as unknown as Env);

// Token anônimo válido (UUID v4 sob o domínio reservado) — `isValidWebToken`.
const TOKEN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301@web.eia.diaria.local";
const REAL_EMAIL = "leitor@example.com";

async function seqState(env: Env, editions: string[], cookie?: string): Promise<Array<{ edition: string; voted: boolean; correct: boolean | null }>> {
  const url = `https://poll.test/jogar/seq-state?email=${encodeURIComponent(TOKEN)}&editions=${editions.join(",")}`;
  const res = await worker.fetch(
    new Request(url, cookie ? { headers: { Cookie: cookie } } : undefined),
    env,
  );
  assert.equal(res.status, 200);
  return res.json() as never;
}

describe("GET /jogar/seq-state — identidade pós-gate (#4115)", () => {
  it("REGRESSÃO: voto gravado sob o E-MAIL REAL (pós-gate) é reconhecido quando há cookie de sessão", async () => {
    // Exatamente o que handleVote grava depois do override do #4054.
    const env = makeEnv({
      [`web:vote:260602:${REAL_EMAIL}`]: JSON.stringify({ choice: "A", correct: true }),
    });
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];

    const withCookie = await seqState(env, ["260602"], cookie);
    assert.deepEqual(withCookie, [{ edition: "260602", voted: true, correct: true }]);

    // Sem o cookie o endpoint não tem como saber a identidade real — segue
    // reportando não-votado (comportamento pré-#4054, preservado).
    const withoutCookie = await seqState(env, ["260602"]);
    assert.deepEqual(withoutCookie, [{ edition: "260602", voted: false, correct: null }]);
  });

  it("voto da RODADA LIVRE (sob o token, pré-gate) continua reconhecido mesmo com sessão ativa", async () => {
    // O fix não pode trocar uma identidade pela outra: o histórico é misto.
    const env = makeEnv({
      [`web:vote:260601:${TOKEN}`]: JSON.stringify({ choice: "B", correct: false }),
    });
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    const state = await seqState(env, ["260601"], cookie);
    assert.deepEqual(state, [{ edition: "260601", voted: true, correct: false }]);
  });

  it("histórico MISTO (rodada livre sob token + rodadas seguintes sob e-mail) é resolvido inteiro", async () => {
    const env = makeEnv({
      [`web:vote:260601:${TOKEN}`]: JSON.stringify({ choice: "A", correct: true }),
      [`web:vote:260602:${REAL_EMAIL}`]: JSON.stringify({ choice: "B", correct: false }),
      [`web:vote:260603:${REAL_EMAIL}`]: JSON.stringify({ choice: "A", correct: true }),
    });
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    const state = await seqState(env, ["260601", "260602", "260603", "260604"], cookie);
    assert.deepEqual(state, [
      { edition: "260601", voted: true, correct: true },
      { edition: "260602", voted: true, correct: false },
      { edition: "260603", voted: true, correct: true },
      { edition: "260604", voted: false, correct: null },
    ]);
  });

  it("cookie FORJADO (secret errado) não concede identidade — só o token vale", async () => {
    const env = makeEnv({
      [`web:vote:260602:${REAL_EMAIL}`]: JSON.stringify({ choice: "A", correct: true }),
    });
    const forged = (await issueWebSessionCookie("secret-errado", REAL_EMAIL)).split(";")[0];
    const state = await seqState(env, ["260602"], forged);
    assert.deepEqual(state, [{ edition: "260602", voted: false, correct: null }]);
  });

  it("token continua obrigatório no parâmetro, mesmo com cookie válido (guard #3976/#4011 intocado)", async () => {
    const env = makeEnv();
    const cookie = (await issueWebSessionCookie(COOKIE_SECRET, REAL_EMAIL)).split(";")[0];
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(REAL_EMAIL)}&editions=260601`, {
        headers: { Cookie: cookie },
      }),
      env,
    );
    assert.equal(res.status, 400);
  });
});

describe("parseSeqStateEditionsParam — teto de edições (#4115)", () => {
  it("descarta o excedente acima do teto em vez de inflar as subrequests", () => {
    const many = Array.from({ length: SEQ_STATE_MAX_EDITIONS + 25 }, (_, i) =>
      `2606${String((i % 28) + 1).padStart(2, "0")}`,
    ).join(",");
    assert.equal(parseSeqStateEditionsParam(many).length, SEQ_STATE_MAX_EDITIONS);
  });

  it("lista normal (mês inteiro) passa intacta", () => {
    const normal = Array.from({ length: 31 }, (_, i) => `2606${String(i + 1).padStart(2, "0")}`);
    assert.equal(parseSeqStateEditionsParam(normal.join(",")).length, 31);
  });
});

describe("voteAndReveal — erro HTTP distinto de 'já votou' (#4116)", () => {
  const html = renderJogarSequencePageHtml(["260601", "260602"]);

  it("REGRESSÃO: o status da resposta é capturado (antes só o corpo era lido)", () => {
    assert.match(html, /ok: res\.ok, status: res\.status, html: html/);
  });

  it("REGRESSÃO: resposta não-ok vira httpError, não cai no branch de 'já votou'", () => {
    assert.match(html, /if \(!resp\.ok\)/);
    assert.match(html, /return \{ httpError: true, status: resp\.status \}/);
  });

  it("5xx tenta de novo uma vez; 4xx não (é determinístico)", () => {
    assert.match(html, /if \(resp\.status >= 500 && attempt < 1\) return voteAndReveal\(voteUrl, attempt \+ 1\)/);
  });

  it("REGRESSÃO: erro HTTP loga evento PRÓPRIO com status, não seq_skip_already_voted_race", () => {
    assert.match(html, /if \(result\.httpError\)/);
    assert.match(html, /"seq_vote_http_error"/);
    assert.match(html, /status: result\.status/);
    // O branch de "já votou" continua existindo, separado.
    assert.match(html, /"seq_skip_already_voted_race"/);
  });

  it("o check de httpError vem ANTES do check de correct === null (senão o erro cairia no branch errado)", () => {
    const iHttp = html.indexOf("result.httpError");
    const iNull = html.indexOf("result.correct === null");
    assert.ok(iHttp > -1 && iNull > -1, "ambos os branches devem existir");
    assert.ok(iHttp < iNull, "httpError precisa ser avaliado primeiro");
  });
});

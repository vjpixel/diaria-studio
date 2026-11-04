/**
 * test/poll-vote-signup-order-12040.test.ts (#12040 item 2)
 *
 * Teste da ORDEM do pedido de cadastro na tela de resultado do voto (brand
 * clarice): metade dos leitores (split determinístico por e-mail) vê a caixa
 * de cadastro logo depois da mensagem, antes do par de imagens; a outra metade
 * mantém a ordem de sempre (caixa depois do resultado). O braço "topo" grava o
 * cadastro com `referringSite` próprio, pra medir os dois braços.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import worker, { hmacSign, votePageHtml } from "../workers/poll/src/index.ts";
import {
  resolveVoteSignupPlacement,
  type VoteSignupPlacement,
} from "../workers/poll/src/lib.ts";
import {
  VOTE_CLARICE_SET_NAME_REFERRING_SITE,
  VOTE_CLARICE_SET_NAME_TOPO_REFERRING_SITE,
} from "../workers/poll/src/subscribe.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

const SECRET = "test-secret";

function findEmail(placement: VoteSignupPlacement): string {
  for (let i = 0; i < 1000; i++) {
    const email = `leitor${i}@example.com`;
    if (resolveVoteSignupPlacement(email, "clarice", true) === placement) return email;
  }
  throw new Error(`nenhum e-mail no braço ${placement}`);
}

const TOPO_EMAIL = findEmail("topo");
const ABAIXO_EMAIL = findEmail("abaixo");

const RESULT_IMAGES = { edition: "261103", aiSide: "A" as const, clickedSide: "B" as const };

function render(email: string, opts: { brand?: "clarice" | "diaria"; box?: "A" | "B"; offer?: boolean } = {}): string {
  const brand = opts.brand ?? "clarice";
  const box = opts.box ?? "A";
  const nicknameForm = box === "A" ? { email, sig: "sig" } : null;
  const subscribeBox = box === "B" ? { email, sig: "sig", nickname: "Ana" } : null;
  return votePageHtml(
    "Acertou!", true, nicknameForm, RESULT_IMAGES, null, brand,
    null, null, null, subscribeBox, opts.offer ?? brand === "clarice",
  );
}

function boxIdx(html: string): number {
  return html.indexOf('<div class="nick-box');
}

describe("resolveVoteSignupPlacement (#12040)", () => {
  it("determinístico: o mesmo leitor vê sempre a mesma ordem (case-insensitive)", () => {
    assert.equal(resolveVoteSignupPlacement(TOPO_EMAIL, "clarice", true), "topo");
    assert.equal(resolveVoteSignupPlacement(TOPO_EMAIL.toUpperCase(), "clarice", true), "topo");
    assert.equal(resolveVoteSignupPlacement(ABAIXO_EMAIL, "clarice", true), "abaixo");
  });

  it("split perto de 50/50 numa amostra de 2000 e-mails", () => {
    let topo = 0;
    for (let i = 0; i < 2000; i++) {
      if (resolveVoteSignupPlacement(`amostra${i}@example.org`, "clarice", true) === "topo") topo++;
    }
    assert.ok(topo > 850 && topo < 1150, `topo=${topo} fora de 850..1150`);
  });

  it("fora do brand clarice, sem oferta de cadastro ou com o teste desligado → sempre abaixo", () => {
    assert.equal(resolveVoteSignupPlacement(TOPO_EMAIL, "diaria", true), "abaixo");
    assert.equal(resolveVoteSignupPlacement(TOPO_EMAIL, "web", true), "abaixo");
    assert.equal(resolveVoteSignupPlacement(TOPO_EMAIL, "clarice", false), "abaixo");
    assert.equal(resolveVoteSignupPlacement(TOPO_EMAIL, "clarice", true, false), "abaixo");
  });
});

describe("votePageHtml: ordem da caixa de cadastro por braço (#12040)", () => {
  it("braço topo, Caixa A: caixa entre a mensagem e as imagens, form leva pos=topo", () => {
    const html = render(TOPO_EMAIL);
    const msg = html.indexOf('<p class="msg">');
    const box = boxIdx(html);
    const images = html.indexOf('<div class="result-images">');
    assert.ok(msg >= 0 && box >= 0 && images >= 0);
    assert.ok(msg < box && box < images, "caixa deve vir depois da mensagem e antes das imagens");
    assert.match(html, /<input type="hidden" name="pos" value="topo">/);
    assert.equal(html.split('<div class="nick-box').length - 1, 1, "a caixa aparece uma vez só");
  });

  it("braço abaixo, Caixa A: ordem de sempre (imagens antes da caixa), sem pos", () => {
    const html = render(ABAIXO_EMAIL);
    assert.ok(html.indexOf('<div class="result-images">') < boxIdx(html));
    assert.doesNotMatch(html, /name="pos"/);
  });

  it("braço topo, Caixa B (assinatura): também sobe e leva pos=topo", () => {
    const html = render(TOPO_EMAIL, { box: "B" });
    assert.ok(boxIdx(html) >= 0);
    assert.ok(boxIdx(html) < html.indexOf('<div class="result-images">'));
    assert.match(html, /class="nick-sub-form">[\s\S]*name="pos" value="topo"/);
  });

  it("form de retry do /set-name (sem oferta de cadastro) nunca muda de posição", () => {
    const html = render(TOPO_EMAIL, { offer: false });
    assert.ok(html.indexOf('<div class="result-images">') < boxIdx(html));
    assert.doesNotMatch(html, /name="pos"/);
  });

  it("brand diaria: ordem de sempre, mesmo pra e-mail do braço topo", () => {
    const html = render(TOPO_EMAIL, { brand: "diaria" });
    assert.ok(html.indexOf('<div class="result-images">') < boxIdx(html));
    assert.doesNotMatch(html, /name="pos"/);
  });
});

describe("/set-name: referringSite por braço do teste de ordem (#12040)", () => {
  async function setNameReferringSite(pos: string | null): Promise<string | undefined> {
    // handleSetName normaliza o e-mail pra minúsculas antes do hmacVerify.
    const email = `setname-${(pos ?? "none").toLowerCase()}@example.com`;
    const sig = await hmacSign(SECRET, `setname:${email}`);
    const kv = makeTrackedKv({ [`clarice:score:${email}`]: JSON.stringify({ total: 1, nickname: null }) });
    const env = makePollEnv(kv);
    env.BEEHIIV_API_KEY = "test-key";
    env.BEEHIIV_PUBLICATION_ID = "pub_test";
    const url = new URL("https://poll.test/set-name");
    url.searchParams.set("email", email);
    url.searchParams.set("name", `Nome${pos ?? ""}`.slice(0, 40));
    url.searchParams.set("sig", sig);
    url.searchParams.set("brand", "clarice");
    url.searchParams.set("optin", "on");
    if (pos !== null) url.searchParams.set("pos", pos);

    let referringSite: string | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      referringSite = body.referring_site;
      return new Response(JSON.stringify({ data: { id: "sub_1" } }), { status: 201 });
    }) as typeof fetch;
    try {
      const res = await worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
      assert.equal(res.status, 302);
      assert.match(res.headers.get("Location") ?? "", /signup=subscribed/);
    } finally {
      globalThis.fetch = originalFetch;
    }
    return referringSite;
  }

  it("pos=topo → referringSite do braço topo", async () => {
    assert.equal(await setNameReferringSite("topo"), VOTE_CLARICE_SET_NAME_TOPO_REFERRING_SITE);
  });

  it("sem pos → referringSite do controle (inalterado)", async () => {
    assert.equal(await setNameReferringSite(null), VOTE_CLARICE_SET_NAME_REFERRING_SITE);
  });

  it("pos com outro valor → controle (só 'topo' exato conta)", async () => {
    assert.equal(await setNameReferringSite("TOPO-x"), VOTE_CLARICE_SET_NAME_REFERRING_SITE);
  });

  it("os dois referringSite são distintos", () => {
    assert.notEqual(VOTE_CLARICE_SET_NAME_TOPO_REFERRING_SITE, VOTE_CLARICE_SET_NAME_REFERRING_SITE);
  });
});

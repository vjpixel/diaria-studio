/**
 * test/poll-jogar-suspense-3595.test.ts (#3595)
 *
 * Segundo review do editor sobre a sequência web (#3589), no mesmo dia do
 * deploy (260716). TRÊS mudanças num PR só:
 *
 *   1. Rótulo dos botões sem sufixo "(A)"/"(B)" — a posição embaixo de cada
 *      imagem já identifica a escolha; `data-choice`/`value` internos
 *      (o que de fato vai pro /vote) são intocados.
 *   2. Modelo "Suspense": clique avança IMEDIATAMENTE (sem esperar o /vote),
 *      que roda em BACKGROUND — sem reveal "Acertou!/Errou" por rodada; o
 *      placar + lista de erros só aparecem na tela final, depois de
 *      `Promise.all(pending)`.
 *   3. Skip-and-credit: `GET /jogar/seq-state` reporta voted/correct por
 *      edição pro token consultante (anti-spoiler: correct só quando
 *      voted===true) — a play list vira só as NÃO votadas; edições já
 *      votadas são pré-creditadas/marcadas como erro conhecido sem
 *      re-votar.
 *
 * Cobre:
 *   - Botões "Essa é a IA" (sem "(A)"/(B)") no par único E na sequência,
 *     `data-choice`/`value` preservados.
 *   - `parseSeqStateEditionsParam` (pure) — parseia o CSV de AAMMDD.
 *   - `handleJogarSeqState` (`GET /jogar/seq-state`) — voted/correct por
 *     edição, anti-spoiler (correct===null pra não-votadas), reusa a MESMA
 *     chave `vote:{edition}:{email}` de vote.ts (zero esquema novo).
 *   - `computeSeqSkipAndCredit` (pure) — monta a play list (só não-votadas),
 *     soma pré-crédito (voted&&correct===true) e erros conhecidos
 *     (voted&&correct===false).
 *   - `renderJogarSequencePageHtml` — modelo Suspense embutido no script
 *     (avanço síncrono, voto em background, sem reveal por rodada, consulta
 *     seq-state antes de montar a play list, `?reset=1` limpa identidade
 *     local).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeSeqSkipAndCredit,
  parseSeqStateEditionsParam,
  renderJogarPageHtml,
  renderJogarSequencePageHtml,
  type SeqStateEntry,
} from "../workers/poll/src/jogar.ts";
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

const makeEnv = (seed: Record<string, string> = {}): Env & { POLL: ReturnType<typeof makeMapKV> } => ({
  POLL: makeMapKV(seed),
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
});

// ── (a) rótulo dos botões sem "(A)"/"(B)" ───────────────────────────────────

describe("botão 'Essa é a IA' sem sufixo A/B (#3595 item 1)", () => {
  it("renderJogarPageHtml (par único): rótulo visível sem '(A)'/'(B)', value A/B interno preservado", () => {
    const html = renderJogarPageHtml({ edition: "260101", revealed: true });
    assert.match(html, /<button type="submit" name="choice" value="A">Essa é a IA<\/button>/);
    assert.match(html, /<button type="submit" name="choice" value="B">Essa é a IA<\/button>/);
    assert.doesNotMatch(html, /Essa é a IA \(A\)/);
    assert.doesNotMatch(html, /Essa é a IA \(B\)/);
  });

  it("renderJogarSequencePageHtml: mesmo rótulo limpo, data-choice A/B interno preservado", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /data-choice="A">Essa é a IA<\/button>/);
    assert.match(html, /data-choice="B">Essa é a IA<\/button>/);
    assert.doesNotMatch(html, /Essa é a IA \(A\)/);
    assert.doesNotMatch(html, /Essa é a IA \(B\)/);
  });
});

// ── (b) GET /jogar/seq-state ─────────────────────────────────────────────

describe("parseSeqStateEditionsParam (pure, #3595)", () => {
  it("parseia CSV de AAMMDD válidos", () => {
    assert.deepEqual(parseSeqStateEditionsParam("260601,260602,260603"), ["260601", "260602", "260603"]);
  });

  it("ignora itens malformados silenciosamente (nunca lança)", () => {
    assert.deepEqual(parseSeqStateEditionsParam("260601,not-a-date,260603"), ["260601", "260603"]);
  });

  it("trima espaços em volta de cada item", () => {
    assert.deepEqual(parseSeqStateEditionsParam(" 260601 , 260602 "), ["260601", "260602"]);
  });

  it("raw nulo/vazio → array vazio", () => {
    assert.deepEqual(parseSeqStateEditionsParam(null), []);
    assert.deepEqual(parseSeqStateEditionsParam(""), []);
  });
});

describe("GET /jogar/seq-state (#3595)", () => {
  const email = "3fa85f64-5717-4562-b3fc-2c963f66afa6@web.eia.diaria.local";

  it("edição SEM voto deste token → voted:false, correct:null", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(email)}&editions=260601`),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ edition: string; voted: boolean; correct: boolean | null }>;
    assert.deepEqual(body, [{ edition: "260601", voted: false, correct: null }]);
  });

  it("edição JÁ votada e CORRETA → voted:true, correct:true (lido da MESMA chave vote:{edition}:{email})", async () => {
    const env = makeEnv({
      [`vote:260601:${email}`]: JSON.stringify({ choice: "A", ts: "2026-07-01T00:00:00.000Z", correct: true }),
    });
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(email)}&editions=260601`),
      env,
    );
    const body = (await res.json()) as Array<{ edition: string; voted: boolean; correct: boolean | null }>;
    assert.deepEqual(body, [{ edition: "260601", voted: true, correct: true }]);
  });

  it("edição JÁ votada e ERRADA → voted:true, correct:false", async () => {
    const env = makeEnv({
      [`vote:260601:${email}`]: JSON.stringify({ choice: "B", ts: "2026-07-01T00:00:00.000Z", correct: false }),
    });
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(email)}&editions=260601`),
      env,
    );
    const body = (await res.json()) as Array<{ edition: string; voted: boolean; correct: boolean | null }>;
    assert.deepEqual(body, [{ edition: "260601", voted: true, correct: false }]);
  });

  it("anti-spoiler: MÚLTIPLAS edições — correct só populado nas votadas, null nas não-votadas", async () => {
    const env = makeEnv({
      [`vote:260601:${email}`]: JSON.stringify({ choice: "A", correct: true }),
      [`vote:260603:${email}`]: JSON.stringify({ choice: "B", correct: false }),
      // 260602 sem voto — mesmo que correct:260602 exista no KV compartilhado
      // (fato público), o endpoint nunca revela pra edição não-votada.
      "correct:260602": "A",
    });
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(email)}&editions=260601,260602,260603`),
      env,
    );
    const body = (await res.json()) as Array<{ edition: string; voted: boolean; correct: boolean | null }>;
    assert.deepEqual(body, [
      { edition: "260601", voted: true, correct: true },
      { edition: "260602", voted: false, correct: null },
      { edition: "260603", voted: true, correct: false },
    ]);
  });

  it("registro de voto corrompido → trata como votado sem gabarito conhecido (nunca derruba o endpoint)", async () => {
    const env = makeEnv({ [`vote:260601:${email}`]: "{not valid json" });
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(email)}&editions=260601`),
      env,
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as Array<{ edition: string; voted: boolean; correct: boolean | null }>;
    assert.deepEqual(body, [{ edition: "260601", voted: true, correct: null }]);
  });

  it("email ausente/inválido → 400 (nunca escaneia KV com uma chave malformada)", async () => {
    const env = makeEnv();
    const res1 = await worker.fetch(new Request("https://poll.test/jogar/seq-state?editions=260601"), env);
    assert.equal(res1.status, 400);
    const res2 = await worker.fetch(
      new Request("https://poll.test/jogar/seq-state?email=not-an-email&editions=260601"),
      env,
    );
    assert.equal(res2.status, 400);
  });

  it("editions ausente → array vazio, 200 (nunca lança)", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(email)}`),
      env,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  it("Cache-Control: no-store — dado por-token, nunca cacheável", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request(`https://poll.test/jogar/seq-state?email=${encodeURIComponent(email)}&editions=260601`),
      env,
    );
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("endpoints 404 listam /jogar/seq-state", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/rota-inexistente"), env);
    const body = (await res.json()) as { endpoints: string[] };
    assert.ok(body.endpoints.includes("/jogar/seq-state"));
  });
});

// ── (c) skip-and-credit (pure) ──────────────────────────────────────────

describe("computeSeqSkipAndCredit (pure, #3595)", () => {
  it("nenhuma edição votada → play list é a sequência inteira, zero pré-crédito/erro conhecido", () => {
    const editions = ["260601", "260602", "260603"];
    const state: SeqStateEntry[] = editions.map((edition) => ({ edition, voted: false, correct: null }));
    assert.deepEqual(computeSeqSkipAndCredit(editions, state), {
      playIndices: [0, 1, 2],
      preCredited: 0,
      knownWrongIndices: [],
    });
  });

  it("mistura de votadas (certo/errado) e não-votadas — play list é SÓ as não-votadas", () => {
    const editions = ["260601", "260602", "260603", "260604"];
    const state: SeqStateEntry[] = [
      { edition: "260601", voted: true, correct: true }, // pré-creditada
      { edition: "260602", voted: false, correct: null }, // joga
      { edition: "260603", voted: true, correct: false }, // erro conhecido
      { edition: "260604", voted: false, correct: null }, // joga
    ];
    assert.deepEqual(computeSeqSkipAndCredit(editions, state), {
      playIndices: [1, 3],
      preCredited: 1,
      knownWrongIndices: [2],
    });
  });

  it("TODAS já votadas → play list vazia (o caller deve ir direto pra tela final)", () => {
    const editions = ["260601", "260602"];
    const state: SeqStateEntry[] = [
      { edition: "260601", voted: true, correct: true },
      { edition: "260602", voted: true, correct: false },
    ];
    assert.deepEqual(computeSeqSkipAndCredit(editions, state), {
      playIndices: [],
      preCredited: 1,
      knownWrongIndices: [1],
    });
  });

  it("entry ausente/undefined pro índice → tratado como não-votada (nunca lança)", () => {
    const editions = ["260601", "260602"];
    const state: Array<SeqStateEntry | undefined> = [undefined, { edition: "260602", voted: false, correct: null }];
    assert.deepEqual(computeSeqSkipAndCredit(editions, state), {
      playIndices: [0, 1],
      preCredited: 0,
      knownWrongIndices: [],
    });
  });

  it("voted=true com correct=null (edge case: gabarito não existia no momento do voto original) — não pré-credita nem soma erro, também não rejoga", () => {
    const editions = ["260601"];
    const state: SeqStateEntry[] = [{ edition: "260601", voted: true, correct: null }];
    assert.deepEqual(computeSeqSkipAndCredit(editions, state), {
      playIndices: [],
      preCredited: 0,
      knownWrongIndices: [],
    });
  });
});

// ── Modelo "Suspense" embutido no script da sequência ───────────────────

describe("renderJogarSequencePageHtml — modelo Suspense (#3595 item 2)", () => {
  it("clique avança IMEDIATAMENTE (advance síncrono) — o /vote roda em função separada não-bloqueante", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /function onChoice\(choice\) \{/);
    assert.match(html, /pending\.push\(voteDone\);/);
    assert.match(html, /\n\s*advance\(\);\n\s*\}/, "onChoice deve chamar advance() diretamente, sem esperar o fetch");
  });

  it("nenhum reveal de 'Acertou!'/'Errou' por rodada — bloco #seq-round-result removido", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.doesNotMatch(html, /seq-round-result/);
    assert.doesNotMatch(html, /Essa não — errou dessa vez/);
  });

  it("tela final aguarda Promise.all(pending) antes de calcular o placar", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /Promise\.all\(pending\)\.then/);
  });

  it("tela final mostra a lista de pares errados quando há pelo menos 1 erro", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /Errou nos pares " \+ pairLabels \+ "\.";/);
    assert.match(html, /class="sub seq-final-wrong"/);
  });

  it("voto em background nunca rejeita — 1 retry, depois resolve null (nunca trava a tela final)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /function voteInBackground\(voteUrl, attempt\)/);
    assert.match(html, /if \(attempt < 1\) return voteInBackground\(voteUrl, attempt \+ 1\);/);
  });

  it("consulta /jogar/seq-state ANTES de montar a play list (skip-and-credit)", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /\/jogar\/seq-state\?email="/);
    assert.match(html, /function startGame\(\)/);
  });

  it("?reset=1 limpa token/cookie local + cache legado de sequência", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /params\.has\("reset"\)/);
    assert.match(html, /eia_web_token/);
    assert.match(html, /eia_web_seq_result_/);
  });

  it("fail-open: falha no fetch de seq-state joga a sequência inteira sem pré-crédito", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /\.catch\(function \(\) \{\s*playIndices = editions\.map/);
  });
});

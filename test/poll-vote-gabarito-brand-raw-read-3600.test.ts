/**
 * test/poll-vote-gabarito-brand-raw-read-3600.test.ts (#3600)
 *
 * BUG: `handleVote` (workers/poll/src/vote.ts) lia o gabarito
 * `correct:{edition}` via o env BRANDED (`bEnv`, passado por `routeRequest`
 * em index.ts). Para brand="web" isso resolvia para `web:correct:{edition}`
 * — chave que NUNCA é escrita (close-poll.ts só grava `correct:{edition}`
 * CRU, fato público brand-independente, mesma decisão já documentada em
 * jogar.ts decisão 3). Resultado: `correctRaw` sempre `null` pra qualquer
 * brand != "diaria" → reveal quebrado, todo voto respondia "Voto registrado!
 * O resultado sai na próxima edição." mesmo com o gabarito já fechado.
 *
 * FIX: `handleVote` ganhou um 4º parâmetro `rawEnv` (default = env, preserva
 * compat com chamadas de teste legadas com env único) — só o READ de
 * `correct:{edition}` usa `rawEnv`; voto/score/dedup/stats continuam via
 * `env` (branded). `index.ts` passa o `env` cru como 4º arg em `routeRequest`.
 *
 * Este teste cobre os 3 brands (diaria/web/clarice) lendo o MESMO gabarito
 * cru — via o worker inteiro (`workerDefault.fetch`), não `handleVote`
 * diretamente, pra exercitar o wiring real de `bEnv`/`env` em index.ts (o
 * bug só se manifesta nesse wiring, não numa chamada direta a handleVote com
 * um único env).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

function voteUrl(email: string, edition: string, choice: "A" | "B", brand?: string): URL {
  const url = new URL("https://poll.diaria.workers.dev/vote");
  url.searchParams.set("email", email);
  url.searchParams.set("edition", edition);
  url.searchParams.set("choice", choice);
  if (brand) url.searchParams.set("brand", brand);
  return url; // sig ausente = merge-tag mode, sem HMAC exigido
}

async function vote(kv: ReturnType<typeof makeTrackedKv>, email: string, edition: string, choice: "A" | "B", brand?: string) {
  const env = makePollEnv(kv);
  return workerDefault.fetch(new Request(voteUrl(email, edition, choice, brand).toString()), env, {} as ExecutionContext);
}

describe("handleVote via /vote — gabarito correct:{edition} é lido CRU (brand-independente) (#3600)", () => {
  it("brand=web: gabarito cru revela ✅/❌ em vez de 'resultado sai na próxima edição'", async () => {
    const kv = makeTrackedKv({ "correct:260601": "A" }); // CRU — nunca "web:correct:260601"
    const token = "44444444-4444-4444-8444-444444444444@web.eia.diaria.local";

    const resHit = await vote(kv, token, "260601", "A", "web"); // acerta
    assert.equal(resHit.status, 200);
    const htmlHit = await resHit.text();
    assert.match(htmlHit, /✅ Acertou! Era a imagem gerada por IA\./, "brand=web deve revelar o acerto usando o gabarito cru");
    assert.doesNotMatch(htmlHit, /resultado sai na próxima edição/);

    // #3976: local-part precisa ser UUID v4 (guard novo em handleVote pra
    // brand="web") — "outro-" + token quebraria a forma UUID, então usamos
    // um 2º token válido em vez de prefixar o primeiro.
    const otherToken = "55555555-5555-4555-8555-555555555555@web.eia.diaria.local";
    const resMiss = await vote(kv, otherToken, "260601", "B", "web"); // erra
    const htmlMiss = await resMiss.text();
    assert.match(htmlMiss, /❌ Não foi dessa vez, era a foto real\./, "brand=web deve revelar o erro usando o gabarito cru");

    // Confirma que NENHUMA chave branded foi tocada — o read é 100% cru.
    assert.equal(await kv.get("web:correct:260601"), null, "web:correct:{edition} nunca deve ser escrito nem necessário pro reveal");
  });

  it("brand=clarice (ciclo YYMM-MM): mesmo gabarito cru revela corretamente", async () => {
    const kv = makeTrackedKv({ "correct:2608-09": "B" }); // CRU — nunca "clarice:correct:2608-09"

    const res = await vote(kv, "leitor-clarice@x.com", "2608-09", "B", "clarice"); // acerta
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /✅ Acertou! Era a imagem gerada por IA\./, "brand=clarice deve revelar usando o mesmo gabarito cru compartilhado");
    assert.doesNotMatch(html, /resultado sai na próxima edição/);
  });

  it("brand=diaria (default, sem regressão): continua revelando normalmente — prefixo é '' então cru===branded", async () => {
    const kv = makeTrackedKv({ "correct:260602": "A" });

    const res = await vote(kv, "leitor-diaria@x.com", "260602", "A"); // sem brand= → default diaria
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /✅ Acertou! Era a imagem gerada por IA\./, "diaria não deve regredir — brandKvPrefix('diaria') === '' já lia a chave crua antes do fix");
  });

  it("os 3 brands compartilham o MESMO gabarito cru — 1 close-poll.ts serve diaria+web+clarice simultaneamente", async () => {
    const kv = makeTrackedKv({ "correct:260603": "A" });

    // #3976: brand="web" exige local-part UUID v4 (guard novo em handleVote)
    // — "w@x.com" não passaria mais; diaria/clarice usam e-mail real de
    // assinante, sem essa exigência (guard é específico do brand web).
    const resDiaria = await vote(kv, "d@x.com", "260603", "A");
    const resWeb = await vote(kv, "66666666-6666-4666-8666-666666666666@web.eia.diaria.local", "260603", "A", "web");
    const resClarice = await vote(kv, "c@x.com", "260603", "A", "clarice");

    for (const [label, res] of [["diaria", resDiaria], ["web", resWeb], ["clarice", resClarice]] as const) {
      assert.equal(res.status, 200, `${label}: status 200`);
      const html = await res.text();
      assert.match(html, /✅ Acertou! Era a imagem gerada por IA\./, `${label}: deve revelar o acerto a partir da MESMA chave correct:260603`);
    }
  });
});

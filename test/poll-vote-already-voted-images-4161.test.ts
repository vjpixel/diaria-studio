/**
 * test/poll-vote-already-voted-images-4161.test.ts (#4161)
 *
 * `buildAlreadyVotedResponse` (vote.ts) computava `correct` (contra
 * `prev.choice`, o voto REALMENTE persistido) e montava um card de
 * compartilhamento dizendo "Acertei o 'É IA?' de hoje!" — mas passava
 * `resultImages = null` fixo e nem lia `eiaMeta`. A tela mais visitada do
 * jogo (reabrir o link da newsletter, o caso mais comum) afirmava um
 * resultado sem nunca mostrar as duas imagens reveladas.
 *
 * Fix: `resultImages`/`eiaMeta` computados no mesmo bloco onde `correct` já é
 * computado, com o MESMO gate anti-spoiler (`correct !== null`) do caminho de
 * voto fresco. `clickedSide` é sempre `prev.choice` (o voto persistido),
 * nunca o `choice` da query string da requisição de "já votou".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";

async function vote(email: string, edition: string, choice: string, env: ReturnType<typeof makePollEnv>) {
  const { default: worker } = await import("../workers/poll/src/index.ts");
  const url = new URL("https://poll.diaria.workers.dev/vote");
  url.searchParams.set("email", email);
  url.searchParams.set("edition", edition);
  url.searchParams.set("choice", choice);
  return worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
}

describe("#4161 — tela de 'já votou' mostra as imagens reveladas quando o gabarito está fechado", () => {
  it("gabarito fechado: 2º voto (já votou) renderiza as DUAS imagens, com destaque em prev.choice", async () => {
    const kv = makeTrackedKv({ "correct:260724": "A" });
    const env = makePollEnv(kv);

    const res1 = await vote("leitor@x.com", "260724", "A", env);
    assert.equal(res1.status, 200);

    const res2 = await vote("leitor@x.com", "260724", "B", env); // choice divergente, descartado — "já votou"
    assert.equal(res2.status, 200);
    const html2 = await res2.text();
    assert.match(html2, /já votou/i);
    assert.match(html2, /\/img\/img-260724-01-eia-A\.jpg/, "imagem A deve aparecer");
    assert.match(html2, /\/img\/img-260724-01-eia-B\.jpg/, "imagem B deve aparecer");
  });

  it("choice da query DIVERGENTE de prev.choice: destaque ('Você clicou') continua em prev.choice, nunca no choice da query", async () => {
    const kv = makeTrackedKv({ "correct:260724": "B" });
    const env = makePollEnv(kv);

    // 1º voto real: A.
    await vote("divergente@x.com", "260724", "A", env);
    // 2º "voto" (na verdade um re-clique/link velho) manda B — deve ser descartado,
    // e o destaque deve seguir em A (o que a pessoa REALMENTE votou).
    const res2 = await vote("divergente@x.com", "260724", "B", env);
    const html2 = await res2.text();
    assert.match(html2, /já votou.*escolha: A/is, "mensagem deve citar a escolha REALMENTE persistida (A)");
    const clickedMatch = /<div class="result-image clicked">([\s\S]*?)<\/div>/.exec(html2);
    assert.ok(clickedMatch, "deve haver exatamente um bloco .clicked");
    assert.match(clickedMatch![1], /eia-A\.jpg/, "o destaque 'Você clicou' deve estar na imagem A (prev.choice), não B (choice da query)");
  });

  it("SEM gabarito (correct:{edition} ausente): nenhuma imagem — anti-spoiler preservado", async () => {
    const kv = makeTrackedKv(); // sem correct:260724
    const env = makePollEnv(kv);

    await vote("semgabarito@x.com", "260724", "A", env);
    const res2 = await vote("semgabarito@x.com", "260724", "B", env);
    const html2 = await res2.text();
    assert.match(html2, /já votou/i);
    // Checa a MARCAÇÃO renderizada (class="result-image..."), não a regra CSS
    // (.result-image { ... } sempre está presente no <style> da página,
    // gabarito fechado ou não — a ausência real é no corpo, não no CSS).
    assert.doesNotMatch(html2, /class="result-image/, "sem gabarito, nenhum bloco de imagem de resultado deve renderizar");
    assert.doesNotMatch(html2, /\/img\/img-260724-01-eia-[AB]\.jpg/, "sem gabarito, nenhuma URL de imagem de resultado deve vazar");
  });

  it("eiameta:{edition} (KV compartilhado, CRU) é lido e renderizado na tela de já votou quando o gabarito está fechado", async () => {
    const kv = makeTrackedKv({
      "correct:260724": "A",
      "eiameta:260724": JSON.stringify({ description: "Uma praça em Lisboa.", credit: "Foto: Banco de imagens X" }),
    });
    const env = makePollEnv(kv);

    await vote("eiameta@x.com", "260724", "A", env);
    const res2 = await vote("eiameta@x.com", "260724", "B", env);
    const html2 = await res2.text();
    assert.match(html2, /id="jogar-eia-meta"/);
    assert.match(html2, /Uma praça em Lisboa\./);
    assert.match(html2, /Foto: Banco de imagens X/);
  });

  it("brand=clarice (edition em ciclo YYMM-MM): gabarito lido via KV CRU (rawEnv), não via namespace branded — resultImages aparece mesmo pro brand clarice", async () => {
    const kv = makeTrackedKv({
      "correct:2605-06": "A", // #3600: gabarito é SEMPRE cru, nunca "clarice:correct:..."
    });
    const env = makePollEnv(kv);

    const { default: worker } = await import("../workers/poll/src/index.ts");
    const voteClarice = (email: string, choice: string) => {
      const url = new URL("https://poll.diaria.workers.dev/vote");
      url.searchParams.set("email", email);
      url.searchParams.set("edition", "2605-06");
      url.searchParams.set("choice", choice);
      url.searchParams.set("brand", "clarice");
      return worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
    };

    await voteClarice("clarice@x.com", "A");
    const res2 = await voteClarice("clarice@x.com", "B");
    const html2 = await res2.text();
    assert.match(html2, /já votou/i);
    assert.match(html2, /\/img\/img-2605-06-01-eia-A\.jpg/);
    assert.match(html2, /\/img\/img-2605-06-01-eia-B\.jpg/);
  });
});

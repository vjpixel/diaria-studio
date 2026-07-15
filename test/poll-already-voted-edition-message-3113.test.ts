/**
 * test/poll-already-voted-edition-message-3113.test.ts (#3113 item 13)
 *
 * A mensagem "já votou" do brand `clarice` (leaderboardPeriod "year") dizia
 * apenas "Você já votou nesta edição" — sem citar QUAL edição. Ambíguo para
 * um leitor que já votou em MAIS de uma edição arquivada retroativamente
 * (#2867: o arquivo permite votar em qualquer edição do ano com gabarito
 * fechado, uma de cada vez).
 *
 * Fix: usa `formatEditionDateForBrand` (já existe desde #3112) nos 2 branches
 * de "já votou" em `vote.ts` (com e sem VOTE_DEDUP) — sempre cita a edição,
 * formatada corretamente por brand (mês completo com dia pra `diaria`, só
 * "mês de ano" pra `clarice`, já que a Clarice News é mensal e o "dia" do
 * AAMMDD é artefato do código, não dado real).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import { makePollEnv } from "./_helpers/make-poll-env.ts";
import { formatEditionDateForBrand } from "../workers/poll/src/lib.ts";

async function vote(
  email: string,
  edition: string,
  choice: string,
  env: ReturnType<typeof makePollEnv>,
  brand?: "clarice",
) {
  const { default: worker } = await import("../workers/poll/src/index.ts");
  const url = new URL("https://poll.diaria.workers.dev/vote");
  url.searchParams.set("email", email);
  url.searchParams.set("edition", edition);
  url.searchParams.set("choice", choice);
  if (brand) url.searchParams.set("brand", brand);
  return worker.fetch(new Request(url.toString()), env, {} as ExecutionContext);
}

describe("#3113 item 13 — mensagem 'já votou' sempre cita a edição (brand clarice, sem VOTE_DEDUP)", () => {
  it("2º voto na MESMA edição arquivada: mensagem cita 'agosto de 2026' — mês de ENVIO (#3464), não o conteúdo (julho)", async () => {
    const kv = makeTrackedKv({ "clarice:correct:260701": "A" });
    const env = makePollEnv(kv);

    const res1 = await vote("leitor@x.com", "260701", "A", env, "clarice");
    assert.equal(res1.status, 200);
    const html1 = await res1.text();
    assert.doesNotMatch(html1, /já votou/i, "1º voto não deve ser tratado como duplicado");

    const res2 = await vote("leitor@x.com", "260701", "B", env, "clarice");
    assert.equal(res2.status, 200);
    const html2 = await res2.text();
    assert.match(html2, /Você já votou na edição de agosto de 2026/, "deve citar 'agosto de 2026' (mês de envio), não o genérico 'nesta edição'");
    assert.doesNotMatch(html2, /nesta edição/i);
  });

  it("2 edições arquivadas DIFERENTES (meses diferentes): cada 'já votou' cita a edição CORRETA (não confunde uma com a outra)", async () => {
    // #3464: 260501 = conteúdo maio → enviado em junho; 260701 = conteúdo
    // julho → enviado em agosto.
    const kv = makeTrackedKv({
      "clarice:correct:260501": "A",
      "clarice:correct:260701": "B",
    });
    const env = makePollEnv(kv);

    // Vota nas 2 edições (1º voto de cada, aceito)
    await vote("multi@x.com", "260501", "A", env, "clarice");
    await vote("multi@x.com", "260701", "B", env, "clarice");

    // Repete o voto na edição de conteúdo MAIO — mensagem deve citar junho (envio), não agosto
    const resMaio = await vote("multi@x.com", "260501", "B", env, "clarice");
    const htmlMaio = await resMaio.text();
    assert.match(htmlMaio, /Você já votou na edição de junho de 2026/);
    assert.doesNotMatch(htmlMaio, /agosto de 2026/);

    // Repete o voto na edição de conteúdo JULHO — mensagem deve citar agosto (envio), não junho
    const resJulho = await vote("multi@x.com", "260701", "A", env, "clarice");
    const htmlJulho = await resJulho.text();
    assert.match(htmlJulho, /Você já votou na edição de agosto de 2026/);
    assert.doesNotMatch(htmlJulho, /junho de 2026/);
  });
});

describe("#3113 item 13 — brand diaria (mensal, com dia) continua inalterado", () => {
  it("2º voto: mensagem cita a data completa com dia (comportamento pré-#3113 preservado)", async () => {
    const kv = makeTrackedKv({ "correct:260701": "A" });
    const env = makePollEnv(kv);

    await vote("diaria@x.com", "260701", "A", env);
    const res2 = await vote("diaria@x.com", "260701", "B", env);
    const html2 = await res2.text();
    assert.match(html2, /Você já votou na edição de 1 de julho de 2026/);
  });
});

// ── Self-review pós-#3192: edição em formato de CICLO Clarice (YYMM-MM) ──────
//
// Produção real do brand `clarice` usa `edition` no formato de ciclo
// `{conteúdo}-{envio}` (ex: "2605-06" — ver close-poll.ts --brand clarice
// --cycle e os links de voto gerados por monthly-render.ts), NÃO AAMMDD. Os
// testes acima só cobrem AAMMDD ("260701" etc.) — sem esta cobertura, a
// mensagem "já votou" introduzida por #3192 mostraria o slug interno cru
// ("2605-06") pro leitor em produção, já que `formatEditionDateForBrand` não
// tinha ramo pra esse formato.

describe("#3113 item 13 (self-review) — formatEditionDateForBrand aceita o ciclo Clarice YYMM-MM", () => {
  it("ciclo 'YYMM-MM' no brand clarice → 'mês de ano' do mês de ENVIO (#3464), sem o slug cru", () => {
    // 2605-06: conteúdo maio → envio junho. 2607-08: conteúdo julho → envio agosto.
    assert.equal(formatEditionDateForBrand("2605-06", "clarice"), "junho de 2026");
    assert.equal(formatEditionDateForBrand("2607-08", "clarice"), "agosto de 2026");
  });

  it("ciclo com mês de conteúdo inválido (ex: 13) → retorna o input cru (fail-open)", () => {
    assert.equal(formatEditionDateForBrand("2613-14", "clarice"), "2613-14");
  });

  it("brand diaria com input em formato de ciclo → NÃO aplica o ramo de ciclo (diária nunca usa esse formato); delega pra formatEditionDate, que retorna o input cru por não bater /^\\d{6}$/", () => {
    assert.equal(formatEditionDateForBrand("2605-06", "diaria"), "2605-06");
  });
});

describe("#3113 item 13 (self-review) — mensagem 'já votou' via /vote com edição em ciclo Clarice", () => {
  it("2º voto numa edição de ciclo ('2605-06'): mensagem cita 'junho de 2026' (mês de ENVIO, #3464), NÃO o slug cru '2605-06' nem o mês de conteúdo (maio)", async () => {
    const kv = makeTrackedKv({ "clarice:correct:2605-06": "A" });
    const env = makePollEnv(kv);

    const res1 = await vote("ciclo@x.com", "2605-06", "A", env, "clarice");
    assert.equal(res1.status, 200);
    assert.doesNotMatch(await res1.text(), /já votou/i, "1º voto não deve ser tratado como duplicado");

    const res2 = await vote("ciclo@x.com", "2605-06", "B", env, "clarice");
    assert.equal(res2.status, 200);
    const html2 = await res2.text();
    assert.match(html2, /Você já votou na edição de junho de 2026/, "deve citar 'junho de 2026' (mês de envio), não o slug de ciclo cru nem o mês de conteúdo");
    assert.doesNotMatch(html2, /2605-06/, "o slug de ciclo interno NUNCA deve vazar pro texto exibido ao leitor");
  });
});

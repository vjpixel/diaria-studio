/**
 * test/poll-streak-3522.test.ts
 *
 * Regressão para #3522 (sub-issue [AMBAS] do EPIC #3514 "É IA? standalone")
 * — streak (dias/meses CONSECUTIVOS acertando).
 *
 * `score:{email}.streak` já existia desde #2832, mas com um bug: só
 * resetava em ERRO (`correct === false`) — nunca em AUSÊNCIA de voto. Um
 * jogador que pulasse um dia (email/diaria/web) ou um mês (clarice) mantinha
 * o streak intacto até a próxima resposta errada. Este arquivo cobre:
 *
 *   1. Os pures novos de lib.ts (`nextWeekdayAammdd`, `nextContentMonthSlug`,
 *      `isConsecutiveVotingPeriod`, `renderStreakSuffix`).
 *   2. Integração via `/vote`: streak incrementa em dias úteis consecutivos
 *      (inclusive sex→seg, pulando o fim de semana — a newsletter não
 *      publica sáb/dom), RESETA pra 1 quando um dia útil é pulado, e reseta
 *      pra 0 em erro. Cobre os 3 brands (diaria "month", web "month" com
 *      identidade por token, clarice "year"/cadência mensal).
 *   3. Sufixo de exibição na mensagem pós-voto (`renderStreakSuffix`,
 *      embutido em `.msg` — mesmo elemento que `jogar.ts` extrai via
 *      DOMParser pro standalone, sem precisar de nenhuma mudança lá).
 *
 * Escopo deliberadamente conservador (ver comentário em `updateScore`,
 * vote.ts): a reconciliação retroativa de streak para o brand "web" votando
 * no par do dia ANTES do reveal do dia seguinte (`correct === null` no
 * momento do voto) não é implementada aqui — estender
 * `adjustScoreCorrectOnly`/`handleAdminCorrect` pra isso quebraria o
 * invariante "backfill nunca toca streak" já travado por
 * test/poll-hardening-2188-2189-2190-2191.test.ts (#2202/#2217), que também
 * é o caminho de correção AO VIVO de diaria/clarice. Documentado como
 * follow-up no PR #3522. Este arquivo testa o caminho síncrono (correctness
 * já conhecida no momento do voto), que cobre diaria/clarice sempre e o
 * brand "web" jogando edições de ARQUIVO (`/jogar?edition=X`, gabarito já
 * fechado).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import workerDefault from "../workers/poll/src/index.ts";
import {
  nextWeekdayAammdd,
  nextContentMonthSlug,
  isConsecutiveVotingPeriod,
  renderStreakSuffix,
} from "../workers/poll/src/lib.ts";
import { makeTrackedKv, readKv } from "./_helpers/make-tracked-kv.ts";
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

// ── 1. Pures (lib.ts) ───────────────────────────────────────────────────────

describe("nextWeekdayAammdd (#3522)", () => {
  it("dia útil seguinte, sem cruzar fim de semana (segunda→terça)", () => {
    // 2026-06-01 é segunda-feira; 2026-06-02 é terça.
    assert.equal(nextWeekdayAammdd("260601"), "260602");
  });

  it("sexta→segunda, pula sábado/domingo", () => {
    // 2026-06-05 é sexta; 2026-06-08 é a segunda seguinte.
    assert.equal(nextWeekdayAammdd("260605"), "260608");
  });

  it("edition malformado → null", () => {
    assert.equal(nextWeekdayAammdd("2606011"), null);
    assert.equal(nextWeekdayAammdd("261301"), null); // mês 13 inválido
    assert.equal(nextWeekdayAammdd("abcdef"), null);
  });
});

describe("nextContentMonthSlug (#3522)", () => {
  // NOTA: o parâmetro é uma EDITION (AAMMDD ou ciclo `YYMM-MM`), não um slug
  // "YYYY-MM" pronto — `editionToMonthSlug` deriva o slug a partir dela.
  // "2026-06" bate acidentalmente a FORMA de `CYCLE_EDITION_RE` (`\d{4}-\d{2}`)
  // mas semanticamente decodificaria pra yy="20"/mm="26" (mês inválido) — usar
  // esse literal aqui seria um teste que exercita null por engano.
  it("mês seguinte dentro do mesmo ano (edition AAMMDD)", () => {
    // "260615" (15/06/2026) → slug "2026-06" → próximo mês "2026-07".
    assert.equal(nextContentMonthSlug("260615"), "2026-07");
  });

  it("wrap dezembro → janeiro do ano seguinte (edition AAMMDD)", () => {
    // "261215" (15/12/2026) → slug "2026-12" → próximo "2027-01".
    assert.equal(nextContentMonthSlug("261215"), "2027-01");
  });

  it("aceita ciclo Clarice YYMM-MM (deriva o slug de CONTEÚDO)", () => {
    // "2606-07" = conteúdo de junho/2026, enviado em julho → próximo conteúdo é julho/2026.
    assert.equal(nextContentMonthSlug("2606-07"), "2026-07");
  });

  it("edition malformado → null", () => {
    assert.equal(nextContentMonthSlug("not-a-slug"), null);
  });
});

describe("isConsecutiveVotingPeriod (#3522)", () => {
  it("prevEdition null (1º voto confirmado) → sempre true", () => {
    assert.equal(isConsecutiveVotingPeriod(null, "260601", "diaria"), true);
    assert.equal(isConsecutiveVotingPeriod(null, "2606-07", "clarice"), true);
  });

  it("brand 'month' (diaria/web): dia útil seguinte → true", () => {
    assert.equal(isConsecutiveVotingPeriod("260601", "260602", "diaria"), true);
    assert.equal(isConsecutiveVotingPeriod("260605", "260608", "web"), true); // sex→seg
  });

  it("brand 'month': dia útil PULADO → false", () => {
    // 260601 (seg) → 260603 (qua): pulou terça (260602).
    assert.equal(isConsecutiveVotingPeriod("260601", "260603", "diaria"), false);
  });

  it("brand 'year' (clarice): mês de conteúdo seguinte → true; mês pulado → false", () => {
    // Editions em formato de ciclo Clarice `YYMM-MM` (ver nextContentMonthSlug acima).
    // "2606-07" = conteúdo junho/2026; "2607-08" = conteúdo julho/2026 (seguinte).
    assert.equal(isConsecutiveVotingPeriod("2606-07", "2607-08", "clarice"), true);
    // "2609-10" = conteúdo setembro/2026 — pulou julho E agosto.
    assert.equal(isConsecutiveVotingPeriod("2606-07", "2609-10", "clarice"), false);
  });

  it("edition malformado em qualquer lado → false (fail-safe)", () => {
    assert.equal(isConsecutiveVotingPeriod("lixo", "260602", "diaria"), false);
    assert.equal(isConsecutiveVotingPeriod("260601", "lixo", "diaria"), false);
  });
});

describe("renderStreakSuffix (#3522)", () => {
  it("null ou < 2 → sem sufixo", () => {
    assert.equal(renderStreakSuffix(null, "diaria"), "");
    assert.equal(renderStreakSuffix(0, "diaria"), "");
    assert.equal(renderStreakSuffix(1, "diaria"), "");
  });

  it(">= 2, brand 'month' (diaria/web) → 'dias seguidos'", () => {
    assert.equal(renderStreakSuffix(2, "diaria"), " 🔥 2 dias seguidos acertando!");
    assert.equal(renderStreakSuffix(5, "web"), " 🔥 5 dias seguidos acertando!");
  });

  it(">= 2, brand 'year' (clarice) → 'meses seguidos' (nunca 'dias')", () => {
    assert.equal(renderStreakSuffix(3, "clarice"), " 🔥 3 meses seguidos acertando!");
  });
});

// ── 2. Integração via /vote — diaria ────────────────────────────────────────

describe("streak via /vote — diaria: incrementa em dias úteis consecutivos (#3522)", () => {
  it("segunda + terça corretos → streak 1 depois 2; mensagem mostra sufixo só na 2ª", async () => {
    const email = "streak-daily@x.com";
    const kv = makeTrackedKv({
      "correct:260601": "A",
      "correct:260602": "A",
    });

    const res1 = await vote(kv, email, "260601", "A");
    assert.equal(res1.status, 200);
    const html1 = await res1.text();
    // streak=1 não recebe sufixo (limiar >=2, ver renderStreakSuffix).
    assert.doesNotMatch(html1, /dias seguidos acertando/, "streak=1 não deve mostrar sufixo");
    const score1 = JSON.parse(await readKv(kv, `score:${email}`));
    assert.equal(score1.streak, 1);

    const res2 = await vote(kv, email, "260602", "A");
    assert.equal(res2.status, 200);
    const html2 = await res2.text();
    assert.match(html2, /🔥 2 dias seguidos acertando!/, "streak=2 deve mostrar o sufixo na mensagem pós-voto");
    const score2 = JSON.parse(await readKv(kv, `score:${email}`));
    assert.equal(score2.streak, 2);
    assert.equal(score2.last_edition, "260602");
  });

  it("sexta + segunda corretos (fim de semana sem edição) → streak continua", async () => {
    const email = "streak-weekend@x.com";
    const kv = makeTrackedKv({
      "correct:260605": "A", // sexta
      "correct:260608": "A", // segunda seguinte
    });

    await vote(kv, email, "260605", "A");
    const res2 = await vote(kv, email, "260608", "A");
    assert.equal(res2.status, 200);
    const score = JSON.parse(await readKv(kv, `score:${email}`));
    assert.equal(score.streak, 2, "sex→seg é a cadência normal (sem edição sáb/dom) — streak deve continuar, não resetar");
  });

  it("pulou um dia útil (segunda, depois quarta — sem votar terça) → streak reseta pra 1, não continua", async () => {
    const email = "streak-gap@x.com";
    const kv = makeTrackedKv({
      "correct:260601": "A", // segunda
      "correct:260603": "A", // quarta (pulou terça 260602)
    });

    await vote(kv, email, "260601", "A"); // streak=1
    const res2 = await vote(kv, email, "260603", "A");
    assert.equal(res2.status, 200);
    const html2 = await res2.text();
    // streak volta pra 1 (não 2) — sem sufixo, já que < 2.
    assert.doesNotMatch(html2, /dias seguidos acertando/, "streak=1 (reset) não deve mostrar sufixo");
    const score = JSON.parse(await readKv(kv, `score:${email}`));
    assert.equal(score.streak, 1, "pular um dia útil deve resetar o streak pra 1 (novo streak começando neste acerto), não continuar pra 2");
    assert.equal(score.last_edition, "260603");
  });

  it("acerta, depois erra → streak reseta pra 0", async () => {
    const email = "streak-wrong@x.com";
    const kv = makeTrackedKv({
      "correct:260601": "A",
      "correct:260602": "A",
    });

    await vote(kv, email, "260601", "A"); // acerto — streak=1
    const res2 = await vote(kv, email, "260602", "B"); // erro (gabarito é A)
    assert.equal(res2.status, 200);
    const score = JSON.parse(await readKv(kv, `score:${email}`));
    assert.equal(score.streak, 0, "resposta errada deve zerar o streak (comportamento pré-existente, preservado)");
  });

  it("3 dias úteis seguidos corretos → streak sobe 1,2,3 (sem regressão de contagem)", async () => {
    const email = "streak-three@x.com";
    const kv = makeTrackedKv({
      "correct:260601": "A",
      "correct:260602": "A",
      "correct:260603": "A",
    });
    await vote(kv, email, "260601", "A");
    await vote(kv, email, "260602", "A");
    const res3 = await vote(kv, email, "260603", "A");
    const html3 = await res3.text();
    assert.match(html3, /🔥 3 dias seguidos acertando!/);
    const score = JSON.parse(await readKv(kv, `score:${email}`));
    assert.equal(score.streak, 3);
  });
});

// ── 3. Integração via /vote — web (identidade por token, arquivo) ──────────

describe("streak via /vote — brand=web: mesma cadência 'month' que diaria (#3522)", () => {
  it("token anônimo jogando 2 edições de ARQUIVO consecutivas (gabarito já fechado) → streak incrementa", async () => {
    // #3516/#3519: standalone reusa /vote com ?brand=web e um pseudo-email
    // (token@web.eia.diaria.local) — arquiva/joga edições já fechadas
    // (correct:{edition} já definido), o mesmo caminho SÍNCRONO testado
    // acima pra diaria. O caso "par do dia, ainda não revelado" (correct
    // null no momento do voto) é o gap documentado/deferido — não testado
    // aqui (ver header do arquivo).
    // #1905: handleVote roda sob o env BRANDED (bEnv) — pra brand="web" isso
    // significa que `correct:{edition}`/`score:{email}` lidos/escritos por
    // handleVote são `web:correct:{edition}`/`web:score:{email}` (mesmo
    // `brandKvPrefix`, lib.ts). Diferente do `env` CRU que
    // `handleJogarPage`/`handleJogarArchivePage` usam só pra decidir a cópia
    // "revelado?" — aqui é o dado autoritativo de correctness do voto.
    const token = "11111111-1111-4111-8111-111111111111@web.eia.diaria.local";
    const kv = makeTrackedKv({
      "web:correct:260601": "A",
      "web:correct:260602": "A",
    });

    await vote(kv, token, "260601", "A", "web");
    const res2 = await vote(kv, token, "260602", "A", "web");
    assert.equal(res2.status, 200);
    const html2 = await res2.text();
    assert.match(html2, /🔥 2 dias seguidos acertando!/);
    const score = JSON.parse(await readKv(kv, `web:score:${token}`));
    assert.equal(score.streak, 2);
  });

  it("web: pular um dia útil de arquivo reseta o streak pra 1", async () => {
    const token = "22222222-2222-4222-8222-222222222222@web.eia.diaria.local";
    const kv = makeTrackedKv({
      "web:correct:260601": "A",
      "web:correct:260603": "A",
    });

    await vote(kv, token, "260601", "A", "web");
    await vote(kv, token, "260603", "A", "web");
    const score = JSON.parse(await readKv(kv, `web:score:${token}`));
    assert.equal(score.streak, 1, "web segue a mesma regra de reset por dia pulado que diaria");
  });
});

// ── 4. Integração via /vote — clarice (cadência mensal) ─────────────────────

describe("streak via /vote — clarice: cadência 'year' (mensal), não 'dias' (#3522)", () => {
  it("2 ciclos mensais consecutivos corretos → streak incrementa, sufixo diz 'meses seguidos'", async () => {
    // Formato de ciclo Clarice `YYMM-MM` (#2115): "2606-07" = conteúdo
    // junho/2026 (enviado julho); "2607-08" = conteúdo julho/2026 (enviado
    // agosto) — mês de CONTEÚDO consecutivo, o que importa pra continuidade
    // (ver editionToMonthSlug/nextContentMonthSlug em lib.ts).
    const email = "streak-clarice@x.com";
    const kv = makeTrackedKv({
      "clarice:correct:2606-07": "A",
      "clarice:correct:2607-08": "A",
    });

    await vote(kv, email, "2606-07", "A", "clarice");
    const res2 = await vote(kv, email, "2607-08", "A", "clarice");
    assert.equal(res2.status, 200);
    const html2 = await res2.text();
    assert.match(html2, /🔥 2 meses seguidos acertando!/, "clarice deve dizer 'meses', nunca 'dias' (cadência mensal)");
    const score = JSON.parse(await readKv(kv, `clarice:score:${email}`));
    assert.equal(score.streak, 2);
  });

  it("clarice: pular um mês de conteúdo reseta o streak pra 1", async () => {
    // "2606-07" (conteúdo junho) → "2609-10" (conteúdo setembro): pulou
    // julho e agosto — não é o próximo mês de conteúdo.
    const email = "streak-clarice-gap@x.com";
    const kv = makeTrackedKv({
      "clarice:correct:2606-07": "A",
      "clarice:correct:2609-10": "A",
    });

    await vote(kv, email, "2606-07", "A", "clarice");
    await vote(kv, email, "2609-10", "A", "clarice");
    const score = JSON.parse(await readKv(kv, `clarice:score:${email}`));
    assert.equal(score.streak, 1, "pular mês(es) de conteúdo deve resetar o streak pra 1");
  });
});

// ── 5. adjustScoreCorrectOnly (backfill) continua NUNCA tocando streak ─────

describe("streak não é tocado pelo backfill de handleAdminCorrect — invariante preservado (#3522)", () => {
  it("correção de gabarito null→true não altera score.streak (mesmo invariante de #2202/#2217)", async () => {
    // Guarda explícita de que #3522 NÃO estendeu adjustScoreCorrectOnly —
    // decisão conservadora documentada em updateScore (vote.ts). Duplica em
    // espírito o teste já existente em
    // test/poll-hardening-2188-2189-2190-2191.test.ts (não removido) — aqui
    // como salvaguarda específica do escopo desta issue.
    const kv = makeTrackedKv({
      "correct:260701": "A",
      "vote:260701:backfill@x.com": JSON.stringify({ choice: "A", ts: "t", correct: null }),
      "score:backfill@x.com": JSON.stringify({ total: 1, correct: 0, streak: 0, last_edition: "260701", nickname: null }),
    });
    const { hmacSign } = await import("../workers/poll/src/index.ts");
    const env = makePollEnv(kv, { adminSecret: "test-admin" });
    const sig = await hmacSign("test-admin", "diaria:260701:A");
    const url = new URL("https://poll.diaria.workers.dev/admin/correct");
    url.searchParams.set("edition", "260701");
    url.searchParams.set("answer", "A");
    url.searchParams.set("sig", sig);
    const res = await workerDefault.fetch(new Request(url.toString(), { method: "POST" }), env, {} as ExecutionContext);
    assert.equal(res.status, 200);

    const score = JSON.parse(await readKv(kv, "score:backfill@x.com"));
    assert.equal(score.correct, 1, "correct É atualizado pelo backfill (comportamento pré-existente)");
    assert.equal(score.streak, 0, "streak NÃO é tocado pelo backfill (#3522 não estendeu esse caminho — follow-up documentado)");
  });
});

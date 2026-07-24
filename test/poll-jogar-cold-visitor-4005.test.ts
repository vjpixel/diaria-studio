/**
 * test/poll-jogar-cold-visitor-4005.test.ts (#4005)
 *
 * "eia-web: primeiro contato do visitante FRIO" — revisão de UX 260724 sobre
 * `/jogar` (sequência do mês, `renderJogarSequencePageHtml`, jogar.ts:870+):
 * o visitante do jogo web vem de compartilhamento em mídia social — NÃO é o
 * assinante da newsletter, dá 3-5 rodadas de atenção antes de decidir se
 * fica. Cinco mudanças cobertas aqui:
 *
 *   1. Título: de "Sequência do mês — jogue e entre no leaderboard" (assume
 *      conhecimento prévio do produto) pra uma pergunta direta, sem
 *      pré-requisito nenhum.
 *   2. Onboarding de 1 linha acima do 1º par — o 1º par É o tutorial.
 *   3. Rodada curta (SEQ_INITIAL_BATCH_SIZE=5) como sessão inicial, com
 *      placar parcial + "Continuar jogando" pro resto da sequência (os 22
 *      pares continuam TODOS disponíveis — só o ponto de pausa muda).
 *   4. Ordem "por surpresa": abre com os pares de MENOR taxa de acerto
 *      (`reorderJogarSequenceBySurprise`, alimentado por `fetchSequenceAccuracy`
 *      — mesma agregação DO StatsCounter/KV que `/stats?edition=` já expõe,
 *      brand `diaria` — ver rationale no import de vote.ts em jogar.ts).
 *      Fallback pra ordem cronológica quando a amostra é insuficiente.
 *   5. "Ranking" em vez de "leaderboard" em toda copy VISÍVEL — URLs/rotas
 *      (`/leaderboard`, `leaderboardHref`) permanecem intocadas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";
import {
  renderJogarSequencePageHtml,
  reorderJogarSequenceBySurprise,
  fetchSequenceAccuracy,
  formatSeqBatchBreakMessage,
  SEQ_INITIAL_BATCH_SIZE,
  MIN_VOTES_FOR_SURPRISE_ORDER,
  SURPRISE_OPENER_COUNT,
  resolvePreviousCalendarMonth,
  type EditionAccuracy,
} from "../workers/poll/src/jogar.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";

const makeEnv = (seed: Record<string, string> = {}): Env => ({
  POLL: makeTrackedKv(seed) as unknown as Env["POLL"],
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
});

// ── item 1: título ───────────────────────────────────────────────────────────

describe("título pra visitante frio (#4005 item 1)", () => {
  it("h1 vira uma pergunta direta — sem pressupor 'sequência do mês' nem conhecimento prévio", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /<h1>Você consegue dizer qual imagem foi feita por IA\?<\/h1>/);
    assert.doesNotMatch(html, /Sequência do mês — jogue e entre no leaderboard/);
  });

  it("<title> e meta description acompanham a nova copy (sem 'sequência do mês anterior' como enquadramento)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /<title>É IA\? — qual imagem foi feita por IA\? \| Diar\.ia<\/title>/);
  });
});

// ── item 2: onboarding de 1 linha ────────────────────────────────────────────

describe("onboarding de 1 linha acima do 1º par (#4005 item 2)", () => {
  it("renderiza a frase de onboarding, visível por padrão (sem 'hidden' — nunca é spoiler)", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(
      html,
      /<p class="sub" id="seq-onboarding">Uma destas imagens foi gerada por IA\. Toque na que você acha que é\.<\/p>/,
    );
    assert.doesNotMatch(html, /id="seq-onboarding"[^>]*hidden/, "onboarding não deve nascer hidden — é instrução, não spoiler");
  });

  it("script esconde o onboarding a partir da 2ª rodada (round !== 0)", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /onboardingEl\.hidden = round !== 0;/);
  });

  it("estado vazio (sem edições) não renderiza onboarding (não há par nenhum pra tutorial)", () => {
    const html = renderJogarSequencePageHtml([]);
    assert.doesNotMatch(html, /seq-onboarding/);
  });
});

// ── item 3: rodada curta + placar parcial + continuar ───────────────────────

describe("rodada curta (#4005 item 3) — placar parcial + continuar pros 22", () => {
  it("SEQ_INITIAL_BATCH_SIZE é 5 (sanity — se mudar, os testes abaixo devem ser revistos)", () => {
    assert.equal(SEQ_INITIAL_BATCH_SIZE, 5);
  });

  it("formatSeqBatchBreakMessage (gêmeo puro do JS embutido): placar parcial + contagem do que falta", () => {
    assert.equal(
      formatSeqBatchBreakMessage(4, 5, 17),
      "Você acertou 4 de 5! Continuar jogando — faltam 17.",
    );
    assert.equal(formatSeqBatchBreakMessage(0, 5, 0), "Você acertou 0 de 5! Continuar jogando — faltam 0.");
  });

  it("script embute BATCH_SIZE=5 e o guard que só interrompe se sobrar mais sequência", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /var BATCH_SIZE = 5;/);
    assert.match(html, /round === BATCH_SIZE && !batchContinued && playIndices\.length > BATCH_SIZE/);
  });

  it("tela de placar parcial: bloco #seq-batch-break com botão 'Continuar jogando' e nota de persistência local", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /<div id="seq-batch-break" class="quiz-final" hidden>/);
    assert.match(html, /<button type="button" id="seq-continue-btn" class="seq-continue-btn">Continuar jogando<\/button>/);
    assert.match(html, /Seu placar fica salvo neste navegador\./);
  });

  it("botão 'Continuar jogando' retoma a partir do MESMO round (não reinicia, não pula rodadas)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /batchContinued = true;/);
    // Sanity: renderRound() é chamado de novo (não advance()/round++) — o
    // continue deve reavaliar o MESMO round que dispou o batch break.
    assert.match(html, /continueBtn\.addEventListener\("click", function \(\) \{\s*batchContinued = true;/);
  });

  it("estado vazio (0 edições) não embute o DIV/script de batch break (só a regra CSS [hidden] persiste, sempre presente)", () => {
    const html = renderJogarSequencePageHtml([]);
    assert.doesNotMatch(html, /<div id="seq-batch-break"/, "sem edições não há bodyHtml nem batch break pra renderizar");
    assert.doesNotMatch(html, /var BATCH_SIZE/, "scriptHtml inteiro é omitido quando total === 0");
  });
});

// ── item 4: ordem "por surpresa" ─────────────────────────────────────────────

describe("reorderJogarSequenceBySurprise (pure, #4005 item 4)", () => {
  const acc = (total: number, correct_count: number): EditionAccuracy => ({ total, correct_count });

  it("promove os SURPRISE_OPENER_COUNT pares de MENOR taxa de acerto pro início, resto preserva ordem cronológica", () => {
    const editions = ["260601", "260602", "260603", "260604"];
    const stats = new Map<string, EditionAccuracy>([
      ["260601", acc(20, 2)], // 10% — mais surpreendente
      ["260602", acc(25, 20)], // 80% — mais fácil, fica por último
      ["260603", acc(20, 5)], // 25%
      ["260604", acc(20, 4)], // 20%
    ]);
    const result = reorderJogarSequenceBySurprise(editions, stats);
    assert.deepEqual(result, ["260601", "260604", "260603", "260602"]);
  });

  it("fallback: menos elegíveis que SURPRISE_OPENER_COUNT (amostra insuficiente) → ordem cronológica intacta", () => {
    const editions = ["260601", "260602", "260603", "260604"];
    const stats = new Map<string, EditionAccuracy>([
      ["260601", acc(20, 2)], // só 1 edição com amostra suficiente
      ["260602", acc(3, 1)], // total < MIN_VOTES_FOR_SURPRISE_ORDER
      // 260603/260604 sem entrada nenhuma no Map (edição nova, sem votos)
    ]);
    const result = reorderJogarSequenceBySurprise(editions, stats);
    assert.deepEqual(result, editions, "1 elegível < 3 exigidos — nunca reordena parcialmente");
  });

  it("edições ausentes do Map (undefined) são tratadas como 'sem amostra', nunca lançam", () => {
    const editions = ["260601", "260602"];
    const stats = new Map<string, EditionAccuracy | null>();
    assert.doesNotThrow(() => reorderJogarSequenceBySurprise(editions, stats));
    assert.deepEqual(reorderJogarSequenceBySurprise(editions, stats), editions);
  });

  it("entrada explicitamente null é tratada como 'sem amostra' (fetchSequenceAccuracy usa null em erro de fetch)", () => {
    const editions = ["260601", "260602", "260603"];
    const stats = new Map<string, EditionAccuracy | null>([
      ["260601", acc(20, 1)],
      ["260602", acc(20, 2)],
      ["260603", null],
    ]);
    // só 2 elegíveis (260603 é null) < openerCount default (3) → fallback
    assert.deepEqual(reorderJogarSequenceBySurprise(editions, stats), editions);
  });

  it("array vazio → array vazio, nunca lança", () => {
    assert.deepEqual(reorderJogarSequenceBySurprise([], new Map()), []);
  });

  it("empate de taxa de acerto é desempatado pela ordem cronológica original (determinístico)", () => {
    const editions = ["260601", "260602", "260603", "260604"];
    const stats = new Map<string, EditionAccuracy>([
      ["260601", acc(20, 5)], // 25%
      ["260602", acc(20, 5)], // 25% — empate com 260601
      ["260603", acc(20, 5)], // 25% — empate também
      ["260604", acc(20, 18)], // 90%
    ]);
    const result = reorderJogarSequenceBySurprise(editions, stats);
    // 3 primeiros são o trio empatado, na ordem cronológica original (índice
    // como critério de desempate) — 260604 (mais fácil) fica por último.
    assert.deepEqual(result, ["260601", "260602", "260603", "260604"]);
  });

  it("respeita minVotes/openerCount customizados (não hardcoded pro default)", () => {
    const editions = ["260601", "260602", "260603"];
    const stats = new Map<string, EditionAccuracy>([
      ["260601", acc(5, 1)], // 20% — só elegível com minVotes baixo
      ["260602", acc(5, 4)], // 80%
      ["260603", acc(5, 3)], // 60%
    ]);
    // openerCount=1: só o par mais surpreendente vem pro início.
    const result = reorderJogarSequenceBySurprise(editions, stats, 5, 1);
    assert.deepEqual(result, ["260601", "260602", "260603"]);
  });

  it("openerCount maior que o nº de edições é clampado ao tamanho da sequência", () => {
    const editions = ["260601", "260602"];
    const stats = new Map<string, EditionAccuracy>([
      ["260601", acc(20, 2)],
      ["260602", acc(20, 18)],
    ]);
    // effectiveOpenerCount = min(SURPRISE_OPENER_COUNT=3, 2) = 2 — ambos elegíveis, reordena normalmente.
    const result = reorderJogarSequenceBySurprise(editions, stats);
    assert.deepEqual(result, ["260601", "260602"]);
  });

  it("MIN_VOTES_FOR_SURPRISE_ORDER e SURPRISE_OPENER_COUNT têm os valores documentados (sanity)", () => {
    assert.equal(MIN_VOTES_FOR_SURPRISE_ORDER, 20);
    assert.equal(SURPRISE_OPENER_COUNT, 3);
  });
});

describe("fetchSequenceAccuracy (I/O, #4005 item 4)", () => {
  it("lê stats:{edition} do espelho KV (sem STATS_COUNTER binding) e monta o Map por edição", async () => {
    const env = makeEnv({
      "stats:260601": JSON.stringify({ total: 30, voted_a: 10, voted_b: 20, correct_count: 6 }),
      "stats:260602": JSON.stringify({ total: 50, voted_a: 25, voted_b: 25, correct_count: 45 }),
    });
    const result = await fetchSequenceAccuracy(env, ["260601", "260602"]);
    assert.deepEqual(result.get("260601"), { total: 30, correct_count: 6 });
    assert.deepEqual(result.get("260602"), { total: 50, correct_count: 45 });
  });

  it("edição sem stats:{edition} (nunca votada) → {total:0, correct_count:0}, nunca undefined/throw", async () => {
    const env = makeEnv();
    const result = await fetchSequenceAccuracy(env, ["260601"]);
    assert.deepEqual(result.get("260601"), { total: 0, correct_count: 0 });
  });

  it("fail-soft por edição: erro de fetch numa edição vira null nessa entrada, não derruba as demais", async () => {
    const okKv = makeTrackedKv({ "stats:260602": JSON.stringify({ total: 25, voted_a: 5, voted_b: 20, correct_count: 20 }) });
    const brokenGet = okKv.get.bind(okKv);
    const flakyKv = {
      ...okKv,
      get: async (key: string) => {
        if (key === "correct:260601" || key === "stats:260601") throw new Error("kv boom");
        return brokenGet(key);
      },
    };
    const env: Env = {
      POLL: flakyKv as unknown as Env["POLL"],
      POLL_SECRET: "poll-secret",
      ADMIN_SECRET: "admin-secret",
      ALLOWED_ORIGINS: "*",
    };
    const result = await fetchSequenceAccuracy(env, ["260601", "260602"]);
    assert.equal(result.get("260601"), null, "edição com erro de fetch vira null, não lança");
    assert.deepEqual(result.get("260602"), { total: 25, correct_count: 20 }, "edição sem erro segue lida normalmente");
  });
});

// ── item 4 (integração): GET /jogar aplica a ordem "por surpresa" fim-a-fim ─

describe("GET /jogar — ordem por surpresa fim-a-fim (#4005 item 4)", () => {
  it("reordena as edições da sequência real com base em stats:{edition} do brand diaria (não web)", async () => {
    const now = new Date();
    const { yy, mm } = resolvePreviousCalendarMonth(now);
    const ed = (dd: string) => `${yy}${mm}${dd}`;
    const e1 = ed("01"); // 10% — mais surpreendente
    const e2 = ed("02"); // 80% — mais fácil
    const e3 = ed("03"); // 25%
    const e4 = ed("04"); // 20%

    const env = makeEnv({
      [`correct:${e1}`]: "A",
      [`correct:${e2}`]: "B",
      [`correct:${e3}`]: "A",
      [`correct:${e4}`]: "B",
      // #4005: stats NÃO-branded (brand diaria é prefixo vazio, brandKvPrefix)
      // — mesma chave que /stats?edition= (brand=diaria default) já lê.
      [`stats:${e1}`]: JSON.stringify({ total: 20, voted_a: 2, voted_b: 18, correct_count: 2 }),
      [`stats:${e2}`]: JSON.stringify({ total: 25, voted_a: 20, voted_b: 5, correct_count: 20 }),
      [`stats:${e3}`]: JSON.stringify({ total: 20, voted_a: 5, voted_b: 15, correct_count: 5 }),
      [`stats:${e4}`]: JSON.stringify({ total: 20, voted_a: 4, voted_b: 16, correct_count: 4 }),
    });

    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    const expectedOrder = [e1, e4, e3, e2];
    assert.match(html, new RegExp(`var editions = \\[${expectedOrder.map((e) => `"${e}"`).join(",")}\\]`));
  });

  it("amostra insuficiente (stats ausentes) → ordem cronológica preservada, nunca quebra a página", async () => {
    const now = new Date();
    const { yy, mm } = resolvePreviousCalendarMonth(now);
    const ed = (dd: string) => `${yy}${mm}${dd}`;
    const e1 = ed("01");
    const e2 = ed("02");

    const env = makeEnv({
      [`correct:${e1}`]: "A",
      [`correct:${e2}`]: "B",
      // sem nenhuma chave stats:* — amostra zerada em ambas.
    });

    const res = await worker.fetch(new Request("https://poll.test/jogar"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, new RegExp(`var editions = \\["${e1}","${e2}"\\]`));
  });
});

// ── item 5: "ranking" em vez de "leaderboard" na copy visível ───────────────

describe("'ranking' substitui 'leaderboard' na copy VISÍVEL (#4005 item 5) — URLs/rotas intocadas", () => {
  it("renderJogarSequencePageHtml: footer e noscript usam 'Ver ranking', nunca 'Ver leaderboard'", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /Ver ranking/);
    assert.doesNotMatch(html, /Ver leaderboard/);
  });

  it("a URL/rota do link NÃO muda — continua /leaderboard?brand=web (só o texto do anchor muda)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /href="[^"]*\/leaderboard\?brand=web"[^>]*>Ver ranking</);
  });

  it("estado vazio (0 edições) também não usa mais 'leaderboard' visível (footer é comum, fora do ternário de bodyHtml)", () => {
    const html = renderJogarSequencePageHtml([]);
    assert.match(html, /Ver ranking/);
    assert.doesNotMatch(html, /Ver leaderboard/);
  });
});

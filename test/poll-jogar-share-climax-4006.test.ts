/**
 * test/poll-jogar-share-climax-4006.test.ts (#4006)
 *
 * "eia-web: loop viral na tela final — share do placar como clímax, no mesmo
 * nível do form de captação" — revisão de UX 260724. Cobre as 4 mudanças da
 * issue sobre `renderJogarSequencePageHtml` (jogar.ts) e `buildQuizShareText`
 * (share.ts):
 *
 *   1. Hierarquia: o card de desafio (share) nasce com peso visual/cronológico
 *      igual ou maior que o form de identidade — um "kicker" ESTÁTICO
 *      (`.share-kicker`) aparece junto com o placar, sem depender do fetch
 *      tardio que popula `#seq-share-slot`/`#seq-batch-share-slot`.
 *   2. Copy do share carrega o placar real + um desafio direto ("Duvido você
 *      acertar mais") — antes era neutra.
 *   3. UTM continua intacto na cadeia de share após as mudanças de layout/copy
 *      (#3978 não regride).
 *   4. O checkpoint parcial de 5 pares (#4005, `showBatchBreak`) também ganha
 *      botão de compartilhar — antes só a tela final (22 pares) tinha.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderJogarSequencePageHtml,
  SEQ_INITIAL_BATCH_SIZE,
} from "../workers/poll/src/jogar.ts";
import {
  buildQuizShareText,
  renderQuizShareCardBlock,
  type QuizSharePayload,
} from "../workers/poll/src/share.ts";
import { PUBLIC_GAME_DISPLAY_HOST } from "../workers/poll/src/lib.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

const makeEnv = (seed: Record<string, string> = {}): Env => ({
  POLL: makeTrackedKv(seed) as unknown as Env["POLL"],
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
});

// ── item 1: hierarquia — share nasce junto com o placar, não espera o fetch ──

describe("hierarquia da tela final: share é clímax, não acessório (#4006 item 1)", () => {
  it("tela final (#seq-final): kicker de desafio ESTÁTICO (não hidden) nasce dentro do bloco, junto com o placar", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    // Bloco #seq-final vai até o fechamento do </div> PAI — captura tolerante
    // a divs filhas (ex: #seq-share-slot) via contagem manual em vez de regex
    // não-guloso (que pararia no primeiro </div>, o da própria div filha).
    const startIdx = html.indexOf('<div id="seq-final" class="quiz-final" hidden>');
    assert.ok(startIdx > -1, "#seq-final deve existir");
    const closeIdx = html.indexOf("</div>\n\n", startIdx); // fecha logo antes do próximo bloco (renderSubscribeCtaBlock)
    assert.ok(closeIdx > -1);
    const finalBlock = html.slice(startIdx, closeIdx);
    assert.match(finalBlock, /<p class="share-kicker">[^<]+<\/p>/, "kicker deve estar DENTRO de #seq-final, ao lado do placar");
    assert.doesNotMatch(finalBlock, /<p class="share-kicker"[^>]*hidden/, "kicker nunca nasce hidden — não depende do fetch de /jogar/quiz/result");
    assert.match(finalBlock, /<div id="seq-share-slot" hidden><\/div>/, "o slot que RECEBE o card (via fetch) continua hidden até popular — só o convite/kicker é imediato");
  });

  it("o kicker vem ANTES do slot de share no DOM (ordem: placar → convite → card fetched)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    const kickerIdx = html.indexOf('<p class="share-kicker">Desafie seus amigos');
    const slotIdx = html.indexOf('id="seq-share-slot"');
    assert.ok(kickerIdx > -1 && slotIdx > -1);
    assert.ok(kickerIdx < slotIdx, "kicker deve vir antes do slot no HTML");
  });

  it("share (dentro de #seq-final) precede o form de identidade no DOM — nunca fica atrás/escondido", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    const seqFinalIdx = html.indexOf('<div id="seq-final"');
    const identityFormIdx = html.indexOf('id="jogar-identity-form"');
    assert.ok(seqFinalIdx > -1 && identityFormIdx > -1);
    assert.ok(seqFinalIdx < identityFormIdx, "#seq-final (com o convite de share) deve vir antes do form de identidade");
  });

  it("CSS: .share-card ganha destaque de borda de marca — peso visual igual ou maior que .signup-form (mesmo padding/bg)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /\.share-card \{[^}]*border-left: 4px solid[^}]*\}/, "share-card deve ter borda de destaque na cor de marca");
    assert.match(html, /\.share-kicker \{[^}]*\}/, "kicker deve ter estilo próprio (não texto sem formatação)");
  });

  it("estado vazio (sem edições) não renderiza o MARKUP do kicker (a regra CSS persiste — mesmo padrão de #seq-batch-break, só o <style> é sempre presente)", () => {
    const html = renderJogarSequencePageHtml([]);
    assert.doesNotMatch(html, /<p class="share-kicker">/, "sem edições não há bodyHtml (nem #seq-final) pra ter kicker nenhum");
  });
});

// ── item 4: checkpoint parcial (#4005, 5 pares) também ganha share ──────────

describe("checkpoint parcial de 5 pares ganha botão de compartilhar (#4006 item 4)", () => {
  it("SEQ_INITIAL_BATCH_SIZE ainda é 5 (sanity — #4005 não regrediu)", () => {
    assert.equal(SEQ_INITIAL_BATCH_SIZE, 5);
  });

  it("#seq-batch-break embute um slot de share dedicado (#seq-batch-share-slot), distinto do da tela final", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    const batchBlockMatch = /<div id="seq-batch-break" class="quiz-final" hidden>([\s\S]*?)<\/div>\s*<div id="seq-final"/.exec(html);
    assert.ok(batchBlockMatch, "#seq-batch-break deve existir");
    const batchBlock = batchBlockMatch![1];
    assert.match(batchBlock, /<div id="seq-batch-share-slot" hidden><\/div>/);
    assert.match(batchBlock, /<p class="share-kicker">[^<]+<\/p>/, "checkpoint também ganha o kicker estático");
    // Continua tendo o botão "Continuar jogando" e a nota de persistência —
    // #4006 não pode ter removido nada do #4005.
    assert.match(batchBlock, /<button type="button" id="seq-continue-btn" class="seq-continue-btn">Continuar jogando<\/button>/);
    assert.match(batchBlock, /Seu placar fica salvo neste navegador\./);
  });

  it("showBatchBreak (script embutido) busca /jogar/quiz/result com score/total do LOTE (não da sequência inteira) e injeta em #seq-batch-share-slot", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602", "260603", "260604", "260605", "260606"]);
    assert.match(
      html,
      /var batchShareSlot = document\.getElementById\("seq-batch-share-slot"\);/,
    );
    assert.match(
      html,
      /fetch\("\/jogar\/quiz\/result\?score=" \+ encodeURIComponent\(String\(batchCorrect\)\) \+ "&total=" \+ encodeURIComponent\(String\(BATCH_SIZE\)\)\)/,
    );
  });

  it("shareButtonScript é wired tanto pra #seq-share-slot (final) quanto pra #seq-batch-share-slot (checkpoint)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /document\.querySelector\("#seq-share-slot"\)/);
    assert.match(html, /document\.querySelector\("#seq-batch-share-slot"\)/);
  });

  it("estado vazio (0 edições) não embute o slot de share do checkpoint (scriptHtml inteiro omitido)", () => {
    const html = renderJogarSequencePageHtml([]);
    assert.doesNotMatch(html, /seq-batch-share-slot/);
  });
});

// ── item 2: copy do share carrega placar + desafio direto ──────────────────

describe("buildQuizShareText: placar real + desafio direto (#4006 item 2)", () => {
  it("mantém 'Acertei X de Y' (contrato de poll-jogar-quiz-3520/poll-share-3517 — não pode divergir)", () => {
    const text = buildQuizShareText({ score: 4, total: 5 });
    assert.match(text, /Acertei 4 de 5/);
  });

  it("carrega o desafio direto pedido pelo editor ('Duvido você acertar mais')", () => {
    const text = buildQuizShareText({ score: 4, total: 5 });
    assert.match(text, /Duvido você acertar mais/);
  });

  it("não menciona mais 'quiz relâmpago' — o mesmo texto é reusado pela sequência mensal (showFinal/showBatchBreak), onde essa referência seria incorreta", () => {
    const text = buildQuizShareText({ score: 4, total: 5 });
    assert.doesNotMatch(text, /quiz relâmpago/);
  });

  it("continua terminando no link do jogo (contrato #3717, não regride)", () => {
    const text = buildQuizShareText({ score: 4, total: 5 });
    assert.ok(text.endsWith(`${PUBLIC_GAME_DISPLAY_HOST}/jogar/quiz`));
  });

  it("varia o placar interpolado corretamente pra qualquer score/total (não hardcoded)", () => {
    assert.match(buildQuizShareText({ score: 0, total: 22 }), /Acertei 0 de 22/);
    assert.match(buildQuizShareText({ score: 22, total: 22 }), /Acertei 22 de 22/);
  });
});

// ── item 3: UTM continua intacto na cadeia de share após as mudanças ───────

describe("UTM preservado na cadeia de share após as mudanças de layout/copy (#4006 item 3, confirma #3978)", () => {
  const payload: QuizSharePayload = { score: 4, total: 5 };

  it("renderQuizShareCardBlock: os 3 botões continuam com utm_source/utm_medium/utm_campaign — copy nova não quebrou os params", () => {
    const html = renderQuizShareCardBlock("s4t5.abc", payload);
    for (const medium of ["social", "whatsapp", "copy"]) {
      assert.match(
        html,
        new RegExp(`utm_source=eia-standalone&amp;utm_medium=${medium}&amp;utm_campaign=eia-quiz-share`),
      );
    }
  });

  it("fim-a-fim: GET /jogar/quiz/result (usado por showFinal E showBatchBreak) devolve card com UTM intacto", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar/quiz/result?score=4&total=5"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /utm_source=eia-standalone&amp;utm_medium=social&amp;utm_campaign=eia-quiz-share/);
    assert.match(html, /Duvido você acertar mais/, "card fim-a-fim já usa a copy nova");
  });
});

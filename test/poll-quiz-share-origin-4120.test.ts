/**
 * test/poll-quiz-share-origin-4120.test.ts (#4120)
 *
 * "É IA? — card da sequência se anuncia como 'quiz relâmpago'" (P1). A
 * sequência (`/jogar` sem `?edition=`, o modo PADRÃO do jogo) reusa
 * LITERALMENTE o endpoint `/jogar/quiz/result` (#3520/#3589) pra montar o
 * card final de compartilhamento — mas o card, a página de destino e a
 * imagem OG sempre se anunciavam como "quiz relâmpago" e mandavam o
 * destinatário pra `/jogar/quiz`, mesmo quando quem compartilhou jogou a
 * SEQUÊNCIA (o caso mais comum, já que é o modo default).
 *
 * Fix: `QuizSharePayload` ganha um campo `origin` opcional ("quiz" |
 * "sequence"), propagado ponta-a-ponta — o fetch client-side da sequência
 * (`showBatchBreak`/`showFinal` em `renderJogarSequencePageHtml`) manda
 * `&origin=sequence`; `resolveQuizResultParams`/`handleQuizResult` (jogar.ts)
 * leem o param e embutem no payload assinado; `renderQuizShareCardSvg`/
 * `renderQuizSharePageHtml` (share.ts) escolhem headline/título/kicker/CTA
 * conforme `payload.origin`.
 *
 * Cobre:
 *   - serializeQuizSharePayload/deserializeQuizSharePayload: round-trip com
 *     origin "sequence" e sem origin (default "quiz"); back-compat — corpo
 *     de token JÁ EMITIDO (`Q.{score}.{total}`, sem o segmento `.s`) decodifica
 *     igual a antes do #4120.
 *   - resolveQuizResultParams: `&origin=sequence` inclui o campo; ausente/
 *     qualquer outro valor não inclui (mesmo shape de antes do #4120).
 *   - renderQuizShareCardSvg/renderQuizSharePageHtml: origin="sequence" NUNCA
 *     diz "quiz"/"quiz relâmpago" e aponta pra `/jogar` (não `/jogar/quiz`);
 *     origin ausente preserva EXATAMENTE o texto/CTA de quiz relâmpago
 *     (tokens de quiz já emitidos continuam caindo no texto certo).
 *   - fim-a-fim via router: GET /jogar/quiz/result?...&origin=sequence →
 *     token embutido → GET /quiz-og/{token} e /quiz-share/{token} refletem
 *     a sequência; sem `origin=` → continuam refletindo quiz relâmpago.
 *   - client script: renderJogarSequencePageHtml (showBatchBreak E showFinal)
 *     embute `&origin=sequence` no fetch; renderJogarQuizPageHtml (o quiz de
 *     verdade) NÃO embute esse parâmetro.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeQuizShareToken,
  deserializeQuizSharePayload,
  encodeQuizShareToken,
  renderQuizShareCardSvg,
  renderQuizSharePageHtml,
  serializeQuizSharePayload,
  type QuizSharePayload,
} from "../workers/poll/src/share.ts";
import {
  handleQuizResult,
  renderJogarQuizPageHtml,
  renderJogarSequencePageHtml,
  resolveQuizResultParams,
} from "../workers/poll/src/jogar.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

const makeEnv = (seed: Record<string, string> = {}): Env => ({
  POLL: makeTrackedKv(seed) as unknown as Env["POLL"],
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
});

describe("serializeQuizSharePayload / deserializeQuizSharePayload (#4120) — origin opcional", () => {
  it("round-trip com origin='sequence'", () => {
    const payload: QuizSharePayload = { score: 4, total: 5, origin: "sequence" };
    const body = serializeQuizSharePayload(payload);
    assert.equal(body, "Q.4.5.s");
    assert.deepEqual(deserializeQuizSharePayload(body), payload);
  });

  it("round-trip sem origin (default 'quiz') — corpo IDÊNTICO ao formato pré-#4120", () => {
    const payload: QuizSharePayload = { score: 4, total: 5 };
    const body = serializeQuizSharePayload(payload);
    assert.equal(body, "Q.4.5", "corpo não pode ganhar sufixo pro caso default — back-compat de assinatura HMAC");
    assert.deepEqual(deserializeQuizSharePayload(body), { score: 4, total: 5 });
  });

  it("back-compat: corpo de token JÁ EMITIDO antes do #4120 (sem segmento .s) decodifica igual a antes", () => {
    // Corpo literal que um token de quiz emitido ANTES desta issue teria.
    const legacyBody = "Q.7.10";
    const decoded = deserializeQuizSharePayload(legacyBody);
    assert.deepEqual(decoded, { score: 7, total: 10 }, "token legado não pode ganhar origin='sequence' por adivinhação");
  });

  it("segmento de origin desconhecido/malformado é rejeitado (validação estrita preservada)", () => {
    assert.equal(deserializeQuizSharePayload("Q.4.5.x"), null);
    assert.equal(deserializeQuizSharePayload("Q.4.5.sequence"), null);
  });
});

describe("encodeQuizShareToken / decodeQuizShareToken (#4120) — fim-a-fim com origin", () => {
  it("token com origin='sequence' decodifica de volta ao payload original", async () => {
    const payload: QuizSharePayload = { score: 3, total: 6, origin: "sequence" };
    const token = await encodeQuizShareToken("secret-a", payload);
    const decoded = await decodeQuizShareToken("secret-a", token);
    assert.deepEqual(decoded, payload);
  });

  it("token de quiz emitido ANTES do #4120 (sem origin) continua decodificando sem o campo — nunca vira 'sequence'", async () => {
    const payload: QuizSharePayload = { score: 3, total: 6 };
    const token = await encodeQuizShareToken("secret-a", payload);
    const decoded = await decodeQuizShareToken("secret-a", token);
    assert.deepEqual(decoded, { score: 3, total: 6 });
  });
});

describe("resolveQuizResultParams (#4120) — &origin=sequence", () => {
  it("rawOrigin='sequence' inclui origin no payload", () => {
    assert.deepEqual(resolveQuizResultParams("4", "5", "sequence"), { score: 4, total: 5, origin: "sequence" });
  });

  it("rawOrigin ausente/undefined preserva o shape de antes do #4120 (sem a chave origin)", () => {
    assert.deepEqual(resolveQuizResultParams("4", "5"), { score: 4, total: 5 });
  });

  it("rawOrigin com valor desconhecido (não 'sequence') cai no default — nunca vira 'sequence' por engano", () => {
    assert.deepEqual(resolveQuizResultParams("4", "5", "quiz"), { score: 4, total: 5 });
    assert.deepEqual(resolveQuizResultParams("4", "5", "lixo"), { score: 4, total: 5 });
    assert.deepEqual(resolveQuizResultParams("4", "5", null), { score: 4, total: 5 });
  });
});

describe("renderQuizShareCardSvg (#4120) — headline/watermark por origem", () => {
  it("origin='sequence': NUNCA diz 'quiz relâmpago', headline plain 'É IA?', watermark aponta pra /jogar", () => {
    const svg = renderQuizShareCardSvg({ score: 18, total: 22, origin: "sequence" });
    assert.doesNotMatch(svg, /QUIZ RELÂMPAGO/i);
    assert.match(svg, />É IA\?</);
    assert.ok(svg.includes(">eia.diar.ia.br/jogar<"), "watermark deve apontar pra /jogar, não /jogar/quiz");
    assert.doesNotMatch(svg, /\/jogar\/quiz</);
  });

  it("origin ausente (quiz, default) preserva EXATAMENTE o texto original — tokens de quiz já emitidos continuam corretos", () => {
    const svg = renderQuizShareCardSvg({ score: 4, total: 5 });
    assert.match(svg, /É IA\? — QUIZ RELÂMPAGO/);
    assert.ok(svg.includes(">eia.diar.ia.br/jogar/quiz<"));
  });
});

describe("renderQuizSharePageHtml (#4120) — <title>/kicker/CTA por origem", () => {
  it("origin='sequence': título/kicker sem 'quiz relâmpago', CTA leva pra /jogar (não /jogar/quiz)", () => {
    const html = renderQuizSharePageHtml({
      token: "t",
      payload: { score: 18, total: 22, origin: "sequence" },
      utmMedium: "link",
    });
    assert.match(html, /<title>É IA\? — resultado da sequência \| Diar\.ia<\/title>/);
    assert.doesNotMatch(html, /quiz relâmpago/i);
    assert.match(html, /<p class="kicker">É IA\?<\/p>/);
    const ctaMatch = /<a class="cta" href="([^"]+)">([^<]+)<\/a>/.exec(html);
    assert.ok(ctaMatch, "CTA não encontrado");
    assert.match(decodeURIComponent(ctaMatch![1]), /^\/jogar\?/, "CTA da sequência deve levar pra /jogar, não /jogar/quiz");
    assert.equal(ctaMatch![2], "Jogar agora");
  });

  it("origin ausente (quiz, default) preserva EXATAMENTE título/kicker/CTA originais — link de quiz já compartilhado continua igual", () => {
    const html = renderQuizSharePageHtml({
      token: "t",
      payload: { score: 4, total: 5 },
      utmMedium: "link",
    });
    assert.match(html, /<title>É IA\? — quiz relâmpago \| Diar\.ia<\/title>/);
    assert.match(html, /<p class="kicker">É IA\? — quiz relâmpago<\/p>/);
    const ctaMatch = /<a class="cta" href="([^"]+)">([^<]+)<\/a>/.exec(html);
    assert.ok(ctaMatch);
    assert.match(decodeURIComponent(ctaMatch![1]), /^\/jogar\/quiz\?/);
    assert.equal(ctaMatch![2], "Jogar o quiz");
  });
});

describe("fim-a-fim via router (#4120) — GET /jogar/quiz/result → /quiz-og//quiz-share refletem a origem", () => {
  it("&origin=sequence: card assinado carrega origin, /quiz-share/{token} reflete a sequência", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/jogar/quiz/result?score=18&total=22&origin=sequence"),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    const match = /data-share-url="https:\/\/eia\.diar\.ia\.br\/quiz-share\/([^"?]+)\?/.exec(html);
    assert.ok(match, "share URL com token não encontrada");
    const token = decodeURIComponent(match![1]);
    const decoded = await decodeQuizShareToken(env.POLL_SECRET, token);
    assert.deepEqual(decoded, { score: 18, total: 22, origin: "sequence" });

    const shareRes = await worker.fetch(new Request(`https://poll.test/quiz-share/${token}`), env);
    assert.equal(shareRes.status, 200);
    const shareHtml = await shareRes.text();
    assert.doesNotMatch(shareHtml, /quiz relâmpago/i, "sequência não pode se anunciar como quiz relâmpago no share page");

    const ogRes = await worker.fetch(new Request(`https://poll.test/quiz-og/${token}`), env);
    assert.equal(ogRes.status, 200);
    const svg = await ogRes.text();
    assert.doesNotMatch(svg, /QUIZ RELÂMPAGO/i);
  });

  it("sem &origin=: continua tudo igual (quiz relâmpago) — regressão do comportamento pré-#4120", async () => {
    const env = makeEnv();
    const res = await worker.fetch(new Request("https://poll.test/jogar/quiz/result?score=4&total=5"), env);
    assert.equal(res.status, 200);
    const html = await res.text();
    const match = /data-share-url="https:\/\/eia\.diar\.ia\.br\/quiz-share\/([^"?]+)\?/.exec(html);
    assert.ok(match);
    const token = decodeURIComponent(match![1]);
    const decoded = await decodeQuizShareToken(env.POLL_SECRET, token);
    assert.deepEqual(decoded, { score: 4, total: 5 });

    const shareRes = await worker.fetch(new Request(`https://poll.test/quiz-share/${token}`), env);
    const shareHtml = await shareRes.text();
    assert.match(shareHtml, /quiz relâmpago/i, "quiz relâmpago de verdade deve continuar se anunciando como tal");
  });
});

describe("client script (#4120) — sequência marca &origin=sequence, quiz de verdade não marca", () => {
  it("renderJogarSequencePageHtml: showBatchBreak E showFinal embutem &origin=sequence no fetch", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602", "260603", "260604", "260605", "260606"]);
    // Cada chamada fetch fica sozinha na sua linha (fecha o parêntese ANTES
    // do .then() na linha seguinte) — casar até o fim da LINHA evita o
    // problema de parênteses aninhados de encodeURIComponent(String(...)).
    const fetchCalls = html.match(/fetch\("\/jogar\/quiz\/result\?[^\n]*$/gm) ?? [];
    assert.equal(fetchCalls.length, 2, "sequência deve ter 2 fetches pro endpoint (batch break + final)");
    for (const call of fetchCalls) {
      assert.match(call, /&origin=sequence"\)$/, `fetch da sequência deve terminar em &origin=sequence: ${call}`);
    }
  });

  it("renderJogarQuizPageHtml (quiz de verdade): fetch NÃO embute &origin= nenhum", () => {
    const html = renderJogarQuizPageHtml(["260601"]);
    const fetchCall = /fetch\("\/jogar\/quiz\/result\?[^\n]*$/m.exec(html);
    assert.ok(fetchCall, "quiz também busca /jogar/quiz/result");
    assert.doesNotMatch(fetchCall![0], /origin=/, "quiz relâmpago de verdade não deve marcar origin (default correto é 'quiz')");
  });
});

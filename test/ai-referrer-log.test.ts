/**
 * test/ai-referrer-log.test.ts (#4558 Parte C)
 *
 * Cobre `scripts/lib/shared/ai-referrer-log.ts` — detecção de Referer de
 * assistente de IA (matchAiReferrerHost) e o logging estruturado
 * (logAiReferrerHit, injetável).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AI_REFERRER_HOSTS,
  AI_REFERRER_WORKERS,
  formatAiReferrerLogLine,
  logAiReferrerHit,
  matchAiReferrerHost,
} from "../scripts/lib/shared/ai-referrer-log.ts";

describe("matchAiReferrerHost", () => {
  it("casa cada um dos 4 hosts da issue #4558 (host exato)", () => {
    assert.equal(matchAiReferrerHost("https://chatgpt.com/c/abc123"), "chatgpt.com");
    assert.equal(matchAiReferrerHost("https://perplexity.ai/search?q=x"), "perplexity.ai");
    assert.equal(matchAiReferrerHost("https://claude.ai/chat/abc"), "claude.ai");
    assert.equal(matchAiReferrerHost("https://gemini.google.com/app"), "gemini.google.com");
  });

  it("casa um subdomínio direto do host (ex: www.claude.ai)", () => {
    assert.equal(matchAiReferrerHost("https://www.claude.ai/chat/abc"), "claude.ai");
  });

  it("não casa host diferente, mesmo que pareça relacionado (chat.openai.com != chatgpt.com)", () => {
    assert.equal(matchAiReferrerHost("https://chat.openai.com/c/abc"), null);
  });

  it("não casa domínio nenhum de fora da lista", () => {
    assert.equal(matchAiReferrerHost("https://www.google.com/search?q=x"), null);
    assert.equal(matchAiReferrerHost("https://diar.ia.br/"), null);
  });

  it("retorna null (nunca lança) pra Referer ausente/vazio/malformado", () => {
    assert.equal(matchAiReferrerHost(null), null);
    assert.equal(matchAiReferrerHost(undefined), null);
    assert.equal(matchAiReferrerHost(""), null);
    assert.doesNotThrow(() => matchAiReferrerHost("não é uma url"));
    assert.equal(matchAiReferrerHost("não é uma url"), null);
  });

  it("é case-insensitive no host", () => {
    assert.equal(matchAiReferrerHost("https://Claude.AI/chat"), "claude.ai");
  });

  it("AI_REFERRER_HOSTS tem exatamente os 4 hosts citados na issue #4558", () => {
    assert.deepEqual([...AI_REFERRER_HOSTS].sort(), [
      "chatgpt.com",
      "claude.ai",
      "gemini.google.com",
      "perplexity.ai",
    ]);
  });
});

describe("formatAiReferrerLogLine", () => {
  it("formata JSON de 1 linha com event + campos do hit", () => {
    const line = formatAiReferrerLogLine({
      worker: "cursos",
      host: "chatgpt.com",
      path: "/",
      at: "2026-08-04T12:00:00.000Z",
    });
    const parsed = JSON.parse(line);
    assert.equal(parsed.event, "ai_referrer_hit");
    assert.equal(parsed.worker, "cursos");
    assert.equal(parsed.host, "chatgpt.com");
    assert.equal(parsed.path, "/");
    assert.equal(parsed.at, "2026-08-04T12:00:00.000Z");
  });

  it("é pure — mesma entrada produz sempre a mesma saída", () => {
    const hit = { worker: "livros", host: "claude.ai" as const, path: "/", at: "2026-01-01T00:00:00.000Z" };
    assert.equal(formatAiReferrerLogLine(hit), formatAiReferrerLogLine(hit));
  });
});

describe("logAiReferrerHit", () => {
  it("chama o logger injetado com a linha formatada, usando o relógio injetado", () => {
    const lines: string[] = [];
    logAiReferrerHit(
      "arquivo",
      "gemini.google.com",
      "/p/edicao-x",
      (line) => lines.push(line),
      () => new Date("2026-08-04T09:30:00.000Z"),
    );
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.deepEqual(parsed, {
      event: "ai_referrer_hit",
      worker: "arquivo",
      host: "gemini.google.com",
      path: "/p/edicao-x",
      at: "2026-08-04T09:30:00.000Z",
    });
  });

  it("usa console.log e new Date() por default (só verifica que não lança)", () => {
    assert.doesNotThrow(() => logAiReferrerHit("livros", "perplexity.ai", "/", () => {}));
  });
});

describe("AiReferrerWorker (#4616 achado 5: union tipada, não string livre)", () => {
  it("AI_REFERRER_WORKERS tem exatamente os 3 Workers que chamam logAiReferrerHit hoje", () => {
    assert.deepEqual([...AI_REFERRER_WORKERS].sort(), ["arquivo", "cursos", "livros"]);
  });

  it("os 3 call sites reais (cursos/livros/arquivo) continuam aceitos", () => {
    const lines: string[] = [];
    for (const worker of AI_REFERRER_WORKERS) {
      assert.doesNotThrow(() => logAiReferrerHit(worker, "claude.ai", "/", (l) => lines.push(l)));
    }
    assert.equal(lines.length, AI_REFERRER_WORKERS.length);
  });

  it("um typo no worker é rejeitado em COMPILE-TIME, não silenciosamente aceito (regressão #4616)", () => {
    // Antes do #4616, `worker` era `string` livre — este typo compilava limpo
    // e corrompia o log de atribuição em silêncio. Agora `AiReferrerWorker` é
    // uma union fechada — o erro de tipo abaixo É o teste (se alguém reverter
    // pra `string`, `tsc --noEmit` deixa de reclamar aqui e o typo volta a
    // passar despercebido).
    // @ts-expect-error — "curso" (sem 's') não é um AiReferrerWorker válido
    assert.doesNotThrow(() => logAiReferrerHit("curso", "claude.ai", "/", () => {}));
  });
});

/**
 * test/site-assinar-page-7015.test.ts (#7015)
 *
 * Regressão do bug de wordmark em `/assinar` — 3ª ocorrência do mesmo padrão
 * (#4797 extraiu `brand-wordmark.ts`; #7010 achou a HOME reescrevendo a
 * marca à mão, só os pontos em teal, sem o `.br` inteiro; agora `/assinar`).
 * Espelha `test/site-home-page-6375.test.ts` (linhas 279-294, testes do
 * #7010) — mesma trava, mesmo mecanismo, aplicado ao gerador novo desta
 * issue (`scripts/lib/site-assinar-page.ts`).
 *
 * Guard mecânico genérico: `assertWordmarkDisplayCorrect` verifica que
 * QUALQUER trecho de HTML que contenha um `<h1>` (ou qualquer elemento) com
 * "diar" seguido de spans decorativos tem o `.br` inteiro dentro do span
 * teal — não hardcoded pro `/assinar`, reusável pra qualquer superfície
 * futura que reescreva a marca à mão (é exatamente essa reescrita que já
 * causou a 2ª e a 3ª ocorrência do bug).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAssinarHtml } from "../scripts/lib/site-assinar-page.ts";
import { WORDMARK_DISPLAY_SEGMENTS } from "../scripts/lib/shared/brand-wordmark.ts";

/** Regex-escapa `s` — usado pra montar `RegExp` a partir de markup literal. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Markup canônico do wordmark de display, derivado por VALOR de
 * `WORDMARK_DISPLAY_SEGMENTS` — não hardcoded aqui, senão o teste trava só a
 * cópia do dia em que foi escrito e não pega drift se `brand-wordmark.ts`
 * mudar a estrutura sem os consumidores acompanharem (mesmo mecanismo do
 * #7010).
 */
const WORDMARK_HTML = WORDMARK_DISPLAY_SEGMENTS.map((seg) => {
  const cls = seg.teal ? ' class="dot"' : "";
  const hidden = seg.decorative ? ' aria-hidden="true"' : "";
  return `<span${cls}${hidden}>${seg.text}</span>`;
}).join("");

/**
 * Guard genérico (não específico a `/assinar`): num HTML de display
 * "diar.ia.br" (h1/nav/logo, não prosa corrida), o "br" precisa estar
 * DENTRO de `class="dot"` — nunca como texto solto atrás do span teal.
 * Reusável por qualquer teste de superfície futura que renderize o
 * wordmark de display.
 */
function assertWordmarkDisplayCorrect(html: string): void {
  assert.match(
    html,
    /<span class="dot">br<\/span>/,
    "'br' precisa estar DENTRO do span teal (class=\"dot\") — reescrever a marca à mão sem consumir WORDMARK_DISPLAY_SEGMENTS tende a colorir só os pontos e deixar '.br' preto",
  );
  assert.ok(
    !html.includes('<span class="dot" aria-hidden="true">br</span>'),
    "'br' não pode estar aria-hidden — um leitor de tela pularia parte do nome da marca",
  );
}

describe("buildAssinarHtml (#7015)", () => {
  const html = buildAssinarHtml();

  it("usa a MESMA estrutura canônica do wordmark que a home (#7010) — '.br' inteiro em teal, não só o ponto", () => {
    assert.match(html, new RegExp(`<h1>${reEscape(WORDMARK_HTML)}</h1>`));
    assertWordmarkDisplayCorrect(html);
  });

  it("os 2 pontos separadores continuam aria-hidden (decorativos)", () => {
    assert.equal((html.match(/<span class="dot" aria-hidden="true">\.<\/span>/g) ?? []).length, 2);
  });

  it("preserva o form de cadastro (source=apex, action pro worker poll) — gerador não deve tocar no resto do conteúdo", () => {
    assert.match(html, /action="https:\/\/eia\.diar\.ia\.br\/jogar\/subscribe"/);
    assert.match(html, /<input type="hidden" name="source" value="apex">/);
  });
});

describe("regressão do bug original (#7015) — HTML anterior sem o gerador falharia este guard", () => {
  it("o markup antigo (só pontos coloridos, 'br' texto solto) É rejeitado pelo guard genérico", () => {
    const buggyH1 = `<h1>diar<span class="dot">.</span>ia<span class="dot">.</span>br</h1>`;
    assert.throws(() => assertWordmarkDisplayCorrect(buggyH1));
  });
});

/**
 * test/poll-jogar-cls-3607.test.ts (#3607)
 *
 * Fix de layout shift (CLS) na sequência web (`/jogar`, modelo Suspense
 * #3595/#3589): `renderRound()` troca o par via `choicesEl.innerHTML =
 * "<img ...>..."`, recriando os `<img loading="lazy">` sem dimensão
 * reservada — a caixa colapsava pra ~0 de altura até a imagem carregar
 * (conteúdo abaixo subia), e re-expandia ao carregar (conteúdo descia de
 * novo). Imagens do É IA são 800x450 (16:9).
 *
 * Fix (workers/poll/src/jogar.ts):
 *   1. `width="800" height="450"` nos `<img>` gerados por `renderRound()`
 *      (sequência) — reserva o box na proporção certa antes do load.
 *   2. `aspect-ratio: 16 / 9` na regra `.choice img` (ambas as páginas —
 *      reforço pro caso do browser ignorar os atributos width/height).
 *   3. Mesmo reserve de espaço no par único (`renderJogarPageHtml`), por
 *      consistência (mesmo risco de CLS ali, embora sem innerHTML swap).
 *   4. Pré-carrega o PRÓXIMO par (`new Image()`) enquanto o leitor ainda
 *      olha o par atual — troca em cache-hit, sem piscar branco.
 *
 * Regressão coberta aqui: `<img>` da sequência/par único voltar SEM
 * dimensão reservada (nem width/height nem aspect-ratio) seria a
 * reintrodução do bug.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderJogarPageHtml, renderJogarSequencePageHtml } from "../workers/poll/src/jogar.ts";

describe("CLS fix — sequência (#3607)", () => {
  it(".choice img reserva aspect-ratio 16:9 no CSS (reforço pro width/height)", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /\.choice img \{[^}]*aspect-ratio:\s*16\s*\/\s*9[^}]*\}/);
  });

  it("renderRound() gera <img> com width=800/height=450 reservados (a troca de par via innerHTML não pode voltar a criar <img> sem dimensão)", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    // As duas <img> montadas dentro do script inline de renderRound().
    assert.match(html, /<img src="' \+ imgUrl\(edition, "A"\) \+ '" width="800" height="450" alt="Imagem A"/);
    assert.match(html, /<img src="' \+ imgUrl\(edition, "B"\) \+ '" width="800" height="450" alt="Imagem B"/);
  });

  it("pré-carrega o próximo par via new Image() (cache-hit na troca, sem piscar branco)", () => {
    const html = renderJogarSequencePageHtml(["260601", "260602"]);
    assert.match(html, /function preloadRound\(/);
    assert.match(html, /new Image\(\)/);
    assert.match(html, /preloadRound\(playIndices\[round \+ 1\]\)/);
  });
});

describe("CLS fix — par único (#3607, consistência com a sequência)", () => {
  it(".choice img reserva aspect-ratio 16:9 no CSS", () => {
    const html = renderJogarPageHtml({ edition: "260601", revealed: false });
    assert.match(html, /\.choice img \{[^}]*aspect-ratio:\s*16\s*\/\s*9[^}]*\}/);
  });

  it("<img> estáticas (A e B) já nascem com width=800/height=450", () => {
    const html = renderJogarPageHtml({ edition: "260601", revealed: false });
    assert.match(html, /<img id="jogar-img-a" src="[^"]+" width="800" height="450" alt="Imagem A" loading="lazy">/);
    assert.match(html, /<img id="jogar-img-b" src="[^"]+" width="800" height="450" alt="Imagem B" loading="lazy">/);
  });
});

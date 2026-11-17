/**
 * test/roteiro-video-topicos.test.ts
 *
 * Tópicos da fala (`topicos`, pedido do editor em 17/11/2026): bullets de até
 * 4 palavras que a página do roteiro mostra numa coluna ao lado da fala, em
 * todos os vídeos que usam a fala, para gravar sem ler.
 *   - o validador aceita a lista, recusa tópico vazio, lista vazia e tópico
 *     com mais de 4 palavras;
 *   - a página mostra os bullets no horizontal e nos verticais;
 *   - fala sem tópicos não ganha lista.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contarPalavrasTopico,
  TOPICO_MAX_PALAVRAS,
  validarRoteiroFalas,
  type RoteiroFalas,
} from "../scripts/lib/diaria/roteiro-gravacao.ts";
import { renderRoteiroPagina } from "../scripts/lib/diaria/roteiro-pagina.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "roteiro-video", "roteiro-falas-261116.json");
const base = (): RoteiroFalas => JSON.parse(readFileSync(FIXTURE, "utf8"));

/** A fixture sem tópicos em nenhuma fala, mesmo que ela venha a ganhar tópicos. */
function semTopicos(): RoteiroFalas {
  const r = base();
  for (const f of r.falas) delete f.topicos;
  return r;
}

/** Uma fala da fixture que está no horizontal e em algum vertical. */
function falaCompartilhada(r: RoteiroFalas) {
  const f = r.falas.find((x) => x.videos.includes("horizontal") && x.videos.some((v) => v !== "horizontal"));
  assert.ok(f, "a fixture precisa de uma fala no horizontal e num vertical");
  return f;
}

describe("topicos da fala", () => {
  it("conta palavras sem contar pontuação solta", () => {
    assert.equal(TOPICO_MAX_PALAVRAS, 4);
    assert.equal(contarPalavrasTopico("Cargo: aconteceu"), 2);
    assert.equal(contarPalavrasTopico("  Vídeo completo no YouTube "), 4);
    assert.equal(contarPalavrasTopico("Placar —"), 1);
  });

  it("aceita tópicos de até 4 palavras", () => {
    const r = base();
    falaCompartilhada(r).topicos = ["Duas aconteceram", "Chinesa contrata data center"];
    assert.deepEqual(validarRoteiroFalas(r), []);
  });

  it("recusa tópico longo, sem palavra, com quebra de linha, com seta, não-texto e lista vazia ou não-lista", () => {
    const casos: Array<[unknown, string]> = [
      [["Um dois três quatro cinco"], "5 palavras"],
      [["  "], "pelo menos uma palavra"],
      [["—"], "pelo menos uma palavra"],
      [[42], "pelo menos uma palavra"],
      [["Antes\ndepois"], "em uma linha"],
      [["Antes → depois"], "seta"],
      [[], "lista não vazia"],
      ["Só um texto", "lista não vazia"],
    ];
    for (const [topicos, trecho] of casos) {
      const r = base();
      const f = falaCompartilhada(r);
      (f as { topicos?: unknown }).topicos = topicos;
      const problemas = validarRoteiroFalas(r);
      assert.ok(problemas.some((p) => p.startsWith(`${f.id}.topicos`) && p.includes(trecho)), `${JSON.stringify(topicos)}: esperado "${trecho}", veio ${JSON.stringify(problemas)}`);
    }
  });

  it("a página mostra os tópicos no horizontal e no vertical da fala", () => {
    const r = base();
    const f = falaCompartilhada(r);
    f.topicos = ["Tópico único da fala", "Segundo bullet"];
    const html = renderRoteiroPagina(r);
    const ocorrencias = html.split("<li>Tópico único da fala</li>").length - 1;
    assert.equal(ocorrencias, f.videos.length, "um bloco de tópicos por vídeo que usa a fala");
    assert.ok(html.includes('<ul class="topicos"><li>Tópico único da fala</li><li>Segundo bullet</li></ul>'));
  });

  it("com tópicos no roteiro, toda linha ganha a coluna (célula vazia quando a fala não tem)", () => {
    const r = semTopicos();
    falaCompartilhada(r).topicos = ["Só nesta fala"];
    const html = renderRoteiroPagina(r);
    assert.ok(html.includes('<div class="row com-topicos"><span></span><p class="fala">'), "fala sem tópicos fica com a célula vazia");
    assert.match(html, /<div class="row com-topicos"><ul class="topicos"><li>Só nesta fala<\/li><\/ul><p class="fala">[\s\S]*?<\/p><span><\/span><\/div>/, "vertical sem tela: tópicos, fala e célula de tela vazia");
    assert.match(html, /\.row\.com-topicos \{ grid-template-columns: 150px/);
    assert.match(html, /\.row > span:empty \{ display: none; \}/);
  });

  it("sem tópicos no roteiro, a linha fica como antes, sem a coluna", () => {
    const html = renderRoteiroPagina(semTopicos());
    assert.ok(!html.includes('<ul class="topicos">'));
    assert.ok(!html.includes('class="row com-topicos"'));
    assert.match(html, /<div class="row"><p class="fala">/);
  });

  it("o botão Copiar roteiro deixa os tópicos de fora", () => {
    const html = renderRoteiroPagina(base());
    assert.match(html, /querySelectorAll\('\.topicos'\)\.forEach\(function \(t\) \{ t\.remove\(\); \}\)/);
  });

  it("o Passo 5 da skill documenta o campo", () => {
    const skill = readFileSync(join(import.meta.dirname, "..", ".claude", "skills", "diaria-video-roteiro", "SKILL.md"), "utf8");
    assert.match(skill, /\*\*`topicos`\*\*/);
  });
});

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

  it("recusa tópico com mais de 4 palavras, vazio ou lista vazia", () => {
    const longo = base();
    const f = falaCompartilhada(longo);
    f.topicos = ["Um dois três quatro cinco"];
    assert.ok(validarRoteiroFalas(longo).some((p) => p.includes(`${f.id}.topicos[0]`) && p.includes("5 palavras")));

    const vazio = base();
    falaCompartilhada(vazio).topicos = ["  "];
    assert.ok(validarRoteiroFalas(vazio).some((p) => p.includes("topicos[0] deve ser texto não vazio")));

    const lista = base();
    falaCompartilhada(lista).topicos = [];
    assert.ok(validarRoteiroFalas(lista).some((p) => p.includes("topicos deve ser lista não vazia")));
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

  it("fala sem tópicos não ganha lista", () => {
    const html = renderRoteiroPagina(base());
    assert.ok(!html.includes('<ul class="topicos">'));
  });

  it("o Passo 5 da skill documenta o campo", () => {
    const skill = readFileSync(join(import.meta.dirname, "..", ".claude", "skills", "diaria-video-roteiro", "SKILL.md"), "utf8");
    assert.match(skill, /\*\*`topicos`\*\*/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseHighlights,
  flagOutOfRange,
  formatMeasureResult,
  HEALTHY_RANGE_MIN,
  HEALTHY_RANGE_MAX,
} from "../scripts/lib/measure-highlights.ts";

const SAMPLE_REVIEWED = `DESTAQUE 1 | PESQUISA
Brasil tem lacuna digital em habilidades com IA

Uma pesquisa da CNI mapeou habilidades digitais. Apenas 44.5% têm habilidades altas em automação.

A maioria está despreparada. Setores como finanças e logística já exigem familiaridade com automação.

Por que isso importa:
O dado quantifica um problema que gestores percebem de forma difusa.

https://example.com/cni-pesquisa-habilidades

---

DESTAQUE 2 | LANÇAMENTO
Google integra Gemini ao Chrome

O Google anunciou Skills no Chrome. O recurso transforma comandos em ferramentas reutilizáveis.

Por que isso importa:
A curva de adoção é mínima.

https://example.com/google-skills

---

DESTAQUE 3 | INDÚSTRIA
IA domina Bollywood

Estúdios indianos adotaram dublagem automática em escala.

Por que isso importa:
A pressão sobre outros mercados se intensifica.

https://example.com/bollywood

---

OUTRAS NOTÍCIAS

Outro item qualquer
Não conta como destaque.
https://example.com/outro
`;

describe("parseHighlights — extrai destaques d1/d2/d3 (#739)", () => {
  it("retorna result vazio pra string vazia", () => {
    const r = parseHighlights("");
    assert.deepEqual(r.highlights, []);
    assert.equal(r.total_chars, 0);
    assert.equal(r.total_words, 0);
    assert.deepEqual(r.warnings, []);
  });

  it("retorna result vazio pra input não-string (defensive)", () => {
    const r = parseHighlights(null as unknown as string);
    assert.deepEqual(r.highlights, []);
  });

  it("identifica os 3 destaques no markdown", () => {
    const r = parseHighlights(SAMPLE_REVIEWED);
    assert.equal(r.highlights.length, 3);
    assert.equal(r.highlights[0].number, 1);
    assert.equal(r.highlights[0].category, "PESQUISA");
    assert.equal(r.highlights[1].number, 2);
    assert.equal(r.highlights[1].category, "LANÇAMENTO");
    assert.equal(r.highlights[2].number, 3);
    assert.equal(r.highlights[2].category, "INDÚSTRIA");
  });

  it("ignora seções não-destaque (OUTRAS NOTÍCIAS, PESQUISAS)", () => {
    const r = parseHighlights(SAMPLE_REVIEWED);
    assert.equal(r.highlights.length, 3);
    // Não tem 'destaque 4' — confirma que outras seções foram ignoradas
    assert.ok(!r.highlights.find((h) => h.number === 4));
  });

  it("URLs são removidas do char count", () => {
    const md = `DESTAQUE 1 | TESTE
Título curto

Texto. https://example.com/very-long-url-aqui termina aqui.

---
`;
    const r = parseHighlights(md);
    assert.equal(r.highlights.length, 1);
    // Texto sem URL: "Título curto Texto. termina aqui." (32-ish chars)
    // Sem URL no count
    assert.ok(r.highlights[0].chars < 50, `chars deveria ser baixo: ${r.highlights[0].chars}`);
    assert.ok(!String(r.highlights[0].chars).includes("example.com"));
  });

  it("conta palavras corretamente (body sem header)", () => {
    const md = `DESTAQUE 1 | TESTE
Um dois três quatro cinco

---
`;
    const r = parseHighlights(md);
    // Header line "DESTAQUE 1 | TESTE" não é body — capture group 3 do regex
    // é tudo APÓS o header. Body = "Um dois três quatro cinco" → 5 palavras.
    assert.equal(r.highlights[0].words, 5);
  });

  it("totals somam corretamente", () => {
    const r = parseHighlights(SAMPLE_REVIEWED);
    const expectedChars = r.highlights.reduce((acc, h) => acc + h.chars, 0);
    const expectedWords = r.highlights.reduce((acc, h) => acc + h.words, 0);
    assert.equal(r.total_chars, expectedChars);
    assert.equal(r.total_words, expectedWords);
  });

  it("ordena destaques por número (caso markdown emita fora de ordem)", () => {
    const md = `DESTAQUE 3 | C
Body três.

---

DESTAQUE 1 | A
Body um.

---

DESTAQUE 2 | B
Body dois.

---
`;
    const r = parseHighlights(md);
    assert.equal(r.highlights.length, 3);
    assert.equal(r.highlights[0].number, 1);
    assert.equal(r.highlights[1].number, 2);
    assert.equal(r.highlights[2].number, 3);
  });

  it("category com emoji é preservado", () => {
    const md = `DESTAQUE 1 | 💼 MERCADO
Body com mercado.

---
`;
    const r = parseHighlights(md);
    assert.equal(r.highlights[0].category, "💼 MERCADO");
  });

  it("destaque sem '---' final ainda é capturado (último na ed)", () => {
    const md = `DESTAQUE 1 | A
Body um.

---

DESTAQUE 2 | B
Body dois sem --- final.`;
    const r = parseHighlights(md);
    assert.equal(r.highlights.length, 2);
    assert.equal(r.highlights[1].number, 2);
  });

  it("aceita header em **negrito** (#590)", () => {
    const md = `**DESTAQUE 1 | PESQUISA**
Body um.

Por que isso importa:
Razão do impacto.

---

**DESTAQUE 2 | LANÇAMENTO**
Body dois.

---
`;
    const r = parseHighlights(md);
    assert.equal(r.highlights.length, 2);
    assert.equal(r.highlights[0].number, 1);
    assert.equal(r.highlights[0].category, "PESQUISA");
    assert.equal(r.highlights[1].number, 2);
    assert.equal(r.highlights[1].category, "LANÇAMENTO");
  });

  it("backwards-compat: format misto (alguns bold, outros plain) funciona", () => {
    const md = `**DESTAQUE 1 | A**
Body um.

---

DESTAQUE 2 | B
Body dois.

---
`;
    const r = parseHighlights(md);
    assert.equal(r.highlights.length, 2);
    assert.equal(r.highlights[0].category, "A");
    assert.equal(r.highlights[1].category, "B");
  });
});

describe("flagOutOfRange — warnings out-of-range (#739)", () => {
  it("não emite warning quando todos dentro da faixa saudável", () => {
    const w = flagOutOfRange([
      { number: 1, category: "X", chars: 800, words: 150 },
      { number: 2, category: "Y", chars: 1000, words: 180 },
      { number: 3, category: "Z", chars: 1200, words: 200 },
    ]);
    assert.deepEqual(w, []);
  });

  it("emite warning quando chars < HEALTHY_RANGE_MIN", () => {
    const w = flagOutOfRange([
      { number: 1, category: "X", chars: 400, words: 70 },
    ]);
    assert.equal(w.length, 1);
    assert.match(w[0], /d1.*400 chars.*abaixo/);
    assert.match(w[0], /substância/);
  });

  it("emite warning quando chars > HEALTHY_RANGE_MAX", () => {
    const w = flagOutOfRange([
      { number: 2, category: "Y", chars: 1800, words: 300 },
    ]);
    assert.equal(w.length, 1);
    assert.match(w[0], /d2.*1800 chars.*acima/);
    assert.match(w[0], /CTR/);
  });

  it("emite warnings combinados quando múltiplos destaques fora", () => {
    const w = flagOutOfRange([
      { number: 1, category: "A", chars: 300, words: 50 },
      { number: 2, category: "B", chars: 800, words: 140 },
      { number: 3, category: "C", chars: 1700, words: 280 },
    ]);
    assert.equal(w.length, 2);
    assert.match(w[0], /d1.*abaixo/);
    assert.match(w[1], /d3.*acima/);
  });

  it("HEALTHY_RANGE constants exportados pra reuso", () => {
    assert.equal(HEALTHY_RANGE_MIN, 600);
    assert.equal(HEALTHY_RANGE_MAX, 1500);
  });
});

describe("formatMeasureResult — output legível (#739)", () => {
  it("inclui chars, palavras, categoria por destaque", () => {
    const r = parseHighlights(SAMPLE_REVIEWED);
    const out = formatMeasureResult(r);
    assert.match(out, /d1:.*chars.*palavras.*PESQUISA/);
    assert.match(out, /d2:.*LANÇAMENTO/);
    assert.match(out, /d3:.*INDÚSTRIA/);
  });

  it("inclui total no output", () => {
    const r = parseHighlights(SAMPLE_REVIEWED);
    const out = formatMeasureResult(r);
    assert.match(out, /total:.*chars/);
  });

  it("não inclui seção '⚠️ Avisos' quando warnings vazias", () => {
    const out = formatMeasureResult({
      highlights: [{ number: 1, category: "X", chars: 800, words: 150 }],
      total_chars: 800,
      total_words: 150,
      warnings: [],
    });
    assert.ok(!out.includes("Avisos"));
  });

  it("inclui seção '⚠️ Avisos' quando há warnings", () => {
    const out = formatMeasureResult({
      highlights: [{ number: 1, category: "X", chars: 300, words: 50 }],
      total_chars: 300,
      total_words: 50,
      warnings: ["d1: 300 chars — abaixo da faixa saudável"],
    });
    assert.match(out, /Avisos/);
    assert.match(out, /abaixo da faixa saudável/);
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectBrazil,
  parsePost,
  splitSections,
} from "../scripts/collect-monthly.ts";

const sampleFile = {
  path: "data/monthly/2603/raw-posts/post_d8d75586_260302.txt",
  filename: "post_d8d75586_260302.txt",
  beehiiv_post_id: "d8d75586",
  edition: "260302",
};

describe("detectBrazil", () => {
  it("flagra category=BRASIL como sinal forte (sem precisar de host ou keyword)", () => {
    const r = detectBrazil({
      category: "BRASIL",
      url: "https://example.com/foo",
      title: "Anthropic lança modelo",
      body: "Texto sobre IA em geral.",
    });
    assert.equal(r.is_brazil, true);
    assert.deepEqual(r.signals, ["category:BRASIL"]);
  });

  it("normaliza acento na categoria (BRASÍLIA hipotético)", () => {
    // Hipótese: scorer envia "Brasília" como categoria. NFD-strip + UPPERCASE
    // dá "BRASILIA" — não casa "BRASIL". Comportamento esperado: NÃO flagra
    // por categoria; pode flagrar por keyword se houver.
    const r = detectBrazil({
      category: "Brasília",
      url: "https://example.com/foo",
      title: "Algo",
      body: "Algo",
    });
    assert.equal(r.is_brazil, false, "categoria 'Brasília' não é 'BRASIL'");
  });

  it("flagra host .br", () => {
    const r = detectBrazil({
      category: "AGENTES",
      url: "https://exemplo.com.br/noticia",
      title: "Título neutro",
      body: "Corpo neutro sobre IA.",
    });
    assert.equal(r.is_brazil, true);
    assert.ok(r.signals.some((s) => s.startsWith("host:")));
  });

  it("flagra host curado (exame.com)", () => {
    const r = detectBrazil({
      category: "MERCADO",
      url: "https://www.exame.com/tecnologia/ai",
      title: "Título",
      body: "Corpo",
    });
    assert.equal(r.is_brazil, true);
    assert.ok(r.signals.includes("host:exame.com"));
  });

  it("flagra keyword com word boundary — 'Lula' bate, 'lulav' não", () => {
    const matchLula = detectBrazil({
      category: "POLÍTICA",
      url: "https://example.com/foo",
      title: "Lula assina decreto",
      body: "...",
    });
    assert.equal(matchLula.is_brazil, true);
    assert.ok(matchLula.signals.some((s) => s === "kw:lula"));

    const noMatchLulav = detectBrazil({
      category: "RELIGIÃO",
      url: "https://example.com/foo",
      title: "Lulav for sukkot",
      body: "Tradição judaica.",
    });
    assert.equal(noMatchLulav.is_brazil, false);
  });

  it("não flagra 'cade' dentro de 'cadeira' (boundary)", () => {
    const r = detectBrazil({
      category: "MOBILIDADE",
      url: "https://example.com/foo",
      title: "A cadeira eletrica",
      body: "Sobre cadeiras.",
    });
    assert.equal(r.is_brazil, false);
  });

  it("flagra 'Itaú' via accent-strip (haystack normalizado)", () => {
    const r = detectBrazil({
      category: "FINANÇAS",
      url: "https://example.com/foo",
      title: "Itaú anuncia parceria",
      body: "Banco Itaú e Anthropic.",
    });
    assert.equal(r.is_brazil, true);
    assert.ok(r.signals.includes("kw:itau"));
  });

  it("flagra 'Brasília' via accent-strip", () => {
    const r = detectBrazil({
      category: "GOVERNO",
      url: "https://example.com/foo",
      title: "Em Brasília hoje",
      body: "Reunião em Brasília.",
    });
    assert.equal(r.is_brazil, true);
    assert.ok(r.signals.includes("kw:brasilia"));
  });

  it("URL malformada não quebra — outros sinais ainda funcionam", () => {
    const r = detectBrazil({
      category: "BRASIL",
      url: "not a url",
      title: "Algo",
      body: "Algo",
    });
    assert.equal(r.is_brazil, true);
    assert.deepEqual(r.signals, ["category:BRASIL"]);
  });
});

describe("splitSections", () => {
  it("divide em separadores de 10+ traços", () => {
    const text = "primeira\n----------\nsegunda\n--------------------\nterceira";
    const sections = splitSections(text);
    assert.equal(sections.length, 3);
    assert.equal(sections[0].trim(), "primeira");
    assert.equal(sections[1].trim(), "segunda");
    assert.equal(sections[2].trim(), "terceira");
  });

  it("ignora linhas com menos de 10 traços", () => {
    const text = "primeira\n---\nainda primeira\n----------\nsegunda";
    const sections = splitSections(text);
    assert.equal(sections.length, 2);
    assert.ok(sections[0].includes("ainda primeira"));
  });
});

describe("parsePost", () => {
  function makePost(content: string): string {
    return content;
  }

  it("parseia 3 destaques completos com why delimitado por bold", () => {
    const text = makePost(`
----------
introdução

----------
##### GEOPOLÍTICA

# [Título D1](https://example.com/d1)

Parágrafo um.

Parágrafo dois.

**Por que isso importa:**

Análise editorial.

----------
##### AGENTES

# [Título D2](https://example.com/d2)

Body D2.

### **Por que isso importa:**

Why D2.

----------
##### LANÇAMENTOS

# [Título D3](https://example.com/d3)

Body D3.

Por que isso importa
Why D3.
`);
    const warnings: string[] = [];
    const dest = parsePost(sampleFile, text, warnings);
    assert.equal(dest.length, 3);
    assert.equal(dest[0].position, 1);
    assert.equal(dest[0].category, "GEOPOLÍTICA");
    assert.equal(dest[0].title, "Título D1");
    assert.equal(dest[0].url, "https://example.com/d1");
    assert.ok(dest[0].body.includes("Parágrafo um"));
    assert.ok(dest[0].body.includes("Parágrafo dois"));
    assert.equal(dest[0].why, "Análise editorial.");
    assert.equal(dest[1].why, "Why D2.");
    assert.equal(dest[2].position, 3);
    assert.equal(warnings.length, 0);
  });

  it("strip 'View image:' e 'Caption:' do body", () => {
    const text = `
----------
##### TESTE

# [Título](https://example.com/x)

View image: (https://media.beehiiv.com/cover.jpg)
Caption: Cover

Conteúdo real.

**Por que isso importa:**

Why.
`;
    const warnings: string[] = [];
    const dest = parsePost(sampleFile, text, warnings);
    assert.equal(dest.length, 1);
    assert.ok(!dest[0].body.includes("View image:"));
    assert.ok(!dest[0].body.includes("Caption:"));
    assert.ok(dest[0].body.includes("Conteúdo real"));
  });

  it("emite warning quando edição tem 4+ destaques (cap em 3)", () => {
    const text = `
----------
##### CAT1

# [D1](https://example.com/1)

Body 1.

**Por que isso importa:**

Why 1.

----------
##### CAT2

# [D2](https://example.com/2)

Body 2.

**Por que isso importa:**

Why 2.

----------
##### CAT3

# [D3](https://example.com/3)

Body 3.

**Por que isso importa:**

Why 3.

----------
##### CAT4

# [D4](https://example.com/4)

Body 4.

**Por que isso importa:**

Why 4.
`;
    const warnings: string[] = [];
    const dest = parsePost(sampleFile, text, warnings);
    assert.equal(dest.length, 3, "cappa em 3");
    assert.equal(dest[2].title, "D3", "mantém os 3 primeiros");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /4 sections matched/);
  });

  it("emite warning quando edição tem < 3 destaques", () => {
    const text = `
----------
##### CAT1

# [D1](https://example.com/1)

Body 1.

**Por que isso importa:**

Why 1.
`;
    const warnings: string[] = [];
    const dest = parsePost(sampleFile, text, warnings);
    assert.equal(dest.length, 1);
    assert.match(warnings[0], /parseou 1 destaques/);
  });

  it("emite warning quando edição tem 0 destaques", () => {
    const text = `
----------
##### LANÇAMENTOS

**[Item 1 sem h1](https://example.com/1)**

Item bold mas não h1.

----------
##### OUTRAS NOTÍCIAS

* [Item bullet](https://example.com/2)
`;
    const warnings: string[] = [];
    const dest = parsePost(sampleFile, text, warnings);
    assert.equal(dest.length, 0);
    assert.match(warnings[0], /nenhum destaque parseado/);
  });

  it("destaque sem 'Por que isso importa' — body inclui tudo, why fica vazio", () => {
    const text = `
----------
##### TESTE

# [Sem why](https://example.com/x)

Apenas corpo.

Sem delimitador.
`;
    const warnings: string[] = [];
    const dest = parsePost(sampleFile, text, warnings);
    assert.equal(dest.length, 1);
    assert.equal(dest[0].why, "");
    assert.ok(dest[0].body.includes("Apenas corpo"));
    assert.ok(dest[0].body.includes("Sem delimitador"));
  });

  it("section LANÇAMENTOS sem h1 é descartada (sem h1+link, não é destaque)", () => {
    const text = `
----------
##### LANÇAMENTOS

**[Item 1](https://example.com/1)**

Description.

[**Item 2**](https://example.com/2)

Description 2.

----------
##### CATEGORIA

# [Destaque real](https://example.com/r)

Body.

**Por que isso importa:**

Why.
`;
    const warnings: string[] = [];
    const dest = parsePost(sampleFile, text, warnings);
    assert.equal(dest.length, 1);
    assert.equal(dest[0].title, "Destaque real");
  });
});

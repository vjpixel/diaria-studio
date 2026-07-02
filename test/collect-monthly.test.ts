import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectBrazil,
  parsePost,
  splitSections,
  splitLocalSections,
  parseLocalEdition,
  collectMonth,
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

// ── Modo local (#2791) ─────────────────────────────────────────────────

describe("splitLocalSections", () => {
  it("divide em separadores de 3+ traços (HR padrão de 02-reviewed.md)", () => {
    const text = "primeira\n\n---\n\nsegunda\n\n---\n\nterceira";
    const sections = splitLocalSections(text);
    assert.equal(sections.length, 3);
    assert.equal(sections[1].trim(), "segunda");
  });
});

// Recorte real-shaped de um 02-reviewed.md publicado (formato usado por
// /diaria-2-escrita — ver data/editions/260701/02-reviewed.md).
const REAL_SHAPED_02_REVIEWED = `---
intentional_error:
  description: "erro de exemplo"
---
TÍTULO

Anthropic lança Sonnet 5

---

**🎉 Sorteio

Texto do sorteio.**

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Anthropic lança Sonnet 5](https://www.anthropic.com/news/claude-sonnet-5)**

A Anthropic lançou o Claude Sonnet 5, um modelo de médio porte.

O Sonnet 5 mira tarefas que pedem raciocínio encadeado.

Por que isso importa:

A Anthropic chega perto do desempenho do Opus pelo preço do Sonnet.

---

**DESTAQUE 2 | 🇧🇷 BRASIL**

**[STF regula uso de IA no Judiciário](https://www.stf.jus.br/noticia/ia-regulamentacao)**

O STF publicou uma resolução sobre uso de IA em decisões judiciais.

Por que isso importa:

Regula um uso sensível da IA dentro do próprio judiciário brasileiro.

---

**DESTAQUE 3 | 💼 TRABALHO**

**[Ford recontrata veteranos após falha das ferramentas](https://canaltech.com.br/mercado/ford-recontrata)**

A montadora Ford recontratou cerca de 350 inspetores de qualidade.

Segundo a Bloomberg, o que a montadora colocou no lugar não chegou ao padrão.

Por que isso importa:

A automação esbarrou num caso real de processo industrial complexo.

---

**É IA?**

Legenda da imagem.

---

**🛠️ USE MELHOR**

**[Currículo com IA](https://www.digitow.com.br/blog/curriculo-com-ia/)**
Guia prático.
`;

describe("parseLocalEdition", () => {
  it("parseia 3 destaques completos de um 02-reviewed.md real-shaped", () => {
    const dest = parseLocalEdition("260701", REAL_SHAPED_02_REVIEWED);
    assert.equal(dest.length, 3);

    assert.equal(dest[0].position, 1);
    assert.equal(dest[0].category, "LANÇAMENTO");
    assert.equal(dest[0].title, "Anthropic lança Sonnet 5");
    assert.equal(dest[0].url, "https://www.anthropic.com/news/claude-sonnet-5");
    assert.ok(dest[0].body.includes("modelo de médio porte"));
    assert.ok(dest[0].body.includes("raciocínio encadeado"));
    assert.equal(dest[0].why, "A Anthropic chega perto do desempenho do Opus pelo preço do Sonnet.");
    assert.equal(dest[0].edition, "260701");
    assert.equal(dest[0].beehiiv_post_id, "");

    assert.equal(dest[1].position, 2);
    assert.equal(dest[1].category, "BRASIL");
    assert.equal(dest[1].is_brazil, true, "categoria BRASIL deve flagar is_brazil");
    assert.ok(dest[1].brazil_signals.includes("category:BRASIL"));

    assert.equal(dest[2].position, 3);
    assert.equal(dest[2].category, "TRABALHO");
    assert.equal(dest[2].title, "Ford recontrata veteranos após falha das ferramentas");
  });

  it("não confunde outras seções (Sorteio, É IA?, Use Melhor) com destaques", () => {
    const dest = parseLocalEdition("260701", REAL_SHAPED_02_REVIEWED);
    assert.equal(dest.length, 3, "só os 3 blocos DESTAQUE N viram destaque — resto é ignorado");
  });

  it("02-reviewed.md sem nenhum bloco DESTAQUE N retorna array vazio (sem crash)", () => {
    const dest = parseLocalEdition("260701", "TÍTULO\n\nAlgo\n\n---\n\nOutra seção qualquer.");
    assert.deepEqual(dest, []);
  });
});

describe("collectMonth", () => {
  function withTmpDirs(fn: (rawPostsRoot: string, editionsRoot: string) => void) {
    const base = mkdtempSync(join(tmpdir(), "diaria-collect-monthly-"));
    const rawPostsRoot = join(base, "cycle");
    const editionsRoot = join(base, "editions");
    mkdirSync(join(rawPostsRoot, "raw-posts"), { recursive: true });
    mkdirSync(editionsRoot, { recursive: true });
    try {
      fn(rawPostsRoot, editionsRoot);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }

  it("edição com 02-reviewed.md local usa o modo local (precedência sobre raw-post)", () => {
    withTmpDirs((rawPostsRoot, editionsRoot) => {
      mkdirSync(join(editionsRoot, "260701"), { recursive: true });
      writeFileSync(join(editionsRoot, "260701", "02-reviewed.md"), REAL_SHAPED_02_REVIEWED, "utf8");
      // raw-post da MESMA edição também existe — local deve vencer.
      writeFileSync(
        join(rawPostsRoot, "raw-posts", "post_aaaaaaaa_260701.txt"),
        "<html>lixo que não deveria ser usado</html>",
        "utf8",
      );

      const result = collectMonth("2607", rawPostsRoot, editionsRoot);
      assert.equal(result.source_counts.local, 1);
      assert.equal(result.source_counts.raw, 0);
      assert.equal(result.destaques.length, 3);
      assert.equal(result.destaques[0].title, "Anthropic lança Sonnet 5");
    });
  });

  it("mistura local + raw-post dentro do mesmo mês (por edição)", () => {
    withTmpDirs((rawPostsRoot, editionsRoot) => {
      mkdirSync(join(editionsRoot, "260701"), { recursive: true });
      writeFileSync(join(editionsRoot, "260701", "02-reviewed.md"), REAL_SHAPED_02_REVIEWED, "utf8");

      const rawMd = `
----------
##### GEOPOLÍTICA

# [Título raw](https://example.com/raw)

Corpo raw.

**Por que isso importa:**

Why raw.
`;
      writeFileSync(join(rawPostsRoot, "raw-posts", "post_bbbbbbbb_260702.txt"), rawMd, "utf8");

      const result = collectMonth("2607", rawPostsRoot, editionsRoot);
      assert.equal(result.source_counts.local, 1);
      assert.equal(result.source_counts.raw, 1);
      assert.equal(result.destaques.length, 4); // 3 local + 1 raw
    });
  });

  it("edição sem 02-reviewed.md e sem raw-post: warning explícito, contagem 0 (não crasha)", () => {
    withTmpDirs((rawPostsRoot, editionsRoot) => {
      // Diretório da edição existe (ex: Stage 1 rodou) mas sem 02-reviewed.md.
      mkdirSync(join(editionsRoot, "260703"), { recursive: true });

      const result = collectMonth("2607", rawPostsRoot, editionsRoot);
      assert.equal(result.destaques.length, 0);
      assert.equal(result.source_counts.missing, 1);
      assert.ok(
        result.warnings.some((w) => /260703.*nem 02-reviewed\.md.*nem raw-post/.test(w)),
        `esperava warning explícito sobre 260703, recebeu: ${JSON.stringify(result.warnings)}`,
      );
    });
  });
});

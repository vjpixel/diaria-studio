/**
 * test/weekly-linkedin-parse.test.ts (#4456)
 *
 * Extração de candidatos (destaques + itens de seção) do `02-reviewed.md`
 * pra newsletter semanal do LinkedIn, e o filtro de links comerciais/
 * afiliados/propriedade própria que exclui candidatos ANTES do ranking por
 * clique (comentário 260802 2º do #4456).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractWeeklyCandidates, detectDeadSectionHeaders } from "../scripts/lib/weekly-linkedin-parse.ts";
import { isCommercialOrOwnLink, hasSuspiciousCommercialLanguage } from "../scripts/lib/weekly-linkedin-filter.ts";

const SAMPLE_MD = `Para esta edição, a diar.ia.br analisou 20 artigos.

---

**DESTAQUE 1 | 💼 MERCADO**

**[Itaú corta 500 vagas com automação](https://exemplo.com/itau)**

Corpo do destaque 1, primeiro parágrafo.

Segundo parágrafo do destaque 1.

Por que isso importa:

Explicação de impacto no mercado brasileiro.

---

**DESTAQUE 2 | 🚀 LANÇAMENTO**

**[Gemini lança novo modelo](https://exemplo.com/gemini)**

Corpo do destaque 2.

Por que isso importa:

Explicação do destaque 2.

---

**🚀 LANÇAMENTOS**

**[Nova ferramenta de IA](https://exemplo.com/ferramenta)**
Descrição curta da ferramenta.

---

**📡 RADAR**

**[Professor flagra 90% da turma colando com IA](https://exemplo.com/professor)**
Notícia sobre educação e IA no Brasil.

**[Livro grátis sobre IA](https://livros.diar.ia.br)**
Divulgação da coleção de livros.

---

**🛠️ USE MELHOR**

**[Effort level no Claude Code](https://exemplo.com/effort-level)**
Tutorial de 5 minutos sobre o parâmetro effort.

---

**🎁 SORTEIO**

Texto do sorteio — não deve virar candidato.

---

**🙋🏼‍♀️ PARA ENCERRAR**

Apoie a curadoria em [apoia.se/diaria](https://apoia.se/diaria).
`;

describe("extractWeeklyCandidates", () => {
  const candidates = extractWeeklyCandidates(SAMPLE_MD, "260728");

  it("extrai os 2 destaques com título/corpo/why/url literais", () => {
    const d1 = candidates.find((c) => c.kind === "destaque" && c.url.includes("itau"));
    assert.ok(d1);
    assert.equal(d1!.title, "Itaú corta 500 vagas com automação");
    assert.match(d1!.body, /primeiro parágrafo/);
    assert.match(d1!.why, /impacto no mercado brasileiro/);
    assert.equal(d1!.section, "destaque");
    assert.equal(d1!.editionDate, "260728");
  });

  it("extrai itens de LANÇAMENTOS/RADAR/USE MELHOR como candidatos de seção", () => {
    const ferramenta = candidates.find((c) => c.url.includes("ferramenta"));
    assert.ok(ferramenta);
    assert.equal(ferramenta!.kind, "section");
    assert.equal(ferramenta!.section, "lancamentos");

    const radar = candidates.find((c) => c.url.includes("professor"));
    assert.ok(radar);
    assert.equal(radar!.section, "radar");

    const useMelhor = candidates.find((c) => c.url.includes("effort-level"));
    assert.ok(useMelhor);
    assert.equal(useMelhor!.section, "use_melhor");
  });

  it("inclui o item de propriedade própria como candidato bruto (a exclusão é responsabilidade do filtro, não do parser)", () => {
    const livros = candidates.find((c) => c.url.includes("livros.diar.ia.br"));
    assert.ok(livros);
  });

  it("NÃO extrai SORTEIO/PARA ENCERRAR como candidatos", () => {
    assert.ok(!candidates.some((c) => /sorteio|apoia\.se/i.test(c.url + c.title + c.body)));
  });

  it("edição sem 02-reviewed.md legível não lança — caller decide", () => {
    assert.deepEqual(extractWeeklyCandidates("", "260728"), []);
  });
});

describe("detectDeadSectionHeaders (#4491 — falha parcial de parse)", () => {
  it("seção genuinamente ausente (sem header no markdown) NÃO é reportada como morta", () => {
    const md = [
      "**DESTAQUE 1 | 💼 MERCADO**",
      "",
      "**[Matéria A](https://exemplo.com/materia-a)**",
      "",
      "Corpo.",
      "",
      "Por que isso importa:",
      "",
      "Explicação.",
      "",
    ].join("\n");
    const candidates = extractWeeklyCandidates(md, "260810");
    assert.deepEqual(detectDeadSectionHeaders(md, candidates), []);
  });

  it("header RADAR reconhecido mas item sem URL (formato quebrado) — reporta RADAR como seção morta, mesmo com USE MELHOR parseando normal", () => {
    const md = [
      "**DESTAQUE 1 | 💼 MERCADO**",
      "",
      "**[Matéria A](https://exemplo.com/materia-a)**",
      "",
      "Corpo.",
      "",
      "Por que isso importa:",
      "",
      "Explicação.",
      "",
      "---",
      "",
      "**📡 RADAR**",
      "",
      "Notícia sem link nenhum — formato mudou e o parser não reconhece mais",
      "",
      "---",
      "",
      "**🛠️ USE MELHOR**",
      "",
      "**[Tutorial Y: como usar melhor](https://exemplo.com/tutorial-y)**",
      "Tutorial de 5 minutos.",
      "",
    ].join("\n");
    const candidates = extractWeeklyCandidates(md, "260810");
    // candidates.length > 0 (destaque + use_melhor) — emptyParseEditions (falha
    // TOTAL) não pegaria este caso; a falha é só da seção RADAR.
    assert.ok(candidates.length > 0);
    assert.ok(!candidates.some((c) => c.section === "radar"));
    assert.deepEqual(detectDeadSectionHeaders(md, candidates), ["RADAR"]);
  });

  it("todas as seções parseando normal — nenhuma seção morta reportada", () => {
    const md = [
      "**📡 RADAR**",
      "",
      "**[Notícia real](https://exemplo.com/noticia)**",
      "Descrição curta.",
      "",
      "---",
      "",
      "**🛠️ USE MELHOR**",
      "",
      "**[Tutorial Y](https://exemplo.com/tutorial-y)**",
      "Tutorial de 5 minutos.",
      "",
    ].join("\n");
    const candidates = extractWeeklyCandidates(md, "260810");
    assert.deepEqual(detectDeadSectionHeaders(md, candidates), []);
  });
});

describe("isCommercialOrOwnLink", () => {
  it("exclui propriedade própria (livros/cursos/eia/apoia.se/domínio nu)", () => {
    assert.ok(isCommercialOrOwnLink("https://livros.diar.ia.br"));
    assert.ok(isCommercialOrOwnLink("https://cursos.diar.ia.br/curso-x"));
    assert.ok(isCommercialOrOwnLink("https://eia.diar.ia.br/vote?x=1"));
    assert.ok(isCommercialOrOwnLink("https://apoia.se/diaria"));
    assert.ok(isCommercialOrOwnLink("https://diar.ia.br/p/algum-slug"));
  });

  it("exclui afiliados (Amazon, Wispr Flow, Clarice, Beehiiv)", () => {
    assert.ok(isCommercialOrOwnLink("https://www.amazon.com.br/dp/B0XXX"));
    assert.ok(isCommercialOrOwnLink("https://amzn.to/abc123"));
    assert.ok(isCommercialOrOwnLink("https://wisprflow.ai/r?x=1"));
    assert.ok(isCommercialOrOwnLink("https://clarice.ai/precos-planos?via=diaria"));
    assert.ok(isCommercialOrOwnLink("https://www.beehiiv.com?via=Diaria"));
  });

  it("exclui preferências/descadastro", () => {
    assert.ok(isCommercialOrOwnLink("https://diaria.beehiiv.com/unsubscribe?x=1"));
    assert.ok(isCommercialOrOwnLink("https://example.com/preferences"));
  });

  it("NÃO exclui link editorial de terceiro (matéria de verdade)", () => {
    assert.ok(!isCommercialOrOwnLink("https://exemplo.com/itau"));
    assert.ok(!isCommercialOrOwnLink("https://g1.globo.com/tecnologia/noticia"));
  });

  it("URL ilegível não é excluída por este filtro (fail-open — caller decide o resto)", () => {
    assert.ok(!isCommercialOrOwnLink("não é uma url"));
  });
});

describe("hasSuspiciousCommercialLanguage (#4489 finding 5 — heurística de baixa confiança, não bloqueia)", () => {
  it("detecta vocabulário comercial/patrocinado em domínio NÃO listado na blocklist", () => {
    assert.ok(hasSuspiciousCommercialLanguage("Prepara IA — curso em parceria com a diar.ia.br"));
    assert.ok(hasSuspiciousCommercialLanguage("Conteúdo patrocinado por uma empresa de IA"));
    assert.ok(hasSuspiciousCommercialLanguage("Assine com este cupom de 20% de desconto"));
    assert.ok(hasSuspiciousCommercialLanguage("Bloco de Divulgação desta edição"));
  });

  it("matéria editorial normal não dispara o alerta", () => {
    assert.ok(!hasSuspiciousCommercialLanguage("Itaú corta 500 vagas com automação"));
    assert.ok(!hasSuspiciousCommercialLanguage("Gemini lança novo modelo multimodal"));
  });
});

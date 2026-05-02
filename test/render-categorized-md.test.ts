import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDate,
  isBrazilianTheme,
  renderLine,
  buildHighlightUrls,
  buildRunnerUpUrls,
  renderEaiBlock,
} from "../scripts/render-categorized-md.ts";

describe("getDate", () => {
  it("prioriza date sobre published_at", () => {
    assert.equal(
      getDate({ url: "x", date: "2026-04-24", published_at: "2026-04-20" }),
      "2026-04-24",
    );
  });

  it("usa published_at como fallback", () => {
    assert.equal(
      getDate({ url: "x", published_at: "2026-04-24T10:00:00Z" }),
      "2026-04-24",
    );
  });

  it("corta ISO string no T", () => {
    assert.equal(
      getDate({ url: "x", date: "2026-04-24T12:00:00Z" }),
      "2026-04-24",
    );
  });

  it("retorna placeholder quando não há data", () => {
    assert.equal(getDate({ url: "x" }), "????-??-??");
  });
});

describe("isBrazilianTheme", () => {
  it("detecta palavra Brasil", () => {
    assert.ok(isBrazilianTheme({ title: "Brasil lidera em IA na América Latina" }));
  });

  it("detecta brasileiro/brasileira", () => {
    assert.ok(isBrazilianTheme({ title: "Startup brasileira levanta rodada" }));
  });

  it("detecta entidades governamentais (ANPD, CVM, Petrobras)", () => {
    assert.ok(isBrazilianTheme({ title: "ANPD multa plataforma de IA" }));
    assert.ok(isBrazilianTheme({ title: "CVM divulga regras sobre trading algorítmico" }));
    assert.ok(isBrazilianTheme({ title: "Petrobras investe em modelos preditivos" }));
  });

  it("detecta cidades BR (São Paulo, Rio, Brasília)", () => {
    assert.ok(isBrazilianTheme({ title: "Evento de IA em São Paulo" }));
    assert.ok(isBrazilianTheme({ title: "Rio de Janeiro sedia conferência" }));
    assert.ok(isBrazilianTheme({ title: "Brasília debate regulação" }));
  });

  it("case-insensitive", () => {
    assert.ok(isBrazilianTheme({ title: "BRASIL em foco" }));
    assert.ok(isBrazilianTheme({ title: "brasil em foco" }));
  });

  it("matcha também em summary", () => {
    assert.ok(isBrazilianTheme({ title: "AI news", summary: "Empresa brasileira vence" }));
  });

  it("não matcha notícias sem tema BR", () => {
    assert.equal(isBrazilianTheme({ title: "OpenAI launches GPT-5" }), false);
    assert.equal(isBrazilianTheme({ title: "Google Cloud announces TPU v7" }), false);
  });

  it("detecta Braz/Brazilian em EN", () => {
    assert.ok(isBrazilianTheme({ title: "Brazilian AI startup raises $10M" }));
  });

  describe("tier 1 vs tier 2 logic (#43)", () => {
    it("tier 1 sozinho dispara (Brasil)", () => {
      assert.ok(isBrazilianTheme({ title: "Brasil debate regulação" }));
    });

    it("1 tier 2 sozinho NÃO dispara (evita falso positivo)", () => {
      // Artigo internacional mencionando Nubank de passagem não é "tema BR"
      assert.equal(
        isBrazilianTheme({
          title: "LATAM fintech landscape",
          summary: "Nubank is one of several players in the region.",
        }),
        false,
      );
    });

    it("2+ tier 2 distintos dispara (clarifica tema BR)", () => {
      assert.ok(
        isBrazilianTheme({
          title: "Nubank e iFood discutem integração de pagamentos",
          summary: "O iFood... a Nubank...",
        }),
      );
    });

    it("tier 2 + tier 1 dispara (tier 1 sozinho já basta)", () => {
      assert.ok(
        isBrazilianTheme({
          title: "Nubank no Brasil",
          summary: "",
        }),
      );
    });

    it("empresas BR privadas expandidas (Embraer, Gerdau, Ambev, etc.)", () => {
      assert.ok(
        isBrazilianTheme({
          title: "Embraer e Gerdau investem em IA industrial",
          summary: "",
        }),
      );
      assert.ok(
        isBrazilianTheme({
          title: "Ambev implanta modelos preditivos",
          summary: "Parceria com a VTEX para e-commerce.",
        }),
      );
    });

    it("fintechs BR: xp inc + btg pactual", () => {
      assert.ok(
        isBrazilianTheme({
          title: "XP Inc e BTG Pactual divulgam roadmap",
          summary: "",
        }),
      );
    });
  });
});

describe("renderLine", () => {
  it("formato básico: score + título + url + data", () => {
    const line = renderLine({
      url: "https://a.com/x",
      title: "Hello",
      score: 87,
      date: "2026-04-24",
    });
    assert.equal(line, "- [87] Hello — https://a.com/x — 2026-04-24");
  });

  it("score ausente mostra [--]", () => {
    const line = renderLine({
      url: "https://a.com/x",
      title: "T",
      date: "2026-04-24",
    });
    assert.ok(line.startsWith("- [--] T"));
  });

  it("marcador ⭐ quando highlight", () => {
    const line = renderLine({ url: "https://a.com/x", title: "T", score: 80 }, true);
    assert.ok(line.includes("⭐"));
  });

  it("marcador ✨ quando runner-up (#104)", () => {
    const line = renderLine(
      { url: "https://a.com/x", title: "T", score: 80 },
      false,
      true,
    );
    assert.ok(line.includes("✨"));
    assert.ok(!line.includes("⭐"));
  });

  it("⭐ wins quando flags conflitam (defensivo)", () => {
    const line = renderLine(
      { url: "https://a.com/x", title: "T", score: 80 },
      true,
      true,
    );
    assert.ok(line.includes("⭐"));
    assert.ok(!line.includes("✨"));
  });

  it("marcador 🇧🇷 em tema brasileiro", () => {
    const line = renderLine({
      url: "https://a.com/x",
      title: "ANPD publica regra",
      score: 75,
    });
    assert.ok(line.includes("🇧🇷"));
  });

  it("marcador [inbox] para editor_submitted", () => {
    const line = renderLine({
      url: "https://a.com/x",
      title: "T",
      score: 80,
      editor_submitted: true,
    });
    assert.ok(line.includes("[inbox]"));
  });

  it("marcador (descoberta) para discovered_source", () => {
    const line = renderLine({
      url: "https://a.com/x",
      title: "T",
      score: 80,
      discovered_source: true,
    });
    assert.ok(line.includes("(descoberta)"));
  });

  it("marcador ⚠️ quando data não verificada", () => {
    const line = renderLine({
      url: "https://a.com/x",
      title: "T",
      score: 80,
      date_unverified: true,
    });
    assert.ok(line.includes("⚠️"));
  });

  it("múltiplos marcadores aparecem juntos na ordem correta", () => {
    const line = renderLine({
      url: "https://a.com/x",
      title: "Brasil e ANPD",
      score: 90,
      editor_submitted: true,
      date: "2026-04-24",
    }, true);
    // Ordem: ⭐ (highlight), 🇧🇷 (BR), [inbox]
    const idxStar = line.indexOf("⭐");
    const idxBr = line.indexOf("🇧🇷");
    const idxInbox = line.indexOf("[inbox]");
    assert.ok(idxStar < idxBr && idxBr < idxInbox);
  });

  it("título ausente usa placeholder", () => {
    const line = renderLine({ url: "https://a.com/x" });
    assert.ok(line.includes("(sem título)"));
  });
});

describe("buildHighlightUrls", () => {
  it("extrai do formato top-level highlights[] (URL flat)", () => {
    const urls = buildHighlightUrls({
      highlights: [{ url: "https://a.com/1" }, { url: "https://b.com/2" }],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    });
    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://a.com/1"));
  });

  it("extrai do formato top-level highlights[] com URL nested em article (#229)", () => {
    const urls = buildHighlightUrls({
      highlights: [
        { rank: 1, score: 92, article: { url: "https://a.com/1", title: "A" } },
        { rank: 2, score: 88, article: { url: "https://b.com/2", title: "B" } },
      ],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    });
    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://a.com/1"));
    assert.ok(urls.has("https://b.com/2"));
  });

  it("extrai mix flat e nested no mesmo array (#229)", () => {
    const urls = buildHighlightUrls({
      highlights: [
        { url: "https://flat.com/1" },
        { rank: 2, article: { url: "https://nested.com/2" } },
      ],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    });
    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://flat.com/1"));
    assert.ok(urls.has("https://nested.com/2"));
  });

  it("extrai do formato legado (inline highlight: true)", () => {
    const urls = buildHighlightUrls({
      lancamento: [
        { url: "https://a.com/1", highlight: true },
        { url: "https://a.com/normal" },
      ],
      pesquisa: [{ url: "https://b.com/2", highlight: true }],
      noticias: [],
    });
    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://a.com/1"));
    assert.ok(urls.has("https://b.com/2"));
    assert.ok(!urls.has("https://a.com/normal"));
  });

  it("combina ambos os formatos sem duplicar", () => {
    const urls = buildHighlightUrls({
      highlights: [{ url: "https://a.com/1" }],
      lancamento: [{ url: "https://a.com/1", highlight: true }],
      pesquisa: [],
      noticias: [],
    });
    assert.equal(urls.size, 1);
  });

  it("retorna Set vazio quando não há highlights", () => {
    const urls = buildHighlightUrls({
      lancamento: [{ url: "https://a.com/1" }],
      pesquisa: [],
      noticias: [],
    });
    assert.equal(urls.size, 0);
  });
});

describe("buildRunnerUpUrls (#104)", () => {
  it("extrai URLs do top-level runners_up[]", () => {
    const urls = buildRunnerUpUrls({
      runners_up: [{ url: "https://r.com/1" }, { url: "https://r.com/2" }],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    });
    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://r.com/1"));
    assert.ok(urls.has("https://r.com/2"));
  });

  it("retorna Set vazio quando runners_up ausente", () => {
    const urls = buildRunnerUpUrls({
      lancamento: [],
      pesquisa: [],
      noticias: [],
    });
    assert.equal(urls.size, 0);
  });

  it("ignora entradas sem url ou com url não-string", () => {
    const urls = buildRunnerUpUrls({
      runners_up: [
        { url: "https://r.com/1" },
        { score: 50 } as unknown,
        { url: 123 } as unknown,
      ],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    });
    assert.equal(urls.size, 1);
    assert.ok(urls.has("https://r.com/1"));
  });

  it("aceita URL nested em article (#229)", () => {
    const urls = buildRunnerUpUrls({
      runners_up: [
        { rank: 4, score: 75, article: { url: "https://r.com/nested", title: "X" } },
        { rank: 5, score: 70, url: "https://r.com/flat" },
      ],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    });
    assert.equal(urls.size, 2);
    assert.ok(urls.has("https://r.com/nested"));
    assert.ok(urls.has("https://r.com/flat"));
  });

  it("highlights e runners_up são sets disjuntos por construção", () => {
    const data = {
      highlights: [{ url: "https://a.com/1" }, { url: "https://a.com/2" }],
      runners_up: [{ url: "https://b.com/3" }, { url: "https://b.com/4" }],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    };
    const h = buildHighlightUrls(data);
    const r = buildRunnerUpUrls(data);
    assert.equal(h.size, 2);
    assert.equal(r.size, 2);
    // Sem overlap
    for (const url of r) assert.ok(!h.has(url));
  });
});

describe("renderEaiBlock (#371)", () => {
  it("retorna placeholder quando nem 01-eia.md nem 01-eai.md existem", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("⏳"));
      assert.ok(block.includes("ainda processando"));
      assert.ok(block.includes("É IA?"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("novo padrão: inclui conteúdo do 01-eia.md quando existe (pós-#428)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      const eiaContent = "---\neia_answer: A\n---\nConteúdo do É IA?";
      writeFileSync(join(dir, "01-eia.md"), eiaContent, "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("Conteúdo do É IA?"));
      assert.ok(!block.includes("⏳"));
      assert.ok(block.includes("01-eia-A.jpg"));
      assert.ok(block.includes("01-eia-B.jpg"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("legacy: inclui conteúdo do 01-eai.md quando 01-eia.md não existe (pré-#428)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      const eaiContent = "---\neai_answer: A\n---\nConteúdo legacy";
      writeFileSync(join(dir, "01-eai.md"), eaiContent, "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("Conteúdo legacy"));
      assert.ok(!block.includes("⏳"));
      assert.ok(block.includes("01-eai-A.jpg"));
      assert.ok(block.includes("01-eai-B.jpg"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("novo padrão tem precedência quando ambos os arquivos existem", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      writeFileSync(join(dir, "01-eia.md"), "Novo", "utf8");
      writeFileSync(join(dir, "01-eai.md"), "Legacy", "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("Novo"));
      assert.ok(!block.includes("Legacy"));
      assert.ok(block.includes("01-eia-A.jpg"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("bloco tem separadores --- e cabeçalho ## É IA?", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      writeFileSync(join(dir, "01-eia.md"), "Texto", "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("---"));
      assert.ok(block.includes("## É IA?"));
      assert.ok(block.includes("Imagem A:"));
      assert.ok(block.includes("Imagem B:"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

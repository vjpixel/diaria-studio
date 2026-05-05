import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDate,
  isBrazilianTheme,
  renderLine,
  buildHighlightUrls,
  buildRunnerUpUrls,
  renderEaiBlock,
  renderSection,
  computeTotalConsidered,
  extractEaiAnswer,
  renderDestaquesFromApproved,
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

  it("marcador [carry-over de XXX] aparece via campo carry_over_from independente do flag (#658 review A)", () => {
    // Caso 1: carry-over de fonte qualquer (flag: carry_over)
    const lineCarry = renderLine({
      url: "https://a.com/x",
      title: "T",
      score: 75,
      flag: "carry_over",
      carry_over_from: "260427",
    });
    assert.ok(lineCarry.includes("[carry-over de 260427]"));

    // Caso 2: carry-over de inbox (flag preserva editor_submitted, mas marker
    // ainda deve aparecer — regressão original do review #2 issue A).
    const lineFromInbox = renderLine({
      url: "https://b.com/y",
      title: "U",
      score: 80,
      flag: "editor_submitted",
      carry_over_from: "260427",
    });
    assert.ok(lineFromInbox.includes("[carry-over de 260427]"));
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

describe("renderEaiBlock (#371, #481)", () => {
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

  it("#481: novo padrão: emite apenas a linha de crédito (sem frontmatter, sem paths de imagem)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      const eiaContent = "---\neia_answer: A\n---\nÉ IA?\n\nFoto: Linha de crédito real";
      writeFileSync(join(dir, "01-eia.md"), eiaContent, "utf8");
      const block = renderEaiBlock(dir);
      // Deve incluir apenas a linha de crédito
      assert.ok(block.includes("Foto: Linha de crédito real"));
      assert.ok(!block.includes("⏳"));
      // NÃO deve incluir frontmatter YAML
      assert.ok(!block.includes("eia_answer:"));
      // NÃO deve incluir paths de imagem
      assert.ok(!block.includes("01-eia-A.jpg"));
      assert.ok(!block.includes("01-eia-B.jpg"));
      assert.ok(!block.includes("Imagem A:"));
      assert.ok(!block.includes("Imagem B:"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#481: legacy: emite apenas linha de crédito do 01-eai.md (sem paths de imagem)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      const eaiContent = "---\neai_answer: A\n---\nÉ IA?\n\nCrédito legacy aqui";
      writeFileSync(join(dir, "01-eai.md"), eaiContent, "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("Crédito legacy aqui"));
      assert.ok(!block.includes("⏳"));
      // NÃO deve incluir frontmatter nem paths
      assert.ok(!block.includes("eai_answer:"));
      assert.ok(!block.includes("01-eai-A.jpg"));
      assert.ok(!block.includes("01-eai-B.jpg"));
      assert.ok(!block.includes("Imagem A:"));
      assert.ok(!block.includes("Imagem B:"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("novo padrão tem precedência quando ambos os arquivos existem", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      writeFileSync(join(dir, "01-eia.md"), "---\neia_answer: A\n---\nCrédito novo", "utf8");
      writeFileSync(join(dir, "01-eai.md"), "---\neai_answer: B\n---\nCrédito legacy", "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("Crédito novo"));
      assert.ok(!block.includes("Crédito legacy"));
      // NÃO deve incluir paths de imagem
      assert.ok(!block.includes("01-eia-A.jpg"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("bloco tem separadores --- e cabeçalho ## É IA? (sem paths de imagem)", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      writeFileSync(join(dir, "01-eia.md"), "---\neia_answer: A\n---\nCrédito da foto", "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("---"));
      assert.ok(block.includes("## É IA?"));
      assert.ok(block.includes("Crédito da foto"));
      // #481: NÃO deve incluir "Imagem A:" nem "Imagem B:"
      assert.ok(!block.includes("Imagem A:"));
      assert.ok(!block.includes("Imagem B:"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#481: arquivo sem frontmatter — pega primeira linha não-vazia como crédito", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      // Sem frontmatter, linha de crédito direta
      writeFileSync(join(dir, "01-eia.md"), "\n\nCrédito direto sem frontmatter", "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("Crédito direto sem frontmatter"));
      assert.ok(!block.includes("⏳"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#481: arquivo só com frontmatter (sem linha de crédito) → placeholder ⏳", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      writeFileSync(join(dir, "01-eia.md"), "---\neia_answer: A\n---\n", "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("⏳"));
      assert.ok(block.includes("ainda processando"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("#481: ignora linha 'É IA?' no corpo e pega a próxima linha não-vazia", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-test-"));
    try {
      writeFileSync(join(dir, "01-eia.md"), "---\neia_answer: A\n---\nÉ IA?\n\nFoto real", "utf8");
      const block = renderEaiBlock(dir);
      assert.ok(block.includes("Foto real"));
      assert.ok(!block.includes("eia_answer"));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("renderSection — bucket Vídeos (#359)", () => {
  const noHighlights = new Set<string>();
  const noRunners = new Set<string>();

  it("renderiza seção VÍDEOS com 1 item", () => {
    const section = renderSection(
      "Vídeos",
      [{ url: "https://www.youtube.com/watch?v=abc", title: "Claude 4 demo", score: 80, date: "2026-05-01" }],
      noHighlights,
      noRunners,
    );
    assert.ok(section.includes("## Vídeos"));
    assert.ok(section.includes("Claude 4 demo"));
    assert.ok(section.includes("https://www.youtube.com/watch?v=abc"));
  });

  it("renderiza seção VÍDEOS com 2 itens", () => {
    const section = renderSection(
      "Vídeos",
      [
        { url: "https://www.youtube.com/watch?v=abc", title: "Video A", score: 80, date: "2026-05-01" },
        { url: "https://vimeo.com/123", title: "Video B", score: 70, date: "2026-05-01" },
      ],
      noHighlights,
      noRunners,
    );
    assert.ok(section.includes("Video A"));
    assert.ok(section.includes("Video B"));
  });

  it("seção vazia quando bucket video está vazio (_(vazio)_ placeholder)", () => {
    const section = renderSection("Vídeos", [], noHighlights, noRunners);
    assert.ok(section.includes("_(vazio)_"));
  });
});

describe("buildHighlightUrls — inclui bucket video (#359)", () => {
  it("extrai URL com highlight=true do bucket video", () => {
    const urls = buildHighlightUrls({
      lancamento: [],
      pesquisa: [],
      noticias: [],
      video: [{ url: "https://www.youtube.com/watch?v=abc", highlight: true }],
    });
    assert.ok(urls.has("https://www.youtube.com/watch?v=abc"));
  });

  it("não adiciona video sem highlight flag", () => {
    const urls = buildHighlightUrls({
      lancamento: [],
      pesquisa: [],
      noticias: [],
      video: [{ url: "https://www.youtube.com/watch?v=abc" }],
    });
    assert.equal(urls.size, 0);
  });
});

describe("computeTotalConsidered (#477) — métricas de cobertura", () => {
  it("usa total_considered do JSON se presente", () => {
    const data = { lancamento: [], pesquisa: [], noticias: [], total_considered: 42 };
    assert.equal(computeTotalConsidered("/any/path/01-categorized.json", data), 42);
  });

  it("auto-descobre tmp-categorized.json quando campo ausente", () => {
    const dir = mkdtempSync(tmpdir() + "/test-coverage-");
    mkdirSync(dir + "/_internal", { recursive: true });
    writeFileSync(
      dir + "/_internal/tmp-categorized.json",
      JSON.stringify({
        lancamento: [{ url: "a" }, { url: "b" }],
        pesquisa: [{ url: "c" }],
        noticias: [{ url: "d" }, { url: "e" }, { url: "f" }],
      }),
    );
    const data = { lancamento: [], pesquisa: [], noticias: [] };
    const result = computeTotalConsidered(dir + "/_internal/01-categorized.json", data);
    assert.equal(result, 6);
    rmSync(dir, { recursive: true });
  });

  it("retorna null quando nem campo nem tmp-categorized.json existem", () => {
    const data = { lancamento: [], pesquisa: [], noticias: [] };
    assert.equal(computeTotalConsidered("/nonexistent/path/01-categorized.json", data), null);
  });

  it("usa total_considered mesmo se tmp-categorized.json existe (campo tem prioridade)", () => {
    const dir = mkdtempSync(tmpdir() + "/test-coverage-prio-");
    mkdirSync(dir + "/_internal", { recursive: true });
    writeFileSync(
      dir + "/_internal/tmp-categorized.json",
      JSON.stringify({ lancamento: [{ url: "x" }], pesquisa: [], noticias: [] }),
    );
    // Campo explícito tem prioridade — deve retornar 99, não 1
    const data = { lancamento: [], pesquisa: [], noticias: [], total_considered: 99 };
    const result = computeTotalConsidered(dir + "/_internal/01-categorized.json", data);
    assert.equal(result, 99);
    rmSync(dir, { recursive: true });
  });
});

describe("extractEaiAnswer (#584)", () => {
  it("extrai A/B do frontmatter", () => {
    const md = `---
eia_answer:
  A: ia
  B: real
---

É IA?

Crédito.
`;
    const r = extractEaiAnswer(md);
    assert.deepEqual(r, { A: "ia", B: "real" });
  });

  it("retorna null sem frontmatter", () => {
    assert.equal(extractEaiAnswer("É IA?\nCrédito."), null);
  });

  it("retorna null se A ou B ausente", () => {
    const md = `---
eia_answer:
  A: ia
---
`;
    assert.equal(extractEaiAnswer(md), null);
  });
});

describe("renderDestaquesFromApproved (#585)", () => {
  it("retorna null quando approved.json não existe", () => {
    const tmp = mkdtempSync(join(tmpdir(), "render-test-"));
    const result = renderDestaquesFromApproved(
      join(tmp, "01-approved.json"),
      new Set(),
      new Set(),
    );
    assert.equal(result, null);
    rmSync(tmp, { recursive: true });
  });

  it("retorna null quando highlights[] vazio", () => {
    const tmp = mkdtempSync(join(tmpdir(), "render-test-"));
    const path = join(tmp, "01-approved.json");
    writeFileSync(path, JSON.stringify({ highlights: [] }));
    const result = renderDestaquesFromApproved(path, new Set(), new Set());
    assert.equal(result, null);
    rmSync(tmp, { recursive: true });
  });

  it("renderiza 3 destaques nested (article shape)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "render-test-"));
    const path = join(tmp, "01-approved.json");
    const approved = {
      highlights: [
        { rank: 1, score: 92, url: "https://a/", article: { url: "https://a/", title: "Titulo A", date: "2026-05-05", score: 92 } },
        { rank: 2, score: 82, url: "https://b/", article: { url: "https://b/", title: "Titulo B", date: "2026-05-05", score: 82 } },
        { rank: 3, score: 80, url: "https://c/", article: { url: "https://c/", title: "Titulo C", date: "2026-05-05", score: 80 } },
      ],
    };
    writeFileSync(path, JSON.stringify(approved));
    const result = renderDestaquesFromApproved(
      path,
      new Set(["https://a/", "https://b/", "https://c/"]),
      new Set(),
    );
    assert.ok(result);
    assert.ok(result!.startsWith("## Destaques\n\n"));
    assert.match(result!, /1\. \[92\] Titulo A/);
    assert.match(result!, /2\. \[82\] Titulo B/);
    assert.match(result!, /3\. \[80\] Titulo C/);
    // Não deve ter o placeholder
    assert.ok(!result!.includes("(mova 3 artigos para cá)"));
    rmSync(tmp, { recursive: true });
  });

  it("retorna null quando JSON inválido", () => {
    const tmp = mkdtempSync(join(tmpdir(), "render-test-"));
    const path = join(tmp, "01-approved.json");
    writeFileSync(path, "{invalid");
    const result = renderDestaquesFromApproved(path, new Set(), new Set());
    assert.equal(result, null);
    rmSync(tmp, { recursive: true });
  });

  it("aceita destaques flat shape (sem article wrapper)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "render-test-"));
    const path = join(tmp, "01-approved.json");
    const approved = {
      highlights: [
        { url: "https://x/", title: "Flat title", date: "2026-05-05", score: 50 } as unknown,
      ],
    };
    writeFileSync(path, JSON.stringify(approved));
    const result = renderDestaquesFromApproved(
      path,
      new Set(["https://x/"]),
      new Set(),
    );
    assert.ok(result);
    assert.match(result!, /Flat title/);
    rmSync(tmp, { recursive: true });
  });
});

describe("renderSection startNumber (#579)", () => {
  it("default startNumber=1 mantém compat", () => {
    const result = renderSection(
      "TestSec",
      [{ url: "https://a.com/x", title: "T", score: 80, date: "2026-05-05" }],
      new Set(),
      new Set(),
    );
    assert.match(result, /^## TestSec\n\n1\. /);
  });

  it("startNumber=5 inicia em 5", () => {
    const result = renderSection(
      "TestSec",
      [
        { url: "https://a.com/1", title: "T1", score: 80, date: "2026-05-05" },
        { url: "https://a.com/2", title: "T2", score: 70, date: "2026-05-05" },
      ],
      new Set(),
      new Set(),
      5,
    );
    assert.match(result, /5\. \[80\] T1/);
    assert.match(result, /6\. \[70\] T2/);
  });
});

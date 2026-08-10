/**
 * test/link-layout.test.ts (#4841)
 *
 * Cobertura de `scripts/lib/link-layout.ts` — as funções puras que derivam
 * `link-layout.json` (posição: bloco + ordinal local + ordinal global) e
 * `published-links.json` (proveniência: scored vs writer_inserted) a partir
 * de `NewsletterContent`, sem depender do CLI/HTML renderizado.
 *
 * `readScoredUrls` é testada à parte (I/O — fixtures em tmpdir).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLinkLayout,
  buildPublishedLinks,
  collectScoredUrls,
  readScoredUrls,
  type Bloco,
} from "../scripts/lib/link-layout.ts";
import type { NewsletterContent, Section } from "../scripts/lib/newsletter-parse.ts";

/** Content mínimo válido — só os campos exigidos por `NewsletterContent`. */
function baseContent(overrides: Partial<NewsletterContent> = {}): NewsletterContent {
  return {
    title: "Edição de teste",
    subtitle: "",
    coverImage: "",
    destaques: [],
    eia: { credit: "", imageA: "", imageB: "", edition: "260999" },
    sections: [],
    ...overrides,
  };
}

function section(name: string, urls: string[], descriptions: string[] = []): Section {
  return {
    name,
    emoji: "📡",
    items: urls.map((url, i) => ({
      title: `Item ${i + 1}`,
      url,
      description: descriptions[i] ?? "",
    })),
  };
}

describe("buildLinkLayout (#4841)", () => {
  it("captura url do destaque + links inline de body/why + aprofunde, em ordem", () => {
    const content = baseContent({
      destaques: [
        {
          n: 1,
          category: "MERCADO",
          title: "D1",
          url: "https://example.com/d1",
          body: "Corpo com um link [contextual](https://example.com/d1-corpo) inserido pelo writer.",
          why: "Por que importa, [outra fonte](https://example.com/d1-why).",
          aprofunde: [
            { title: "Fonte extra", url: "https://example.com/d1-aprofunde", source: "Reuters" },
          ],
        },
      ],
    });
    const layout = buildLinkLayout(content);
    assert.deepEqual(
      layout.map((e) => e.url),
      [
        "https://example.com/d1",
        "https://example.com/d1-corpo",
        "https://example.com/d1-why",
        "https://example.com/d1-aprofunde",
      ],
    );
    assert.ok(layout.every((e) => e.bloco === "destaque"));
    // ordinal_no_bloco e ordinal_global coincidem quando só há 1 bloco.
    assert.deepEqual(
      layout.map((e) => e.ordinal_no_bloco),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      layout.map((e) => e.ordinal_global),
      [1, 2, 3, 4],
    );
  });

  it("destaques vêm antes das seções secundárias, na ordem de content.sections (#4846: posição auditável)", () => {
    const content = baseContent({
      destaques: [
        { n: 1, category: "MERCADO", title: "D1", url: "https://example.com/d1", body: "", why: "" },
      ],
      sections: [
        section("RADAR", ["https://example.com/radar-1", "https://example.com/radar-2"]),
        section("LANÇAMENTOS", ["https://example.com/lanc-1"]),
      ],
    });
    const layout = buildLinkLayout(content);
    assert.deepEqual(
      layout.map((e) => [e.bloco, e.url] as [Bloco, string]),
      [
        ["destaque", "https://example.com/d1"],
        ["radar", "https://example.com/radar-1"],
        ["radar", "https://example.com/radar-2"],
        ["lancamento", "https://example.com/lanc-1"],
      ],
    );
    // ordinal_global é sequencial por TODO o layout; ordinal_no_bloco reinicia por bloco.
    assert.deepEqual(
      layout.map((e) => e.ordinal_global),
      [1, 2, 3, 4],
    );
    const radarEntries = layout.filter((e) => e.bloco === "radar");
    assert.deepEqual(
      radarEntries.map((e) => e.ordinal_no_bloco),
      [1, 2],
    );
  });

  it("captura link inline dentro da descrição de um item de seção", () => {
    const content = baseContent({
      sections: [
        section(
          "USE MELHOR",
          ["https://example.com/tutorial"],
          ["Veja também [o anúncio oficial](https://example.com/tutorial-anuncio)."],
        ),
      ],
    });
    const layout = buildLinkLayout(content);
    assert.deepEqual(
      layout.map((e) => e.url),
      ["https://example.com/tutorial", "https://example.com/tutorial-anuncio"],
    );
    assert.ok(layout.every((e) => e.bloco === "use_melhor"));
  });

  it("seção VÍDEOS mapeia pro bloco 'video'; nome não-reconhecido é ignorado", () => {
    const content = baseContent({
      sections: [
        section("VÍDEOS", ["https://example.com/video-1"]),
        { name: "ALGO DESCONHECIDO", emoji: "❓", items: [{ title: "x", url: "https://example.com/ignored", description: "" }] },
      ],
    });
    const layout = buildLinkLayout(content);
    assert.deepEqual(
      layout.map((e) => [e.bloco, e.url]),
      [["video", "https://example.com/video-1"]],
    );
  });

  it("destaque sem url (defensivo) não quebra e simplesmente não gera entry pra esse campo", () => {
    const content = baseContent({
      destaques: [
        { n: 1, category: "MERCADO", title: "D1", url: "", body: "", why: "" },
      ],
    });
    assert.deepEqual(buildLinkLayout(content), []);
  });
});

describe("collectScoredUrls (#4841)", () => {
  it("junta highlights (flat e nested), runners_up e os 4 buckets", () => {
    const scored = collectScoredUrls({
      highlights: [
        { url: "https://example.com/flat" },
        { article: { url: "https://example.com/nested" } },
      ],
      runners_up: [{ url: "https://example.com/runner" }],
      lancamento: [{ url: "https://example.com/lanc" }],
      radar: [{ url: "https://example.com/radar" }],
      use_melhor: [{ url: "https://example.com/use-melhor" }],
      video: [{ url: "https://example.com/video" }],
    });
    assert.deepEqual(
      [...scored].sort(),
      [
        "https://example.com/flat",
        "https://example.com/lanc",
        "https://example.com/nested",
        "https://example.com/radar",
        "https://example.com/runner",
        "https://example.com/use-melhor",
        "https://example.com/video",
      ].sort(),
    );
  });

  it("objeto vazio/campos ausentes → Set vazio, sem lançar", () => {
    assert.deepEqual(collectScoredUrls({}), new Set());
  });
});

describe("buildPublishedLinks (#4841 — separa posição [layout] de proveniência [scoredUrls], #4848)", () => {
  it("marca 'scored' quando a url está no pool aprovado, 'writer_inserted' quando não está", () => {
    const layout = buildLinkLayout(
      baseContent({
        destaques: [
          {
            n: 1,
            category: "MERCADO",
            title: "D1",
            url: "https://example.com/scored-destaque",
            body: "Segundo a Reuters, [fonte inserida pelo writer](https://example.com/writer-inserted).",
            why: "",
          },
        ],
      }),
    );
    const published = buildPublishedLinks(
      layout,
      new Set(["https://example.com/scored-destaque"]),
    );
    assert.deepEqual(
      published.map((p) => [p.url, p.origin]),
      [
        ["https://example.com/scored-destaque", "scored"],
        ["https://example.com/writer-inserted", "writer_inserted"],
      ],
    );
  });

  it("dedup por url — mantém a 1ª ocorrência (bloco da 1ª aparição)", () => {
    const layout = buildLinkLayout(
      baseContent({
        destaques: [
          {
            n: 1,
            category: "MERCADO",
            title: "D1",
            url: "https://example.com/repeat",
            body: "",
            why: "Reforça [o mesmo link](https://example.com/repeat) de novo.",
          },
        ],
      }),
    );
    assert.equal(layout.length, 2); // 2 aparições na camada de POSIÇÃO
    const published = buildPublishedLinks(layout, new Set());
    assert.equal(published.length, 1); // 1 na camada de PROVENIÊNCIA (dedup)
    assert.equal(published[0].bloco, "destaque");
  });

  it("scoredUrls vazio (ex: 01-approved.json ausente) marca tudo como writer_inserted — nunca mente 'scored'", () => {
    const layout = buildLinkLayout(
      baseContent({ sections: [section("RADAR", ["https://example.com/x"])] }),
    );
    const published = buildPublishedLinks(layout, new Set());
    assert.equal(published[0].origin, "writer_inserted");
  });
});

describe("readScoredUrls (#4841 — fail-soft)", () => {
  function makeEditionDir(): string {
    return mkdtempSync(join(tmpdir(), "diaria-link-layout-scored-"));
  }

  it("lê 01-approved.json quando presente", () => {
    const dir = makeEditionDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "01-approved.json"),
        JSON.stringify({ highlights: [{ url: "https://example.com/a" }] }),
      );
      const urls = readScoredUrls(dir);
      assert.ok(urls.has("https://example.com/a"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fallback pra 01-categorized.json quando 01-approved.json não existe", () => {
    const dir = makeEditionDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, "_internal", "01-categorized.json"),
        JSON.stringify({ radar: [{ url: "https://example.com/b" }] }),
      );
      const urls = readScoredUrls(dir);
      assert.ok(urls.has("https://example.com/b"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("nenhum arquivo presente → Set vazio, sem lançar", () => {
    const dir = makeEditionDir();
    try {
      assert.deepEqual(readScoredUrls(dir), new Set());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON inválido → fail-soft, Set vazio (não derruba o render)", () => {
    const dir = makeEditionDir();
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "01-approved.json"), "{ isso não é json válido");
      assert.deepEqual(readScoredUrls(dir), new Set());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDestaqueUrls,
  extractPromptUrl,
  computeSwaps,
} from "../scripts/match-prompts-to-destaques.ts";

describe("extractDestaqueUrls", () => {
  it("extrai URLs em ordem de DESTAQUE 1/2/3", () => {
    const md = `DESTAQUE 1 | MERCADO

Pentágono fecha
[https://cnnbrasil.com.br/pentagono](https://cnnbrasil.com.br/pentagono)

Corpo.

---

DESTAQUE 2 | TENDÊNCIA

DeepSeek V4
[https://mittechreview.com.br/deepseek-v4](https://mittechreview.com.br/deepseek-v4)

Corpo.

---

DESTAQUE 3 | SEGURANÇA

Falha Lovable
[https://exame.com/lovable](https://exame.com/lovable)

Corpo.
`;
    const urls = extractDestaqueUrls(md);
    assert.equal(urls.length, 3);
    assert.ok(urls[0].includes("pentagono"));
    assert.ok(urls[1].includes("deepseek"));
    assert.ok(urls[2].includes("lovable"));
  });

  it("normaliza CRLF", () => {
    const md = "DESTAQUE 1 | M\r\n\r\nhttps://a.com/x\r\n\r\nDESTAQUE 2 | T\r\n\r\nhttps://b.com/y\r\n\r\nDESTAQUE 3 | S\r\nhttps://c.com/z";
    const urls = extractDestaqueUrls(md);
    assert.equal(urls.length, 3);
  });

  it("ignora seções secundárias", () => {
    const md = `DESTAQUE 1 | M\n\nhttps://a.com/x\n\nDESTAQUE 2 | T\n\nhttps://b.com/y\n\nDESTAQUE 3 | S\n\nhttps://c.com/z\n\nLANÇAMENTOS\n\nItem\nhttps://blog.google/foo`;
    const urls = extractDestaqueUrls(md);
    assert.equal(urls.length, 3);
    assert.ok(!urls.some((u) => u.includes("blog.google")));
  });
});

describe("extractPromptUrl", () => {
  it("extrai do frontmatter", () => {
    const md = `---
destaque_url: https://example.com/article
position_at_write: 1
---

Cena Van Gogh impasto.
`;
    assert.equal(extractPromptUrl(md), "https://example.com/article");
  });

  it("retorna null sem frontmatter", () => {
    assert.equal(extractPromptUrl("Cena Van Gogh."), null);
  });

  it("aceita URL no body também (fallback)", () => {
    const md = "<!-- destaque_url: https://example.com/article -->\nCena.";
    assert.equal(extractPromptUrl(md), "https://example.com/article");
  });
});

describe("computeSwaps (#606)", () => {
  it("já alinhado → 0 swaps", () => {
    const swaps = computeSwaps(
      { d1: "https://a", d2: "https://b", d3: "https://c" },
      ["https://a", "https://b", "https://c"],
    );
    assert.deepEqual(swaps, []);
  });

  it("d1↔d3 reordenado → swaps via tmp", () => {
    const swaps = computeSwaps(
      { d1: "https://pentagono", d2: "https://deepseek", d3: "https://lovable" },
      ["https://lovable", "https://deepseek", "https://pentagono"],
    );
    // 6 swaps: 3 pra .swap-tmp + 3 pro destino final
    assert.equal(swaps.length, 6);
    // Step 1: tudo pra .swap-tmp
    assert.ok(swaps.slice(0, 3).every((s) => s.to.includes(".swap-tmp")));
    // Step 2: do tmp pro final
    assert.ok(swaps.slice(3, 6).every((s) => s.from.includes(".swap-tmp")));
    // d1 (pentagono) deve virar d3
    const d1Final = swaps.find((s) => s.from === "02-d1-prompt.swap-tmp.md");
    assert.equal(d1Final?.to, "02-d3-prompt.md");
    // d3 (lovable) deve virar d1
    const d3Final = swaps.find((s) => s.from === "02-d3-prompt.swap-tmp.md");
    assert.equal(d3Final?.to, "02-d1-prompt.md");
  });

  it("URL ausente do reviewed → não swap (degenerado)", () => {
    const swaps = computeSwaps(
      { d1: "https://a", d2: "https://b", d3: "https://orphan" },
      ["https://a", "https://b", "https://c"],
    );
    assert.deepEqual(swaps, []);
  });

  it("prompt sem URL → não swap", () => {
    const swaps = computeSwaps(
      { d1: null, d2: "https://b", d3: "https://c" },
      ["https://a", "https://b", "https://c"],
    );
    assert.deepEqual(swaps, []);
  });

  it("3-cycle (rotação) gera swaps via tmp corretamente", () => {
    const swaps = computeSwaps(
      { d1: "https://a", d2: "https://b", d3: "https://c" },
      ["https://b", "https://c", "https://a"], // a→3, b→1, c→2
    );
    assert.equal(swaps.length, 6);
    const d1Final = swaps.find((s) => s.from === "02-d1-prompt.swap-tmp.md");
    assert.equal(d1Final?.to, "02-d3-prompt.md");
    const d2Final = swaps.find((s) => s.from === "02-d2-prompt.swap-tmp.md");
    assert.equal(d2Final?.to, "02-d1-prompt.md");
    const d3Final = swaps.find((s) => s.from === "02-d3-prompt.swap-tmp.md");
    assert.equal(d3Final?.to, "02-d2-prompt.md");
  });
});

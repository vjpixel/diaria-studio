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

  // #1730 review: o formato REAL de produção (desde ~260520) usa header em
  // bold markdown + link markdown. Antes do fix, o `^DESTAQUE` strict retornava
  // [] em todo arquivo real — match-prompts (Stage 3) e image-content-fresh
  // (Stage 4) viravam no-op silencioso.
  it("parseia o formato real bold `**DESTAQUE N | ...**` com frontmatter eia", () => {
    const md = `---
eia:
  location: "DESTAQUE 1, parágrafo 1, primeira frase"
---

**DESTAQUE 1 | 🛠️ FERRAMENTAS**

**[GitHub Copilot muda cobrança](https://canaltech.com.br/ia/github-copilot-creditos/)**

Corpo do destaque.

Por que isso importa:

Impacto.

---

**DESTAQUE 2 | 🔬 PESQUISA**

**[Novo paper](https://arxiv.org/abs/2506.001)**

Corpo.

---

**DESTAQUE 3 | ⚖️ REGULAÇÃO**

**[UE aprova lei](https://exame.com/ue-lei-ia/)**

Corpo.
`;
    const urls = extractDestaqueUrls(md);
    assert.equal(urls.length, 3, JSON.stringify(urls));
    assert.ok(urls[0].includes("canaltech"), urls[0]);
    assert.ok(urls[1].includes("arxiv"), urls[1]);
    assert.ok(urls[2].includes("exame"), urls[2]);
    // não captura a menção "DESTAQUE 1" dentro do frontmatter eia.location
    assert.ok(!urls.some((u) => u.includes("location")));
  });

  // #1833: URL com parêntese interno balanceado (Wikipedia/gov) não pode ser
  // truncada no primeiro `)`. O `)` que fecha o link markdown e a pontuação de
  // prose são removidos; os parênteses balanceados internos são preservados.
  it("#1833: preserva parêntese interno balanceado, strippa o `)` do link markdown", () => {
    const md =
      `**DESTAQUE 1 | A**\n\n` +
      `**[Verbete](https://en.wikipedia.org/wiki/AI_(disambiguation))**\n\n` +
      `Corpo.\n\n---\n\n` +
      `**DESTAQUE 2 | B**\n\n` +
      `**[Lei](https://www.gov.br/lei/art_5_(2026)/texto)**\n\n` +
      `Corpo.\n\n---\n\n` +
      `**DESTAQUE 3 | C**\n\n` +
      `**[Limpa](https://exame.com/ia/x/)**\n\n` +
      `Corpo.\n`;
    const urls = extractDestaqueUrls(md);
    assert.equal(urls.length, 3, JSON.stringify(urls));
    assert.equal(urls[0], "https://en.wikipedia.org/wiki/AI_(disambiguation)");
    assert.equal(urls[1], "https://www.gov.br/lei/art_5_(2026)/texto");
    assert.equal(urls[2], "https://exame.com/ia/x/"); // sem `)**`, sem truncar
  });

  it("#1833: parêntese desbalanceado de prose `(url)` é removido", () => {
    const md = `DESTAQUE 1 | A\n\nveja (https://a.com/x) aqui\n\nCorpo.`;
    const urls = extractDestaqueUrls(md);
    assert.deepEqual(urls, ["https://a.com/x"]);
  });

  it("#1833: `*` interno no path é preservado (só o `**` de fecho do bold é removido)", () => {
    const md = `**DESTAQUE 1 | A**\n\n**[Glob](https://a.com/v1/*/items)**\n\nCorpo.`;
    const urls = extractDestaqueUrls(md);
    assert.deepEqual(urls, ["https://a.com/v1/*/items"]);
  });

  // review #1834: `*` no FIM do path, imediatamente antes do `**` de fecho do
  // bold — discrimina o `replace(/\*+$/)` (tira só o bold) do `)` do link.
  it("#1833: `*` no fim do path antes do `**` de fecho é preservado", () => {
    const md = `**DESTAQUE 1 | A**\n\n**[Glob](https://a.com/p*)**\n\nCorpo.`;
    const urls = extractDestaqueUrls(md);
    assert.deepEqual(urls, ["https://a.com/p*"]);
  });

  // review #1834: contrato "primeira URL do block" — título bold-wrapped vence
  // um segundo link no corpo (formato real: título em linha própria + EOL).
  it("retorna só a 1ª URL quando há 2 links no block (título vence)", () => {
    const md =
      `**DESTAQUE 1 | A**\n\n` +
      `**[Manchete](https://a.com/1)**\n\n` +
      `corpo citando [outro](https://b.com/2) no meio.\n`;
    const urls = extractDestaqueUrls(md);
    assert.deepEqual(urls, ["https://a.com/1"]);
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
  it("já alinhado → ok=true, 0 swaps", () => {
    const r = computeSwaps(
      { d1: "https://a", d2: "https://b", d3: "https://c" },
      ["https://a", "https://b", "https://c"],
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.swaps.length === 0);
    assert.match(r.ok ? r.reason : "", /alinhados/);
  });

  it("d1↔d3 reordenado → swaps via tmp", () => {
    const r = computeSwaps(
      { d1: "https://pentagono", d2: "https://deepseek", d3: "https://lovable" },
      ["https://lovable", "https://deepseek", "https://pentagono"],
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    // 6 swaps: 3 pra .swap-tmp + 3 pro destino final
    assert.equal(r.swaps.length, 6);
    assert.ok(r.swaps.slice(0, 3).every((s) => s.to.includes(".swap-tmp")));
    assert.ok(r.swaps.slice(3, 6).every((s) => s.from.includes(".swap-tmp")));
    const d1Final = r.swaps.find((s) => s.from === "02-d1-prompt.swap-tmp.md");
    assert.equal(d1Final?.to, "02-d3-prompt.md");
    const d3Final = r.swaps.find((s) => s.from === "02-d3-prompt.swap-tmp.md");
    assert.equal(d3Final?.to, "02-d1-prompt.md");
  });

  it("#691: URL ausente do reviewed → fail-closed (ok=false), NÃO no-op", () => {
    const r = computeSwaps(
      { d1: "https://a", d2: "https://b", d3: "https://orphan" },
      ["https://a", "https://b", "https://c"],
    );
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /orphan/);
    assert.match(r.ok ? "" : r.reason, /02-reviewed\.md/);
  });

  it("#691: prompt sem destaque_url no frontmatter → fail-closed", () => {
    const r = computeSwaps(
      { d1: null, d2: "https://b", d3: "https://c" },
      ["https://a", "https://b", "https://c"],
    );
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /02-d1-prompt\.md/);
    assert.match(r.ok ? "" : r.reason, /destaque_url/);
  });

  it("#691: prompt d3 sem URL → fail-closed (mensagem identifica d3)", () => {
    const r = computeSwaps(
      { d1: "https://a", d2: "https://b", d3: null },
      ["https://a", "https://b", "https://c"],
    );
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /02-d3-prompt\.md/);
  });

  // review #1832: alinhar com o critério do image-content-fresh (Stage 4) —
  // canonicalize compartilhado. Diferença benigna (trailing slash, case de host,
  // tracking param) entre frontmatter e reviewed NÃO deve mais fail-close.
  it("#1832: trailing-slash / host-case / utm benignos → alinhado, NÃO fail-closed", () => {
    const r = computeSwaps(
      {
        d1: "https://Exame.com/ia/artigo/",
        d2: "https://b.com/y?utm_source=x",
        d3: "https://c.com/z",
      },
      ["https://exame.com/ia/artigo", "https://b.com/y", "https://c.com/z"],
    );
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    assert.ok(r.ok && r.swaps.length === 0);
  });

  it("#1832: reorder ainda detectado mesmo com diferença benigna de slug", () => {
    const r = computeSwaps(
      { d1: "https://a.com/x/", d2: "https://b.com/y", d3: "https://c.com/z" },
      ["https://c.com/z", "https://b.com/y", "https://a.com/x"],
    );
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.swaps.length === 6); // d1↔d3 via tmp
  });

  it("3-cycle (rotação) gera swaps via tmp corretamente", () => {
    const r = computeSwaps(
      { d1: "https://a", d2: "https://b", d3: "https://c" },
      ["https://b", "https://c", "https://a"], // a→3, b→1, c→2
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.swaps.length, 6);
    const d1Final = r.swaps.find((s) => s.from === "02-d1-prompt.swap-tmp.md");
    assert.equal(d1Final?.to, "02-d3-prompt.md");
    const d2Final = r.swaps.find((s) => s.from === "02-d2-prompt.swap-tmp.md");
    assert.equal(d2Final?.to, "02-d1-prompt.md");
    const d3Final = r.swaps.find((s) => s.from === "02-d3-prompt.swap-tmp.md");
    assert.equal(d3Final?.to, "02-d2-prompt.md");
  });
});

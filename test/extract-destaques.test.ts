import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDestaques, buildSubtitle, replaceDestaqueTitleInMd } from "../scripts/extract-destaques.ts";

describe("parseDestaques (#172)", () => {
  it("parseia formato novo: URL imediatamente abaixo do título", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título escolhido d1",
      "https://example.com/d1",
      "",
      "Parágrafo 1 do corpo.",
      "",
      "Parágrafo 2 do corpo.",
      "",
      "Por que isso importa:",
      "Impacto prático.",
      "",
      "---",
      "DESTAQUE 2 | PESQUISA",
      "Título d2",
      "https://example.com/d2",
      "",
      "Corpo d2.",
      "",
      "Por que isso importa:",
      "Impacto d2.",
      "",
      "---",
      "DESTAQUE 3 | MERCADO",
      "Título d3",
      "https://example.com/d3",
      "",
      "Corpo d3.",
      "",
      "Por que isso importa:",
      "Impacto d3.",
    ].join("\n");

    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 3);
    assert.equal(destaques[0].n, 1);
    assert.equal(destaques[0].title, "Título escolhido d1");
    assert.equal(destaques[0].url, "https://example.com/d1");
    assert.equal(destaques[0].body, "Parágrafo 1 do corpo.\n\nParágrafo 2 do corpo.");
    assert.equal(destaques[0].why, "Impacto prático.");
    assert.equal(destaques[1].title, "Título d2");
    assert.equal(destaques[1].url, "https://example.com/d2");
    assert.equal(destaques[2].title, "Título d3");
    assert.equal(destaques[2].url, "https://example.com/d3");
  });

  it("parseia formato legacy: URL no fim do bloco (compat)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título d1",
      "",
      "Corpo d1.",
      "",
      "Por que isso importa:",
      "Impacto d1.",
      "",
      "https://example.com/d1",
      "",
      "---",
      "DESTAQUE 2 | PESQUISA",
      "Título d2",
      "",
      "Corpo d2.",
      "",
      "https://example.com/d2",
      "",
      "---",
      "DESTAQUE 3 | MERCADO",
      "Título d3",
      "",
      "Corpo d3.",
      "",
      "https://example.com/d3",
    ].join("\n");

    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 3);
    assert.equal(destaques[0].title, "Título d1");
    assert.equal(destaques[0].url, "https://example.com/d1");
    assert.equal(destaques[0].body, "Corpo d1.");
    assert.equal(destaques[0].why, "Impacto d1.");
    assert.equal(destaques[1].title, "Título d2");
    assert.equal(destaques[1].url, "https://example.com/d2");
    assert.equal(destaques[1].why, "");
    assert.equal(destaques[2].url, "https://example.com/d3");
  });

  it("destaque sem URL → url vazia", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título sem URL",
      "",
      "Corpo.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    assert.equal(destaques[0].url, "");
  });

  it("body em formato novo NÃO inclui a URL", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://example.com/x",
      "",
      "Parágrafo 1.",
      "",
      "Parágrafo 2.",
      "",
      "Por que isso importa:",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques[0].url, "https://example.com/x");
    assert.ok(!destaques[0].body.includes("https://example.com/x"));
    assert.equal(destaques[0].body, "Parágrafo 1.\n\nParágrafo 2.");
    assert.equal(destaques[0].why, "Impacto.");
  });

  it("B1: legacy com URL bare inline no body — URL canônica do fim ganha", () => {
    // Edge case: layout legacy (URL no fim) onde o LLM/editor deixou uma
    // URL bare em uma linha do body. O parser deve escolher a URL
    // canônica (última depois de "Por que isso importa:"), não a inline.
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título legacy",
      "",
      "Parágrafo do corpo.",
      "",
      "https://midbody.example.com",
      "",
      "Por que isso importa:",
      "Impacto.",
      "",
      "https://canonical.example.com/source",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    assert.equal(destaques[0].url, "https://canonical.example.com/source");
    // URL inline fica no body (mas NÃO substitui a canônica).
    assert.ok(destaques[0].body.includes("Parágrafo do corpo."));
    assert.equal(destaques[0].why, "Impacto.");
  });

  it("formato #245 double-newline: URL após bloco de título com blank lines", () => {
    // Formato pós-#245: blank line entre header, título, URL, body
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Título 245",
      "",
      "https://example.com/d1",
      "",
      "Parágrafo 1.",
      "",
      "Parágrafo 2.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    assert.equal(destaques[0].title, "Título 245");
    assert.equal(destaques[0].url, "https://example.com/d1");
    // Body inclui ambos parágrafos
    assert.ok(destaques[0].body.includes("Parágrafo 1."));
    assert.ok(destaques[0].body.includes("Parágrafo 2."));
    // Body NÃO inclui a URL nem "Por que isso importa:"
    assert.ok(!destaques[0].body.includes("https://"));
    assert.ok(!destaques[0].body.includes("Por que isso"));
    assert.equal(destaques[0].why, "Impacto.");
  });

  it("formato #245 pre-gate: 3 opções de título com blank entre cada", () => {
    // Pre-gate: writer emite 3 opções; parser pega a primeira como title.
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Opção 1 do título",
      "",
      "Opção 2 do título",
      "",
      "Opção 3 do título",
      "",
      "https://example.com/d1",
      "",
      "Corpo do destaque.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    // Parser pega a primeira opção como title (post-gate só tem 1 mesmo)
    assert.equal(destaques[0].title, "Opção 1 do título");
    assert.equal(destaques[0].url, "https://example.com/d1");
    assert.ok(destaques[0].body.includes("Corpo do destaque."));
  });

  it("B1: novo formato — URL inline no body NÃO ganha da canônica do topo", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título novo",
      "https://canonical.example.com/source",
      "",
      "Corpo com URL inline https://midbody.example.com no meio.",
      "",
      "Por que isso importa:",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques[0].url, "https://canonical.example.com/source");
    assert.ok(destaques[0].body.includes("URL inline"));
  });

  it("#599: formato inline link `[título](URL)` (post-gate, 1 título)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Título único embedado](https://example.com/x)",
      "",
      "Corpo do destaque.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    assert.equal(destaques[0].title, "Título único embedado");
    assert.equal(destaques[0].url, "https://example.com/x");
    assert.equal(destaques[0].body, "Corpo do destaque.");
    assert.equal(destaques[0].why, "Impacto.");
  });

  it("#599: formato inline link com 3 opções pré-gate", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Opção 1 do título](https://example.com/x)",
      "",
      "[Opção 2 alternativa](https://example.com/x)",
      "",
      "[Opção 3 mais curta](https://example.com/x)",
      "",
      "Corpo do destaque com várias frases.",
      "",
      "Por que isso importa:",
      "",
      "Impacto editorial.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 1);
    // Parser usa primeira opção como title
    assert.equal(destaques[0].title, "Opção 1 do título");
    assert.equal(destaques[0].url, "https://example.com/x");
    // Body NÃO inclui as outras opções de título
    assert.ok(destaques[0].body.includes("Corpo do destaque"));
    assert.ok(!destaques[0].body.includes("Opção 2"));
    assert.ok(!destaques[0].body.includes("Opção 3"));
  });

  it("#599: 3 destaques em formato inline link", () => {
    const md = [
      "DESTAQUE 1 | LANÇAMENTO",
      "",
      "[Título D1](https://a.com/x)",
      "",
      "Corpo D1.",
      "",
      "Por que isso importa:",
      "",
      "Impacto D1.",
      "",
      "---",
      "",
      "DESTAQUE 2 | PESQUISA",
      "",
      "[Título D2](https://b.com/y)",
      "",
      "Corpo D2.",
      "",
      "Por que isso importa:",
      "",
      "Impacto D2.",
      "",
      "---",
      "",
      "DESTAQUE 3 | MERCADO",
      "",
      "[Título D3](https://c.com/z)",
      "",
      "Corpo D3.",
      "",
      "Por que isso importa:",
      "",
      "Impacto D3.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques.length, 3);
    assert.equal(destaques[0].url, "https://a.com/x");
    assert.equal(destaques[1].url, "https://b.com/y");
    assert.equal(destaques[2].url, "https://c.com/z");
    assert.equal(destaques[0].body, "Corpo D1.");
    assert.equal(destaques[1].body, "Corpo D2.");
    assert.equal(destaques[2].body, "Corpo D3.");
  });

  it("#599: formato legacy (URL solo) ainda funciona — backward compat", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "Título legacy",
      "",
      "https://example.com/legacy",
      "",
      "Corpo legacy.",
      "",
      "Por que isso importa:",
      "",
      "Impacto.",
    ].join("\n");
    const destaques = parseDestaques(md);
    assert.equal(destaques[0].title, "Título legacy");
    assert.equal(destaques[0].url, "https://example.com/legacy");
  });
});

// ── #2316: 2-destaque support ────────────────────────────────────────────────

describe("#2316: parseDestaques aceita 2 destaques", () => {
  const md2 = [
    "DESTAQUE 1 | PRODUTO",
    "Título D1",
    "https://example.com/d1",
    "",
    "Corpo D1.",
    "",
    "Por que isso importa:",
    "Impacto D1.",
    "",
    "---",
    "DESTAQUE 2 | PESQUISA",
    "Título D2",
    "https://example.com/d2",
    "",
    "Corpo D2.",
    "",
    "Por que isso importa:",
    "Impacto D2.",
  ].join("\n");

  it("parseia 2 destaques sem erro", () => {
    const destaques = parseDestaques(md2);
    assert.equal(destaques.length, 2);
    assert.equal(destaques[0].n, 1);
    assert.equal(destaques[0].title, "Título D1");
    assert.equal(destaques[1].n, 2);
    assert.equal(destaques[1].title, "Título D2");
  });

  it("subtitle com 2 destaques usa só D2 (sem ' | ')", () => {
    // Regressão: subtitle = buildSubtitle(d2, d3) quando d3 existe;
    // com 2 destaques, deve usar só d2.title.slice(0, 200).
    const destaques = parseDestaques(md2);
    assert.equal(destaques.length, 2);
    // destaques[2] é undefined → d3 undefined → subtitle = d2 title
    const d3 = destaques[2];
    assert.equal(d3, undefined);
  });
});

describe("buildSubtitle (#1214)", () => {
  it("junta d2 e d3 quando combinado cabe em 200 chars", () => {
    const r = buildSubtitle("Título curto 2", "Título curto 3");
    assert.equal(r, "Título curto 2 | Título curto 3");
  });

  it("junta d2 e d3 quando combinado > 80 mas <= 200 (caso 260517)", () => {
    // Regressão pra #1214: D2 + ' | ' + D3 = 86 chars caía pra só D2
    const d2 = "Austrália obriga datacenters a bancar renováveis";   // 48
    const d3 = "Como a NVIDIA usa Codex em produção";                  // 35
    const r = buildSubtitle(d2, d3);
    assert.equal(r, `${d2} | ${d3}`);
    assert.ok(r.length > 80 && r.length <= 200);
  });

  it("usa só d2 quando combinado passa de 200 chars", () => {
    const long2 = "X".repeat(150);
    const long3 = "Y".repeat(100);
    const r = buildSubtitle(long2, long3);
    // Combinado: 150 + 3 + 100 = 253 → trunca pra só d2 (150 chars, cabe em 200)
    assert.equal(r, long2);
  });

  it("trunca d2 quando d2 sozinho passa de 200 chars", () => {
    const huge2 = "Z".repeat(250);
    const long3 = "Y".repeat(50);
    const r = buildSubtitle(huge2, long3);
    assert.equal(r.length, 200);
    assert.ok(r.endsWith("..."));
  });
});

describe("replaceDestaqueTitleInMd (#3806 — Opção B spike: edição visual do título)", () => {
  const THREE_DESTAQUES_NEW_FORMAT = [
    "DESTAQUE 1 | PRODUTO",
    "Título original d1",
    "https://example.com/d1",
    "",
    "Parágrafo 1 do corpo d1.",
    "",
    "Parágrafo 2 do corpo d1.",
    "",
    "Por que isso importa:",
    "Impacto d1.",
    "",
    "---",
    "DESTAQUE 2 | PESQUISA",
    "Título original d2",
    "https://example.com/d2",
    "",
    "Corpo d2.",
    "",
    "Por que isso importa:",
    "Impacto d2.",
    "",
    "---",
    "DESTAQUE 3 | MERCADO",
    "Título original d3",
    "https://example.com/d3",
    "",
    "Corpo d3.",
    "",
    "Por que isso importa:",
    "Impacto d3.",
  ].join("\n");

  it("formato novo (#172): substitui só a linha do título, preservando URL/corpo/why intactos", () => {
    const result = replaceDestaqueTitleInMd(THREE_DESTAQUES_NEW_FORMAT, 1, "Título NOVO d1");
    assert.equal(result.ok, true);
    assert.ok(result.md);
    // parseDestaques sobre o resultado confirma round-trip completo: só o
    // título de D1 mudou, D2/D3 e o resto do D1 permanecem intocados.
    const destaques = parseDestaques(result.md!);
    assert.equal(destaques.length, 3);
    assert.equal(destaques[0].title, "Título NOVO d1");
    assert.equal(destaques[0].url, "https://example.com/d1");
    assert.equal(destaques[0].body, "Parágrafo 1 do corpo d1.\n\nParágrafo 2 do corpo d1.");
    assert.equal(destaques[0].why, "Impacto d1.");
    assert.equal(destaques[1].title, "Título original d2");
    assert.equal(destaques[2].title, "Título original d3");
  });

  it("byte-exato: reaplicar o MESMO título reproduz o arquivo original inalterado", () => {
    const result = replaceDestaqueTitleInMd(THREE_DESTAQUES_NEW_FORMAT, 2, "Título original d2");
    assert.equal(result.ok, true);
    assert.equal(result.md, THREE_DESTAQUES_NEW_FORMAT);
  });

  it("edita D2/D3 sem tocar nos outros blocos", () => {
    const r2 = replaceDestaqueTitleInMd(THREE_DESTAQUES_NEW_FORMAT, 2, "Título NOVO d2");
    assert.equal(r2.ok, true);
    const d2 = parseDestaques(r2.md!);
    assert.equal(d2[0].title, "Título original d1");
    assert.equal(d2[1].title, "Título NOVO d2");
    assert.equal(d2[2].title, "Título original d3");

    const r3 = replaceDestaqueTitleInMd(THREE_DESTAQUES_NEW_FORMAT, 3, "Título NOVO d3");
    assert.equal(r3.ok, true);
    const d3 = parseDestaques(r3.md!);
    assert.equal(d3[0].title, "Título original d1");
    assert.equal(d3[1].title, "Título original d2");
    assert.equal(d3[2].title, "Título NOVO d3");
  });

  it("formato inline-link plano `[título](url)`: troca só o texto entre colchetes", () => {
    const md = ["DESTAQUE 1 | PRODUTO", "", "[Título antigo](https://example.com/x)", "", "Corpo.", "", "Por que isso importa:", "Impacto."].join("\n");
    const result = replaceDestaqueTitleInMd(md, 1, "Título trocado");
    assert.equal(result.ok, true);
    assert.match(result.md!, /^\[Título trocado\]\(https:\/\/example\.com\/x\)$/m);
    const destaques = parseDestaques(result.md!);
    assert.equal(destaques[0].title, "Título trocado");
    assert.equal(destaques[0].url, "https://example.com/x");
  });

  it("formato inline-link com negrito INTERNO `[**título**](url)`: preserva o wrap interno", () => {
    const md = ["DESTAQUE 1 | PRODUTO", "", "[**Título antigo**](https://example.com/x)", "", "Corpo.", "", "Por que isso importa:", "Impacto."].join("\n");
    const result = replaceDestaqueTitleInMd(md, 1, "Título trocado");
    assert.equal(result.ok, true);
    assert.match(result.md!, /^\[\*\*Título trocado\*\*\]\(https:\/\/example\.com\/x\)$/m);
  });

  it("formato inline-link com negrito EXTERNO `**[título](url)**`: preserva o wrap externo", () => {
    const md = ["DESTAQUE 1 | PRODUTO", "", "**[Título antigo](https://example.com/x)**", "", "Corpo.", "", "Por que isso importa:", "Impacto."].join("\n");
    const result = replaceDestaqueTitleInMd(md, 1, "Título trocado");
    assert.equal(result.ok, true);
    assert.match(result.md!, /^\*\*\[Título trocado\]\(https:\/\/example\.com\/x\)\*\*$/m);
  });

  it("recusa (ok:false) quando o destaque N não existe no arquivo", () => {
    const result = replaceDestaqueTitleInMd(THREE_DESTAQUES_NEW_FORMAT, 3, "x");
    assert.equal(result.ok, true); // D3 existe neste fixture — sanity check
    const md2 = ["DESTAQUE 1 | X", "Título único", "https://example.com/1"].join("\n");
    const missing = replaceDestaqueTitleInMd(md2, 2, "Novo título");
    assert.equal(missing.ok, false);
    assert.match(missing.error!, /DESTAQUE 2.*não encontrado/);
  });

  it("recusa (ok:false) com título novo vazio ou só espaço", () => {
    assert.equal(replaceDestaqueTitleInMd(THREE_DESTAQUES_NEW_FORMAT, 1, "").ok, false);
    assert.equal(replaceDestaqueTitleInMd(THREE_DESTAQUES_NEW_FORMAT, 1, "   ").ok, false);
  });

  it("colapsa quebras de linha/espaços múltiplos no título novo (contenteditable pode inserir <br> virando \\n)", () => {
    const result = replaceDestaqueTitleInMd(THREE_DESTAQUES_NEW_FORMAT, 1, "Título   com\nquebra   estranha");
    assert.equal(result.ok, true);
    const destaques = parseDestaques(result.md!);
    assert.equal(destaques[0].title, "Título com quebra estranha");
  });

  it("preserva CRLF quando o arquivo original usa CRLF", () => {
    const crlfMd = THREE_DESTAQUES_NEW_FORMAT.replace(/\n/g, "\r\n");
    const result = replaceDestaqueTitleInMd(crlfMd, 1, "Título NOVO d1 CRLF");
    assert.equal(result.ok, true);
    assert.match(result.md!, /Título NOVO d1 CRLF\r\nhttps:\/\/example\.com\/d1/);
    // Resto do arquivo continua CRLF (não virou LF por acidente).
    assert.ok(result.md!.includes("Título original d2\r\n"));
  });

  it("regex simplificado (fim-de-linha ancorado) ainda lida bem com URL contendo parênteses — backtracking greedy encontra o split certo mesmo sem balanceamento explícito", () => {
    // Não é o caso de refusal que o doc-comment de `rebuildInlineLinkTitleLine`
    // avisa como "formato complexo demais" — esse caso só dispara pra shapes
    // que NEM `isInlineLinkLine` aceitaria (ver comentário da função). Este
    // teste documenta que URL-com-parênteses (caso comum: Wikipedia, `(1).pdf`)
    // funciona normalmente, sem recusa.
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Título com URL complexa](https://example.com/GPT_(modelo))",
      "",
      "Corpo.",
      "",
      "Por que isso importa:",
      "Impacto.",
    ].join("\n");
    const result = replaceDestaqueTitleInMd(md, 1, "Novo título");
    assert.equal(result.ok, true);
    assert.match(result.md!, /^\[Novo título\]\(https:\/\/example\.com\/GPT_\(modelo\)\)$/m);
  });
});

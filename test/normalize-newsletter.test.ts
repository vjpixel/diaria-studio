import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  splitConcatenatedHighlightHeader,
  splitConcatenatedSectionItem,
  normalizeNewsletter,
  addTrailingSpaces,
  extractEiaFrontmatter,
  resolveEiaFrontmatterBlock,
} from "../scripts/normalize-newsletter.ts";
import { writeEiaAnswerSidecar } from "../scripts/lib/eia-answer.ts";

describe("splitConcatenatedHighlightHeader", () => {
  it("quebra header + 3 títulos colados", () => {
    const line =
      "DESTAQUE 1 | GEOPOLÍTICA Brasil entra no jogo dos pacotes de IA dos EUA EUA oferecem pacote de IA ao Brasil para barrar China Pacotes de IA dos EUA colocam Brasil no centro";
    const r = splitConcatenatedHighlightHeader(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 4);
    assert.equal(r.lines[0], "DESTAQUE 1 | GEOPOLÍTICA");
    // Cada título tem comprimento razoável
    for (let i = 1; i <= 3; i++) {
      assert.ok(r.lines[i].length > 5);
      assert.ok(r.lines[i].length <= 70);
    }
  });

  it("header válido (apenas 1 linha) passa intacto", () => {
    const line = "DESTAQUE 2 | PRODUTO";
    const r = splitConcatenatedHighlightHeader(line);
    assert.equal(r.split, false);
    assert.deepEqual(r.lines, [line]);
  });

  it("linha que não é header de destaque passa intacta", () => {
    const line = "Algum título qualquer";
    const r = splitConcatenatedHighlightHeader(line);
    assert.equal(r.split, false);
  });
});

describe("splitConcatenatedSectionItem", () => {
  it("quebra item legacy com markdown link [url](url) no fim → ordem nova (#172)", () => {
    const line =
      "GPT-5.5 chega com Codex Superapp. OpenAI publica System Card e abre Codex como app standalone. [https://openai.com/index/introducing-gpt-5-5](https://openai.com/index/introducing-gpt-5-5)";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 3);
    assert.equal(r.lines[0], "GPT-5.5 chega com Codex Superapp.");
    // Pós-#172: URL na linha 2 (entre título e descrição)
    assert.equal(r.lines[1], "https://openai.com/index/introducing-gpt-5-5");
    assert.equal(
      r.lines[2],
      "OpenAI publica System Card e abre Codex como app standalone.",
    );
  });

  it("quebra item legacy com bare URL no fim → ordem nova (#172)", () => {
    const line =
      "Anthropic abre marketplace. Plataforma permite agentes negociarem. https://techcrunch.com/anthropic-marketplace";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 3);
    assert.equal(r.lines[0], "Anthropic abre marketplace.");
    assert.equal(r.lines[1], "https://techcrunch.com/anthropic-marketplace");
    assert.equal(r.lines[2], "Plataforma permite agentes negociarem.");
  });

  it("quebra item novo com URL no meio (#172) → ordem nova", () => {
    // LLM colapsou na ordem nova: título + URL + descrição em 1 linha
    const line =
      "GPT-5.5 chega com Codex Superapp https://openai.com/x OpenAI publica o System Card e abre Codex como app.";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 3);
    assert.equal(r.lines[0], "GPT-5.5 chega com Codex Superapp");
    assert.equal(r.lines[1], "https://openai.com/x");
    assert.equal(
      r.lines[2],
      "OpenAI publica o System Card e abre Codex como app.",
    );
  });

  it("sem ponto pra separar título/descrição: 2 linhas + warning", () => {
    const line =
      "Título sem pontuação clara https://example.com";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.equal(r.lines.length, 2);
    assert.ok(r.warning);
  });

  it("linha sem URL passa intacta", () => {
    const line = "Apenas um título normal sem link";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, false);
  });

  it("M2: 2 URLs distintas na mesma linha → recusa split + warning", () => {
    const line =
      "Título com https://first.com/a no meio. Descrição https://second.com/b com 2nd URL.";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, false);
    assert.ok(r.warning);
    assert.match(r.warning ?? "", /URLs distintas/);
    // Linha intocada
    assert.deepEqual(r.lines, [line]);
  });

  it("M2: markdown link [url](url) NÃO conta como 2 URLs (mesma URL)", () => {
    const line =
      "Título da matéria. Descrição em 1 frase. [https://x.com/a](https://x.com/a)";
    const r = splitConcatenatedSectionItem(line);
    assert.equal(r.split, true);
    assert.ok(!r.warning || !/URLs distintas/.test(r.warning));
  });
});

describe("normalizeNewsletter — integração", () => {
  it("normaliza newsletter com bug nos destaques + seção (caso real 260426)", () => {
    const input = [
      "DESTAQUE 1 | GEOPOLÍTICA Brasil entra no jogo dos pacotes de IA dos EUA EUA oferecem pacote de IA ao Brasil para barrar China Pacotes de IA dos EUA colocam Brasil no centro",
      "",
      "Parágrafo do destaque normal.",
      "",
      "https://example.com/destaque-1",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "GPT-5.5 chega. OpenAI publica System Card. https://openai.com/x",
      "",
      "DeepSeek v4 lançado. Modelo open-source. https://hf.co/deepseek",
      "",
      "---",
    ].join("\n");

    const r = normalizeNewsletter(input);
    assert.equal(r.report.highlight_headers_split, 1);
    assert.equal(r.report.section_items_split, 2);

    const lines = r.text.split("\n");
    // Header destaque agora em 4 linhas
    assert.equal(lines[0], "DESTAQUE 1 | GEOPOLÍTICA");
    assert.ok(lines[1].length > 5); // título 1
    assert.ok(lines[2].length > 5); // título 2
    assert.ok(lines[3].length > 5); // título 3

    // Itens de seção quebrados (URLs têm trailing spaces após addTrailingSpaces)
    assert.ok(r.text.includes("https://openai.com/x"));
    assert.ok(r.text.includes("https://hf.co/deepseek"));
  });

  it("newsletter já bem formatada (ordem nova #172) passa sem mudanças", () => {
    const input = [
      "DESTAQUE 1 | PRODUTO",
      "Título único",
      "https://example.com/x",
      "",
      "Corpo do destaque.",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item título",
      "https://example.com/item",
      "Item descrição.",
    ].join("\n");

    const r = normalizeNewsletter(input);
    assert.equal(r.report.highlight_headers_split, 0);
    assert.equal(r.report.section_items_split, 0);
    // addTrailingSpaces adiciona "  " em título de destaque e título+URL de seção
    const expectedWithSpaces = [
      "DESTAQUE 1 | PRODUTO",
      "Título único  ",
      "https://example.com/x",
      "",
      "Corpo do destaque.",
      "",
      "---",
      "",
      "LANÇAMENTOS",
      "Item título  ",
      "https://example.com/item  ",
      "Item descrição.",
    ].join("\n");
    assert.equal(r.text, expectedWithSpaces);
  });

  it("URL no meio do parágrafo de destaque NÃO é tocada", () => {
    const input = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "",
      "Corpo com link inline https://example.com/x no meio.",
      "",
      "---",
    ].join("\n");

    const r = normalizeNewsletter(input);
    // Não estamos em seção, então não tenta split
    assert.equal(r.report.section_items_split, 0);
    assert.ok(r.text.includes("link inline https://example.com/x no meio."));
  });
});

describe("addTrailingSpaces (#382)", () => {
  it("adiciona trailing spaces nos títulos do destaque (antes da URL)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Opção de título A",
      "Opção de título B",
      "Opção de título C",
      "https://example.com/artigo",
      "",
      "Corpo do artigo aqui.",
    ].join("\n");
    const result = addTrailingSpaces(md);
    const lines = result.split("\n");
    assert.ok(lines[1].endsWith("  "), "título A deve ter trailing spaces");
    assert.ok(lines[2].endsWith("  "), "título B deve ter trailing spaces");
    assert.ok(lines[3].endsWith("  "), "título C deve ter trailing spaces");
    assert.ok(!lines[4].endsWith("  "), "URL do destaque não deve ter trailing spaces");
    assert.ok(!lines[6].endsWith("  "), "corpo não deve ter trailing spaces");
  });

  it("adiciona trailing spaces em título e URL das seções secundárias", () => {
    const md = [
      "LANÇAMENTOS",
      "",
      "Título do lançamento",
      "https://example.com/lancamento",
      "Descrição do lançamento aqui.",
    ].join("\n");
    const result = addTrailingSpaces(md);
    const lines = result.split("\n");
    assert.ok(lines[2].endsWith("  "), "título de item deve ter trailing spaces");
    assert.ok(lines[3].endsWith("  "), "URL de item deve ter trailing spaces");
    assert.ok(!lines[4].endsWith("  "), "descrição não deve ter trailing spaces");
  });

  it("é idempotente — segunda execução não duplica espaços", () => {
    const md = "LANÇAMENTOS\n\nTítulo\nhttps://x.com\nDescrição.";
    const once = addTrailingSpaces(md);
    const twice = addTrailingSpaces(once);
    assert.equal(once, twice);
  });

  it("não adiciona trailing spaces em separadores e cabeçalhos", () => {
    const md = ["---", "LANÇAMENTOS", "PESQUISAS"].join("\n");
    const result = addTrailingSpaces(md);
    for (const line of result.split("\n")) {
      assert.ok(!line.endsWith("  "), `linha "${line}" não deveria ter trailing spaces`);
    }
  });

  it("múltiplos itens em seção — cada título e URL recebem trailing spaces", () => {
    const md = [
      "PESQUISAS",
      "",
      "Artigo 1",
      "https://a.com",
      "Descrição A.",
      "",
      "Artigo 2",
      "https://b.com",
      "Descrição B.",
    ].join("\n");
    const result = addTrailingSpaces(md);
    const lines = result.split("\n");
    assert.ok(lines[2].endsWith("  "), "título 1");
    assert.ok(lines[3].endsWith("  "), "url 1");
    assert.ok(!lines[4].endsWith("  "), "descrição 1");
    assert.ok(lines[6].endsWith("  "), "título 2");
    assert.ok(lines[7].endsWith("  "), "url 2");
    assert.ok(!lines[8].endsWith("  "), "descrição 2");
  });

  it("#691: linha 'https://x.com diz que Y' NÃO é tratada como URL line (isUrl estrito)", () => {
    // Antes: regex /^\s*\[?https?:\/\// classificava qualquer linha começando
    // com URL como URL — quebrava state machine quando LLM emitia URL inline
    // no body de um item.
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título escolhido",
      "https://example.com/destaque",
      "",
      "https://outra.com explica o impacto da decisão.",
      "",
      "---",
    ].join("\n");
    const result = addTrailingSpaces(md);
    const lines = result.split("\n");
    // URL real do destaque sem trailing
    assert.ok(!lines[2].endsWith("  "), "URL pura não tem trailing");
    // Linha "https://outra.com explica..." é body — não deve ganhar trailing
    // (não é URL line pura nem opção de título — body de destaque pós-URL).
    assert.equal(
      lines[4],
      "https://outra.com explica o impacto da decisão.",
      "linha com URL+texto fica intocada",
    );
  });

  it("#691: destaque sem URL emite warning (todas linhas viram títulos)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título A",
      "Título B",
      "Parágrafo body sem URL nenhuma.",
      "",
      "---",
    ].join("\n");
    const warnings: string[] = [];
    addTrailingSpaces(md, warnings);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sem URL/);
    assert.match(warnings[0], /DESTAQUE 1/);
  });

  it("#691: warning também emitido no EOF se destaque sem URL termina o arquivo", () => {
    const md = [
      "DESTAQUE 3 | MERCADO",
      "Único título",
      "Body sem URL.",
    ].join("\n");
    const warnings: string[] = [];
    addTrailingSpaces(md, warnings);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /DESTAQUE 3/);
  });

  it("#599: inline links em destaques recebem trailing spaces; body não (sem blanks)", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "[Opção 1 do título](https://example.com/x)",
      "[Opção 2 do título](https://example.com/x)",
      "[Opção 3 do título](https://example.com/x)",
      "Parágrafo do corpo, primeiro.",
      "Outro parágrafo do body.",
    ].join("\n");
    const result = addTrailingSpaces(md);
    const lines = result.split("\n");
    assert.ok(lines[1].endsWith("  "), "opção 1 deve ter trailing");
    assert.ok(lines[2].endsWith("  "), "opção 2 deve ter trailing");
    assert.ok(lines[3].endsWith("  "), "opção 3 deve ter trailing");
    assert.ok(!lines[4].endsWith("  "), "body 1 não deve ter trailing");
    assert.ok(!lines[5].endsWith("  "), "body 2 não deve ter trailing");
  });

  it("#599: body após blank line pós-inline-link NÃO recebe trailing (regressão bug #1 review)", () => {
    // Formato #245: blank lines entre todos os elementos. Bug original:
    // lookup no array out[out.length-1] falhava quando blank entrava no array,
    // fazendo body ganhar "  ". Fix: state variable highlightInlineLinkSeen.
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "",
      "[Opção 1 do título](https://example.com/x)",
      "",
      "[Opção 2 do título](https://example.com/x)",
      "",
      "[Opção 3 do título](https://example.com/x)",
      "",
      "Parágrafo do corpo que deve aparecer sem trailing.",
      "",
      "Segundo parágrafo do corpo.",
    ].join("\n");
    const result = addTrailingSpaces(md);
    const lines = result.split("\n");
    // Títulos (inline links) têm trailing
    assert.ok(lines[2].endsWith("  "), "opção 1 deve ter trailing");
    assert.ok(lines[4].endsWith("  "), "opção 2 deve ter trailing");
    assert.ok(lines[6].endsWith("  "), "opção 3 deve ter trailing");
    // Body NÃO tem trailing — mesmo com blank lines entre eles
    assert.ok(!lines[8].endsWith("  "), "corpo 1 não deve ter trailing");
    assert.ok(!lines[10].endsWith("  "), "corpo 2 não deve ter trailing");
  });

  it("#599: inline link em seção secundária recebe trailing; descrição não", () => {
    const md = [
      "LANÇAMENTOS",
      "",
      "[Título do item](https://example.com/x)",
      "Descrição em 1 linha.",
    ].join("\n");
    const result = addTrailingSpaces(md);
    const lines = result.split("\n");
    assert.ok(lines[2].endsWith("  "), "inline link de item deve ter trailing");
    assert.ok(!lines[3].endsWith("  "), "descrição não deve ter trailing");
  });

  it("#691: destaque com URL não emite warning", () => {
    const md = [
      "DESTAQUE 1 | PRODUTO",
      "Título",
      "https://x.com/y",
      "",
      "Body OK.",
      "",
      "---",
    ].join("\n");
    const warnings: string[] = [];
    addTrailingSpaces(md, warnings);
    assert.equal(warnings.length, 0);
  });
});

describe("extractEiaFrontmatter (#744)", () => {
  const TMP = "test/_tmp_eia_fm";

  it("extrai eia_answer de frontmatter mapeado (A/B)", () => {
    const dir = join(TMP, "mapped");
    mkdirSync(dir, { recursive: true });
    const eiaPath = join(dir, "01-eia.md");
    writeFileSync(eiaPath, "---\neia_answer:\n  A: real\n  B: ia\n---\n\nÉ IA?\n");
    const fm = extractEiaFrontmatter(eiaPath);
    assert.ok(fm !== null, "deve retornar o bloco");
    assert.match(fm!, /eia_answer/);
    rmSync(dir, { recursive: true });
  });

  it("extrai eia_answer de frontmatter escalar", () => {
    const dir = join(TMP, "scalar");
    mkdirSync(dir, { recursive: true });
    const eiaPath = join(dir, "01-eia.md");
    writeFileSync(eiaPath, "---\neia_answer: ia\n---\n\nÉ IA?\n");
    const fm = extractEiaFrontmatter(eiaPath);
    assert.ok(fm !== null);
    assert.match(fm!, /eia_answer: ia/);
    rmSync(dir, { recursive: true });
  });

  it("retorna null quando arquivo não existe", () => {
    const fm = extractEiaFrontmatter("test/_tmp_eia_fm/nao-existe/01-eia.md");
    assert.equal(fm, null);
  });

  it("retorna null quando não tem eia_answer no frontmatter", () => {
    const dir = join(TMP, "no_eia");
    mkdirSync(dir, { recursive: true });
    const eiaPath = join(dir, "01-eia.md");
    writeFileSync(eiaPath, "---\noutro_campo: valor\n---\n\nÉ IA?\n");
    const fm = extractEiaFrontmatter(eiaPath);
    assert.equal(fm, null);
    rmSync(dir, { recursive: true });
  });

  it("retorna null quando não tem frontmatter", () => {
    const dir = join(TMP, "no_fm");
    mkdirSync(dir, { recursive: true });
    const eiaPath = join(dir, "01-eia.md");
    writeFileSync(eiaPath, "É IA?\n\nTexto sem frontmatter.");
    const fm = extractEiaFrontmatter(eiaPath);
    assert.equal(fm, null);
    rmSync(dir, { recursive: true });
  });
});

describe("resolveEiaFrontmatterBlock (#927)", () => {
  const TMP = "test/_tmp_eia_resolve";

  it("usa sidecar quando disponível", () => {
    const dir = join(TMP, "sidecar");
    mkdirSync(dir, { recursive: true });
    writeEiaAnswerSidecar(dir, "260507", { A: "ia", B: "real" });
    const block = resolveEiaFrontmatterBlock(dir);
    assert.ok(block);
    assert.match(block!, /eia_answer:/);
    assert.match(block!, /A: ia/);
    assert.match(block!, /B: real/);
    rmSync(dir, { recursive: true });
  });

  it("Drive round-trip: 01-eia.md sem frontmatter, sidecar resgata gabarito", () => {
    const dir = join(TMP, "drive_strip");
    mkdirSync(dir, { recursive: true });
    // Frontmatter strippado
    writeFileSync(join(dir, "01-eia.md"), "É IA?\n\nFoto: Linha de crédito");
    writeEiaAnswerSidecar(dir, "260507", { A: "real", B: "ia" });
    const block = resolveEiaFrontmatterBlock(dir);
    assert.ok(block);
    assert.match(block!, /A: real/);
    assert.match(block!, /B: ia/);
    rmSync(dir, { recursive: true });
  });

  it("falls back pra frontmatter quando sidecar ausente", () => {
    const dir = join(TMP, "fm_only");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "01-eia.md"),
      "---\neia_answer:\n  A: real\n  B: ia\n---\n\nÉ IA?\n",
    );
    const block = resolveEiaFrontmatterBlock(dir);
    assert.ok(block);
    assert.match(block!, /eia_answer/);
    rmSync(dir, { recursive: true });
  });

  it("retorna null quando nada disponível", () => {
    const dir = join(TMP, "empty");
    mkdirSync(dir, { recursive: true });
    assert.equal(resolveEiaFrontmatterBlock(dir), null);
    rmSync(dir, { recursive: true });
  });
});

describe("CLI main: #1069 — não injeta eia_answer frontmatter no output", () => {
  const TMP = join(process.env.TEMP ?? "/tmp", "normalize-cli-1069");

  it("output do CLI não contém ---\neia_answer:\n no topo", () => {
    const dir = join(TMP, "edition");
    mkdirSync(dir, { recursive: true });
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    const inPath = join(internalDir, "input.md");
    const outPath = join(internalDir, "output.md");
    writeFileSync(inPath, "DESTAQUE 1 | LANÇAMENTO\nTexto.\n", "utf8");
    // Cria sidecar (que ANTES disparava injeção do frontmatter no output)
    writeEiaAnswerSidecar(dir, "260999", { A: "real", B: "ia" });

    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "normalize-newsletter.ts");
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "--in", inPath, "--out", outPath],
      { cwd: projectRoot, encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);

    const out = readFileSync(outPath, "utf8");
    assert.ok(!/^---\s*\neia_answer:/m.test(out), `output não deve ter eia_answer frontmatter — got:\n${out.slice(0, 200)}`);
    rmSync(dir, { recursive: true, force: true });
  });
});

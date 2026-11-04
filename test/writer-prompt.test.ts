/**
 * test/writer-prompt.test.ts (#1208, #2377)
 *
 * Grep tests pra garantir que instruções críticas estão presentes em
 * `.claude/agents/writer.md` e `.claude/agents/writer-destaque.md`.
 * Não testa comportamento (LLM); testa presença de strings que o
 * prompt-tuning depende.
 *
 * Equivalente a snapshot test do orchestrator-prompt.test.ts mas com
 * focus em invariantes editoriais que merecem teste de regressão.
 *
 * #2377 (root cause fix): checks atualizados para validar que ambos os agents
 * documentam CORRETAMENTE o fluxo do ERRO INTENCIONAL:
 *   - writer emite apenas placeholder genérico (nunca o reveal)
 *   - EDITOR preenche a declaração de primeira pessoa no frontmatter/prosa
 *   - lint do Stage 4 valida que a declaração do editor é específica
 * O fix anterior (PR inicial de #2377) documentava o reveal como se fosse
 * responsabilidade do writer — estava INCORRETO. O writer nunca escreve
 * "Na última edição, escrevi que…" porque esse texto é de uma edição futura,
 * composto pelo script a partir do que o EDITOR escreveu nesta edição.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DESTAQUE_MIN_CHARS, DESTAQUE_MAX_CHARS } from "../scripts/lib/lint-checks/destaque-chars.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRITER_MD = resolve(ROOT, ".claude/agents/writer.md");
const WRITER_DESTAQUE_MD = resolve(ROOT, ".claude/agents/writer-destaque.md");

describe("writer.md invariants (#1208)", () => {
  const content = readFileSync(WRITER_MD, "utf8");

  it("contém instrução explícita de char count por destaque", () => {
    // janela única desde #6061 (de novo desde #12218): todos os destaques 900-1000
    assert.match(content, /D1\/D2\/D3 todos entre 900-1000/);
    assert.ok(!/1000-1200/.test(content), "janela assimétrica antiga do D1 não deve mais existir no prompt");
  });

  it("janela única nos 3 destaques: lint e prompts sem janela maior pro D1 (regressão #12218)", () => {
    // A #11321 deu ao D1 1100-1200; a #12218 desfez a pedido do editor.
    assert.deepEqual([DESTAQUE_MIN_CHARS[1], DESTAQUE_MIN_CHARS[2], DESTAQUE_MIN_CHARS[3]], [900, 900, 900]);
    assert.deepEqual([DESTAQUE_MAX_CHARS[1], DESTAQUE_MAX_CHARS[2], DESTAQUE_MAX_CHARS[3]], [1000, 1000, 1000]);
    const wd = readFileSync(WRITER_DESTAQUE_MD, "utf8");
    assert.match(wd, /\*\*D1, D2 e D3\*\* entre \*\*900-1000 chars\*\*/);
    assert.match(wd, /D1\/D2\/D3 → todos 900-1000/);
    const rules = readFileSync(resolve(ROOT, "context/editorial-rules.md"), "utf8");
    const stage2 = readFileSync(resolve(ROOT, ".claude/agents/orchestrator-stage-2.md"), "utf8");
    for (const [name, text] of [
      ["writer.md", content],
      ["writer-destaque.md", wd],
      ["editorial-rules.md", rules],
      ["orchestrator-stage-2.md", stage2],
    ] as const) {
      assert.ok(!/D1 1100[-–]1200|D1 ~?1100|D1 ?≥ ?1100|janela por posição/.test(text), `${name} ainda carrega a janela maior do D1`);
    }
  });

  it("writer-destaque.md: alvo recomendado de corpo + why cabe na janela do lint (#11520)", () => {
    // O alvo "mire corpo entre ~X-Y, com why ~A-B" somado nas pontas tem que
    // cair dentro de DESTAQUE_MIN/MAX_CHARS em qualquer posição.
    const wd = readFileSync(WRITER_DESTAQUE_MD, "utf8");
    const m = wd.match(
      /mire corpo entre \*\*~(\d+)-(\d+) chars\*\*, com "Por que isso importa" perto do meio da janela \(~(\d+)-(\d+) chars\)/,
    );
    assert.ok(m, "alvo recomendado de corpo/why não encontrado no writer-destaque.md");
    const [lo, hi, whyLo, whyHi] = m.slice(1).map(Number);
    for (const pos of [1, 2, 3] as const) {
      assert.ok(lo + whyLo >= DESTAQUE_MIN_CHARS[pos], `D${pos}: ${lo}+${whyLo} < ${DESTAQUE_MIN_CHARS[pos]}`);
      assert.ok(hi + whyHi <= DESTAQUE_MAX_CHARS[pos], `D${pos}: ${hi}+${whyHi} > ${DESTAQUE_MAX_CHARS[pos]}`);
    }
  });

  it("contém anti-pattern reference pra D2/D3 anêmicos (#1208)", () => {
    // D2/D3 saiam sistematicamente abaixo de 900 chars em 260517
    assert.match(content, /D2 e D3.*erro comum|sistematicamente.*900/i,
      "writer prompt deve documentar o anti-pattern observado em 260517");
  });

  it("contém estrutura sugerida pra atingir min-chars", () => {
    // Prompt sugere "3 parágrafos + why expandido" pra atingir o min
    assert.match(content, /3 parágrafos|estrutur[ea] deliberadamente/i,
      "writer prompt deve sugerir estrutura pra atingir min-chars");
  });

  it("'Por que isso importa' tem instrução de mínimo 2 frases (#1208)", () => {
    assert.match(content, /M[íi]nimo 2 frases|2 frases/i,
      "writer prompt deve exigir mínimo 2 frases em 'Por que isso importa'");
  });
});

// #2377 (root cause fix) — ERRO INTENCIONAL: writer emite placeholder, EDITOR escreve a declaração
describe("ERRO INTENCIONAL — writer emite placeholder, EDITOR escreve declaração (#2377)", () => {
  const writerContent = readFileSync(WRITER_MD, "utf8");
  const writerDestaqueContent = readFileSync(WRITER_DESTAQUE_MD, "utf8");

  // writer.md deve deixar claro que o writer emite APENAS placeholder
  it("writer.md documenta que writer emite só placeholder (não o reveal)", () => {
    assert.match(
      writerContent,
      /placeholder|só precisa garantir que a seção existe/i,
      "writer.md deve documentar que writer emite apenas placeholder no bloco ERRO INTENCIONAL",
    );
  });

  // writer.md deve deixar claro que o EDITOR (não writer) escreve a declaração de primeira pessoa
  it("writer.md documenta responsabilidade do EDITOR para a declaração de primeira pessoa", () => {
    assert.match(
      writerContent,
      /EDITOR|editor preenche|declaração de primeira pessoa/i,
      "writer.md deve atribuir ao EDITOR a responsabilidade de preencher a declaração de primeira pessoa",
    );
  });

  // writer.md deve mencionar o lint que valida isso
  it("writer.md menciona lint Stage 4 que valida a declaração do editor", () => {
    assert.match(
      writerContent,
      /lint.*Stage 4|narrative-not-generic-placeholder/i,
      "writer.md deve mencionar o lint do Stage 4 que valida a declaração real do editor",
    );
  });

  // writer-destaque.md: writer emite placeholder, EDITOR escreve a declaração
  it("writer-destaque.md documenta que writer emite só placeholder (não o reveal)", () => {
    assert.match(
      writerDestaqueContent,
      /placeholder|só.*placeholder|emite apenas o placeholder/i,
      "writer-destaque.md deve documentar que writer emite apenas placeholder",
    );
  });

  it("writer-destaque.md documenta responsabilidade do EDITOR para a declaração", () => {
    assert.match(
      writerDestaqueContent,
      /EDITOR|editor preenche|declaração de primeira pessoa/i,
      "writer-destaque.md deve atribuir ao EDITOR a responsabilidade de preencher a declaração",
    );
  });

  // writer.md não deve instruir o writer a escrever o reveal como se fosse tarefa dele
  it("writer.md não contém instrução incorreta de writer escrever o reveal diretamente", () => {
    // O texto "Você (writer) escreve o reveal" nunca deve aparecer
    // Presença de "escrevi que" é OK se for no contexto do EDITOR, não como instrução direta ao writer
    // Verificar que não tem instrução no imperativo para o writer escrever o reveal
    assert.doesNotMatch(
      writerContent,
      /Você deve escrever.*Na última edição|você.*escreve.*reveal/i,
      "writer.md não deve instruir o writer a escrever o reveal da edição anterior",
    );
  });
});

// #2657 — safe-area do crop 1:1 documentada no agent
describe("writer-destaque.md safe-area invariant (#2657)", () => {
  const writerDestaqueContent = readFileSync(WRITER_DESTAQUE_MD, "utf8");

  it("menciona instrução de safe-area / terço central para crop 1:1", () => {
    assert.match(
      writerDestaqueContent,
      /safe.?area|terço central|agrup.*no terço|central.*crop/i,
      "writer-destaque.md deve mencionar safe-area para múltiplos sujeitos no crop 1:1",
    );
  });
});

describe("nunca especular além do summary — sem WebFetch por design (#4000)", () => {
  // writer/writer-destaque não têm WebFetch (design: pesquisa já aconteceu no
  // Stage 1). O incidente 260724 mostrou que, sem uma regra explícita, o
  // writer preenche lacunas do summary com suposição hedged em vez de omitir.
  for (const [nome, path] of [
    ["writer.md", WRITER_MD],
    ["writer-destaque.md", WRITER_DESTAQUE_MD],
  ] as const) {
    const content = readFileSync(path, "utf8");

    it(`${nome} não declara WebFetch no frontmatter tools`, () => {
      const toolsLine = content.match(/^tools:\s*(.+)$/m)?.[1] ?? "";
      assert.doesNotMatch(
        toolsLine,
        /WebFetch/,
        `${nome} não deve ter WebFetch no frontmatter — pesquisa já aconteceu no Stage 1 (#4000)`,
      );
    });

    it(`${nome} cita o #4000 e instrui a omitir em vez de especular`, () => {
      assert.match(content, /#4000/, `${nome} deve citar o #4000`);
      assert.match(
        content,
        /omit[ae]/i,
        `${nome} deve instruir a omitir a afirmação quando o summary não cobrir o ângulo`,
      );
    });

    it(`${nome} documenta o incidente real (Health in ChatGPT / rivais) como anti-exemplo`, () => {
      assert.match(
        content,
        /Health in ChatGPT/,
        `${nome} deve referenciar o incidente real da edição 260724`,
      );
    });
  }
});

describe("fidelidade de itens secundários (#5663)", () => {
  for (const [nome, path] of [
    ["writer.md", WRITER_MD],
    ["writer-destaque.md", WRITER_DESTAQUE_MD],
  ] as const) {
    it(`${nome} exige resumo representativo, citações fechadas e sem reticência fabricada`, () => {
      const content = readFileSync(path, "utf8");
      assert.match(content, /#5663/);
      assert.match(content, /fato central.*summary|summary.*fato central/i);
      assert.match(content, /cita[cç][aã]o.*meio|aspas fechadas/i);
      assert.match(content, /fabrique.*retic|fabrique.*`\.\.\.`|reticências/);
      assert.match(content, /secondary-item-coherence/);
    });
  }
});

describe("caveat de nomes de produto/modelo — Gemini Nano ≠ Nano Banana (#2685)", () => {
  // Ambos os writers (default × destaque) devem carregar o guard, senão vira gap
  // silencioso em prod (padrão writer-agents-keep-in-sync).
  for (const [nome, path] of [
    ["writer.md", WRITER_MD],
    ["writer-destaque.md", WRITER_DESTAQUE_MD],
  ] as const) {
    const content = readFileSync(path, "utf8");
    it(`${nome} documenta o caveat de não-fundir produtos de nome parecido`, () => {
      assert.match(content, /#2685/, `${nome} deve citar o #2685`);
      assert.match(content, /Gemini Nano/, `${nome} deve nomear Gemini Nano`);
      assert.match(content, /Nano Banana/, `${nome} deve nomear Nano Banana`);
      assert.match(
        content,
        /on-device|no aparelho|offline|local/i,
        `${nome} deve alertar contra alucinar processamento on-device/offline`,
      );
    });
  }
});

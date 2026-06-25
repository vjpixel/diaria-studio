/**
 * lint-newsletter-md-secondary-items-have-summary.test.ts (#2545)
 *
 * Regressão: item de seção secundária (LANÇAMENTOS/RADAR/USE MELHOR) sem
 * descrição deve disparar o check `--check secondary-items-have-summary`.
 *
 * Caso real (260625): item de LANÇAMENTOS `We got local models to triage the
 * OpenClaw repo for FREE!` (https://huggingface.co/blog/local-models-pr-triage)
 * saiu sem descrição — cache-miss no enrich não persistiu og:description e o
 * lint pré-gate era inexistente. Editor pegou no Stage 4 manual.
 *
 * Testa o helper puro (`checkSecondaryItemsHaveSummary`) incluindo o CENÁRIO
 * REAL reportado na issue.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkSecondaryItemsHaveSummary } from "../scripts/lint-newsletter-md.ts";

// ---------------------------------------------------------------------------
// Fixtures helpers
// ---------------------------------------------------------------------------

function lancamentoSection(items: string): string {
  return `**🚀 LANÇAMENTOS**\n\n${items}\n---\n`;
}

function radarSection(items: string): string {
  return `**📡 RADAR**\n\n${items}\n---\n`;
}

function useMelhorSection(items: string): string {
  return `**🛠️ USE MELHOR**\n\n${items}\n---\n`;
}

// ---------------------------------------------------------------------------
// Cenário REAL (#2545): LANÇAMENTOS com item sem descrição
// ---------------------------------------------------------------------------

describe("checkSecondaryItemsHaveSummary — CENÁRIO REAL #2545", () => {
  it("acusa item LANÇAMENTOS com título pelado (caso OpenClaw 260625)", () => {
    // Reproduz o caso real: item com URL real, título real, SEM descrição
    const md = lancamentoSection(
      `**[We got local models to triage the OpenClaw repo for FREE!](https://huggingface.co/blog/local-models-pr-triage)**\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].section, "🚀 LANÇAMENTOS");
    assert.ok(result.errors[0].titleExcerpt.includes("OpenClaw"));
  });

  it("passa quando o item LANÇAMENTOS tem descrição na linha seguinte", () => {
    const md = lancamentoSection(
      `**[We got local models to triage the OpenClaw repo for FREE!](https://huggingface.co/blog/local-models-pr-triage)**\nTriagem automática de pull requests open-source usando modelos locais Llama.\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// LANÇAMENTOS
// ---------------------------------------------------------------------------

describe("checkSecondaryItemsHaveSummary — LANÇAMENTOS", () => {
  it("ok: item com descrição na linha seguinte", () => {
    const md = lancamentoSection(
      `**[Ferramenta X](https://x.com/release)**\nLançamento da versão 2.0 com suporte a multimodal.\n`,
    );
    assert.ok(checkSecondaryItemsHaveSummary(md).ok);
  });

  it("erro: item sem descrição (próxima linha vazia, depois EOF)", () => {
    const md = lancamentoSection(
      `**[Ferramenta X](https://x.com/release)**\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].titleExcerpt.includes("Ferramenta X"));
  });

  it("erro: dois itens, apenas o segundo sem descrição", () => {
    const md = lancamentoSection(
      `**[Ferramenta A](https://a.com)**\nDescrição da ferramenta A.\n\n**[Ferramenta B](https://b.com)**\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].titleExcerpt.includes("Ferramenta B"));
  });

  it("erro: dois itens consecutivos sem linha de descrição entre eles", () => {
    const md = lancamentoSection(
      `**[Ferramenta A](https://a.com)**\n**[Ferramenta B](https://b.com)**\nDescrição B.\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].titleExcerpt.includes("Ferramenta A"));
  });
});

// ---------------------------------------------------------------------------
// RADAR
// ---------------------------------------------------------------------------

describe("checkSecondaryItemsHaveSummary — RADAR", () => {
  it("ok: item RADAR com descrição", () => {
    const md = radarSection(
      `**[Artigo de pesquisa](https://arxiv.org/abs/1234)**\nPesquisadores demonstram novo método de compressão de LLMs.\n`,
    );
    assert.ok(checkSecondaryItemsHaveSummary(md).ok);
  });

  it("erro: item RADAR sem descrição", () => {
    const md = radarSection(
      `**[Artigo de pesquisa](https://arxiv.org/abs/1234)**\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].section.includes("RADAR"));
  });
});

// ---------------------------------------------------------------------------
// USE MELHOR — formato inline (link + desc na mesma linha)
// ---------------------------------------------------------------------------

describe("checkSecondaryItemsHaveSummary — USE MELHOR inline", () => {
  it("ok: formato canônico inline (link + descrição na mesma linha)", () => {
    const md = useMelhorSection(
      `**[Guia de prompts](https://guide.com)** Referência prática de prompts para LLMs (15 min)\n`,
    );
    assert.ok(checkSecondaryItemsHaveSummary(md).ok);
  });

  it("erro: USE MELHOR com título pelado (link sem descrição inline e sem próxima linha)", () => {
    const md = useMelhorSection(
      `**[Guia de prompts](https://guide.com)**\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Boundary cases: não pegar seções fora do escopo
// ---------------------------------------------------------------------------

describe("checkSecondaryItemsHaveSummary — boundary cases", () => {
  it("não acusa DESTAQUE (mesmo sem linha após link)", () => {
    const md = `DESTAQUE 1\n\n**[Artigo principal](https://main.com)**\n\n`;
    const result = checkSecondaryItemsHaveSummary(md);
    assert.ok(result.ok); // DESTAQUEs não são seções secundárias
  });

  it("não bleed entre seções: erro em LANÇAMENTOS não contamina RADAR seguinte", () => {
    const md =
      `**🚀 LANÇAMENTOS**\n\n**[Lancamento A](https://a.com)**\nDescrição A.\n\n---\n\n` +
      `**📡 RADAR**\n\n**[Artigo B](https://b.com)**\nDescrição B.\n\n---\n`;
    const result = checkSecondaryItemsHaveSummary(md);
    assert.ok(result.ok);
  });

  it("separador `---` encerra a seção (item após `---` não é auditado como da seção anterior)", () => {
    const md =
      `**🚀 LANÇAMENTOS**\n\n**[L](https://l.com)**\nDescrição L.\n\n---\n\nTexto livre sem link\n`;
    assert.ok(checkSecondaryItemsHaveSummary(md).ok);
  });

  it("vários itens, todos com descrição, retorna ok=true com errors=[]", () => {
    const md =
      lancamentoSection(
        `**[A](https://a.com)**\nDescrição A.\n\n**[B](https://b.com)**\nDescrição B.\n`,
      ) +
      radarSection(
        `**[C](https://c.com)**\nDescrição C.\n`,
      );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.ok(result.ok);
    assert.equal(result.errors.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Regressão #2579: descrição que começa com link markdown não é falso-positivo
// ---------------------------------------------------------------------------

describe("checkSecondaryItemsHaveSummary — regressão #2579 (descrição começa com link)", () => {
  it("ok: descrição inicia com [Fonte](url) + texto — não é título pelado", () => {
    // A linha de descrição começa com um link markdown, mas tem texto após ele.
    // O lint NÃO deve acusar — é uma descrição válida, não um item sem descrição.
    const md = lancamentoSection(
      `**[Ferramenta Nova](https://nova.com)**\n[The Verge](https://theverge.com/x) explica que a ferramenta automatiza deploys com IA.\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, true, "descrição iniciando com link não deve acusar falso-positivo");
    assert.equal(result.errors.length, 0);
  });

  it("ok: descrição RADAR inicia com link markdown + texto longo", () => {
    const md = radarSection(
      `**[Pesquisa sobre LLMs](https://arxiv.org/abs/9999)**\n[MIT Technology Review](https://technologyreview.com/x) analisa os resultados e aponta limitações.\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("erro: item sem descrição ainda é detectado (não-regressão do #2545)", () => {
    // Item realmente pelado (sem nenhuma linha de descrição) AINDA deve acusar.
    const md = lancamentoSection(
      `**[Ferramenta Pelada](https://pelada.com)**\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, false, "item sem descrição deve continuar sendo detectado");
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].titleExcerpt.includes("Ferramenta Pelada"));
  });

  it("erro: item pelado seguido de USE MELHOR canonical ainda detectado", () => {
    // Um item pelado (link-only) seguido de outro item USE MELHOR bolded+inline
    // deve ser flagged — o segundo item NÃO é a descrição do primeiro.
    const md = useMelhorSection(
      `**[Guia A](https://a.com)**\n**[Guia B](https://b.com)** Descrição B aqui.\n`,
    );
    const result = checkSecondaryItemsHaveSummary(md);
    assert.equal(result.ok, false, "item pelado antes de outro item inline deve acusar");
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].titleExcerpt.includes("Guia A"));
  });
});

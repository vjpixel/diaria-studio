/**
 * test/render-html-with-warnings-4687.test.ts (#4687, achado do fleet review
 * sobre o #4673)
 *
 * `collectedRenderWarnings` (scripts/lib/newsletter-render-html.ts) é estado
 * MUTÁVEL DE PROCESSO, resetado no início de CADA `renderHTML()`. Seguro em
 * processos one-shot (CLI); armadilha em processo LONGO (`Diaria-Studio-
 * Server`) SE um dia um caller ler `getRenderWarnings()` depois de um
 * `await` — nesse intervalo, outra chamada concorrente de `renderHTML()`
 * pode resetar o coletor por baixo do primeiro caller.
 *
 * `renderHTMLWithWarnings()` fecha essa lacuna: lê o coletor SINCRONAMENTE
 * (sem await entre a chamada de `renderHTML()` e a leitura) e devolve uma
 * cópia defensiva — o resultado retornado nunca muda sob o caller mesmo que
 * outra chamada de `renderHTML()`/`renderHTMLWithWarnings()` rode logo em
 * seguida no mesmo processo (simulação do cenário de 2 previews do Studio
 * interleavados, sem precisar de um servidor HTTP real no teste).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHTML, renderHTMLWithWarnings, getRenderWarnings } from "../scripts/lib/newsletter-render-html.ts";
import type { NewsletterContent, RenderDestaque } from "../scripts/lib/newsletter-parse.ts";

const EDITION = "260801";

// #5817: `renderConviteAmigo` (chamado incondicionalmente por `renderHTML`)
// lê `data/snippets/convite-amigo-whatsapp.md` via `readSnippetFile` — nunca
// a `data/` real do editor (gitignored, ausente em CI/clone fresco). Sem
// fixture, toda chamada de `renderHTML()` neste arquivo dispararia
// `convite_amigo_snippet_missing`, poluindo os testes que existiam antes do
// #5794/#5817 e que verificam warnings NÃO relacionados a este bloco. Mesmo
// padrão de fixture de `test/convite-amigo-whatsapp-5794.test.ts`.
const SNIPPETS_FIXTURE_ROOT = mkdtempSync(join(tmpdir(), "render-html-warnings-snippet-fixture-"));
mkdirSync(join(SNIPPETS_FIXTURE_ROOT, "data", "snippets"), { recursive: true });
writeFileSync(
  join(SNIPPETS_FIXTURE_ROOT, "data", "snippets", "convite-amigo-whatsapp.md"),
  "Conhece alguém que ia gostar de receber esta newsletter?\n\n[Convide pelo WhatsApp →](https://diar.ia.br/)\n",
  "utf8",
);
const OPTS = { rootDir: SNIPPETS_FIXTURE_ROOT };

after(() => {
  rmSync(SNIPPETS_FIXTURE_ROOT, { recursive: true, force: true });
});

function makeD1(overrides: Partial<RenderDestaque> = {}): RenderDestaque {
  return {
    n: 1,
    category: "🚀 LANÇAMENTO",
    emoji: "🚀",
    title: "Título D1",
    body: "Corpo do destaque.",
    why: "Por que importa.",
    url: "https://example.com/d1",
    ...overrides,
  };
}

/** Dispara `whatsapp_share_no_d1` (destaques vazio → renderWhatsappShare sem D1).
 * #5999: `encerrar` precisa estar presente — sem bloco "Para encerrar", o
 * bloco "Convide um amigo" cai no fallback standalone e emite
 * `convite_amigo_orphan_no_encerrar`, um 2º evento que não é o que estes
 * testes verificam. */
const contentWithWarning: NewsletterContent = {
  title: "Edição teste",
  subtitle: "Teste",
  coverImage: "04-d1-2x1.jpg",
  destaques: [],
  eia: { credit: "", imageA: "01-eia-A.jpg", imageB: "01-eia-B.jpg", edition: EDITION },
  sections: [],
  encerrar: "Apoie a curadoria.",
};

/** Edição normal — sem eventos de conteúdo perdido. */
const contentClean: NewsletterContent = {
  ...contentWithWarning,
  destaques: [makeD1()],
};

describe("renderHTMLWithWarnings (#4687)", () => {
  it("retorna { html, warnings } com os eventos desta chamada", () => {
    const { html, warnings } = renderHTMLWithWarnings(contentWithWarning, OPTS);
    assert.ok(html.length > 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].event, "whatsapp_share_no_d1");
  });

  it("edição limpa → warnings: []", () => {
    const { warnings } = renderHTMLWithWarnings(contentClean, OPTS);
    assert.deepEqual(warnings, []);
  });

  it("2 chamadas sequenciais (simula requests concorrentes do Studio) não misturam warnings — cada resultado retornado permanece correto mesmo depois da 2ª chamada resetar o coletor", () => {
    const resultA = renderHTMLWithWarnings(contentWithWarning, OPTS); // dispara whatsapp_share_no_d1
    // Simula uma 2ª "request" que roda ANTES do caller de A ler
    // getRenderWarnings() separadamente — é exatamente o cenário perigoso do
    // padrão antigo (renderHTML() + getRenderWarnings() depois de um await).
    const resultB = renderHTMLWithWarnings(contentClean, OPTS); // sem warnings

    // O resultado JÁ RETORNADO de A não muda por causa da chamada B —
    // renderHTMLWithWarnings copiou o array antes de B rodar.
    assert.equal(resultA.warnings.length, 1, "resultado de A não deve ser afetado pela chamada B subsequente");
    assert.equal(resultA.warnings[0].event, "whatsapp_share_no_d1");
    assert.deepEqual(resultB.warnings, []);

    // Contraste explícito: se um caller tivesse usado o padrão inseguro
    // (renderHTML() + getRenderWarnings() separado) e lido DEPOIS de B rodar,
    // veria os warnings de B (ou nenhum), não os de A — a prova viva da
    // armadilha que renderHTMLWithWarnings evita.
    renderHTML(contentWithWarning, OPTS); // volta a popular o coletor global
    renderHTML(contentClean, OPTS); // último a rodar reseta pra warnings: []
    assert.deepEqual(getRenderWarnings(), [], "getRenderWarnings() cru reflete só a ÚLTIMA chamada no processo — por isso é perigoso ler depois de um await");
  });

  it("array retornado é cópia — mutar não afeta o coletor interno nem chamadas seguintes", () => {
    const { warnings } = renderHTMLWithWarnings(contentWithWarning, OPTS);
    warnings.push({ event: "whatsapp_share_no_d1", edition: "999999" });
    const { warnings: warningsClean } = renderHTMLWithWarnings(contentClean, OPTS);
    assert.deepEqual(warningsClean, [], "mutação do array anterior não deve vazar pra próxima chamada");
  });
});

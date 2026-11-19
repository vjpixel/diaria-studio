/**
 * test/clarice-pending-footer-credit-13711.test.ts (#13711)
 *
 * Regressão da edição 261119: a Clarice ficou fora (marcador
 * `_internal/02-clarice-pending.json` ativo até o envio) e o rodapé PARA
 * ENCERRAR saiu afirmando "A revisão foi feita pelo MCP da Clarice (...)".
 *
 * Cobre:
 *   1. `omitClariceReviewCredit` tira a oração (com o link de afiliado) no
 *      texto real do snippet, nas variantes de pontuação, e é idempotente.
 *   2. `extractContent` + render: marcador ativo → frase e link fora do HTML;
 *      sem marcador → frase presente. `02-reviewed.md` nunca é reescrito.
 *   3. Invariante `clarice-pending-footer-credit` (Stage 4, warning): avisa só
 *      com o marcador ativo E a frase no rodapé.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extractContent } from "../scripts/lib/newsletter-parse.ts";
import { renderHTML } from "../scripts/lib/newsletter-render-html.ts";
import { hasClariceReviewCredit, omitClariceReviewCredit } from "../scripts/lib/clarice-review-credit.ts";
import { CLARICE_PENDING_REL } from "../scripts/lib/clarice-pending.ts";
import { checkClaricePendingFooterCredit, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

/** Parágrafo de ferramentas como saiu na 261119 (data/snippets/encerramento-social-apoio.md). */
const TOOLS =
  "Nesta edição da **diar.ia.br**, usei Claude Code para automatizar parte da pesquisa e criar resumos, ChatGPT para criar imagens e Wispr Flow para ganhar velocidade com comandos de voz ([ganhe um mês do plano Pro](https://wisprflow.ai/r?ANGELO492=)). A revisão foi feita pelo MCP da Clarice ([ganhe descontos com os cupons NEWS25 e NEWS50](https://clarice.ai/precos-planos?via=diaria)), dei o toque final e enviei via Beehiiv ([ganhe um mês grátis e 20% de desconto por 3 meses](https://www.beehiiv.com?via=Diaria)).";

const EIA = `**É IA?**

Foto teste. [Autor](https://example.com/a) / CC.

Resultado da última edição: 40% das pessoas acertaram.
`;

function d(n: number, url: string): string {
  return `**DESTAQUE ${n} | 💼 MERCADO**

**[Título D${n}](${url})**

Corpo do destaque ${n}.

Por que isso importa:

Why do D${n}.
`;
}

function buildReviewed(): string {
  return `TÍTULO: Edição de teste

---

Olá! Eu sou o [Pixel](https://example.com/pixel). Hoje li 80 notícias e selecionei os 12 mais relevantes.

---

${d(1, "https://example.com/d1")}

---

${d(2, "https://example.com/d2")}

---

${d(3, "https://example.com/d3")}

---

${EIA}

---

**🙋🏼‍♀️ PARA ENCERRAR**

Gosta da diar.ia.br? Apoie o projeto.

${TOOLS}
`;
}

function withEdition<T>(pending: boolean, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ed-13711-"));
  try {
    writeFileSync(join(dir, "02-reviewed.md"), buildReviewed(), "utf8");
    writeFileSync(join(dir, "01-eia.md"), EIA, "utf8");
    if (pending) {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(
        join(dir, CLARICE_PENDING_REL),
        JSON.stringify({ reason: "clarice_unavailable", skipped_at: "2026-11-18T20:00:00Z", source: "02-pre-clarice.md" }),
        "utf8",
      );
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#13711 omitClariceReviewCredit", () => {
  it("tira a oração da Clarice e o link de afiliado, e o resto da frase abre com maiúscula", () => {
    const r = omitClariceReviewCredit(TOOLS);
    assert.equal(r.omitido, true);
    assert.ok(!r.markdown.includes("Clarice"), r.markdown);
    assert.ok(!r.markdown.includes("clarice.ai"), r.markdown);
    assert.match(r.markdown, /\(\[ganhe um mês do plano Pro\]\(https:\/\/wisprflow\.ai\/r\?ANGELO492=\)\)\. Dei o toque final e enviei via Beehiiv/);
    // O resto do parágrafo fica intacto.
    assert.ok(r.markdown.startsWith("Nesta edição da **diar.ia.br**, usei Claude Code"));
    assert.ok(r.markdown.endsWith("(https://www.beehiiv.com?via=Diaria))."));
  });

  it("é idempotente e não toca texto sem o crédito", () => {
    const once = omitClariceReviewCredit(TOOLS).markdown;
    const twice = omitClariceReviewCredit(once);
    assert.equal(twice.omitido, false);
    assert.equal(twice.markdown, once);
    const plain = "Texto qualquer. Sem Clarice aqui.\n";
    assert.deepEqual(omitClariceReviewCredit(plain), { markdown: plain, omitido: false });
  });

  it("frase da Clarice inteira (terminada em ponto) some sem deixar espaço sobrando", () => {
    const md = "Usei Claude Code. A revisão foi feita pela Clarice ([cupons](https://clarice.ai/precos-planos?via=diaria)).\n\nOutro parágrafo.";
    assert.equal(omitClariceReviewCredit(md).markdown, "Usei Claude Code.\n\nOutro parágrafo.");
    const mid = "Usei Claude Code. A revisão foi feita pela Clarice ([cupons](https://clarice.ai/x)). Enviei por e-mail.";
    assert.equal(omitClariceReviewCredit(mid).markdown, "Usei Claude Code. Enviei por e-mail.");
  });

  it("não casa o box de divulgação da Clarice (sem 'revisão')", () => {
    const box = "**📣 Clarice** Corrija seus textos com a Clarice ([use o cupom NEWS25](https://clarice.ai/precos-planos?via=diaria)).";
    assert.equal(hasClariceReviewCredit(box), false);
    assert.equal(omitClariceReviewCredit(box).omitido, false);
  });
});

describe("#13711 render do rodapé conforme o marcador da Clarice", () => {
  it("marcador ativo: frase e link da Clarice fora do conteúdo e do HTML; 02-reviewed.md intacto", () => {
    withEdition(true, (dir) => {
      const before = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const content = extractContent(dir);
      assert.ok(content.encerrar, "bloco PARA ENCERRAR presente");
      assert.ok(!content.encerrar!.includes("revisão foi feita"), content.encerrar!);
      assert.match(content.encerrar!, /Dei o toque final/);
      const html = renderHTML(content);
      assert.ok(!html.includes("revisão foi feita"), "HTML não afirma a revisão");
      assert.ok(!html.includes("clarice.ai/precos-planos"), "HTML sem o link de afiliado da Clarice");
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), before, "02-reviewed.md não é reescrito");
    });
  });

  it("sem marcador: a frase da Clarice segue no rodapé", () => {
    withEdition(false, (dir) => {
      const content = extractContent(dir);
      assert.match(content.encerrar ?? "", /A revisão foi feita pelo MCP da Clarice/);
      const html = renderHTML(content);
      assert.ok(html.includes("revisão foi feita pelo MCP da Clarice"));
      assert.ok(html.includes("clarice.ai/precos-planos?via=diaria"));
    });
  });
});

describe("#13711 invariante clarice-pending-footer-credit", () => {
  it("está registrado no Stage 4 como warning", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "clarice-pending-footer-credit");
    assert.ok(rule, "regra registrada");
    assert.equal(rule!.stage, 4);
  });

  it("avisa com o marcador ativo e a frase no rodapé", () => {
    withEdition(true, (dir) => {
      const v = checkClaricePendingFooterCredit(dir);
      assert.equal(v.length, 1);
      assert.equal(v[0].rule, "clarice-pending-footer-credit");
      assert.equal(v[0].severity, "warning");
    });
  });

  it("silencioso sem o marcador", () => {
    withEdition(false, (dir) => {
      assert.deepEqual(checkClaricePendingFooterCredit(dir), []);
    });
  });
});

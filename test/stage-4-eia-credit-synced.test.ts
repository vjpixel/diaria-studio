/**
 * test/stage-4-eia-credit-synced.test.ts (#3825)
 *
 * O bloco `**É IA?**` em `02-reviewed.md` é só espelho/preview pro editor —
 * `extractContent` (newsletter-parse.ts) SEMPRE lê o crédito real de
 * `01-eia.md`. Este check (Stage 4) detecta quando os dois ficam fora de
 * sincronia — caso real 260722: editor corrigiu a legenda em
 * `02-reviewed.md` (a aba que o Studio abre), `01-eia.md` nunca foi tocado, e
 * o HTML publicado saiu com o crédito antigo, sem nenhum aviso.
 *
 * Severity "warning" (não "error") — decisão conservadora documentada no
 * docstring de `checkEiaCreditSynced`: o mirror passa pelo humanizador +
 * Clarice (Stage 2, escopo full-document, sem exclusão de seção) DEPOIS do
 * stitch, enquanto `01-eia.md` nunca é re-processado — uma correção mínima
 * de pontuação/grafia bastaria pra disparar `error` toda edição, mesmo sem
 * ação do editor. "warning" ainda aparece no `{violations_block}` do gate
 * humano (nunca silencioso), só não falha o exit code.
 *
 * Espelha o padrão de test/stage-4-capture-failed-invariant.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkEiaCreditSynced, STAGE_4_RULES } from "../scripts/lib/invariant-checks/stage-4.ts";

function makeEditionDir(): string {
  return mkdtempSync(join(tmpdir(), "stage4-eia-credit-synced-"));
}

function writeReviewed(dir: string, eiaBlock: string): void {
  const md = [
    "Para esta edição, eu (o editor) enviei 3 submissões e a Diar.ia encontrou outros 40 artigos. Selecionamos os 12 mais relevantes para as pessoas que assinam a newsletter.",
    "",
    "**DESTAQUE 1 | MERCADO**",
    "",
    "**[Título do D1](https://x.com/d1)**",
    "",
    "Corpo do D1.",
    "",
    "Por que isso importa: razão.",
    "",
    "---",
    "",
    "**DESTAQUE 2 | PRODUTO**",
    "",
    "**[Título do D2](https://x.com/d2)**",
    "",
    "Corpo do D2.",
    "",
    "Por que isso importa: razão.",
    "",
    "---",
    "",
    eiaBlock,
    "",
    "---",
    "",
    "**DESTAQUE 3 | CULTURA**",
    "",
    "**[Título do D3](https://x.com/d3)**",
    "",
    "Corpo do D3.",
    "",
    "Por que isso importa: razão.",
  ].join("\n");
  writeFileSync(resolve(dir, "02-reviewed.md"), md, "utf8");
}

function writeEia(dir: string, body: string): void {
  writeFileSync(resolve(dir, "01-eia.md"), body, "utf8");
}

describe("checkEiaCreditSynced (#3825)", () => {
  it("(1) credit + prevResultLine IGUAIS entre 01-eia.md e 02-reviewed.md → sem violação", () => {
    const dir = makeEditionDir();
    try {
      const credit = "Foto da ave-do-paraíso — [Author](https://x.com/u) / CC BY-SA 4.0.";
      writeEia(
        dir,
        `**É IA?**\n\n${credit}\n\nResultado da última edição: 62% das pessoas acertaram.\n`,
      );
      writeReviewed(
        dir,
        `**É IA?**\n\n${credit}\n\nResultado da última edição: 62% das pessoas acertaram.`,
      );
      assert.deepEqual(checkEiaCreditSynced(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(2) credit DIVERGENTE → violação warning apontando qual arquivo é real e qual precisa ser editado", () => {
    const dir = makeEditionDir();
    try {
      writeEia(dir, "**É IA?**\n\nFoto da ave-do-paraíso, legenda ANTIGA (errada).\n");
      writeReviewed(dir, "**É IA?**\n\nFoto da ave-do-paraíso, legenda CORRIGIDA pelo editor.");
      const violations = checkEiaCreditSynced(dir);
      const creditViolation = violations.find((v) => v.rule === "eia-credit-synced");
      assert.ok(creditViolation, "deveria reportar divergência de credit");
      assert.equal(creditViolation!.severity, "warning");
      assert.equal(creditViolation!.source_issue, "#3825");
      assert.match(creditViolation!.message, /01-eia\.md/);
      assert.match(creditViolation!.message, /02-reviewed\.md/);
      // Mensagem precisa deixar claro qual lado é o real (vai pro email) e
      // qual é só cosmético — não apenas "diverge".
      assert.match(creditViolation!.message, /fonte que .* usa/i);
      assert.match(creditViolation!.message, /legenda CORRIGIDA/);
      assert.match(creditViolation!.message, /legenda ANTIGA/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(3) reproduz o cenário EXATO do incidente 260722: editor edita só 02-reviewed.md, 01-eia.md fica com o crédito antigo", () => {
    const dir = makeEditionDir();
    try {
      const creditOriginal = "Ave-do-paraíso em display de acasalamento — [Foto](https://x.com/a) / CC BY-SA 4.0.";
      // Passo 1: stitch roda no Stage 2 — copia 01-eia.md verbatim pro mirror
      // (readEiaBlock em stitch-newsletter.ts). Nesse momento os dois batem.
      writeEia(dir, `**É IA?**\n\n${creditOriginal}\n`);
      writeReviewed(dir, `**É IA?**\n\n${creditOriginal}`);
      assert.deepEqual(
        checkEiaCreditSynced(dir),
        [],
        "logo após o stitch os dois arquivos devem bater",
      );

      // Passo 2: editor corrige o erro intencional (legenda cômica/errada da
      // ave) SÓ em 02-reviewed.md — fluxo natural, é a aba que o Studio abre
      // ("02 — Newsletter"). 01-eia.md nunca é tocado.
      const creditCorrigido =
        "Ave-do-paraíso fazendo sua dança de acasalamento anual — [Foto](https://x.com/a) / CC BY-SA 4.0.";
      writeReviewed(dir, `**É IA?**\n\n${creditCorrigido}`);

      // O bug do #3825: render-newsletter-html.ts (via extractContent) lê
      // SEMPRE 01-eia.md — a edição do editor em 02-reviewed.md não teria
      // efeito nenhum no HTML publicado, sem nenhum aviso. Este check deve
      // pegar isso ANTES do gate humano do Stage 4.
      const violations = checkEiaCreditSynced(dir);
      const creditViolation = violations.find((v) => v.rule === "eia-credit-synced");
      assert.ok(
        creditViolation,
        "deveria detectar que 01-eia.md ficou stale após edição só no mirror",
      );
      assert.equal(creditViolation!.severity, "warning");
      assert.equal(creditViolation!.file, resolve(dir, "01-eia.md"));
      // A mensagem deve instruir editar 01-eia.md (não 02-reviewed.md de novo).
      assert.match(creditViolation!.message, /editar 01-eia\.md/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prevResultLine divergente também produz violação (rule eia-prev-result-line-synced)", () => {
    const dir = makeEditionDir();
    try {
      const credit = "Crédito estável.";
      writeEia(
        dir,
        `**É IA?**\n\n${credit}\n\nResultado da última edição: 30% das pessoas acertaram.\n`,
      );
      writeReviewed(
        dir,
        `**É IA?**\n\n${credit}\n\nResultado da última edição: 85% das pessoas acertaram.`,
      );
      const violations = checkEiaCreditSynced(dir);
      const prevResultViolation = violations.find(
        (v) => v.rule === "eia-prev-result-line-synced",
      );
      assert.ok(prevResultViolation, "deveria reportar divergência de prevResultLine");
      assert.equal(prevResultViolation!.severity, "warning");
      // credit bate — não deveria também reportar eia-credit-synced.
      assert.ok(!violations.some((v) => v.rule === "eia-credit-synced"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("normaliza whitespace/trailing newline — não falso-positivo por diferença cosmética", () => {
    const dir = makeEditionDir();
    try {
      writeEia(dir, "**É IA?**\n\nCrédito   com   espaços   extras.\n\n");
      writeReviewed(dir, "**É IA?**\n\nCrédito com espaços extras.");
      assert.deepEqual(checkEiaCreditSynced(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem bloco mirror em 02-reviewed.md (edição legada, stitch não rodou) → []", () => {
    const dir = makeEditionDir();
    try {
      writeEia(dir, "**É IA?**\n\nCrédito qualquer.\n");
      writeFileSync(
        resolve(dir, "02-reviewed.md"),
        "**DESTAQUE 1 | MERCADO**\n\nCorpo sem bloco É IA?.\n",
        "utf8",
      );
      assert.deepEqual(checkEiaCreditSynced(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("01-eia.md ausente → usa fallbackEIA (credit vazio); mirror com credit não-vazio diverge", () => {
    const dir = makeEditionDir();
    try {
      writeReviewed(dir, "**É IA?**\n\nCrédito só no mirror.");
      const violations = checkEiaCreditSynced(dir);
      assert.ok(violations.some((v) => v.rule === "eia-credit-synced"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("02-reviewed.md ausente → []", () => {
    const dir = makeEditionDir();
    try {
      writeEia(dir, "**É IA?**\n\nCrédito.\n");
      assert.deepEqual(checkEiaCreditSynced(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("STAGE_4_RULES registry (#3825)", () => {
  it("inclui eia-credit-synced", () => {
    const ids = STAGE_4_RULES.map((r) => r.id);
    assert.ok(ids.includes("eia-credit-synced"));
  });

  it("a regra registrada é severity warning via run() (surfaced no gate, não gate-blocking — decisão conservadora #3825)", () => {
    const rule = STAGE_4_RULES.find((r) => r.id === "eia-credit-synced");
    assert.ok(rule);
    const dir = makeEditionDir();
    try {
      writeEia(dir, "**É IA?**\n\nCrédito real.\n");
      writeReviewed(dir, "**É IA?**\n\nCrédito espelho divergente.");
      const violations = rule!.run(dir);
      assert.ok(violations.length > 0);
      assert.ok(violations.every((v) => v.severity === "warning"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

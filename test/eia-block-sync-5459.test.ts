/**
 * test/eia-block-sync-5459.test.ts (#5459)
 *
 * `stitch-newsletter.ts::readEiaBlock` copia `01-eia.md` verbatim pro mirror
 * em `02-reviewed.md` no momento do stitch — mas depois disso o mirror passa
 * por humanizador + Clarice (Stage 2, full-document), enquanto `01-eia.md`
 * nunca é re-processado. `checkEiaCreditSynced` (#3825) já DETECTAVA essa
 * divergência (warning, Stage 4), mas nunca corrigia — sempre exigia fix
 * manual em `01-eia.md`. Este teste cobre `syncEiaBlockFromReviewed`
 * (`scripts/lib/eia-sync.ts`), que fecha esse loop automaticamente no Stage
 * 2, logo após Clarice/humanizador rodarem — antes do Stage 4 nunca ver a
 * divergência.
 *
 * Achado ao vivo que motivou a issue (edição 260817): um travessão solto
 * antes do crédito em `01-eia.md`, ausente em `02-reviewed.md` — consistente
 * com o humanizador (padrão #20 "Travessão excessivo") tendo limpado o
 * travessão só na cópia mirror, sem propagar de volta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { syncEiaBlockFromReviewed } from "../scripts/lib/eia-sync.ts";

const EDITION_DIR = "/tmp/fake-edition-dir/260817";

function reviewedMdWithEiaBlock(eiaBlock: string): string {
  // Mesma ordem que stitch-newsletter.ts produz (destaques → boxes →
  // É IA? → seções secundárias). Extração é position-agnostic
  // (extractEiaMirrorBlock só procura o bloco `---`-isolado cujo header
  // casa `**É IA?**`), então o resto do documento em volta é só contexto
  // realista, não algo que o parser dependa.
  return [
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
    eiaBlock,
    "",
    "---",
    "",
    "**LANÇAMENTOS**",
    "",
    "**[Um lançamento](https://x.com/l1)**",
    "Descrição do lançamento.",
  ].join("\n");
}

describe("syncEiaBlockFromReviewed (#5459)", () => {
  it("bloco divergente (travessão solto removido pelo humanizador) → sincroniza 01-eia.md com a versão corrigida", () => {
    const creditOriginal = "— Foto da ave-do-paraíso — [Author](https://x.com/u) / CC BY-SA 4.0.";
    const creditCorrigido = "Foto da ave-do-paraíso — [Author](https://x.com/u) / CC BY-SA 4.0.";

    const eiaMd = `---\neia_answer:\n  A: real\n  B: ia\n---\n\n**É IA?**\n\n${creditOriginal}\n`;
    const reviewedMd = reviewedMdWithEiaBlock(`**É IA?**\n\n${creditCorrigido}`);

    const result = syncEiaBlockFromReviewed(eiaMd, reviewedMd, EDITION_DIR);

    assert.equal(result.changed, true);
    assert.ok(result.newEiaMd.includes(creditCorrigido), "01-eia.md sincronizado deve trazer o crédito corrigido");
    assert.ok(!result.newEiaMd.includes(creditOriginal), "01-eia.md sincronizado não deve mais conter o crédito antigo");
    // Frontmatter YAML original preservado intacto.
    assert.match(result.newEiaMd, /^---\r?\neia_answer:\r?\n {2}A: real\r?\n {2}B: ia\r?\n---/);
    assert.match(result.newEiaMd, /\*\*É IA\?\*\*/);
  });

  it("blocos já idênticos → no-op, não reescreve 01-eia.md desnecessariamente", () => {
    const credit = "Foto da ave-do-paraíso — [Author](https://x.com/u) / CC BY-SA 4.0.";
    const eiaMd = `---\neia_answer:\n  A: real\n  B: ia\n---\n\n**É IA?**\n\n${credit}\n`;
    const reviewedMd = reviewedMdWithEiaBlock(`**É IA?**\n\n${credit}`);

    const result = syncEiaBlockFromReviewed(eiaMd, reviewedMd, EDITION_DIR);

    assert.equal(result.changed, false);
    assert.equal(result.reason, "already-synced");
    assert.equal(result.newEiaMd, eiaMd, "no-op deve retornar o texto original byte-idêntico");
  });

  it("diferença cosmética de whitespace/trailing newline → não é falso-positivo (mesma normalização de #3825)", () => {
    const eiaMd = "**É IA?**\n\nCrédito   com   espaços   extras.\n\n";
    const reviewedMd = reviewedMdWithEiaBlock("**É IA?**\n\nCrédito com espaços extras.");

    const result = syncEiaBlockFromReviewed(eiaMd, reviewedMd, EDITION_DIR);

    assert.equal(result.changed, false);
    assert.equal(result.reason, "already-synced");
  });

  it("prevResultLine divergente também é sincronizado", () => {
    const credit = "Crédito estável.";
    const eiaMd = `**É IA?**\n\n${credit}\n\nResultado da última edição: 30% das pessoas acertaram.\n`;
    const reviewedMd = reviewedMdWithEiaBlock(
      `**É IA?**\n\n${credit}\n\nResultado da última edição: 85% das pessoas acertaram.`,
    );

    const result = syncEiaBlockFromReviewed(eiaMd, reviewedMd, EDITION_DIR);

    assert.equal(result.changed, true);
    assert.ok(result.newEiaMd.includes("85% das pessoas acertaram"));
    assert.ok(!result.newEiaMd.includes("30% das pessoas acertaram"));
  });

  it("sem bloco mirror em 02-reviewed.md (Stage 3 ainda não rodou / edição legada) → no-op, reason no-mirror", () => {
    const eiaMd = "**É IA?**\n\nCrédito qualquer.\n";
    const reviewedMd = "**DESTAQUE 1 | MERCADO**\n\nCorpo sem bloco É IA?.\n";

    const result = syncEiaBlockFromReviewed(eiaMd, reviewedMd, EDITION_DIR);

    assert.equal(result.changed, false);
    assert.equal(result.reason, "no-mirror");
    assert.equal(result.newEiaMd, eiaMd);
  });

  it("01-eia.md vazio/ausente (representado como string vazia) + mirror com conteúdo → detecta divergência (changed true)", () => {
    const reviewedMd = reviewedMdWithEiaBlock("**É IA?**\n\nCrédito só no mirror.");

    const result = syncEiaBlockFromReviewed("", reviewedMd, EDITION_DIR);

    assert.equal(result.changed, true);
    assert.ok(result.newEiaMd.includes("Crédito só no mirror."));
  });

  it("#5466 review: mirror é o placeholder de stitch (eia-composer ainda rodando no momento do stitch) e 01-eia.md já tem conteúdo real (race: eia-composer terminou DEPOIS do stitch mas ANTES desta sync) → no-op, reason mirror-is-placeholder, 01-eia.md NÃO é sobrescrito", () => {
    const creditoReal = "Foto da ave-do-paraíso — [Author](https://x.com/u) / CC BY-SA 4.0.";
    const eiaMd = `---\neia_answer:\n  A: real\n  B: ia\n---\n\n**É IA?**\n\n${creditoReal}\n`;
    // Mesmo texto literal gravado por stitch-newsletter.ts::readEiaBlock
    // quando 01-eia.md ainda não existia no momento do stitch.
    const reviewedMd = reviewedMdWithEiaBlock(
      "É IA?\n\n[É IA? ainda processando — bloco será inserido na Etapa 3]",
    );

    const result = syncEiaBlockFromReviewed(eiaMd, reviewedMd, EDITION_DIR);

    assert.equal(result.changed, false);
    assert.equal(result.reason, "mirror-is-placeholder");
    assert.equal(result.newEiaMd, eiaMd, "01-eia.md real não deve ser sobrescrito pelo placeholder");
    assert.ok(result.newEiaMd.includes(creditoReal), "crédito real de 01-eia.md deve permanecer intacto");
  });

  it("frontmatter sem eia_answer (formato inesperado) não é confundido com corpo — preserva o que houver antes do 2º ---", () => {
    const eiaMd = "---\nalgum_outro_campo: valor\n---\n\n**É IA?**\n\nCrédito original.\n";
    const reviewedMd = reviewedMdWithEiaBlock("**É IA?**\n\nCrédito corrigido.");

    const result = syncEiaBlockFromReviewed(eiaMd, reviewedMd, EDITION_DIR);

    assert.equal(result.changed, true);
    assert.match(result.newEiaMd, /^---\r?\nalgum_outro_campo: valor\r?\n---/);
    assert.ok(result.newEiaMd.includes("Crédito corrigido."));
  });
});

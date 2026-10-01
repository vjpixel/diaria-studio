/**
 * test/edition-manual-edits.test.ts (#9357)
 *
 * Métrica "edições sem modificação manual" (definição de feito da #7972):
 * normalização que desconta mutações da própria pipeline, diff por seção,
 * veredito por edição e contagem de edições consecutivas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyAutofixReplacements,
  applyIntentionalError,
  countTitleOptions,
  diffBySection,
  extractDestaqueTitles,
  normalizeNewsletterForComparison,
  pruneTitleOptions,
  sectionHeaderName,
} from "../scripts/lib/manual-edit-diff.ts";
import {
  computeEditionManualEdits,
  decideZeroManualEdits,
  summarizeSeries,
  type EditionManualEdits,
} from "../scripts/edition-manual-edits.ts";
import { captureStage2Baseline } from "../scripts/lib/editor-request-snapshots.ts";
import { renderManualEditsSection } from "../scripts/send-edition-report.ts";

const FINAL = [
  "TÍTULO",
  "",
  "Título D1",
  "",
  "SUBTÍTULO",
  "",
  "algo",
  "",
  "---",
  "Olá!",
  "",
  "Nesta edição, a IA analisou 380 conteúdos e selecionei os 9 mais relevantes.",
  "",
  "---",
  "",
  "**DESTAQUE 1 | ⚠️ NOTÍCIAS**",
  "",
  "**[Título D1](https://example.com/d1)**  ",
  "",
  "Parágrafo D1 com Deloite.",
  "",
  "Link: https://diar.ia.br/p/edicao-260930",
  "",
  "---",
  "",
  "É IA?",
  "",
  "[É IA? ainda processando]",
  "",
  "---",
  "",
  "**📡 RADAR**",
  "",
  "**[Item](https://example.com/r)**",
  "Resumo.",
  "",
  "---",
  "",
  "**ERRO INTENCIONAL**",
  "",
  "Na última edição, escrevi X.",
  "",
  "---",
  "",
  "**🙋🏼‍♀️ PARA ENCERRAR**",
  "",
  "Rodapé com hubs.",
  "",
].join("\n");

describe("manual-edit-diff (#9357) — normalização", () => {
  it("sectionHeaderName aceita emoji e rejeita linha de link/título de caixa", () => {
    assert.equal(sectionHeaderName("**📡 RADAR**"), "RADAR");
    assert.equal(sectionHeaderName("**🙋🏼‍♀️ PARA ENCERRAR**"), "PARA ENCERRAR");
    assert.equal(sectionHeaderName("**DESTAQUE 2 | 🚀 LANÇAMENTO**"), "DESTAQUE 2");
    assert.equal(sectionHeaderName("É IA?"), "É IA?");
    assert.equal(sectionHeaderName("**[Título](https://x)**"), null);
    assert.equal(sectionHeaderName("**Equipamentos que eu uso**"), null);
  });

  it("desconta bloco TÍTULO, linha de cobertura, URL própria e blocos da pipeline", () => {
    const pipelineVersion = FINAL.replace(/^TÍTULO[\s\S]*?---\n/, "")
      .replace("os 9 mais relevantes", "os 15 mais relevantes")
      .replace("https://diar.ia.br/p/edicao-260930", "{edition_url}")
      .replace("Na última edição, escrevi X.", "{placeholder}")
      .replace("Rodapé com hubs.", "Rodapé sem hubs.")
      .replace("[É IA? ainda processando]", "Bloco do É IA? pronto");
    assert.equal(normalizeNewsletterForComparison(pipelineVersion), normalizeNewsletterForComparison(FINAL));
    assert.deepEqual(diffBySection(normalizeNewsletterForComparison(pipelineVersion), normalizeNewsletterForComparison(FINAL)), []);
  });

  it("edição real de texto aparece na seção certa", () => {
    const edited = FINAL.replace("Resumo.", "Resumo reescrito.");
    const changes = diffBySection(normalizeNewsletterForComparison(FINAL), normalizeNewsletterForComparison(edited));
    assert.equal(changes.length, 1);
    assert.equal(changes[0].section, "RADAR");
    assert.equal(changes[0].added, 1);
    assert.equal(changes[0].removed, 1);
  });

  it("títulos: poda pela escolha do title-picker, extração e contagem de opções", () => {
    const three = "**DESTAQUE 1 | X**\n\n**[A](https://e/1)**  \n\n**[B](https://e/1)**  \n\n**[C](https://e/1)**  \n\nCorpo.\n";
    assert.equal(countTitleOptions(three).get(1), 3);
    const pruned = pruneTitleOptions(three, [{ destaque: 1, chosen: "B" }]);
    assert.equal(extractDestaqueTitles(pruned).get(1), "B");
    assert.equal(countTitleOptions(pruned).get(1), 1);
    assert.equal(extractDestaqueTitles(pruneTitleOptions(three, [])).get(1), "A", "sem pick, fica a 1ª");
  });

  it("erro intencional e fact-check autofix aplicados ao baseline", () => {
    const base = "Texto com Deloitte e 3 meses.";
    const final = "Texto com Deloite e 3 semanas.";
    const withError = applyIntentionalError(base, final, { correct_value: "Deloitte", wrong_value: "Deloite" });
    const withFix = applyAutofixReplacements(withError, [{ text: "3 meses", suggested_fix: "3 semanas", sources: ["newsletter"] }], "newsletter");
    assert.equal(withFix, final);
    // Placeholder não preenchido: no-op.
    assert.equal(applyIntentionalError(base, final, { correct_value: "{PREENCHER}", wrong_value: "Deloite" }), base);
    // Fix só do social não toca a newsletter.
    assert.equal(applyAutofixReplacements(base, [{ text: "3 meses", suggested_fix: "x", sources: ["social"] }], "newsletter"), base);
  });
});

function makeEdition(root: string, opts: { editNewsletter?: boolean; withBaseline?: boolean; redoImage?: boolean }): string {
  const dir = join(root, "2609", "260930");
  const internal = join(dir, "_internal");
  mkdirSync(internal, { recursive: true });
  const categorized = {
    highlights: [1, 2, 3].map((r) => ({ rank: r, article: { url: `https://example.com/d${r}`, title: `D${r}` } })),
  };
  writeFileSync(join(internal, "01-categorized.json"), JSON.stringify(categorized), "utf8");
  writeFileSync(join(internal, "01-approved.json"), JSON.stringify(categorized), "utf8");
  writeFileSync(join(internal, ".step-1-gate.json"), JSON.stringify({ auto_approved: true }), "utf8");
  writeFileSync(join(internal, "02-title-picks.json"), JSON.stringify({ picks: [{ destaque: 1, chosen: "Título D1" }] }), "utf8");
  writeFileSync(join(dir, "02-reviewed.md"), FINAL, "utf8");
  writeFileSync(join(dir, "03-social.md"), "# Social\n\n## d1\n\nTexto.\n", "utf8");
  const step2 = new Date("2026-09-29T20:42:59.000Z");
  writeFileSync(join(internal, ".step-2-done.json"), JSON.stringify({ step: 2, completed_at: step2.toISOString() }), "utf8");
  if (opts.withBaseline) captureStage2Baseline(dir, "pipeline-sentinel-step-2", new Date(step2.getTime() + 5000));
  const step3 = new Date("2026-09-29T20:52:36.000Z");
  writeFileSync(join(internal, ".step-3-done.json"), JSON.stringify({ step: 3, completed_at: step3.toISOString() }), "utf8");
  const img = join(dir, "04-d1-2x1.jpg");
  writeFileSync(img, "jpg", "utf8");
  const imgTime = opts.redoImage ? new Date("2026-09-29T22:13:00.000Z") : new Date("2026-09-29T20:49:00.000Z");
  utimesSync(img, imgTime, imgTime);
  if (opts.editNewsletter) writeFileSync(join(dir, "02-reviewed.md"), FINAL.replace("Resumo.", "Resumo do editor."), "utf8");
  return dir;
}

describe("computeEditionManualEdits (#9357)", () => {
  it("baseline carimbado + nada editado → zero_manual_edits=true", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-"));
    try {
      const r = computeEditionManualEdits(makeEdition(root, { withBaseline: true }), "260930");
      assert.equal(r.baseline_status, "ok");
      assert.equal(r.zero_manual_edits, true, JSON.stringify(r.gates, null, 2));
      assert.equal(r.gates.newsletter.baseline, "snapshot");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("editor reescreveu o RADAR → false, com a seção nomeada", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-"));
    try {
      const r = computeEditionManualEdits(makeEdition(root, { withBaseline: true, editNewsletter: true }), "260930");
      assert.equal(r.zero_manual_edits, false);
      assert.match(r.gates.newsletter.changes[0].detail, /^RADAR:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("arte regerada depois do Stage 3 conta como modificação", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-"));
    try {
      const r = computeEditionManualEdits(makeEdition(root, { withBaseline: true, redoImage: true }), "260930");
      assert.equal(r.zero_manual_edits, false);
      assert.equal(r.gates.images.changes[0].kind, "image-redo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem baseline confiável: social não medido → null (nunca true por omissão)", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-"));
    try {
      const dir = makeEdition(root, {});
      // Saída da pipeline igual ao final (sem o bloco TÍTULO) — newsletter reconstruída sem diff.
      writeFileSync(join(dir, "_internal", "02-humanized.md"), FINAL.replace(/^TÍTULO[\s\S]*?---\n/, ""), "utf8");
      const r = computeEditionManualEdits(dir, "260930");
      assert.equal(r.baseline_status, "missing");
      assert.equal(r.gates.newsletter.baseline, "reconstructed");
      assert.equal(r.gates.social.status, "unmeasured");
      assert.equal(r.zero_manual_edits, null, JSON.stringify(r.gates, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("série e veredito (#9357)", () => {
  const mk = (edition: string, zero: boolean | null): EditionManualEdits => ({
    edition,
    arm: "A",
    baseline_status: "ok",
    gates: {} as EditionManualEdits["gates"],
    manual_edit_count: zero === false ? 1 : 0,
    zero_manual_edits: zero,
  });

  it("consecutivas contam da mais recente pra trás e param em false/null", () => {
    const s = summarizeSeries([mk("261001", true), mk("260929", false), mk("260930", true), mk("261002", true)]);
    assert.equal(s.consecutive_zero, 3);
    assert.equal(summarizeSeries([mk("261001", true), mk("261002", null)]).consecutive_zero, 0);
    assert.equal(s.with_edits, 1);
  });

  it("decideZeroManualEdits: mudança medida vence gate não medido", () => {
    const measured = (n: number) => ({ status: "measured" as const, changes: Array.from({ length: n }, () => ({ kind: "x", detail: "y" })) });
    const un = { status: "unmeasured" as const, changes: [] };
    assert.equal(decideZeroManualEdits({ stage1: measured(0), newsletter: measured(1), titles: measured(0), social: un, images: measured(0) }), false);
    assert.equal(decideZeroManualEdits({ stage1: measured(0), newsletter: measured(0), titles: measured(0), social: un, images: measured(0) }), null);
  });

  it("relatório de edição renderiza o veredito e o gate não medido", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-"));
    try {
      const html = renderManualEditsSection(computeEditionManualEdits(makeEdition(root, { withBaseline: true, editNewsletter: true }), "260930"));
      assert.match(html, /Modificações manuais/);
      assert.match(html, /RADAR/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
  findCutItems,
  findIncludedItems,
  normalizeItemUrl,
  normalizeNewsletterForComparison,
  pruneTitleOptions,
  removeCutItemBlocks,
  sectionHeaderName,
  extractDestaques,
  isCorrectedUrl,
  matchDestaquesByUrl,
  type DestaqueEntry,
} from "../scripts/lib/manual-edit-diff.ts";
import {
  INCLUSIONS_WINDOW,
  computeEditionManualEdits,
  decideZeroManualEdits,
  editionsRootOf,
  resolvePickUrls,
  stage1EditorAddedUrls,
  summarizeSeries,
  trailingSeriesSummary,
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

function makeEdition(
  root: string,
  opts: { editNewsletter?: boolean; withBaseline?: boolean; redoImage?: boolean; edition?: string; stage4Done?: boolean },
): string {
  const edition = opts.edition ?? "260930";
  const dir = join(root, edition.slice(0, 4), edition);
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
  if (opts.stage4Done) writeFileSync(join(internal, ".step-4-done.json"), JSON.stringify({ step: 4 }), "utf8");
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

// ---------------------------------------------------------------------------
// #9641: cortes fora da contagem, inclusões, item movido de seção
// ---------------------------------------------------------------------------

const RADAR_KEPT = "**[Item](https://example.com/r)**\nResumo.";
const RADAR_CUT = "**[Cortado](https://example.com/cut)**\nResumo do cortado.";
const USE_MELHOR_CUT = "**🛠️ USE MELHOR**\n\n**[Tutorial](https://example.com/um)**\n\nResumo do tutorial em linha separada.\n\n---\n\n";

/** Saída da pipeline: FINAL + 1 item extra no RADAR + seção USE MELHOR inteira. */
const PIPELINE = FINAL.replace(RADAR_KEPT, `${RADAR_KEPT}\n\n${RADAR_CUT}`).replace("**📡 RADAR**", `${USE_MELHOR_CUT}**📡 RADAR**`);

const pool = (radar: string[]) => ({
  highlights: [1, 2, 3].map((r) => ({ rank: r, article: { url: `https://example.com/d${r}`, title: `D${r}` } })),
  radar: radar.map((u) => ({ url: u, title: u })),
});

/** Edição com snapshot do Stage 2 = `pipelineMd`/`approvedAtStage2`, e final = `finalMd`/`approvedFinal`. */
function makeItemEdition(
  root: string,
  opts: { pipelineMd: string; finalMd: string; approvedAtStage2?: unknown; approvedFinal?: unknown },
): string {
  const dir = makeEdition(root, {});
  const internal = join(dir, "_internal");
  if (opts.approvedAtStage2) writeFileSync(join(internal, "01-approved.json"), JSON.stringify(opts.approvedAtStage2), "utf8");
  writeFileSync(join(dir, "02-reviewed.md"), opts.pipelineMd, "utf8");
  captureStage2Baseline(dir, "pipeline-sentinel-step-2", new Date("2026-09-29T20:43:04.000Z"));
  writeFileSync(join(dir, "02-reviewed.md"), opts.finalMd, "utf8");
  if (opts.approvedFinal) writeFileSync(join(internal, "01-approved.json"), JSON.stringify(opts.approvedFinal), "utf8");
  return dir;
}

describe("cortes × inclusões (#9641)", () => {
  it("edição só com cortes → zero_manual_edits=true sem a flag e false com --count-cuts", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9641-"));
    try {
      const dir = makeItemEdition(root, {
        pipelineMd: PIPELINE,
        finalMd: FINAL,
        approvedAtStage2: pool(["https://example.com/r", "https://example.com/cut"]),
        approvedFinal: pool(["https://example.com/r"]),
      });
      const r = computeEditionManualEdits(dir, "260930");
      assert.equal(r.baseline_status, "ok");
      assert.equal(r.zero_manual_edits, true, JSON.stringify(r.gates, null, 2));
      assert.equal(r.manual_edit_count, 0);
      assert.equal(r.cuts_counted, false);
      assert.deepEqual(r.cuts.map((c) => c.url).sort(), ["https://example.com/cut", "https://example.com/um"]);
      assert.deepEqual(r.inclusions, []);
      // O pool-cut do Stage 1 saiu de `changes` e foi pra `cuts`.
      assert.deepEqual(r.gates.stage1.changes, []);
      assert.equal(r.gates.stage1.cuts?.[0].kind, "pool-cut");

      const strict = computeEditionManualEdits(dir, "260930", { countCuts: true });
      assert.equal(strict.zero_manual_edits, false);
      assert.equal(strict.cuts_counted, true);
      assert.ok(strict.gates.stage1.changes.some((c) => c.kind === "pool-cut"));
      assert.deepEqual(
        strict.gates.newsletter.changes.map((c) => c.detail.split(":")[0]).sort(),
        ["RADAR", "USE MELHOR"],
        "com a flag, o diff de texto volta a mostrar as seções cortadas",
      );
      assert.equal(strict.cuts.length, 2, "a lista de cortes sai igual com ou sem a flag");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inclusão (URL fora da saída da pipeline) é contada e continua sendo modificação", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9641-"));
    try {
      const included = "**[Novo do editor](https://example.com/novo)**\nResumo novo.";
      const dir = makeItemEdition(root, { pipelineMd: FINAL, finalMd: FINAL.replace(RADAR_KEPT, `${RADAR_KEPT}\n\n${included}`) });
      const r = computeEditionManualEdits(dir, "260930");
      assert.deepEqual(r.inclusions, [{ url: "https://example.com/novo", title: "Novo do editor", section: "RADAR" }]);
      assert.deepEqual(r.cuts, []);
      assert.equal(r.zero_manual_edits, false);
      assert.match(r.gates.newsletter.changes[0].detail, /^RADAR: \+2\/-0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("troca de URL da mesma história conta como inclusão (e o item antigo como corte)", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9641-"));
    try {
      const dir = makeItemEdition(root, {
        pipelineMd: FINAL,
        finalMd: FINAL.replace("https://example.com/r", "https://primaria.example.org/r"),
      });
      const r = computeEditionManualEdits(dir, "260930");
      assert.deepEqual(r.inclusions?.map((i) => i.url), ["https://primaria.example.org/r"]);
      assert.deepEqual(r.cuts.map((c) => c.url), ["https://example.com/r"]);
      assert.equal(r.zero_manual_edits, false, "a linha nova do item segue no diff");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("item movido de seção NÃO é corte: segue contando nas duas seções", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9641-"));
    try {
      const moved = FINAL.replace("**📡 RADAR**", "**🛠️ USE MELHOR**");
      const dir = makeItemEdition(root, { pipelineMd: FINAL, finalMd: moved });
      const r = computeEditionManualEdits(dir, "260930");
      assert.deepEqual(r.cuts, []);
      assert.deepEqual(r.inclusions, []);
      assert.equal(r.zero_manual_edits, false);
      assert.deepEqual(r.gates.newsletter.changes.map((c) => c.detail.split(":")[0]).sort(), ["RADAR", "USE MELHOR"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removeCutItemBlocks: resumo depois de linha em branco sai junto; cabeçalho fica se a seção existe no final", () => {
    const md = "**🛠️ USE MELHOR**\n\n**[A](https://e/a)**\n\nResumo A.\n\n---\n\n**📡 RADAR**\n\n**[B](https://e/b)**\nResumo B.\n**[C](https://e/c)**\nResumo C.\n";
    const out = removeCutItemBlocks(md, new Set(["https://e/a", "https://e/b"]));
    assert.doesNotMatch(out, /USE MELHOR|Resumo A|Resumo B/);
    assert.match(out, /\*\*\[C\]\(https:\/\/e\/c\)\*\*\nResumo C\./);
    const keepHeader = removeCutItemBlocks(md, new Set(["https://e/a"]), new Set(["USE MELHOR"]));
    assert.match(keepHeader, /USE MELHOR/);
    assert.doesNotMatch(keepHeader, /Resumo A/);
  });

  it("corte de X + resumo de Y reescrito na MESMA seção → a seção segue no diff e zero_manual_edits=false", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9641-"));
    try {
      const dir = makeItemEdition(root, { pipelineMd: PIPELINE, finalMd: FINAL.replace("Resumo.", "Resumo reescrito.") });
      const r = computeEditionManualEdits(dir, "260930");
      assert.deepEqual(r.cuts.map((c) => c.url).sort(), ["https://example.com/cut", "https://example.com/um"]);
      assert.equal(r.zero_manual_edits, false, JSON.stringify(r.gates, null, 2));
      assert.deepEqual(
        r.gates.newsletter.changes.map((c) => c.detail),
        ['RADAR: +1/-1 (ex.: "Resumo reescrito.")'],
        "o corte sai do diff, a reescrita do resumo do item mantido fica",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removeCutItemBlocks: título solto numa seção de resumo colado NÃO engole o parágrafo seguinte", () => {
    // RADAR em formato "resumo colado"; o item cortado veio só com título e,
    // depois da linha em branco, há uma nota que não é dele.
    const md = "**📡 RADAR**\n\n**[A](https://e/a)**\nResumo A.\n\n**[B](https://e/b)**\n\nNota do editor sobre a seção.\n\n**[C](https://e/c)**\nResumo C.\n";
    const out = removeCutItemBlocks(md, new Set(["https://e/b"]));
    assert.doesNotMatch(out, /e\/b/);
    assert.match(out, /Nota do editor sobre a seção\./);
    assert.match(out, /Resumo A\./);
    assert.match(out, /Resumo C\./);
    // Seção de títulos soltos: idem.
    const titles = "**📡 RADAR**\n\n**[A](https://e/a)**\n\n**[B](https://e/b)**\n\nParágrafo de fecho.\n";
    assert.match(removeCutItemBlocks(titles, new Set(["https://e/b"])), /Parágrafo de fecho\./);
    // Seção toda em "título, branco, resumo": o resumo do cortado sai junto.
    const blank = "**📡 RADAR**\n\n**[A](https://e/a)**\n\nResumo A.\n\n**[B](https://e/b)**\n\nResumo B.\n";
    const outBlank = removeCutItemBlocks(blank, new Set(["https://e/b"]));
    assert.doesNotMatch(outBlank, /Resumo B/);
    assert.match(outBlank, /Resumo A\./);
  });

  it("findCutItems ignora destaque e item que reaparece como link em outro lugar", () => {
    const baseline = "**DESTAQUE 1 | X**\n\n**[D1](https://e/d1)**\n\nCorpo.\n\n---\n\n**📡 RADAR**\n\n**[R](https://e/r)**\nResumo.\n";
    assert.deepEqual(findCutItems(baseline, "**DESTAQUE 1 | X**\n\n**[Outro](https://e/x)**\n\nCorpo com [link](https://e/r).\n"), []);
    assert.deepEqual(
      findCutItems(baseline, "**DESTAQUE 1 | X**\n\n**[D1](https://e/d1)**\n").map((c) => c.url),
      ["https://e/r"],
    );
    assert.deepEqual(findIncludedItems("**📡 RADAR**\n\n**[N](https://e/n)**\n", new Set(["https://e/r"])).map((i) => i.url), ["https://e/n"]);
  });
});

describe("stage1EditorAddedUrls (#9641)", () => {
  it("normalizeItemUrl: mesma normalização do baseline (espaço nas pontas, URL própria)", () => {
    assert.equal(normalizeItemUrl("  https://example.com/x \n"), "https://example.com/x");
    assert.equal(normalizeItemUrl("https://diar.ia.br/p/edicao-260930"), "{edition_url}");
    assert.equal(normalizeItemUrl(normalizeItemUrl(" https://e/x ")), "https://e/x");
  });

  it("gate humano: URL incluída pelo editor sai normalizada; auto-aprovado → vazio", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9641-"));
    try {
      const dir = makeEdition(root, {});
      const internal = join(dir, "_internal");
      // auto_approved: true (default do fixture) → nada é do editor.
      writeFileSync(join(internal, "01-approved.json"), JSON.stringify(pool([" https://example.com/novo "])), "utf8");
      assert.deepEqual([...stage1EditorAddedUrls(dir, undefined)], []);
      writeFileSync(join(internal, ".step-1-gate.json"), JSON.stringify({ auto_approved: false }), "utf8");
      assert.deepEqual([...stage1EditorAddedUrls(dir, undefined)], ["https://example.com/novo"]);
      // Snapshot do Stage 2 tem precedência sobre o aprovado final.
      const snap = JSON.stringify(pool(["https://example.com/do-snapshot"]));
      assert.deepEqual([...stage1EditorAddedUrls(dir, snap)], ["https://example.com/do-snapshot"]);
      // URL que a pipeline já tinha (mesmo com espaço sobrando no categorizado) não é do editor.
      writeFileSync(join(internal, "01-categorized.json"), JSON.stringify(pool(["https://example.com/novo  "])), "utf8");
      assert.deepEqual([...stage1EditorAddedUrls(dir, undefined)], []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("URL crua do 01-approved.json casa com a URL normalizada do baseline → conta como inclusão", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9641-"));
    try {
      const included = "**[Do gate 1](https://example.com/novo)**\nResumo novo.";
      const md = FINAL.replace(RADAR_KEPT, `${RADAR_KEPT}\n\n${included}`);
      const dir = makeItemEdition(root, {
        pipelineMd: md,
        finalMd: md,
        approvedAtStage2: pool(["https://example.com/r", " https://example.com/novo "]),
      });
      writeFileSync(join(dir, "_internal", "01-categorized.json"), JSON.stringify(pool(["https://example.com/r"])), "utf8");
      writeFileSync(join(dir, "_internal", ".step-1-gate.json"), JSON.stringify({ auto_approved: false }), "utf8");
      const r = computeEditionManualEdits(dir, "260930");
      assert.deepEqual(r.inclusions?.map((i) => i.url), ["https://example.com/novo"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("editionsRootOf / trailingSeriesSummary (#9641)", () => {
  it("editionsRootOf: layout nested (AAMM/AAMMDD) e flat (AAMMDD)", () => {
    assert.equal(editionsRootOf("/x/data/editions/2609/260930"), "/x/data/editions");
    assert.equal(editionsRootOf("/x/data/editions/260930"), "/x/data/editions");
    assert.equal(editionsRootOf("/x/data/editions/2609/260930/"), "/x/data/editions");
  });

  const editionNames = (n: number) =>
    Array.from({ length: n }, (_, i) => `2609${String(i + 1).padStart(2, "0")}`);

  it("lê o histórico inteiro enquanto a sequência segue aberta; edições futuras ficam fora", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-series-"));
    try {
      const names = editionNames(14); // 260901..260914
      for (const e of names) makeEdition(root, { edition: e, withBaseline: true, stage4Done: true });
      const current = computeEditionManualEdits(join(root, "2609", "260913"), "260913");
      assert.equal(current.zero_manual_edits, true);
      const s = trailingSeriesSummary(root, current);
      assert.equal(s.editions, 13, "260914 (futura) não entra");
      assert.equal(s.consecutive_zero, 13);
      assert.equal(s.consecutive_zero_inclusions, 13);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("parada antecipada: sequências fechadas na edição atual → só a janela das últimas 10", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-series-"));
    try {
      const names = editionNames(13);
      for (const e of names) makeEdition(root, { edition: e, withBaseline: true, stage4Done: true });
      const measured = computeEditionManualEdits(join(root, "2609", "260913"), "260913");
      const current: EditionManualEdits = {
        ...measured,
        zero_manual_edits: false,
        inclusions: [{ url: "https://e/n", title: "Novo", section: "RADAR" }],
      };
      const s = trailingSeriesSummary(root, current);
      assert.equal(s.editions, INCLUSIONS_WINDOW);
      assert.equal(s.consecutive_zero, 0);
      assert.equal(s.consecutive_zero_inclusions, 0);
      assert.equal(s.avg_inclusions_last_10, 0.1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("série e veredito (#9357)", () => {
  const mk = (edition: string, zero: boolean | null, inclusions: number | null = 0): EditionManualEdits => ({
    edition,
    arm: "A",
    baseline_status: "ok",
    gates: {} as EditionManualEdits["gates"],
    manual_edit_count: zero === false ? 1 : 0,
    zero_manual_edits: zero,
    cuts_counted: false,
    cuts: [],
    inclusions: inclusions === null ? null : Array.from({ length: inclusions }, (_, i) => ({ url: `https://e/${i}`, title: "t", section: "RADAR" })),
  });

  it("#9641: sequência sem inclusão e média das últimas 10", () => {
    const s = summarizeSeries([mk("261001", false, 4), mk("261002", false, 0), mk("261003", false, 0), mk("260930", false, 2)]);
    assert.equal(s.consecutive_zero_inclusions, 2);
    assert.equal(s.avg_inclusions_last_10, 1.5);
    assert.equal(s.inclusions_window_editions, 4);
    // `null` (newsletter não medida) interrompe a sequência e fica fora da média.
    const t = summarizeSeries([mk("261001", false, 0), mk("261002", false, null)]);
    assert.equal(t.consecutive_zero_inclusions, 0);
    assert.equal(t.avg_inclusions_last_10, 0);
    assert.equal(t.inclusions_window_editions, 1);
    // Janela: só as 10 mais recentes.
    const many = Array.from({ length: 12 }, (_, i) => mk(`2610${String(i + 1).padStart(2, "0")}`, false, i < 2 ? 10 : 1));
    assert.equal(summarizeSeries(many).avg_inclusions_last_10, 1);
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
    assert.equal(
      decideZeroManualEdits({ stage1: measured(0), destaques: measured(0), newsletter: measured(1), titles: measured(0), social: un, images: measured(0) }),
      false,
    );
    assert.equal(
      decideZeroManualEdits({ stage1: measured(0), destaques: measured(0), newsletter: measured(0), titles: measured(0), social: un, images: measured(0) }),
      null,
    );
  });

  it("relatório de edição renderiza o veredito e o gate não medido", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-"));
    try {
      const edits = computeEditionManualEdits(makeEdition(root, { withBaseline: true, editNewsletter: true }), "260930");
      const html = renderManualEditsSection(edits);
      assert.match(html, /Modificações manuais/);
      assert.match(html, /RADAR/);
      assert.doesNotMatch(html, /Sequência sem modificação/, "sem série, sem a linha de sequência");
      // #9641: com a série, mostra a sequência N/3 e as inclusões da edição.
      const withSeries = renderManualEditsSection(
        { ...edits, inclusions: [{ url: "https://e/n", title: "Novo do editor", section: "RADAR" }] },
        summarizeSeries([mk("260929", true), mk("260930", true)]),
      );
      assert.match(withSeries, /Sequência sem modificação: <strong>2\/3<\/strong>/);
      assert.match(withSeries, /Inclusões: <strong>1<\/strong>/);
      assert.match(withSeries, /RADAR: Novo do editor/);
      assert.doesNotMatch(withSeries, /<li>\+\d+<\/li>/, "até 12 itens, sem o +N");
      // #9641: lista cortada em 12 mostra quantos ficaram de fora.
      const many = Array.from({ length: 15 }, (_, i) => ({ url: `https://e/${i}`, title: `Item ${i}`, section: "RADAR" }));
      const truncated = renderManualEditsSection({ ...edits, inclusions: many });
      assert.match(truncated, /Inclusões: <strong>15<\/strong>/);
      assert.equal((truncated.match(/<li>RADAR: /g) ?? []).length, 12);
      assert.match(truncated, /<li>\+3<\/li>/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #9647: destaques, títulos e artes casados por URL, não por posição
// ---------------------------------------------------------------------------

const DU = (id: string) => `https://example.com/destaque-${id}`;

/** Texto com os destaques dados (`titles[0]` é o título exibido; 3 opções = saída do writer). */
function destaquesMd(ds: Array<{ id: string; titles: string[] }>): string {
  const parts = ["Olá!", "", "---", ""];
  ds.forEach((d, i) => {
    parts.push(`**DESTAQUE ${i + 1} | 📰 NOTÍCIAS**`, "");
    for (const t of d.titles) parts.push(`**[${t}](${DU(d.id)})**  `, "");
    parts.push(`Parágrafo do destaque ${d.id}.`, "", "---", "");
  });
  parts.push("**📡 RADAR**", "", "**[Item](https://example.com/r)**", "Resumo.", "");
  return parts.join("\n");
}

const opts3 = (id: string) => [`${id} opção 1`, `${id} opção 2`, `${id} opção 3`];
/** Final: 1 título por destaque — o pick (opção 2) do destaque da pipeline, ou o título do destaque novo. */
const finalOf = (ids: string[]) => destaquesMd(ids.map((id) => ({ id, titles: [`${id} opção 2`] })));
const picksFor = (ids: string[]) => ({ picks: ids.map((id, i) => ({ destaque: i + 1, chosen: `${id} opção 2` })) });
const highlights = (ids: string[]) => ({ highlights: ids.map((id, i) => ({ rank: i + 1, url: DU(id), article: { url: DU(id), title: id } })) });

/**
 * Edição com 3 destaques. `pipeline` = destaques que a pipeline entregou
 * (3 opções de título cada); `final` = os do `02-reviewed.md`. `snapshot`:
 * baseline carimbado (`ok`) ou só `02-humanized.md` (reconstruído).
 * `redo`: posições cujas artes foram regeradas depois do Stage 3.
 */
function makeDestaqueEdition(
  root: string,
  o: {
    pipeline: string[];
    final: string[];
    snapshot?: boolean;
    categorizedTop?: string[];
    itensMovidos?: number;
    approvedFinal?: string[];
    redo?: number[];
    finalMd?: string;
  },
): string {
  const dir = makeEdition(root, {});
  const internal = join(dir, "_internal");
  writeFileSync(join(internal, "01-categorized.json"), JSON.stringify(highlights(o.categorizedTop ?? o.pipeline)), "utf8");
  writeFileSync(join(internal, "01-approved.json"), JSON.stringify(highlights(o.pipeline)), "utf8");
  writeFileSync(join(internal, ".step-1-gate.json"), JSON.stringify({ auto_approved: true, itens_movidos: o.itensMovidos ?? 0 }), "utf8");
  writeFileSync(join(internal, "02-title-picks.json"), JSON.stringify(picksFor(o.pipeline)), "utf8");
  const pipelineMd = destaquesMd(o.pipeline.map((id) => ({ id, titles: opts3(id) })));
  writeFileSync(join(internal, "02-draft.md"), pipelineMd, "utf8");
  writeFileSync(join(internal, "02-humanized.md"), pipelineMd, "utf8");
  if (o.snapshot) {
    writeFileSync(join(dir, "02-reviewed.md"), finalOf(o.pipeline), "utf8");
    captureStage2Baseline(dir, "pipeline-sentinel-step-2", new Date("2026-09-29T20:43:04.000Z"));
  }
  writeFileSync(join(dir, "02-reviewed.md"), o.finalMd ?? finalOf(o.final), "utf8");
  // Stage 4 nem sempre regrava o 01-approved.json (260917, 260918): só quando pedido.
  if (o.approvedFinal) writeFileSync(join(internal, "01-approved.json"), JSON.stringify(highlights(o.approvedFinal)), "utf8");
  const before = new Date("2026-09-29T20:49:00.000Z");
  const after = new Date("2026-09-29T22:13:00.000Z");
  for (const n of [1, 2, 3]) {
    const img = join(dir, `04-d${n}-2x1.jpg`);
    writeFileSync(img, "jpg", "utf8");
    const t = o.redo?.includes(n) ? after : before;
    utimesSync(img, t, t);
  }
  return dir;
}

const kinds = (g: { changes: Array<{ kind: string }> }) => g.changes.map((c) => c.kind).sort();

describe("destaques por URL (#9647)", () => {
  const e = (id: string, position: number): DestaqueEntry => ({ position, url: DU(id), title: id, titleOptions: [id] });

  it("extractDestaques: 3 opções de título por destaque; 1º título é o exibido", () => {
    const ds = extractDestaques(destaquesMd([{ id: "a", titles: opts3("a") }, { id: "b", titles: ["b só"] }]));
    assert.deepEqual(
      ds.map((d) => [d.position, d.url, d.title, d.titleOptions.length]),
      [
        [1, DU("a"), "a opção 1", 3],
        [2, DU("b"), "b só", 1],
      ],
    );
  });

  it("matchDestaquesByUrl: destaque novo inserido acima NÃO reordena os mantidos (260916)", () => {
    const m = matchDestaquesByUrl([e("a", 1), e("b", 2), e("c", 3)], [e("x", 1), e("a", 2), e("c", 3)]);
    assert.equal(m.swaps.length, 1);
    assert.equal(m.swaps[0].out.url, DU("b"));
    assert.equal(m.reorders.length, 0);
    assert.equal(m.statusByFinalPosition.get(2), "moved");
    assert.equal(m.statusByFinalPosition.get(3), "same");
  });

  it("matchDestaquesByUrl: D1↔D2 é UMA reordenação, não duas (260922)", () => {
    const m = matchDestaquesByUrl([e("a", 1), e("b", 2), e("c", 3)], [e("b", 1), e("a", 2), e("c", 3)]);
    assert.equal(m.swaps.length, 0);
    assert.equal(m.reorders.length, 1);
  });

  it("isCorrectedUrl: mesma página com o caminho corrigido casa; slug curto ou host diferente não (261001)", () => {
    const fixedUrl = "https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/";
    assert.equal(isCorrectedUrl("https://blog.google/innovation-and-ai/models-and-research/gemini-4-argon/", fixedUrl), true);
    assert.equal(isCorrectedUrl("https://a.com/x/news", "https://a.com/y/news"), false);
    assert.equal(isCorrectedUrl("https://a.com/x/gemini-4-argon", "https://b.com/x/gemini-4-argon"), false);
    const m = matchDestaquesByUrl(
      [{ position: 1, url: "https://blog.google/innovation-and-ai/models-and-research/gemini-4-argon/", title: "t", titleOptions: ["t"] }],
      [{ position: 1, url: fixedUrl, title: "t", titleOptions: ["t"] }],
    );
    assert.equal(m.swaps.length, 0, "URL corrigida não é troca");
    assert.equal(m.statusByFinalPosition.get(1), "same");
  });

  it("resolvePickUrls: o pick vai pro destaque cujas opções contêm o título escolhido", () => {
    const opts = extractDestaques(destaquesMd([{ id: "a", titles: opts3("a") }, { id: "b", titles: opts3("b") }]));
    const r = resolvePickUrls([{ destaque: 1, chosen: "b opção 3" }], opts, []);
    assert.equal(r[0].url, DU("b"));
  });

  it("260917/260918: troca do Stage 4 sem 01-approved regravado é vista; título e arte do novo são cascata", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9647-"));
    try {
      // Pipeline A,B,C → final B,X,Y (A e C trocados; B sobe pra D1 com o pick dele).
      const dir = makeDestaqueEdition(root, { pipeline: ["a", "b", "c"], final: ["b", "x", "y"], redo: [2, 3] });
      const r = computeEditionManualEdits(dir, "260930");
      assert.equal(r.gates.destaques.status, "measured");
      assert.equal(r.gates.destaques.baseline, "reconstructed");
      assert.deepEqual(kinds(r.gates.destaques), ["destaque-swap", "destaque-swap"]);
      assert.equal(r.gates.stage1.changes.length, 0, "a troca não é contada de novo no stage1");
      assert.equal(r.gates.titles.changes.length, 0, JSON.stringify(r.gates.titles, null, 2));
      assert.equal(r.gates.titles.cascades?.length, 2);
      assert.equal(r.gates.images.changes.length, 0);
      assert.equal(r.gates.images.cascades?.length, 2);
      assert.equal(r.zero_manual_edits, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("260916/260929: rebaixamento do apply-gate-edits (itens_movidos sob auto) não é troca", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9647-"));
    try {
      // Scorer: A,G,C; pipeline rebaixou G e entregou A,C,D. Editor não mexeu.
      const dir = makeDestaqueEdition(root, {
        pipeline: ["a", "c", "d"],
        final: ["a", "c", "d"],
        categorizedTop: ["a", "g", "c"],
        itensMovidos: 1,
        snapshot: true,
      });
      const r = computeEditionManualEdits(dir, "260930");
      assert.equal(r.gates.destaques.changes.length, 0, JSON.stringify(r.gates.destaques, null, 2));
      assert.equal(r.gates.stage1.changes.length, 0, JSON.stringify(r.gates.stage1, null, 2));
      assert.equal(r.gates.titles.changes.length, 0);
      assert.equal(r.zero_manual_edits, true, JSON.stringify(r.gates, null, 2));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("260916 sem baseline carimbado: categorizado × aprovado final também não conta o rebaixamento", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9647-"));
    try {
      const dir = makeDestaqueEdition(root, { pipeline: ["a", "c", "d"], final: ["a", "c", "d"], categorizedTop: ["a", "g", "c"], itensMovidos: 1 });
      const r = computeEditionManualEdits(dir, "260930");
      assert.equal(r.gates.stage1.baseline, "categorized");
      assert.equal(r.gates.stage1.changes.length, 0, JSON.stringify(r.gates.stage1, null, 2));
      assert.equal(r.gates.destaques.changes.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("261005: D3→D1 é 1 reordenação + 1 troca (não 2 trocas); título mantido não conta; arte do novo é cascata", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9647-"));
    try {
      // Pipeline A,B,C → final C,B,K. 01-approved regravado. Arte de C movida com `mv`
      // pra D1 (mtime preservado, não detectada); D3 regerada pro K.
      const dir = makeDestaqueEdition(root, {
        pipeline: ["a", "b", "c"],
        final: ["c", "b", "k"],
        approvedFinal: ["c", "b", "k"],
        snapshot: true,
        redo: [3],
      });
      const r = computeEditionManualEdits(dir, "260930");
      assert.equal(r.gates.destaques.baseline, "snapshot");
      assert.deepEqual(kinds(r.gates.destaques), ["destaque-reorder", "destaque-swap"], JSON.stringify(r.gates.destaques, null, 2));
      const swap = r.gates.destaques.changes.find((c) => c.kind === "destaque-swap")!;
      assert.equal(swap.url, DU("k"));
      assert.equal(r.gates.stage1.changes.length, 0, JSON.stringify(r.gates.stage1, null, 2));
      assert.equal(r.gates.titles.changes.length, 0, "C saiu em D1 com o pick dele (era D3)");
      assert.equal(r.gates.images.changes.length, 0);
      assert.equal(r.gates.images.cascades?.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("destaque mantido na mesma posição: título reescrito e arte regerada CONTAM", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9647-"));
    try {
      const finalMd = finalOf(["a", "b", "c"]).replace("b opção 2", "b reescrito pelo editor");
      const dir = makeDestaqueEdition(root, { pipeline: ["a", "b", "c"], final: ["a", "b", "c"], snapshot: true, redo: [2], finalMd });
      const r = computeEditionManualEdits(dir, "260930");
      assert.equal(r.gates.destaques.changes.length, 0);
      assert.deepEqual(kinds(r.gates.titles), ["title-choice"]);
      assert.match(r.gates.titles.changes[0].detail, /^D2: pipeline escolheu "b opção 2"/);
      assert.deepEqual(kinds(r.gates.images), ["image-redo"]);
      assert.equal(r.gates.images.cascades, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("destaque reposicionado com título reescrito: conta como título, comparado com o pick DELE", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9647-"));
    try {
      const finalMd = finalOf(["b", "a", "c"]).replace("b opção 2", "b reescrito");
      const dir = makeDestaqueEdition(root, { pipeline: ["a", "b", "c"], final: ["b", "a", "c"], snapshot: true, finalMd });
      const r = computeEditionManualEdits(dir, "260930");
      assert.deepEqual(kinds(r.gates.destaques), ["destaque-reorder"]);
      assert.equal(r.gates.titles.changes.length, 1, JSON.stringify(r.gates.titles, null, 2));
      assert.match(r.gates.titles.changes[0].detail, /^D1 \(era D2\): pipeline escolheu "b opção 2", saiu "b reescrito"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem texto da pipeline legível (formato antigo): destaques caem no categorizado × aprovado final", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9647-"));
    try {
      const dir = makeEdition(root, {});
      writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(highlights(["x", "d2", "d3"])), "utf8");
      writeFileSync(join(dir, "_internal", "01-categorized.json"), JSON.stringify(highlights(["d1", "d2", "d3"])), "utf8");
      const r = computeEditionManualEdits(dir, "260930");
      assert.equal(r.gates.destaques.baseline, "categorized");
      assert.deepEqual(kinds(r.gates.destaques), ["destaque-swap"]);
      assert.equal(r.zero_manual_edits, false, "edição antiga com troca não vira null");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("relatório mostra as cascatas sem contá-las", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9647-"));
    try {
      const dir = makeDestaqueEdition(root, { pipeline: ["a", "b", "c"], final: ["b", "x", "y"], redo: [2, 3] });
      const html = renderManualEditsSection(computeEditionManualEdits(dir, "260930"));
      assert.match(html, /destaques/);
      assert.match(html, /\+2 em cascata, não contam/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

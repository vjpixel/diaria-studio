/**
 * test/studio-gate.test.ts (#6447 Fatia 1)
 *
 * Painel "Gate" (`scripts/studio-ui/studio-gate.ts`) — checklist de conclusão
 * + resumo consolidado (títulos original/final, WhatsApp, meta description,
 * fact-check, boxes, violations), tudo lido de disco (sem servidor rodando,
 * sem LLM). Roda contra um `rootDir` tmpdir injetado — nunca toca `data/`
 * real, mesmo padrão de `test/studio-review.test.ts`.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGateSummary, buildChecklist } from "../scripts/studio-ui/studio-gate.ts";
import type { LintReport } from "../scripts/studio-ui/studio-review.ts";

const ONE_TITLE_PER_DESTAQUE_MD = [
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  "**[IA chega às fábricas brasileiras](https://example.com/1)**",
  "",
  "Corpo do primeiro destaque com contexto suficiente.",
  "",
  "Por que isso importa: automatização industrial tem impacto direto no emprego.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | PESQUISA**",
  "",
  "**[Modelos de linguagem superam humanos em diagnóstico](https://example.com/2)**",
  "",
  "Corpo do segundo destaque.",
  "",
  "Por que isso importa: abre caminho para triagem automatizada em clínicas.",
  "",
].join("\n");

// Mesma estrutura acima, mas D1 com 2 opções de título ainda não podadas —
// dispara `titles-per-highlight` (o mesmo check que já bloqueia o gate real).
const TWO_TITLES_ON_D1_MD = [
  "**DESTAQUE 1 | LANÇAMENTO**",
  "",
  "**[IA chega às fábricas brasileiras](https://example.com/1)**",
  "",
  "**[Fábricas brasileiras adotam IA em massa](https://example.com/1)**",
  "",
  "Corpo do primeiro destaque com contexto suficiente.",
  "",
  "Por que isso importa: automatização industrial tem impacto direto no emprego.",
  "",
  "---",
  "",
  "**DESTAQUE 2 | PESQUISA**",
  "",
  "**[Modelos de linguagem superam humanos em diagnóstico](https://example.com/2)**",
  "",
  "Corpo do segundo destaque.",
  "",
  "Por que isso importa: abre caminho para triagem automatizada em clínicas.",
  "",
].join("\n");

function makeEdition(root: string, aammdd: string): string {
  const dir = resolve(root, "data", "editions", aammdd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, "_internal"), { recursive: true });
  return dir;
}

describe("buildGateSummary (#6447 Fatia 1)", () => {
  let root: string;
  let editionDir: string;
  const aammdd = "260716";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "studio-gate-"));
    editionDir = makeEdition(root, aammdd);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("edição inexistente: editionExists=false, ok=false, sem lançar", () => {
    const summary = buildGateSummary(root, "999999");
    assert.equal(summary.editionExists, false);
    assert.equal(summary.ok, false);
    assert.deepEqual(summary.highlights, []);
    assert.deepEqual(summary.checklist, []);
  });

  it("edição vazia (nenhum arquivo de stage ainda): degrada tudo com note, nunca lança", () => {
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.editionExists, true);
    assert.equal(summary.highlights.length, 0);
    assert.equal(summary.whatsappUrl, null);
    assert.equal(summary.metaDescriptionSuggestion, null);
    assert.equal(summary.factCheck.available, false);
    assert.ok(summary.factCheck.note);
    assert.equal(summary.factCheckAutofix.available, false);
    assert.equal(summary.boxSelection.available, false);
    assert.equal(summary.renderWarnings.available, false);
  });

  it("títulos: cruza 01-approved.json (original) com countTitlesPerHighlight de 02-reviewed.md (final) — resolvido quando title_count===1", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(
      resolve(editionDir, "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: [
          { url: "https://example.com/1", title: "Fábricas usam robôs com IA (fonte original)" },
          { url: "https://example.com/2", title: "LLM diagnostica doenças (fonte original)" },
        ],
      }),
      "utf8",
    );
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.highlights.length, 2);
    const d1 = summary.highlights.find((h) => h.n === 1)!;
    assert.equal(d1.originalTitle, "Fábricas usam robôs com IA (fonte original)");
    assert.equal(d1.finalTitle, "IA chega às fábricas brasileiras");
    assert.equal(d1.titleCount, 1);
    assert.equal(d1.resolved, true);
  });

  it("títulos: originalTitle cai pro fallback aninhado approved.highlights[n].article.title quando .title falta (#6449 achado do pr-test-analyzer)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(
      resolve(editionDir, "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: [
          { url: "https://example.com/1", article: { title: "Fábricas usam robôs com IA (aninhado)" } },
          { url: "https://example.com/2", title: "LLM diagnostica doenças (fonte original)" },
        ],
      }),
      "utf8",
    );
    const summary = buildGateSummary(root, aammdd);
    const d1 = summary.highlights.find((h) => h.n === 1)!;
    assert.equal(d1.originalTitle, "Fábricas usam robôs com IA (aninhado)");
  });

  it("checklist titles-per-highlight: falha quando um destaque ainda tem >1 título (poda pendente)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), TWO_TITLES_ON_D1_MD, "utf8");
    const summary = buildGateSummary(root, aammdd);
    const d1 = summary.highlights.find((h) => h.n === 1)!;
    assert.equal(d1.resolved, false);
    assert.equal(d1.titleCount, 2);
    assert.equal(d1.finalTitle, null);

    const item = summary.checklist.find((c) => c.id === "titles-per-highlight")!;
    assert.equal(item.ok, false);
    assert.match(item.detail, /D1/);
    assert.equal(summary.ok, false);
  });

  it("checklist titles-per-highlight: ok quando todos os destaques têm exatamente 1 título", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    const summary = buildGateSummary(root, aammdd);
    const item = summary.checklist.find((c) => c.id === "titles-per-highlight")!;
    assert.equal(item.ok, true);
    assert.equal(item.detail, "");
  });

  it("checklist fact-check: sem fact-check.json -> pendente (ok:false, note explicativa)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    const summary = buildGateSummary(root, aammdd);
    const item = summary.checklist.find((c) => c.id === "fact-check")!;
    assert.equal(item.ok, false);
    assert.ok(item.detail.length > 0);
  });

  it("checklist fact-check: attention_items=0 -> ok", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(
      resolve(editionDir, "_internal", "fact-check.json"),
      JSON.stringify({
        edition: aammdd,
        checked_at: new Date().toISOString(),
        claims: [],
        summary: { total: 3, sustained: 3, divergent: 0, not_found_in_source: 0, source_unreachable: 0, inferred: 0, attention_items: 0 },
      }),
      "utf8",
    );
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.factCheck.available, true);
    if (summary.factCheck.available) assert.equal(summary.factCheck.blockingCount, 0);
    const item = summary.checklist.find((c) => c.id === "fact-check")!;
    assert.equal(item.ok, true);
  });

  it("checklist fact-check: claim NOT_FOUND_IN_SOURCE não-superlativo -> falha com blockingCount no detail", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(
      resolve(editionDir, "_internal", "fact-check.json"),
      JSON.stringify({
        edition: aammdd,
        checked_at: new Date().toISOString(),
        claims: [
          { destaque: 1, claim_type: "number", text: "R$ 500 milhões", context: "x", sources: ["newsletter"], verdict: "NOT_FOUND_IN_SOURCE" },
        ],
        summary: { total: 3, sustained: 2, divergent: 0, not_found_in_source: 1, source_unreachable: 0, inferred: 0, attention_items: 1 },
      }),
      "utf8",
    );
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.factCheck.available, true);
    if (summary.factCheck.available) assert.equal(summary.factCheck.blockingCount, 1);
    const item = summary.checklist.find((c) => c.id === "fact-check")!;
    assert.equal(item.ok, false);
    assert.match(item.detail, /1/);
  });

  it("checklist fact-check: attention_items>0 mas SÓ claims não-bloqueantes (DIVERGENT/superlative) -> ok=true, sem falso-negativo (#6449 achado do code-reviewer)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(
      resolve(editionDir, "_internal", "fact-check.json"),
      JSON.stringify({
        edition: aammdd,
        checked_at: new Date().toISOString(),
        claims: [
          { destaque: 1, claim_type: "number", text: "GPT-4o", context: "x", sources: ["newsletter"], verdict: "DIVERGENT" },
          { destaque: 2, claim_type: "superlative", text: "primeira vez", context: "x", sources: ["newsletter"], verdict: "NOT_FOUND_IN_SOURCE" },
        ],
        summary: { total: 3, sustained: 1, divergent: 1, not_found_in_source: 1, source_unreachable: 0, inferred: 0, attention_items: 2 },
      }),
      "utf8",
    );
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.factCheck.available, true);
    if (summary.factCheck.available) {
      assert.equal(summary.factCheck.summary.attention_items, 2, "attention_items continua exposto pra exibição informativa completa");
      assert.equal(summary.factCheck.blockingCount, 0, "nem DIVERGENT nem superlative bloqueiam o gate real (getBlockingClaims)");
    }
    const item = summary.checklist.find((c) => c.id === "fact-check")!;
    assert.equal(item.ok, true, "checklist não deve mostrar pendência quando nenhuma claim bloqueia de verdade");
  });

  it("checklist lint-violations: conta falhas bloqueantes agregadas de reviewed + social", () => {
    // Sem 01-approved.json e sem intentional-error.json, `02-reviewed.md`
    // sozinho já dispara vários checks bloqueantes (intentional-error-flagged
    // etc.) — suficiente pra provar que o agregador conta > 0.
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    const summary = buildGateSummary(root, aammdd);
    const item = summary.checklist.find((c) => c.id === "lint-violations")!;
    assert.equal(item.ok, false);
    assert.match(item.detail, /\d+ violation/);
  });

  it("checklist lint-violations: crash do lint runner (checks:[], ok:false) NUNCA mostra 'sem violations' verde (#6449 achado do code-reviewer)", () => {
    const crashedReport: LintReport = { ok: false, checks: [], skipped: [], note: "Lints indisponíveis (erro inesperado ao rodar): boom" };
    const okReport: LintReport = { ok: true, checks: [{ id: "x", label: "x", blocking: true, ok: true, crashed: false }], skipped: [] };
    const items = buildChecklist([], crashedReport, okReport, { available: false, note: "sem fact-check" });
    const item = items.find((c) => c.id === "lint-violations")!;
    assert.equal(item.ok, false, "checks:[] não pode ser confundido com '0 violations' quando ok:false diz que o runner crashou");
    assert.match(item.detail, /boom/, "detail expõe o motivo do crash, não '0 violation(ões)'");
  });

  it("fact-check-autofix: lê fact-check-autofix.json real do disco e mapeia social_modified -> socialModified (#6449 achado do pr-test-analyzer)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(
      resolve(editionDir, "_internal", "fact-check-autofix.json"),
      JSON.stringify({
        edition: aammdd,
        applied_at: new Date().toISOString(),
        dry_run: false,
        intentional_error_destaque: null,
        entries: [],
        summary: { total_divergent: 2, applied: 1, skipped: 1 },
        social_modified: true,
      }),
      "utf8",
    );
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.factCheckAutofix.available, true);
    if (summary.factCheckAutofix.available) {
      assert.deepEqual(summary.factCheckAutofix.summary, { total_divergent: 2, applied: 1, skipped: 1 });
      assert.equal(summary.factCheckAutofix.socialModified, true);
    }
  });

  it("box-selection: expõe os slots quando o arquivo existe", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(
      resolve(editionDir, "_internal", "box-selection.json"),
      JSON.stringify([
        { slot: 1, mode: "auto", file: "apoio.md", nome: "Apoio", score: 0.8, trend: null, editionsAppeared: 3, seasonal: false },
      ]),
      "utf8",
    );
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.boxSelection.available, true);
    assert.equal(summary.boxSelection.slots!.length, 1);
    assert.equal(summary.boxSelection.slots![0].nome, "Apoio");
  });

  it("render-warnings: expõe os eventos quando o arquivo existe", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(
      resolve(editionDir, "_internal", "render-warnings.json"),
      JSON.stringify({ generated_at: new Date().toISOString(), warnings: [{ event: "whatsapp_share_no_d1", edition: aammdd }] }),
      "utf8",
    );
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.renderWarnings.available, true);
    assert.equal(summary.renderWarnings.events.length, 1);
    assert.equal(summary.renderWarnings.events[0].event, "whatsapp_share_no_d1");
  });

  it("whatsappUrl/metaDescriptionSuggestion: lidos de stage4-capture-state.json (#5414)", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(
      resolve(editionDir, "_internal", "stage4-capture-state.json"),
      JSON.stringify({
        whatsappUrl: "https://diar.ia.br/edicao/x?utm=whatsapp",
        metaDescriptionSuggestion: "Resumo do D1 pra SEO.",
        capturedAt: new Date().toISOString(),
      }),
      "utf8",
    );
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.whatsappUrl, "https://diar.ia.br/edicao/x?utm=whatsapp");
    assert.equal(summary.metaDescriptionSuggestion, "Resumo do D1 pra SEO.");
  });

  it("nunca lança mesmo com JSON corrompido em qualquer um dos arquivos consumidos", () => {
    writeFileSync(resolve(editionDir, "02-reviewed.md"), ONE_TITLE_PER_DESTAQUE_MD, "utf8");
    writeFileSync(resolve(editionDir, "_internal", "01-approved.json"), "{not json", "utf8");
    writeFileSync(resolve(editionDir, "_internal", "fact-check.json"), "{not json", "utf8");
    writeFileSync(resolve(editionDir, "_internal", "box-selection.json"), "{not json", "utf8");
    writeFileSync(resolve(editionDir, "_internal", "render-warnings.json"), "{not json", "utf8");
    assert.doesNotThrow(() => buildGateSummary(root, aammdd));
    const summary = buildGateSummary(root, aammdd);
    assert.equal(summary.factCheck.available, false);
    assert.equal(summary.boxSelection.available, false);
    assert.equal(summary.renderWarnings.available, false);
  });
});

/**
 * #10135 — a recorrência (`recurring_editor_request`) usa o classificador
 * ATUAL, não o rótulo gravado no `editor-requests.jsonl` no dia da edição.
 *
 * Caso real: 261005–261009 gravaram 9 `title-choice` e 7 `length-cut` com o
 * classificador anterior ao #9879/#9880 (corte de item de pool virava
 * `length-cut`; 1º item do RADAR cortado virava `title-choice`). Reclassificando
 * stage2-post-gate × 02-reviewed.md com o código atual, os dois somem — e o
 * auto-report seguia abrindo #10090 e reforçando #9422 com os rótulos velhos.
 * Fixtures sintéticas no formato real dessas edições (data/ não vai pro CI).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSignals,
  readEditorRequestsForEditions,
  reclassifyEditorRequests,
  signalsFromRecurringEditorRequests,
} from "../scripts/collect-edition-signals.ts";
import { rederiveStage2FileRequests } from "../scripts/derive-editor-requests.ts";

function item(title: string, url: string, desc: string): string {
  return [`**[${title}](${url})**  `, desc, ""].join("\n");
}
function section(header: string, items: string[]): string {
  return ["---", "", header, "", ...items, "---", ""].join("\n");
}
const A = item("Como usar IA para produtividade", "https://querobolsa.com.br/revista/como-usar-ia", "Guia com usos de ChatGPT, Claude e Gemini no dia a dia. (10 min)");
const B = item("Ideias de mochila maluca infantil", "https://www.techtudo.com.br/guia/2026/10/mochila.ghtml", "Entenda como funciona a trend que está bombando nas redes. (15 min)");
const C = item("Claude Code Mods Tutorial", "https://app.therundown.ai/guides/claude-code-mods-tutorial", "Aprenda a usar os mods do Claude Code. (10 min)");
const D = item("Incident Command Dashboard", "https://www.chatprd.ai/how-i-ai/workflows/dashboard", "Monte um painel em tempo real para coordenar incidentes. (5 min)");
const E = item("Decisions API is now available", "https://community.openai.com/t/decisions-api/1403877", "A Decisions API entrou em beta público.");

// Pipeline (snapshot stage2-post-gate) × editor (02-reviewed.md final):
// USE MELHOR 4→2 e 1º item do RADAR cortado — só corte de ITEM de pool.
const BASELINE_MD = section("**🛠️ USE MELHOR**", [A, B, C, D]) + section("**📡 RADAR**", [E, A, B]);
const FINAL_MD = section("**🛠️ USE MELHOR**", [A, C]) + section("**📡 RADAR**", [A, B]);

/** Rótulos que o classificador antigo gravou pra esse mesmo diff. */
function legacyLine(edition: string, request_type: string, target: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: `${edition}T12:00:00Z`, edition, stage: 4, request_type, target,
    description: `rótulo antigo ${request_type} ${target}`, resolution: "accepted", source: "derived", ...extra,
  });
}

function writeEdition(editionsRoot: string, edition: string, opts: { snapshot: boolean; extraLines?: string[] }): string {
  const dir = join(editionsRoot, edition);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), FINAL_MD);
  if (opts.snapshot) {
    const snap = join(dir, "_internal/editor-request-snapshots/stage2-post-gate");
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(snap, "02-reviewed.md"), BASELINE_MD);
  }
  const lines = [
    legacyLine(edition, "length-cut", "use-melhor"),
    legacyLine(edition, "title-choice", "radar"),
    ...(opts.extraLines ?? []),
  ];
  writeFileSync(join(dir, "_internal/editor-requests.jsonl"), lines.join("\n") + "\n");
  return dir;
}

const titles = (signals: Array<{ title: string }>) => signals.map((s) => s.title).sort();

describe("recorrência usa o classificador atual (#10135)", () => {
  it("caso real 261005–261009: rótulos antigos title-choice/length-cut → zero com o classificador atual", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-10135-"));
    try {
      const editions = ["261005", "261006", "261007", "261008", "261009"].map((edition) => ({
        edition,
        dir: writeEdition(root, edition, { snapshot: true }),
      }));
      const recorded = readEditorRequestsForEditions(editions);

      // Sem reclassificar (comportamento antigo): o alarme dispara pelos rótulos velhos.
      const before = titles(signalsFromRecurringEditorRequests(recorded));
      assert.ok(before.includes("Pedido recorrente do editor: length-cut"));
      assert.ok(before.includes("Pedido recorrente do editor: title-choice"));

      const after = signalsFromRecurringEditorRequests(
        reclassifyEditorRequests(recorded, editions, rederiveStage2FileRequests),
      );
      assert.deepEqual(titles(after), ["Pedido recorrente do editor: pool-cut"]);
      assert.equal(after[0].details.edition_count, 5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("collectSignals ponta a ponta não abre title-choice/length-cut para o caso real", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-10135-e2e-"));
    try {
      const editionsRoot = join(root, "data/editions");
      mkdirSync(editionsRoot, { recursive: true });
      let current = "";
      for (const ed of ["261005", "261006", "261007", "261008", "261009"]) {
        current = writeEdition(editionsRoot, ed, { snapshot: true });
      }
      const draft = collectSignals({ rootDir: root, editionDir: current });
      const recurring = draft.signals.filter((s) => s.kind === "recurring_editor_request");
      // 5 edições não formam taxa-base medida (#11337): nenhum sinal — e,
      // principalmente, nada de title-choice/length-cut pelos rótulos velhos.
      assert.deepEqual(titles(recurring), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição sem snapshot stage2-post-gate cai no rótulo gravado (fallback)", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-10135-fallback-"));
    try {
      const editions = ["261005", "261006", "261007"].map((edition) => ({
        edition,
        dir: writeEdition(root, edition, { snapshot: false }),
      }));
      const merged = reclassifyEditorRequests(readEditorRequestsForEditions(editions), editions, rederiveStage2FileRequests);
      assert.ok(titles(signalsFromRecurringEditorRequests(merged)).includes("Pedido recorrente do editor: length-cut"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pedido manual e derivado do Stage 1 são preservados; derivado do Stage 6 é substituído", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-10135-keep-"));
    try {
      const manual = JSON.stringify({
        timestamp: "t", edition: "261005", stage: 4, request_type: "tone", target: "d1",
        description: "manual", resolution: "accepted", source: "manual",
      });
      const legacyNoSource = JSON.stringify({
        timestamp: "t", edition: "261005", stage: 4, request_type: "lead-rewrite", target: "d2",
        description: "linha antiga sem source", resolution: "accepted",
      });
      const stage1 = legacyLine("261005", "destaque-swap", "d1", { stage: 1 });
      const stage6 = legacyLine("261005", "length-cut", "radar", { stage: 6 });
      const dir = writeEdition(root, "261005", { snapshot: true, extraLines: [manual, legacyNoSource, stage1, stage6] });
      const editions = [{ edition: "261005", dir }];
      const merged = reclassifyEditorRequests(readEditorRequestsForEditions(editions), editions, rederiveStage2FileRequests)["261005"];
      const kinds = merged.map((e) => `${e.stage}:${e.request_type}:${e.target}`).sort();
      assert.ok(kinds.includes("4:tone:d1"));
      assert.ok(kinds.includes("4:lead-rewrite:d2"));
      assert.ok(kinds.includes("1:destaque-swap:d1"));
      assert.ok(!kinds.some((k) => k.includes("length-cut") || k.includes("title-choice")));
      assert.ok(merged.filter((e) => e.request_type === "pool-cut").every((e) => e.context?.reclassified === "#10135"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rederive que lança cai no rótulo gravado, sem derrubar a coleta", () => {
    const recorded = {
      "261005": [{ timestamp: "t", edition: "261005", stage: 4, request_type: "length-cut", target: "radar", description: "x", resolution: "accepted" as const, source: "derived" }],
    };
    const merged = reclassifyEditorRequests(recorded, [{ edition: "261005", dir: "/nao/existe" }], () => {
      throw new Error("boom");
    });
    assert.deepEqual(merged, recorded);
  });
});

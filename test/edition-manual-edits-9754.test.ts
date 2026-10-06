/**
 * #9754 — gate `social` da métrica de edições manuais (#7972) e `reordered`
 * do gate4-highlight-changes:
 * 1. social: Social×Curto fundidos, casamento posicional (reorder = edição),
 *    CRLF gerando diff;
 * 2. `reordered` divergia de `matchDestaquesByUrl.reorders` (LIS).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEditionManualEdits, diffSocialSections } from "../scripts/edition-manual-edits.ts";
import { captureStage2Baseline } from "../scripts/lib/editor-request-snapshots.ts";
import { compareHighlights } from "../scripts/lib/gate4-highlight-changes.ts";

const U1 = "https://example.com/historia-alfa-longa";
const U2 = "https://example.com/historia-bravo-longa";
const U3 = "https://example.com/historia-charlie-longa";
const U4 = "https://example.com/historia-delta-longa";

const T = {
  a: "Texto longo sobre a primeira história, com detalhes do modelo novo da Anthropic.",
  b: "Texto longo sobre a segunda história, com números de adoção em empresas brasileiras.",
  c: "Texto longo sobre a terceira história, com a regulação europeia e prazos de conformidade.",
  d: "Texto longo sobre uma história totalmente diferente, envolvendo chips e exportação.",
};
const curto = { a: "Curto alfa.", b: "Curto bravo.", c: "Curto charlie." };

function social(order: Array<keyof typeof curto>, overrides: Partial<Record<string, string>> = {}): string {
  const out = ["# Social", ""];
  order.forEach((k, i) => out.push(`## d${i + 1}`, "", overrides[`social-${k}`] ?? T[k], ""));
  out.push("# Curto", "");
  order.forEach((k, i) => out.push(`## d${i + 1}`, "", overrides[`curto-${k}`] ?? curto[k], ""));
  return out.join("\n");
}
const urls = (...u: string[]) => new Map(u.map((x, i) => [`d${i + 1}`, x]));

describe("diffSocialSections (#9754 item 1)", () => {
  it("reordenação pura D1↔D3 (URLs dos dois lados) → nenhuma edição", () => {
    const r = diffSocialSections(social(["a", "b", "c"]), social(["c", "b", "a"]), urls(U1, U2, U3), urls(U3, U2, U1));
    assert.deepEqual(r.changes, []);
    assert.deepEqual(r.cascades, []);
  });

  it("Social e Curto são seções distintas: editar só o Curto d2 → 1 mudança curto/d2", () => {
    const r = diffSocialSections(
      social(["a", "b", "c"]),
      social(["a", "b", "c"], { "curto-b": "Curto bravo reescrito." }),
      urls(U1, U2, U3),
      urls(U1, U2, U3),
    );
    assert.deepEqual(r.changes.map((c) => c.detail), ["curto/d2: +1/-1"]);
  });

  it("CRLF só no fim de linha → nenhuma edição", () => {
    const base = social(["a", "b", "c"]);
    const r = diffSocialSections(base, base.replace(/\n/g, "\r\n"), urls(U1, U2, U3), urls(U1, U2, U3));
    assert.deepEqual(r.changes, []);
  });

  it("destaque trocado (URL nova) → texto novo é cascata, não edição", () => {
    const fin = social(["a", "b", "c"], { "social-c": T.d, "curto-c": "Curto delta." });
    const r = diffSocialSections(social(["a", "b", "c"]), fin, urls(U1, U2, U3), urls(U1, U2, U4));
    assert.deepEqual(r.changes, []);
    assert.ok(r.cascades.length >= 2, JSON.stringify(r.cascades));
  });

  it("reescrita real de destaque mantido que mudou de posição conta, com o nome das duas posições", () => {
    const fin = social(["c", "b", "a"], { "social-a": `${T.a} Frase nova do editor.` });
    const r = diffSocialSections(social(["a", "b", "c"]), fin, urls(U1, U2, U3), urls(U3, U2, U1));
    assert.deepEqual(r.changes.map((c) => c.detail), ["social/d1→d3: +1/-1"]);
    assert.equal(r.changes[0].url, U1);
  });

  it("sem URL: destaque de mesmo nome com texto totalmente novo ainda é comparado por nome", () => {
    const fin = social(["a", "b", "c"], { "social-c": T.d });
    const r = diffSocialSections(social(["a", "b", "c"]), fin);
    assert.deepEqual(r.changes.map((c) => c.detail), ["social/d3: +1/-1"]);
  });
});

describe("computeEditionManualEdits — gate social (#9754 item 1, em disco)", () => {
  it("03-social.md final só reordenado e em CRLF → gate social sem mudança", () => {
    const root = mkdtempSync(join(tmpdir(), "manual-edits-9754-"));
    try {
      const dir = join(root, "2610", "261099");
      const internal = join(dir, "_internal");
      mkdirSync(internal, { recursive: true });
      const approved = (u: string[]) => JSON.stringify({ highlights: u.map((url) => ({ article: { url, title: url } })) });
      writeFileSync(join(internal, "01-approved.json"), approved([U1, U2, U3]), "utf8");
      writeFileSync(join(dir, "02-reviewed.md"), "Olá!\n", "utf8");
      writeFileSync(join(dir, "03-social.md"), social(["a", "b", "c"]), "utf8");
      const step2 = new Date("2026-10-05T20:00:00.000Z");
      writeFileSync(join(internal, ".step-2-done.json"), JSON.stringify({ step: 2, completed_at: step2.toISOString() }), "utf8");
      captureStage2Baseline(dir, "pipeline-sentinel-step-2", new Date(step2.getTime() + 5000));
      // Editor reordena D1↔D3 no gate 4; o arquivo final sai em CRLF.
      writeFileSync(join(internal, "01-approved.json"), approved([U3, U2, U1]), "utf8");
      writeFileSync(join(dir, "03-social.md"), social(["c", "b", "a"]).replace(/\n/g, "\r\n"), "utf8");
      const r = computeEditionManualEdits(dir, "261099");
      assert.equal(r.gates.social.status, "measured");
      assert.deepEqual(r.gates.social.changes, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("compareHighlights.reordered segue matchDestaquesByUrl.reorders (#9754 item 2)", () => {
  const dest = (n: number, title: string, url: string) =>
    [`**DESTAQUE ${n} | 🔬 PESQUISA**`, "", `**[${title}](${url})**  `, "", `Corpo ${n}.`, "", "---", ""].join("\n");

  it("item promovido acima: mantidos só descem → nenhum reordenado", () => {
    const base = [dest(1, "Alfa", U1), dest(2, "Bravo", U2), dest(3, "Charlie", U3)].join("\n");
    const fin = [dest(1, "Delta", U4), dest(2, "Alfa", U1), dest(3, "Bravo", U2)].join("\n");
    const cmp = compareHighlights(base, fin);
    assert.deepEqual(cmp.highlights.map((h) => h.reordered), [false, false, false]);
  });

  it("troca de ordem real entre mantidos → só o que saiu da ordem relativa é reordenado", () => {
    const base = [dest(1, "Alfa", U1), dest(2, "Bravo", U2), dest(3, "Charlie", U3)].join("\n");
    const fin = [dest(1, "Charlie", U3), dest(2, "Alfa", U1), dest(3, "Bravo", U2)].join("\n");
    const cmp = compareHighlights(base, fin);
    assert.deepEqual(cmp.highlights.map((h) => h.reordered), [true, false, false]);
  });
});

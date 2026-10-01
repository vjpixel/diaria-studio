/**
 * #9308 — teste A/B de CONTEÚDO (caixa) no envio Clarice mensal: config
 * declarativa, resolução do HTML por braço, divisão 50/50 VA/VB, nome de
 * lista e guards dos caminhos legados de HTML único. Nada toca a Brevo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertArmsDiffer,
  assertNoAbTestForSingleHtmlPath,
  parseClariceAbTest,
  readClariceAbTest,
  resolveCampaignHtmlPath,
  variantArmFromKey,
} from "../scripts/lib/clarice-ab-test.ts";
import { buildVariantCells, resolveCellStrategy } from "../scripts/lib/clarice-group-cells.ts";
import { waveKey } from "../scripts/lib/clarice-wave-plan.ts";
import { groupCellListNameFor, isGroupCellWave } from "../scripts/clarice-import-waves.ts";

function monthlyFixture(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ab-test-9308-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  if (config !== undefined) {
    writeFileSync(join(dir, "_internal", "ab-test.json"), typeof config === "string" ? config : JSON.stringify(config));
  }
  return dir;
}

const CFG = {
  label: "caixa",
  arms: { a: "_internal/cloudflare-preview-caixa-a.html", b: "_internal/cloudflare-preview-caixa-b.html" },
};

describe("#9308 clarice-ab-test — config", () => {
  it("ausente => null (comportamento de sempre)", () => {
    const dir = monthlyFixture();
    assert.equal(readClariceAbTest(dir), null);
    rmSync(dir, { recursive: true, force: true });
  });

  it("presente => braços resolvidos contra o dir do ciclo", () => {
    const dir = monthlyFixture(CFG);
    const c = readClariceAbTest(dir)!;
    assert.equal(c.label, "caixa");
    assert.equal(c.arms.a, resolve(dir, CFG.arms.a));
    assert.equal(c.arms.b, resolve(dir, CFG.arms.b));
    rmSync(dir, { recursive: true, force: true });
  });

  it("JSON quebrado ou campos faltando => LANÇA (nunca cai em silêncio no html default)", () => {
    const dir = monthlyFixture("{ nao json");
    assert.throws(() => readClariceAbTest(dir), /JSON inválido/);
    rmSync(dir, { recursive: true, force: true });
    assert.throws(() => parseClariceAbTest({ arms: CFG.arms }, "/m"), /label/);
    assert.throws(() => parseClariceAbTest({ label: "caixa", arms: { a: "x.html" } }, "/m"), /arms/);
    assert.throws(() => parseClariceAbTest({ label: "caixa", arms: { a: "x.html", b: "x.html" } }, "/m"), /MESMO/);
    assert.throws(() => parseClariceAbTest({ label: "com espaço", arms: CFG.arms }, "/m"), /label/);
  });

  it("assertArmsDiffer recusa HTMLs idênticos", () => {
    assert.throws(() => assertArmsDiffer("<p>x</p>", "<p>x</p>"), /idênticos/);
    assert.doesNotThrow(() => assertArmsDiffer("<p>a</p>", "<p>b</p>"));
  });
});

describe("#9308 clarice-ab-test — html por campanha", () => {
  const cfg = parseClariceAbTest(CFG, "/m");

  it("variantArmFromKey só reconhece -VA/-VB", () => {
    assert.equal(variantArmFromKey("d6-qui06-VA"), "a");
    assert.equal(variantArmFromKey("d6-qui06-VB"), "b");
    assert.equal(variantArmFromKey("d6-qui06-A"), null, "-A é célula de ASSUNTO, não variante");
    assert.equal(variantArmFromKey("d6-qui06-H06"), null);
    assert.equal(variantArmFromKey("d6-qui06"), null);
  });

  it("VA => html A, VB => html B, key sem variante => cloudflare-preview.html", () => {
    assert.equal(resolveCampaignHtmlPath("/m", "d6-qui06-VA", cfg), resolve("/m", CFG.arms.a));
    assert.equal(resolveCampaignHtmlPath("/m", "d6-qui06-VB", cfg), resolve("/m", CFG.arms.b));
    assert.equal(resolveCampaignHtmlPath("/m", "d6-qui06", cfg), resolve("/m", "_internal", "cloudflare-preview.html"));
    assert.equal(resolveCampaignHtmlPath("/m", "novos-x", null), resolve("/m", "_internal", "cloudflare-preview.html"));
  });

  it("key de variante SEM config => lança (os dois braços receberiam o mesmo html)", () => {
    assert.throws(() => resolveCampaignHtmlPath("/m", "d6-qui06-VB", null), /variante/);
  });

  it("caminhos legados de html único abortam com teste ativo, seguem sem ele", () => {
    const on = monthlyFixture(CFG);
    const off = monthlyFixture();
    assert.throws(() => assertNoAbTestForSingleHtmlPath(on, "clarice-schedule-sends.ts"), /ab-test\.json/);
    assert.doesNotThrow(() => assertNoAbTestForSingleHtmlPath(off, "clarice-schedule-sends.ts"));
    rmSync(on, { recursive: true, force: true });
    rmSync(off, { recursive: true, force: true });
  });
});

describe("#9308 células VA/VB", () => {
  const DATE = "2026-10-01";

  it("waveKey aceita VA/VB", () => {
    assert.match(waveKey(3, DATE, "VA"), /^d3-\w{3}01-VA$/);
    assert.match(waveKey(3, DATE, "VB"), /-VB$/);
  });

  it("buildVariantCells divide 50/50, sem perder nem duplicar linhas", () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ email: `u${i}@x.com`, tier: String(i % 3) }));
    const art = buildVariantCells(rows, 3, DATE);
    assert.deepEqual(art.cells.map((c) => c.entry.key), [waveKey(3, DATE, "VA"), waveKey(3, DATE, "VB")]);
    const [a, b] = art.cells.map((c) => c.rows.length);
    assert.ok(Math.abs(a - b) <= 1, `50/50: ${a} × ${b}`);
    const all = art.cells.flatMap((c) => c.rows.map((r) => r.email));
    assert.equal(all.length, 101);
    assert.equal(new Set(all).size, 101);
    // Determinístico: mesma entrada => mesma divisão.
    const again = buildVariantCells(rows, 3, DATE);
    assert.deepEqual(again.cells[0].rows, art.cells[0].rows);
  });

  it("--variant-cells é exclusivo com --no-cells/--hour-cells", () => {
    assert.deepEqual(resolveCellStrategy(["--variant-cells"]), { kind: "variants" });
    assert.throws(() => resolveCellStrategy(["--variant-cells", "--no-cells"]), /exclusivo/);
    assert.throws(() => resolveCellStrategy(["--variant-cells", "--hour-cells", "6,10"]), /exclusivo/);
  });

  it("lista distinta por braço, rotulada 'variante' (nunca 'célula', que o painel lê como assunto)", () => {
    const key = waveKey(3, DATE, "VA");
    assert.ok(isGroupCellWave("d3-qui01", key));
    const name = groupCellListNameFor("2609-10", key);
    assert.match(name, /variante A$/);
    assert.doesNotMatch(name, /célula/);
    assert.notEqual(name, groupCellListNameFor("2609-10", waveKey(3, DATE, "VB")));
  });
});

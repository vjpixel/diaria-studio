/**
 * #13105 itens 3 e 4 (resíduo depois da PR #13110, que fez os itens 1 e 2):
 *   3. o guard do texto FINAL fica armado também no mensal (lint + render da
 *      mensal-apoiadores, que lê o mesmo draft.md), na anual (lint) e na
 *      seleção compartilhada (`shared-selection.json`) — antes só o insumo era
 *      limpo;
 *   4. grafia errada de nome casa em qualquer caixa ("APPEL" num título em
 *      caixa alta escapava do scrub e do guard); valor ambíguo segue sensível.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  correctInMatchCase,
  editionsFromRawDestaques,
  findDraftIntentionalErrorLeaks,
  findIntentionalErrorLeaks,
  findScopedIntentionalErrorLeaks,
  scrubIntentionalError,
  type IntentionalErrorPair,
} from "../scripts/lib/intentional-error-scrub.ts";
import { lintAnnualDraft } from "../scripts/lint-annual-draft.ts";
import { monthlyDraftIntentionalErrors } from "../scripts/lint-monthly-draft.ts";
import { main as sharedMain, sharedSelectionPath } from "../scripts/weekly-shared-selection.ts";

const tmpRoots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const APPEL: IntentionalErrorPair = { edition: "261111", wrong: "Appel", correct: "Apple" };
const MTER: IntentionalErrorPair = { edition: "261110", wrong: "MTER", correct: "METR" };
const NUM: IntentionalErrorPair = { edition: "261112", wrong: "2025", correct: "2026" };
const MAU: IntentionalErrorPair = { edition: "261113", wrong: "mau", correct: "mal" };

function intentionalJson(dir: string, wrong: string, correct: string): void {
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "_internal", "intentional-error.json"),
    JSON.stringify({ wrong_value: wrong, correct_value: correct, error_type: "ortografico" }),
    "utf8",
  );
}

describe("#13105 item 4 — casamento sem distinguir maiúsculas para grafia de nome", () => {
  it('scrub troca "APPEL" e "appel", devolvendo o correto na caixa da ocorrência', () => {
    assert.equal(
      scrubIntentionalError("APPEL LANÇA CHIP; a appel e a Appel", APPEL),
      "APPLE LANÇA CHIP; a apple e a Apple",
    );
    assert.equal(scrubIntentionalError("mter e Mter", MTER), "metr e Metr");
  });

  it("correctInMatchCase: igual ao declarado, caixa alta, caixa baixa, inicial maiúscula, mista", () => {
    assert.equal(correctInMatchCase("Appel", "Appel", "Apple"), "Apple");
    assert.equal(correctInMatchCase("APPEL", "Appel", "Apple"), "APPLE");
    assert.equal(correctInMatchCase("appel", "Appel", "Apple"), "apple");
    assert.equal(correctInMatchCase("Mter", "MTER", "METR"), "Metr");
    assert.equal(correctInMatchCase("aPPel", "Appel", "Apple"), "Apple");
  });

  it('guard acusa "APPEL" (antes escapava)', () => {
    const leaks = findIntentionalErrorLeaks("RADAR: APPEL LANÇA CHIP", [APPEL]);
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0].count, 1);
    assert.equal(findScopedIntentionalErrorLeaks([{ edition: null, text: "APPEL" }], [APPEL]).blocking.length, 1);
  });

  it("palavra inteira continua valendo em qualquer caixa (APPELTREE não casa)", () => {
    assert.equal(scrubIntentionalError("APPELTREE e APPEL", APPEL), "APPELTREE e APPLE");
  });

  it('valor ambíguo segue sensível: "Mau" no começo de frase não é o "mau" plantado', () => {
    assert.equal(scrubIntentionalError("Mau tempo. O resultado foi mau.", MAU), "Mau tempo. O resultado foi mal.");
    assert.deepEqual(findIntentionalErrorLeaks("Mau tempo.", [MAU]), []);
  });
});

describe("#13105 item 3 — guard do texto final do mensal, anual e seleção compartilhada", () => {
  it("findDraftIntentionalErrorLeaks: grafia de nome recusa, número só avisa", () => {
    const r = findDraftIntentionalErrorLeaks("O tema do mês: a APPEL e o relatório de 2025.", [APPEL, NUM]);
    assert.deepEqual(r.blocking.map((l) => l.wrong), ["Appel"]);
    assert.deepEqual(r.advisory.map((l) => l.wrong), ["2025"]);
    assert.deepEqual(findDraftIntentionalErrorLeaks("A Apple em 2026.", [APPEL]), { blocking: [], advisory: [] });
  });

  it("editionsFromRawDestaques: edições únicas e ordenadas; arquivo ausente ou ilegível = []", () => {
    const dir = tmp("raw-destaques-13105-");
    const p = join(dir, "raw-destaques.json");
    writeFileSync(
      p,
      JSON.stringify({ destaques: [{ edition: "261112" }, { edition: "261111" }, { edition: "261112" }, { edition: "x" }] }),
      "utf8",
    );
    assert.deepEqual(editionsFromRawDestaques(p), ["261111", "261112"]);
    assert.deepEqual(editionsFromRawDestaques(join(dir, "nada.json")), []);
    writeFileSync(join(dir, "ruim.json"), "{", "utf8");
    assert.deepEqual(editionsFromRawDestaques(join(dir, "ruim.json")), []);
  });

  it("mensal (lint + mensal-apoiadores): o draft com a grafia errada de uma edição do mês é recusado", () => {
    const root = tmp("monthly-guard-13105-");
    const monthDir = join(root, "data/monthly/2611-12");
    mkdirSync(join(monthDir, "_internal"), { recursive: true });
    writeFileSync(
      join(monthDir, "_internal", "raw-destaques.json"),
      JSON.stringify({ destaques: [{ edition: "261111" }, { edition: "261112" }] }),
      "utf8",
    );
    intentionalJson(join(root, "data/editions/261111"), "Appel", "Apple");
    intentionalJson(join(root, "data/editions/261112"), "2025", "2026");

    const bad = monthlyDraftIntentionalErrors("**DESTAQUE 1 | IA**\n\nA Appel lançou o chip em 2025.", monthDir);
    assert.equal(bad.note, null);
    assert.deepEqual(bad.leaks.blocking.map((l) => [l.edition, l.wrong]), [["261111", "Appel"]]);
    assert.deepEqual(bad.leaks.advisory.map((l) => [l.edition, l.wrong]), [["261112", "2025"]]);

    const ok = monthlyDraftIntentionalErrors("**DESTAQUE 1 | IA**\n\nA Apple lançou o chip.", monthDir);
    assert.deepEqual(ok.leaks, { blocking: [], advisory: [] });
  });

  it("mensal sem raw-destaques.json: o guard registra que ficou sem insumo, sem recusar", () => {
    const root = tmp("monthly-guard-noraw-13105-");
    const monthDir = join(root, "data/monthly/2611-12");
    mkdirSync(monthDir, { recursive: true });
    const r = monthlyDraftIntentionalErrors("A Appel.", monthDir);
    assert.deepEqual(r.leaks, { blocking: [], advisory: [] });
    assert.match(r.note ?? "", /sem insumo/);
  });

  it("anual: lintAnnualDraft reprova a grafia errada e só avisa o número", () => {
    const md = "**TEMA 1 | A APPEL**\n\nTexto sobre 2025.";
    const r = lintAnnualDraft(md, "janeiro", { intentionalErrors: [APPEL, NUM] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.includes('"Appel"') && e.includes("261111")), r.errors.join("\n"));
    assert.ok(r.warnings.some((w) => w.includes('"2025"')), r.warnings.join("\n"));
    const clean = lintAnnualDraft(md.replace("APPEL", "APPLE"), "janeiro", { intentionalErrors: [APPEL] });
    assert.ok(!clean.errors.some((e) => e.includes("erro intencional")));
  });
});

// ── seleção compartilhada (integração pelo main, fixture do #13022) ─────
const U = (s: string) => `https://exemplo.com/${s}`;
function epochFor(aammdd: string): number {
  return Math.floor(
    new Date(2000 + Number(aammdd.slice(0, 2)), Number(aammdd.slice(2, 4)) - 1, Number(aammdd.slice(4, 6)), 8).getTime() / 1000,
  );
}
function editionMd(d: Array<{ n: number; title: string; url: string }>): string {
  return d
    .map((x) =>
      [`**DESTAQUE ${x.n} | 💼 MERCADO**`, "", `**[${x.title}](${x.url})**`, "", `Corpo de ${x.title}.`, "", "Por que isso importa:", "", "Explicação.", ""].join("\n"),
    )
    .join("\n---\n\n");
}
function withMockedExit(fn: () => void): number | null {
  const orig = process.exit;
  let code: number | null = null;
  process.exit = ((c?: number) => {
    code = c ?? 0;
    throw new Error("__exit__");
  }) as typeof process.exit;
  const ol = console.log;
  const oe = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    fn();
  } catch (e) {
    if ((e as Error).message !== "__exit__") throw e;
  } finally {
    process.exit = orig;
    console.log = ol;
    console.error = oe;
  }
  return code;
}

describe("#13105 item 3 — shared-selection.json", () => {
  it("valor ambíguo que o scrub não pôde atribuir sai como aviso no arquivo", () => {
    const root = tmp("shared-selection-13105-");
    const ed = (date: string, md: string) => {
      mkdirSync(join(root, "data/editions", date), { recursive: true });
      writeFileSync(join(root, "data/editions", date, "02-reviewed.md"), md, "utf8");
    };
    // "2025" duas vezes e sem location: o scrub não sabe qual é o erro e deixa as duas.
    ed("260727", editionMd([{ n: 1, title: "Matéria A de 2025", url: U("a") }, { n: 2, title: "Matéria A2 de 2025", url: U("a2") }]));
    intentionalJson(join(root, "data/editions/260727"), "2025", "2026");
    ed("260728", editionMd([{ n: 1, title: "Matéria B", url: U("b") }, { n: 2, title: "Matéria B2", url: U("b2") }]));
    ed("260729", editionMd([{ n: 1, title: "Matéria C", url: U("c") }]));
    const dir = join(root, "data/beehiiv-cache/posts");
    mkdirSync(dir, { recursive: true });
    for (const [date, clicks] of [
      ["260727", { a: 20, a2: 8 }],
      ["260728", { b: 16, b2: 4 }],
      ["260729", { c: 14 }],
    ] as const) {
      writeFileSync(
        join(dir, `post_${date}.json`),
        JSON.stringify({
          id: `post_${date}`,
          slug: `post_${date}`,
          status: "confirmed",
          publish_date: epochFor(date),
          stats: {
            email: { clicks: 1, unique_opens: 400 },
            clicks: Object.entries(clicks).map(([u, n]) => ({ url: U(u), base_url: U(u), email: { unique_verified_clicks: n } })),
          },
        }),
        "utf8",
      );
    }

    const code = withMockedExit(() => sharedMain(root, ["--saturday", "260801"], new Date("2026-08-01T12:00:00-03:00")));
    assert.equal(code, null);
    const s = JSON.parse(readFileSync(sharedSelectionPath(root, "26w31"), "utf8")) as { warnings: string[] };
    assert.ok(
      s.warnings.some((w) => w.includes('"2025"') && w.includes("260727") && w.includes("shared-selection.json")),
      s.warnings.join("\n"),
    );
  });
});

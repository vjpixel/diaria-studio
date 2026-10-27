/**
 * #11337: `recurring_editor_request` só dispara quando a taxa do tipo na
 * janela (7 edições) passa da taxa-base — média móvel das últimas 30 edições
 * com pedidos, janela incluída — mais a margem (2σ binomial). Antes, a base
 * curta (10-12 edições, só ANTES da janela) deixava `pool-add` e `bucket-move`
 * dispararem no ruído na série real, e base insuficiente caía na regra antiga
 * de 3-em-7, que abria issue de rotina toda semana (#11245-#11248).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectSignals,
  computeRequestTypeBaseline,
  selectBaselineEntries,
  signalsFromRecurringEditorRequests,
  RECURRING_REQUEST_BASELINE_WINDOW,
  RECURRING_REQUEST_MIN_EDITIONS,
} from "../scripts/collect-edition-signals.ts";

type Entry = {
  timestamp: string;
  edition: string;
  stage: number;
  request_type: string;
  target: string;
  description: string;
  resolution: "accepted" | "partial" | "declined";
};

/**
 * Série REAL: tipos `accepted`/`partial` por edição, como o coletor os vê
 * (`readEditorRequestsForEditions` + `reclassifyEditorRequests` com o
 * classificador atual), extraída de `data/editions/` em 27/10/2026. Só
 * edições com `editor-requests.jsonl` (o log começa em 260814). `data/` não
 * vai pro CI, por isso a série fica inline.
 */
const REAL_SERIES: Record<string, string[]> = {
  "260814": ["destaque-cut", "destaque-swap"],
  "260820": ["bucket-move", "destaque-swap", "lead-rewrite", "pool-add", "pool-cut", "social-rewrite", "title-choice"],
  "260821": ["bucket-move", "destaque-swap", "lead-rewrite", "pool-add", "pool-cut", "social-rewrite"],
  "260824": ["bucket-move", "destaque-swap", "pool-cut", "title-choice"],
  "260826": ["lead-rewrite", "pool-add", "pool-cut"],
  "260827": ["bucket-move", "destaque-swap", "pool-cut", "section-order"],
  "260904": ["bucket-move"],
  "260908": ["bucket-move", "destaque-swap", "lead-rewrite", "pool-cut", "pool-text-edit", "section-order"],
  "260909": ["bucket-move", "destaque-swap", "pool-add", "pool-cut", "section-order"],
  "260910": ["destaque-swap", "lead-rewrite", "pool-cut"],
  "260914": ["destaque-swap", "pool-add", "pool-cut", "title-choice"],
  "260916": ["bucket-move", "destaque-swap", "pool-add", "pool-cut", "pool-text-edit"],
  "260917": ["destaque-swap", "pool-add", "pool-cut"],
  "260918": ["destaque-swap", "lead-rewrite", "pool-add", "pool-cut"],
  "260921": ["destaque-swap", "lead-rewrite", "pool-add", "pool-cut"],
  "260922": ["lead-rewrite", "pool-add", "pool-cut", "pool-text-edit", "section-order"],
  "260923": ["destaque-swap", "pool-add", "pool-cut", "social-rewrite"],
  "260925": ["destaque-swap", "pool-cut", "pool-text-edit"],
  "260928": ["bucket-move", "destaque-swap", "length-cut", "pool-add", "pool-cut", "social-rewrite"],
  "260929": ["bucket-move", "destaque-swap", "lead-rewrite", "pool-cut", "pool-text-edit"],
  "260930": ["bucket-move", "destaque-swap", "lead-rewrite", "pool-cut"],
  "261001": ["bucket-move", "destaque-swap", "pool-add", "pool-cut"],
  "261002": ["destaque-swap", "lead-rewrite", "pool-add", "pool-cut"],
  "261005": ["bucket-move", "destaque-swap", "pool-add", "pool-cut", "social-rewrite"],
  "261006": ["bucket-move", "lead-rewrite", "link-swap", "pool-cut", "section-order", "social-rewrite"],
  "261007": ["lead-rewrite", "link-swap", "pool-add", "pool-cut", "section-order", "social-rewrite"],
  "261008": ["bucket-move", "destaque-swap", "lead-rewrite", "link-swap", "pool-add", "pool-cut", "section-order"],
  "261009": ["bucket-move", "destaque-swap", "lead-rewrite", "pool-add", "pool-cut"],
  "261013": ["destaque-swap", "pool-cut", "pool-text-edit", "section-order"],
  "261014": ["bucket-move", "pool-add", "pool-cut", "pool-text-edit", "section-order"],
  "261015": ["bucket-move", "destaque-swap", "pool-add", "pool-cut", "social-rewrite"],
  "261016": ["bucket-move", "destaque-swap", "lead-rewrite", "pool-cut", "pool-text-edit", "section-order"],
  "261019": ["pool-cut"],
  "261020": ["bucket-move", "pool-cut"],
  "261021": ["bucket-move", "link-swap", "pool-cut", "section-order"],
  "261022": ["bucket-move", "destaque-swap", "pool-add", "pool-cut"],
  "261023": ["lead-rewrite", "link-swap", "pool-cut", "social-rewrite"],
  "261026": ["destaque-swap", "lead-rewrite", "pool-add", "pool-cut", "social-rewrite"],
  "261027": ["bucket-move", "destaque-swap", "lead-rewrite", "link-swap", "pool-cut", "social-rewrite"],
  "261028": ["destaque-swap", "pool-add", "pool-cut", "social-rewrite"],
};

/** Tipos que reabriam issue toda semana (#11245-#11249) e não têm ação de código. */
const ROUTINE_TYPES = ["bucket-move", "destaque-swap", "pool-add", "lead-rewrite", "pool-cut"];

function toEntries(series: Record<string, string[]>): Record<string, Entry[]> {
  const out: Record<string, Entry[]> = {};
  for (const [edition, types] of Object.entries(series)) {
    out[edition] = types.map((request_type) => ({
      timestamp: "t", edition, stage: 4, request_type, target: "d1",
      description: `${request_type} em ${edition}`, resolution: "accepted",
    }));
  }
  return out;
}

/**
 * Avalia a janela que termina em `endEdition` como o coletor faz: janela = as
 * 7 edições mais recentes; base = média móvel das 30 mais recentes (janela
 * incluída) via `selectBaselineEntries`.
 */
function evaluateAt(series: Record<string, string[]>, endEdition: string) {
  const all = toEntries(Object.fromEntries(Object.entries(series).filter(([k]) => k <= endEdition)));
  const keysDesc = Object.keys(all).sort().reverse();
  const window = Object.fromEntries(keysDesc.slice(0, 7).map((k) => [k, all[k]]));
  const baseline = computeRequestTypeBaseline(selectBaselineEntries(all));
  return signalsFromRecurringEditorRequests(window, RECURRING_REQUEST_MIN_EDITIONS, baseline);
}

const firedTypes = (sigs: Array<{ details: Record<string, unknown> }>) => sigs.map((s) => String(s.details.request_type));

const ENDS_2609_2610 = Object.keys(REAL_SERIES).filter((k) => /^26(09|10)/.test(k)).sort();

describe("série real 2609-2610 (#11337)", () => {
  it("nenhum tipo rotineiro dispara em nenhuma janela que termina em 2609-2610", () => {
    for (const end of ENDS_2609_2610) {
      const fired = firedTypes(evaluateAt(REAL_SERIES, end));
      for (const t of ROUTINE_TYPES) {
        assert.ok(!fired.includes(t), `${t} disparou na janela que termina em ${end}: ${fired.join(", ")}`);
      }
    }
  });

  it("sem base (regra antiga 3-em-7), a mesma série dispararia nos tipos rotineiros — é o bug", () => {
    const all = toEntries(REAL_SERIES);
    const last7 = Object.fromEntries(Object.keys(all).sort().slice(-7).map((k) => [k, all[k]]));
    const fired = firedTypes(signalsFromRecurringEditorRequests(last7));
    assert.ok(fired.includes("destaque-swap"));
    assert.ok(fired.includes("pool-cut"));
  });

  it("base que deixa a janela de fora e curta (o #11291) disparava pool-add em 260923", () => {
    // Reproduz a 1ª versão (#11291): base = até 28 edições ANTES da janela.
    const all = toEntries(Object.fromEntries(Object.entries(REAL_SERIES).filter(([k]) => k <= "260923")));
    const keysDesc = Object.keys(all).sort().reverse();
    const window = Object.fromEntries(keysDesc.slice(0, 7).map((k) => [k, all[k]]));
    const before = Object.fromEntries(keysDesc.slice(7, 35).map((k) => [k, all[k]]));
    const old = firedTypes(signalsFromRecurringEditorRequests(window, 3, computeRequestTypeBaseline(before)));
    assert.ok(old.includes("pool-add"), "regressão: a base antiga disparava pool-add 7/7 contra 5/10");
    assert.ok(!firedTypes(evaluateAt(REAL_SERIES, "260923")).includes("pool-add"));
  });
});

describe("salto sintético sobre a série real (#11337)", () => {
  // 23 edições reais de base + 7 sintéticas: um tipo ausente da base aparece
  // em 5 das 7, e os rotineiros seguem na própria frequência.
  const synthetic: Record<string, string[]> = Object.fromEntries(
    Object.entries(REAL_SERIES).filter(([k]) => k <= "261022").slice(-23),
  );
  const jumpDays = ["261101", "261102", "261103", "261104", "261105", "261106", "261107"];
  jumpDays.forEach((d, i) => {
    synthetic[d] = ["destaque-swap", "pool-cut", ...(i % 2 === 0 ? ["bucket-move"] : []), ...(i < 5 ? ["tone"] : [])];
  });

  it("tipo que salta acima da base dispara, e só ele", () => {
    const sigs = evaluateAt(synthetic, "261107");
    assert.deepEqual(firedTypes(sigs), ["tone"]);
  });

  it("corpo do sinal cita taxa da janela × taxa-base e o limiar", () => {
    const tone = evaluateAt(synthetic, "261107")[0];
    assert.equal(tone.details.edition_count, 5);
    assert.equal(tone.details.window_editions, 7);
    assert.equal(tone.details.window_rate, 0.714);
    assert.equal(tone.details.baseline_editions, RECURRING_REQUEST_BASELINE_WINDOW);
    assert.equal(tone.details.baseline_type_editions, 5);
    assert.equal(tone.details.baseline_rate, 0.167);
    assert.match(tone.suggested_action, /em 5 de 7 edições revisadas da janela \(71%\)/);
    assert.match(tone.suggested_action, /acima da base: 17% na média móvel \(5 de 30 edições; esperado 1\.2 na janela, limiar 3\.1\)/);
  });

  it("título continua estável (dedup do auto-reporter casa por título)", () => {
    assert.equal(evaluateAt(synthetic, "261107")[0].title, "Pedido recorrente do editor: tone");
  });
});

describe("base curta não dispara (#11337)", () => {
  it("menos de 10 edições com pedidos: sem taxa-base medida, nenhum sinal", () => {
    const short = toEntries({
      "261001": ["tone", "destaque-swap"], "261002": ["tone"], "261005": ["tone"],
      "261006": ["tone"], "261007": ["destaque-swap"],
    });
    const baseline = computeRequestTypeBaseline(selectBaselineEntries(short));
    assert.deepEqual(signalsFromRecurringEditorRequests(short, RECURRING_REQUEST_MIN_EDITIONS, baseline), []);
  });
});

describe("selectBaselineEntries (#11337)", () => {
  it("pega as N edições mais recentes com pedidos, ignorando as vazias", () => {
    const entries = toEntries({ "261001": ["tone"], "261002": [], "261003": ["tone"], "261004": ["tone"] });
    assert.deepEqual(Object.keys(selectBaselineEntries(entries, 2)).sort(), ["261003", "261004"]);
  });
});

describe("collectSignals ponta a ponta com média móvel (#11337)", () => {
  it("lê a base das 30 edições mais recentes com pedidos e só abre o tipo que saltou", () => {
    const root = mkdtempSync(join(tmpdir(), "diaria-11337-"));
    try {
      const editionsRoot = join(root, "data/editions");
      let current = "";
      for (let i = 0; i < 30; i++) {
        const ed = `2610${String(i + 1).padStart(2, "0")}`;
        const dir = join(editionsRoot, ed);
        mkdirSync(join(dir, "_internal"), { recursive: true });
        // destaque-swap em toda edição (rotina); tone só nas 5 últimas (salto).
        const types = ["destaque-swap", ...(i >= 25 ? ["tone"] : [])];
        const lines = types.map((request_type) => JSON.stringify({
          timestamp: "t", edition: ed, stage: 4, request_type, target: "d1",
          description: `${request_type} ${ed}`, resolution: "accepted", source: "manual",
        }));
        writeFileSync(join(dir, "_internal/editor-requests.jsonl"), lines.join("\n") + "\n");
        current = dir;
      }
      const draft = collectSignals({ rootDir: root, editionDir: current });
      const recurring = draft.signals.filter((s) => s.kind === "recurring_editor_request");
      assert.deepEqual(firedTypes(recurring), ["tone"]);
      assert.equal(recurring[0].details.baseline_editions, 30);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

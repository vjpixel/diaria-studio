/**
 * #11291: `recurring_editor_request` disparava em tipos que acontecem em
 * quase toda edição (destaque-swap em 34 de 39, lead-rewrite, bucket-move),
 * reabrindo a mesma issue toda semana. Com a base histórica, o tipo só
 * dispara quando a janela fica acima da própria frequência-base.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRequestTypeBaseline,
  recurringRequestThreshold,
  signalsFromRecurringEditorRequests,
  RECURRING_REQUEST_MIN_BASELINE_EDITIONS,
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

function entry(edition: string, request_type: string, resolution: Entry["resolution"] = "accepted"): Entry {
  return { timestamp: "t", edition, stage: 4, request_type, target: "d1", description: `${request_type} em ${edition}`, resolution };
}

/** Monta N edições; `typesFor(i)` diz quais tipos a i-ésima edição teve. */
function editions(prefix: number, n: number, typesFor: (i: number) => string[]): Record<string, Entry[]> {
  const out: Record<string, Entry[]> = {};
  for (let i = 0; i < n; i++) {
    const ed = String(prefix + i);
    out[ed] = typesFor(i).map((t) => entry(ed, t));
  }
  return out;
}

const titles = (sigs: Array<{ title: string }>) => sigs.map((s) => s.title);

describe("computeRequestTypeBaseline (#11291)", () => {
  it("conta edições distintas por tipo e usa como denominador as edições com qualquer pedido", () => {
    const base = computeRequestTypeBaseline({
      "260901": [entry("260901", "destaque-swap"), entry("260901", "destaque-swap")],
      "260902": [entry("260902", "other")],
      "260903": [entry("260903", "tone", "declined")],
      "260904": [],
    });
    assert.equal(base.edition_count, 3, "edição sem pedido não entra no denominador");
    assert.deepEqual(base.type_edition_counts, { "destaque-swap": 1 }, "other e declined não contam");
  });
});

describe("recurringRequestThreshold (#11291)", () => {
  it("base curta demais devolve null (vale só o piso)", () => {
    const base = { edition_count: RECURRING_REQUEST_MIN_BASELINE_EDITIONS - 1, type_edition_counts: { x: 5 } };
    assert.equal(recurringRequestThreshold("x", 7, base), null);
    assert.equal(recurringRequestThreshold("x", 7, undefined), null);
  });

  it("tipo rotineiro (34 de 39) fica com limiar inalcançável numa janela de 7", () => {
    const t = recurringRequestThreshold("destaque-swap", 7, { edition_count: 39, type_edition_counts: { "destaque-swap": 34 } });
    assert.ok(t);
    assert.ok(t.threshold >= 7, `limiar ${t.threshold} deveria ser ≥7`);
  });

  it("tipo nunca visto na base tem limiar 0 (vale o piso de 3)", () => {
    const t = recurringRequestThreshold("tone", 7, { edition_count: 28, type_edition_counts: {} });
    assert.ok(t);
    assert.equal(t.threshold, 0);
  });
});

describe("signalsFromRecurringEditorRequests com base histórica (#11291)", () => {
  // Cenário real da issue: destaque-swap e lead-rewrite em quase toda edição.
  const baseline = computeRequestTypeBaseline(
    editions(260800, 28, (i) => [
      ...(i % 8 !== 0 ? ["destaque-swap"] : []), // ~87%
      ...(i % 3 !== 0 ? ["lead-rewrite", "bucket-move"] : []), // ~64%
      ...(i === 5 ? ["tone"] : []), // raro
    ]),
  );
  const window = editions(260901, 7, (i) => [
    "destaque-swap",
    ...(i < 5 ? ["lead-rewrite", "bucket-move"] : []),
    ...(i < 4 ? ["tone"] : []),
  ]);

  it("sem base (comportamento antigo) dispara nos tipos rotineiros — é o bug", () => {
    const t = titles(signalsFromRecurringEditorRequests(window));
    assert.ok(t.includes("Pedido recorrente do editor: destaque-swap"));
    assert.ok(t.includes("Pedido recorrente do editor: lead-rewrite"));
  });

  it("com base, tipo rotineiro dentro da própria frequência NÃO dispara", () => {
    const t = titles(signalsFromRecurringEditorRequests(window, RECURRING_REQUEST_MIN_EDITIONS, baseline));
    assert.ok(!t.includes("Pedido recorrente do editor: destaque-swap"), "destaque-swap em 7/7 é a rotina dele");
    assert.ok(!t.includes("Pedido recorrente do editor: lead-rewrite"), "lead-rewrite em 5/7 é a rotina dele");
    assert.ok(!t.includes("Pedido recorrente do editor: bucket-move"), "bucket-move em 5/7 é a rotina dele");
  });

  it("com base, tipo raro que sobe acima da base CONTINUA disparando, com a base nos details", () => {
    const sigs = signalsFromRecurringEditorRequests(window, RECURRING_REQUEST_MIN_EDITIONS, baseline);
    const tone = sigs.find((s) => s.title === "Pedido recorrente do editor: tone");
    assert.ok(tone, "tone em 4/7 contra base de 1/28 é mudança real");
    assert.equal(tone.details.edition_count, 4);
    assert.equal(tone.details.baseline_editions, baseline.edition_count);
    assert.match(tone.suggested_action, /base histórica/);
  });

  it("base com edições insuficientes cai na regra antiga (3-em-7)", () => {
    const shortBase = computeRequestTypeBaseline(editions(260800, 5, () => ["destaque-swap"]));
    const t = titles(signalsFromRecurringEditorRequests(window, RECURRING_REQUEST_MIN_EDITIONS, shortBase));
    assert.ok(t.includes("Pedido recorrente do editor: destaque-swap"));
  });

  it("o piso de 3 edições continua valendo mesmo com base que zera o limiar", () => {
    const twoTone = editions(260901, 7, (i) => (i < 2 ? ["tone"] : ["destaque-swap"]));
    const t = titles(signalsFromRecurringEditorRequests(twoTone, RECURRING_REQUEST_MIN_EDITIONS, baseline));
    assert.ok(!t.includes("Pedido recorrente do editor: tone"));
  });
});

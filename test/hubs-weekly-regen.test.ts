/**
 * test/hubs-weekly-regen.test.ts (#8906)
 *
 * Regressão pura pra `scripts/lib/hubs-weekly-regen.ts` — decisão de regen
 * por hub, bump de `UPDATED_DATE` e heurística de alarme de revisão de
 * prosa. Nenhum teste toca disco/rede — o orquestrador de I/O
 * (`scripts/hubs-weekly-regen.ts`) não é exercitado aqui (mesmo padrão de
 * `test/hub-drift-check.test.ts`/`test/hub-staleness-check.test.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasHubDataChange,
  planHubRegen,
  bumpUpdatedDateLine,
  HUB_PROSE_REVIEW_THRESHOLD_EDITIONS,
  emptyProseReviewState,
  countEditionsSince,
  decideProseAlarm,
  ensureProseReviewBaseline,
  type HubSourcesDiff,
} from "../scripts/lib/hubs-weekly-regen.ts";

const EMPTY_DIFF: HubSourcesDiff = { added: [], removed: [], changed: [], unchanged: 3 };

describe("hasHubDataChange", () => {
  it("false quando o diff não tem added/removed/changed", () => {
    assert.equal(hasHubDataChange(EMPTY_DIFF), false);
  });

  it("true com added", () => {
    assert.equal(hasHubDataChange({ ...EMPTY_DIFF, added: ["edicao-nova"] }), true);
  });

  it("true com removed", () => {
    assert.equal(hasHubDataChange({ ...EMPTY_DIFF, removed: ["edicao-velha"] }), true);
  });

  it("true com changed", () => {
    assert.equal(hasHubDataChange({ ...EMPTY_DIFF, changed: ["edicao-x"] }), true);
  });
});

describe("planHubRegen", () => {
  it("sem mudança de dados -> hasDataChange false, newUpdatedDate null", () => {
    const plan = planHubRegen("anthropic-claude", EMPTY_DIFF, "2026-09-28");
    assert.deepEqual(plan, { slug: "anthropic-claude", hasDataChange: false, newUpdatedDate: null });
  });

  it("com mudança de dados -> hasDataChange true, newUpdatedDate = todayISO (nunca derivado da edição)", () => {
    const diff: HubSourcesDiff = { ...EMPTY_DIFF, added: ["2026-09-25-edicao-nova"] };
    const plan = planHubRegen("openai-chatgpt", diff, "2026-09-28");
    assert.deepEqual(plan, { slug: "openai-chatgpt", hasDataChange: true, newUpdatedDate: "2026-09-28" });
  });
});

describe("bumpUpdatedDateLine", () => {
  it("substitui a linha const UPDATED_DATE pela nova data", () => {
    const before = [
      "// comentário",
      'const UPDATED_DATE = "2026-08-27";',
      "export const x = 1;",
    ].join("\n");
    const after = bumpUpdatedDateLine(before, "2026-09-28");
    assert.match(after, /const UPDATED_DATE = "2026-09-28";/);
    assert.doesNotMatch(after, /2026-08-27/);
  });

  it("preserva o resto do arquivo intocado", () => {
    const before = 'const A = 1;\nconst UPDATED_DATE = "2026-01-01";\nconst B = 2;\n';
    const after = bumpUpdatedDateLine(before, "2026-01-02");
    assert.equal(after, 'const A = 1;\nconst UPDATED_DATE = "2026-01-02";\nconst B = 2;\n');
  });

  it("lança quando o padrão não é encontrado (fail loud, #8906)", () => {
    assert.throws(() => bumpUpdatedDateLine("sem UPDATED_DATE aqui", "2026-09-28"), /não encontrado/);
  });
});

describe("countEditionsSince", () => {
  it("conta só datas estritamente posteriores", () => {
    const dates = ["2026-08-01", "2026-08-15", "2026-09-01", "2026-09-20"];
    assert.equal(countEditionsSince(dates, "2026-08-15"), 2);
  });

  it("zero quando nenhuma data é posterior", () => {
    assert.equal(countEditionsSince(["2026-01-01"], "2026-06-01"), 0);
  });
});

describe("decideProseAlarm", () => {
  it("não alarma abaixo do limiar", () => {
    const dates = Array.from({ length: HUB_PROSE_REVIEW_THRESHOLD_EDITIONS - 1 }, (_, i) => `2026-09-${10 + i}`);
    const decision = decideProseAlarm(emptyProseReviewState(), "anthropic-claude", dates, "2026-09-01");
    assert.equal(decision.alarm, false);
    assert.equal(decision.newEditionsCount, HUB_PROSE_REVIEW_THRESHOLD_EDITIONS - 1);
  });

  it("alarma no limiar exato", () => {
    const dates = Array.from({ length: HUB_PROSE_REVIEW_THRESHOLD_EDITIONS }, (_, i) => `2026-09-${10 + i}`);
    const decision = decideProseAlarm(emptyProseReviewState(), "anthropic-claude", dates, "2026-09-01");
    assert.equal(decision.alarm, true);
    assert.equal(decision.newEditionsCount, HUB_PROSE_REVIEW_THRESHOLD_EDITIONS);
  });

  it("usa a baseline persistida em `state` quando existe, não o fallback", () => {
    const state = { "anthropic-claude": { proseReviewedDate: "2026-09-20" } };
    const dates = ["2026-09-05", "2026-09-10", "2026-09-25"]; // só 1 depois de 2026-09-20
    const decision = decideProseAlarm(state, "anthropic-claude", dates, "2026-01-01");
    assert.equal(decision.baselineDate, "2026-09-20");
    assert.equal(decision.newEditionsCount, 1);
    assert.equal(decision.alarm, false);
  });
});

describe("ensureProseReviewBaseline", () => {
  it("semeia baseline quando o hub não tem entrada ainda (dia-0)", () => {
    const next = ensureProseReviewBaseline(emptyProseReviewState(), "google-gemini", "2026-09-17");
    assert.deepEqual(next, { "google-gemini": { proseReviewedDate: "2026-09-17" } });
  });

  it("não sobrescreve entrada já existente", () => {
    const state = { "google-gemini": { proseReviewedDate: "2026-08-01" } };
    const next = ensureProseReviewBaseline(state, "google-gemini", "2026-09-17");
    assert.deepEqual(next, state);
  });

  it("não afeta outros hubs", () => {
    const state = { "anthropic-claude": { proseReviewedDate: "2026-08-01" } };
    const next = ensureProseReviewBaseline(state, "google-gemini", "2026-09-17");
    assert.deepEqual(next, {
      "anthropic-claude": { proseReviewedDate: "2026-08-01" },
      "google-gemini": { proseReviewedDate: "2026-09-17" },
    });
  });
});

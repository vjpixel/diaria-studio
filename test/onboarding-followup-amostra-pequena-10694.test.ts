/**
 * test/onboarding-followup-amostra-pequena-10694.test.ts (#10694)
 *
 * A regra "sistêmica" (`≥ 50%` das leituras falhas) valia com qualquer
 * amostra: com 1 ou 2 devidos no dia, uma única falha transitória já era
 * 50%, contava como falha da rodada e alimentava o streak do alarme. Agora a
 * fração só vale com `totalLookups ≥ FOLLOWUP_LOOKUP_SYSTEMIC_MIN_LOOKUPS`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyLookupFailures,
  FOLLOWUP_LOOKUP_SYSTEMIC_MIN_LOOKUPS,
  resolveFollowupConfig,
  type FollowupDue,
  type LookupFailure,
} from "../scripts/lib/onboarding-followup.ts";

const DAY = 86_400;
const T0 = Date.parse("2026-01-01T12:00:00Z") / 1000;
const cfg = resolveFollowupConfig({ enabled: true });
const due = (id: number): FollowupDue => ({ kit_subscriber_id: id, email: `${id}@x.com`, kind: "apoio30" });
// Janela [T0+30d, T0+40d); "agora" no 1º dia: longe do último.
const now = T0 + 30 * DAY + 3600;
const fail = (id: number, transient = true): LookupFailure => ({ due: due(id), transient, anchorSec: T0 });

describe("#10694 falha transitória em amostra pequena não é sistêmica", () => {
  it("1 falha transitória em 1 consulta é adiada", () => {
    assert.deepEqual(classifyLookupFailures([fail(1)], 1, now, cfg), { blocking: 0, deferred: 1 });
  });

  it("2 falhas em 2 consultas, abaixo da amostra mínima, também são adiadas", () => {
    assert.deepEqual(classifyLookupFailures([fail(1), fail(2)], 2, now, cfg), { blocking: 0, deferred: 2 });
  });

  it("com amostra suficiente, metade ou mais continua sistêmica", () => {
    const n = FOLLOWUP_LOOKUP_SYSTEMIC_MIN_LOOKUPS;
    const half = Array.from({ length: n / 2 }, (_, i) => fail(i + 1));
    assert.deepEqual(classifyLookupFailures(half, n, now, cfg), { blocking: n / 2, deferred: 0 });
    assert.deepEqual(classifyLookupFailures(half.slice(1), n, now, cfg), { blocking: 0, deferred: n / 2 - 1 });
  });

  it("amostra pequena ainda reprova erro não transitório e último dia da janela", () => {
    assert.deepEqual(classifyLookupFailures([fail(1, false)], 1, now, cfg), { blocking: 1, deferred: 0 });
    const lastDay = T0 + 39 * DAY + 3600;
    assert.deepEqual(classifyLookupFailures([fail(1)], 1, lastDay, cfg), { blocking: 1, deferred: 0 });
  });
});

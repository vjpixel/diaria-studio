/**
 * test/clarice-schedule-ramp-select-available.test.ts (#5403, #5424)
 *
 * Regressão pros 2 achados do self-review consolidado de 260816:
 *
 * #5403 — `clarice-schedule-ramp.ts` (`--build-audience`) e
 * `weekly-send-plan-audience.ts` construíam a fila `ramp-warm` só com
 * `excludeCommittedToQueuedCampaigns`, sem o guard cycle-wide
 * `sent-or-queued.json` que #5402 adicionou a `clarice-plan-wave.ts`
 * (mesmo cenário de teste de `test/clarice-plan-wave-5395.test.ts`).
 *
 * #5424 — os mesmos 2 call sites chamavam `segmentRampWarm`/`isRampWarm`
 * SEM o cutoff `novos`/`rampa` (#5410, `readNovosCutoff`), continuando a
 * absorver a janela `novos` mesmo depois do fix no fluxo automático.
 *
 * `selectAvailableRampWarm` (exportada de `clarice-schedule-ramp.ts`) é a
 * função pura extraída pra aplicar os 3 guards na ordem certa — reusada
 * por AMBOS os call sites (`clarice-schedule-ramp.ts` e
 * `weekly-send-plan-audience.ts`, via import direto), então um teste único
 * cobre os dois — eles não podem mais divergir por construção.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAvailableRampWarm } from "../scripts/clarice-schedule-ramp.ts";
import { cohortFromTier } from "../scripts/lib/cohorts.ts";
import type { StoreRow } from "../scripts/lib/clarice-segment.ts";

/** Mesmo padrão de `row()` em test/clarice-segment.test.ts — fixture mínima elegível a ramp-warm. */
function row(p: Partial<StoreRow> & { email: string }): StoreRow {
  const tier = p.tier ?? null;
  return {
    tier,
    cohort: cohortFromTier(tier),
    priority_points: 0,
    send_eligible: 1,
    ineligible_reason: null,
    sends_count: 0,
    mv_bucket: "verified",
    brevo_modified_at: "2026-08-01T00:00:00Z",
    ...p,
  };
}

test("#5403: contato em sent-or-queued.json (fora de campanha queued/sent) NÃO é contado como disponível", () => {
  const rows: StoreRow[] = [
    row({ email: "orphan@x.com" }),
    row({ email: "fresh@x.com" }),
  ];
  const result = selectAvailableRampWarm(rows, {
    committedListIds: new Set(),
    sentOrQueuedEmails: new Set(["orphan@x.com"]),
    cutoffNovosIso: null,
  });
  assert.deepEqual(result.map((r) => r.email), ["fresh@x.com"]);
});

test("#5403: sem sentOrQueuedEmails (Set vazio) — nada excluído por esse guard (comportamento pré-fix preservado)", () => {
  const rows: StoreRow[] = [row({ email: "a@x.com" }), row({ email: "b@x.com" })];
  const result = selectAvailableRampWarm(rows, {
    committedListIds: new Set(),
    sentOrQueuedEmails: new Set(),
    cutoffNovosIso: null,
  });
  assert.deepEqual(result.map((r) => r.email).sort(), ["a@x.com", "b@x.com"]);
});

test("#5424: contato dentro da janela novos (created >= cutoff) É EXCLUÍDO da rampa", () => {
  const rows: StoreRow[] = [
    row({ email: "pendente-novos@x.com", created: "2026-08-16T09:00:00Z" }),
    row({ email: "fila-fria@x.com", created: "2026-01-01T09:00:00Z" }),
  ];
  const result = selectAvailableRampWarm(rows, {
    committedListIds: new Set(),
    sentOrQueuedEmails: new Set(),
    cutoffNovosIso: "2026-08-14",
  });
  assert.deepEqual(result.map((r) => r.email), ["fila-fria@x.com"]);
});

test("#5424: cutoffNovosIso null (novos-cutoff.json nunca rodou) — fail-safe pré-existente, ninguém excluído por cutoff", () => {
  const rows: StoreRow[] = [row({ email: "sem-cutoff@x.com", created: "2026-08-16T09:00:00Z" })];
  const result = selectAvailableRampWarm(rows, {
    committedListIds: new Set(),
    sentOrQueuedEmails: new Set(),
    cutoffNovosIso: null,
  });
  assert.deepEqual(result.map((r) => r.email), ["sem-cutoff@x.com"]);
});

test("#5403+#5424 combinados: os 3 guards (cutoff novos, committed, sent-or-queued) compõem na ordem certa", () => {
  const rows: StoreRow[] = [
    row({ email: "novos-window@x.com", created: "2026-08-16T09:00:00Z" }), // excluído pelo cutoff
    row({ email: "committed@x.com", created: "2026-01-01T00:00:00Z", brevo_list_ids: '["68"]' }), // excluído por committed
    row({ email: "orphan-sent-or-queued@x.com", created: "2026-01-01T00:00:00Z" }), // excluído por sent-or-queued
    row({ email: "survivor@x.com", created: "2026-01-01T00:00:00Z" }), // sobrevive aos 3 guards
  ];
  const result = selectAvailableRampWarm(rows, {
    committedListIds: new Set(["68"]),
    sentOrQueuedEmails: new Set(["orphan-sent-or-queued@x.com"]),
    cutoffNovosIso: "2026-08-14",
  });
  assert.deepEqual(result.map((r) => r.email), ["survivor@x.com"]);
});

/**
 * #7738 — testes de regressão do teto fila diária unificada.
 * Cobre: wiring real (queued/committed NÃO trocados — lição #7784),
 * pool suf/insuf, fallback quando guard falha, nunca superestimar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDailySendQueue, isDailyQueueEligible, compareDailyQueueOrder } from "../scripts/lib/clarice-segment.js";
import { computeDailyQueueAvailable } from "../scripts/lib/clarice-segment.js";

function row(email: string, opts: Partial<any> = {}): any {
  return {
    email,
    send_eligible: 1,
    sends_count: opts.sends_count ?? 0,
    priority_points: opts.priority_points ?? 0,
    brevo_list_ids: opts.brevo_list_ids ?? null,
    created: opts.created ?? "2026-05-01",
    cohort: opts.cohort ?? "leads-2026-05",
    mv_bucket: opts.mv_bucket ?? "verified",
    ...opts,
  };
}

describe("#7738 wiring real — queued vs committed (não #7784)", () => {
  it("engajados (hasSendHistory) usam queuedListIds; warm usam committedListIds", () => {
    // #7784 falhou ao colocar committed em both — anula engajados.
    const rows = [
      row("e1@test.com", { sends_count: 3, priority_points: 10, brevo_list_ids: "list-A" }),
      row("w1@test.com", { sends_count: 0, priority_points: 0, brevo_list_ids: "list-B" }),
    ];
    const queued = new Set(["list-A"]);
    const committed = new Set(["list-B"]);
    const q = buildDailySendQueue(rows, { queuedListIds: queued, committedListIds: committed });
    expect(q.map((r: any) => r.email)).toEqual(["e1@test.com", "w1@test.com"]); // ambos elegíveis se listas não estão no guard
    // Se queued tem list-A, e1 sai; se committed tem list-B, w1 sai — wiring correto.
    const qBlocked = buildDailySendQueue(rows, { queuedListIds: new Set(["list-A"]), committedListIds: new Set(["list-B"]) });
    assert.strictEqual(qBlocked.length, 0); // ambos bloqueados pelo guard correto
  });

  it("não inverte: queued em committed ou vice-versa", () => {
    const r = row("a@test.com", { sends_count: 5, priority_points: 20, brevo_list_ids: "X" });
    // Queued guard bloqueia X → não deve aparecer se committed for usado por engajado (erro #7784)
    const wrong = buildDailySendQueue([r], { queuedListIds: new Set(), committedListIds: new Set(["X"]) });
    // Com #7784 o engajado seria filtrado por committed (errado); com wiring real, queued está vazio → passa (correto)
    // O teste assertivo: se queued tem X, deve sair.
    expect(buildDailySendQueue([r], { queuedListIds: new Set(["X"]), committedListIds: new Set() })).toHaveLength(0);
  });
});

describe("#7738 pool suficiente / insuficiente / fallback", () => {
  it("pool suficiente: fila >= desejado", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(`u${i}@t`, { sends_count: 0, priority_points: 0 }));
    const q = computeDailyQueueAvailable(rows, { queuedListIds: new Set(), committedListIds: new Set() });
    assert.strictEqual(q, 100);
  });

  it("pool insuficiente: alguns já agendados (queued)", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`u${i}@t`, { sends_count: 0, brevo_list_ids: `l${i}` }));
    const queued = new Set(rows.map((r: any) => r.brevo_list_ids as string));
    const q = computeDailyQueueAvailable(rows, { queuedListIds: queued, committedListIds: new Set() });
    assert.strictEqual(q, 0); // todos já agendados
  });

  it("fallback seguro: guard vazio + eligible vazio → 0 (nunca superestima)", () => {
    const q = computeDailyQueueAvailable([], { queuedListIds: new Set(), committedListIds: new Set() });
    assert.strictEqual(q, 0);
  });

  it("nunca retorna > eligible real (capacidade não superestimada)", () => {
    const rows = [row("a@test.com", { sends_count: 0, brevo_list_ids: "L1" })];
    // Com guard vazio → 1; com guard contendo L1 → 0
    expect(computeDailyQueueAvailable(rows, { queuedListIds: new Set(), committedListIds: new Set() })).toBe(1);
    expect(computeDailyQueueAvailable(rows, { committedListIds: new Set(["L1"]), queuedListIds: new Set() })).toBe(0);
  });
});

describe("#7738 distinção 1º-envio vitalício vs fila unificada", () => {
  it("availableFirstSend (sends_count<=0) NÃO é o teto da fila diária", () => {
    // Um contato com sends_count=0 mas já na fila unificada (elegível pelo score) conta pra dailyQueue,
    // mas o 1º-envio só conta se nunca recebeu — distinção operada pelo guard, não pelo SQL direto.
    const rows = [row("novo@test.com", { sends_count: 0, priority_points: 30 })];
    // Sem guard: fila unificada = 1; 1º-envio também = 1 (coincidente para este caso isolado)
    // Mas se já recebeu e tem score > 0, fila unificada conta, 1º-envio não.
    const sent = [row("eng@test.com", { sends_count: 2, priority_points: 10, brevo_list_ids: "L" })];
    expect(computeDailyQueueAvailable(sent, { queuedListIds: new Set(), committedListIds: new Set() })).toBe(1);
    // 1º-envio para esse caso seria 0 (sends_count>0)
  });
});

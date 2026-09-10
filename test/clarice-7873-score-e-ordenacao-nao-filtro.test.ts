/**
 * #7873 — regressão: `priority_points` na fila diária unificada (#7406) é
 * ORDENAÇÃO, nunca FILTRO. `isDailyQueueEligible`/`buildDailySendQueue`
 * herdavam o predicado antigo de `isEngajados` (`priority_points > 0` como
 * corte de elegibilidade pra quem já recebeu, `sends_count > 0`) — medido em
 * produção (09/09/2026, ciclo `2608-09`): a fila caiu de ~268k pra 9
 * contatos por causa desse filtro indevido.
 *
 * Cenário de regressão (issue #7873, escopo item 5): contato com
 * `sends_count>0`, `priority_points<=0`, fora do `sent-or-queued` do ciclo
 * → ELEGÍVEL, e ordenado ABAIXO de quem tem score positivo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildDailySendQueue, isDailyQueueEligible, compareDailyQueueOrder } from "../scripts/lib/clarice-segment.js";

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

const noGuard = { queuedListIds: new Set<string>(), committedListIds: new Set<string>() };

describe("#7873 — priority_points<=0 com sends_count>0 é elegível (score ordena, não filtra)", () => {
  it("isDailyQueueEligible: score zero continua elegível", () => {
    const zero = row("zero@test.com", { sends_count: 4, priority_points: 0 });
    assert.strictEqual(isDailyQueueEligible(zero), true);
  });

  it("isDailyQueueEligible: score negativo (decaído) continua elegível — não é mais território exclusivo de reativação", () => {
    const negativo = row("negativo@test.com", { sends_count: 4, priority_points: -15 });
    assert.strictEqual(isDailyQueueEligible(negativo), true);
  });

  it("buildDailySendQueue: contato decaído (priority_points<=0, sends_count>0, fora do guard) entra na fila", () => {
    const decaido = row("decaido@test.com", { sends_count: 6, priority_points: -5 });
    const q = buildDailySendQueue([decaido], noGuard);
    assert.deepStrictEqual(
      q.map((r) => r.email),
      ["decaido@test.com"],
    );
  });

  it("buildDailySendQueue: decaído entra, mas ordenado ABAIXO de quem tem score positivo (compareDailyQueueOrder já fazia isso certo)", () => {
    const decaido = row("decaido@test.com", { sends_count: 6, priority_points: -5 });
    const scorePositivo = row("positivo@test.com", { sends_count: 6, priority_points: 30 });
    const q = buildDailySendQueue([decaido, scorePositivo], noGuard);
    assert.deepStrictEqual(
      q.map((r) => r.email),
      ["positivo@test.com", "decaido@test.com"],
    );
    assert.ok(compareDailyQueueOrder(scorePositivo, decaido) < 0);
  });

  it("buildDailySendQueue: guard de duplicidade por contato (queued/committed, #7236) continua intacto — decaído numa lista queued ainda é excluído", () => {
    const decaidoNaFila = row("decaido-agendado@test.com", {
      sends_count: 6,
      priority_points: -5,
      brevo_list_ids: JSON.stringify(["list-queued-hoje"]),
    });
    const guards = { queuedListIds: new Set(["list-queued-hoje"]), committedListIds: new Set<string>() };
    assert.deepStrictEqual(buildDailySendQueue([decaidoNaFila], guards), []);
  });

  it("isDailyQueueEligible: send_eligible=0 e conta de teste continuam excluindo, independente do score", () => {
    const inelegivel = row("inelegivel@test.com", { sends_count: 4, priority_points: 30, send_eligible: 0 });
    assert.strictEqual(isDailyQueueEligible(inelegivel), false);
    const conta_teste = row("vjpixel+test@gmail.com", { sends_count: 4, priority_points: 30 });
    assert.strictEqual(isDailyQueueEligible(conta_teste), false);
  });
});

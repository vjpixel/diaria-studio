/**
 * test/overnight-watchdog-resumed-at-11433.test.ts (#11433)
 *
 * A escalada `urgente` do #11276 conta stalls finais sem `resumed_at`, mas
 * nada gravava `resumed_at` (o watchdog sempre anexava `null`). Uma rodada com
 * stalls às 01:00, 04:00 e 07:00 e atividade real entre eles escalava como
 * "sessão parada sem retomar". Agora o watchdog marca o último stall como
 * retomado quando vê atividade posterior a ele (`markLastStallResumed`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countTrailingUnresumedStalls,
  isDeduped,
  markLastStallResumed,
  shouldEscalateUnresumedStalls,
  type StallEvent,
} from "../scripts/overnight-watchdog.ts";

const ms = (iso: string): number => new Date(iso).getTime();
const ev = (at: string, resumed_at: string | null = null): StallEvent => ({ at, reason: "unknown", resumed_at });

/**
 * Reproduz a sequência do bloco STALL de `runWatchdogForKind`: marca o último
 * evento com a atividade observada, depois anexa o stall novo e avalia a
 * escalada (a ordem real do código).
 */
function simulate(ticks: { now: string; lastActivity: string }[]): { events: StallEvent[]; escalatedAt: string[] } {
  let events: StallEvent[] = [];
  const escalatedAt: string[] = [];
  let escalated = false;
  for (const t of ticks) {
    events = markLastStallResumed(events, ms(t.lastActivity));
    events = [...events, ev(new Date(ms(t.now)).toISOString())];
    if (shouldEscalateUnresumedStalls(events, escalated)) {
      escalated = true;
      escalatedAt.push(t.now);
    }
  }
  return { events, escalatedAt };
}

describe("#11433 — markLastStallResumed", () => {
  it("marca o último stall quando há atividade depois dele", () => {
    const out = markLastStallResumed([ev("2026-10-28T01:00:00.000Z")], ms("2026-10-28T03:00:00.000Z"));
    assert.equal(out[0].resumed_at, "2026-10-28T03:00:00.000Z");
  });

  it("não marca quando a última atividade é anterior (ou igual) ao stall", () => {
    const events = [ev("2026-10-28T01:00:00.000Z")];
    assert.equal(markLastStallResumed(events, ms("2026-10-28T00:10:00.000Z")), events, "mesma referência");
    assert.equal(markLastStallResumed(events, ms("2026-10-28T01:00:00.000Z"))[0].resumed_at, null);
  });

  it("não sobrescreve resumed_at já gravado nem quebra com lista vazia/ausente ou at inválido", () => {
    const done = [ev("2026-10-28T01:00:00.000Z", "2026-10-28T01:30:00.000Z")];
    assert.equal(markLastStallResumed(done, ms("2026-10-28T05:00:00.000Z")), done);
    assert.deepEqual(markLastStallResumed(undefined, Date.now()), []);
    assert.deepEqual(markLastStallResumed([], Date.now()), []);
    const bad = [ev("lixo")];
    assert.equal(markLastStallResumed(bad, Date.now()), bad);
  });

  it("só toca o último evento", () => {
    const events = [ev("2026-10-28T01:00:00.000Z"), ev("2026-10-28T01:30:00.000Z")];
    const out = markLastStallResumed(events, ms("2026-10-28T03:00:00.000Z"));
    assert.equal(out[0].resumed_at, null);
    assert.equal(out[1].resumed_at, "2026-10-28T03:00:00.000Z");
    assert.equal(events[1].resumed_at, null, "não muta a entrada");
  });
});

describe("#11433 — escalada só para stall contínuo", () => {
  it("regressão: 3 stalls com atividade real entre eles → sem escalada", () => {
    const { events, escalatedAt } = simulate([
      { now: "2026-10-28T01:00:00.000Z", lastActivity: "2026-10-28T00:10:00.000Z" },
      { now: "2026-10-28T04:00:00.000Z", lastActivity: "2026-10-28T03:00:00.000Z" },
      { now: "2026-10-28T07:00:00.000Z", lastActivity: "2026-10-28T06:00:00.000Z" },
    ]);
    assert.deepEqual(escalatedAt, []);
    assert.equal(countTrailingUnresumedStalls(events), 1);
    assert.equal(events[0].resumed_at, "2026-10-28T03:00:00.000Z");
    assert.equal(events[1].resumed_at, "2026-10-28T06:00:00.000Z");
  });

  it("3 stalls seguidos sem atividade nenhuma → escala (o caso do #11276 continua coberto)", () => {
    const { escalatedAt } = simulate([
      { now: "2026-10-28T01:00:00.000Z", lastActivity: "2026-10-28T00:10:00.000Z" },
      { now: "2026-10-28T01:25:00.000Z", lastActivity: "2026-10-28T00:10:00.000Z" },
      { now: "2026-10-28T01:50:00.000Z", lastActivity: "2026-10-28T00:10:00.000Z" },
    ]);
    assert.deepEqual(escalatedAt, ["2026-10-28T01:50:00.000Z"]);
  });

  it("retomada no meio zera a sequência: escala só depois de 3 contíguos novos", () => {
    const { escalatedAt } = simulate([
      { now: "2026-10-28T01:00:00.000Z", lastActivity: "2026-10-28T00:10:00.000Z" },
      { now: "2026-10-28T01:25:00.000Z", lastActivity: "2026-10-28T00:10:00.000Z" },
      { now: "2026-10-28T04:00:00.000Z", lastActivity: "2026-10-28T03:00:00.000Z" },
      { now: "2026-10-28T04:25:00.000Z", lastActivity: "2026-10-28T03:00:00.000Z" },
      { now: "2026-10-28T04:50:00.000Z", lastActivity: "2026-10-28T03:00:00.000Z" },
    ]);
    assert.deepEqual(escalatedAt, ["2026-10-28T04:50:00.000Z"]);
  });

  it("stall marcado como retomado deixa de deduplicar o stall seguinte", () => {
    const marked = markLastStallResumed([ev("2026-10-28T01:00:00.000Z")], ms("2026-10-28T01:05:00.000Z"));
    assert.equal(isDeduped(marked, 22.5 * 60_000, ms("2026-10-28T01:10:00.000Z")), false);
  });
});

/**
 * test/lib/kit-subscriber-state-transition-alarm.test.ts (#7660)
 *
 * Regressão do alarme de transição de estado no Kit — `active` →
 * `complained`/`bounced`/`cancelled`/`inactive`.
 *
 * A 1ª versão importava de `vitest`, dependência que este repo não usa (o
 * runner é `node:test`): quebrava `test`, `Typecheck ratchet` (TS2307) e
 * `Unused code check` (unlisted dependency) de uma vez só — a mesma causa
 * raiz da PR #7669, do mesmo lote. Convertido, e os literais passaram a
 * respeitar os tipos reais (`KitSubscriberSummary` tem `email_address`;
 * `KitStateTransition` tem `address` — a versão anterior usava
 * `email_address` nos dois e escondia a divergência com `as any`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectKitStateTransitions,
  toStateTransitionAlarmFindings,
  shouldAlarmKitStateTransition,
  advanceKitStateTransitionAlarmState,
  emptyKitStateTransitionAlarmState,
  KIT_STATE_TRANSITION_ALARM_STATES,
  type KitStateTransitionSnapshotEntry,
} from "../../scripts/lib/kit-subscriber-state-transition-alarm.ts";
import type { KitSubscriberSummary } from "../../scripts/lib/kit-subscribers.ts";

const NOW = new Date("2026-09-08T12:00:00Z");

const PREV: KitStateTransitionSnapshotEntry[] = [
  { id: 1, state: "active" },
  { id: 2, state: "active" },
  { id: 3, state: "bounced" },
];

function sub(id: number, state: string, fields: Record<string, string> = {}): KitSubscriberSummary {
  return { id, email_address: `s${id}@x.com`, state, created_at: "2026-01-01T00:00:00Z", fields };
}

describe("detectKitStateTransitions (#7660)", () => {
  it("detecta active → complained", () => {
    const res = detectKitStateTransitions(PREV, [sub(1, "complained")], NOW);
    assert.equal(res.length, 1);
    assert.equal(res[0].toState, "complained");
    assert.equal(res[0].fromState, "active");
    assert.equal(res[0].address, "s1@x.com");
  });

  it("bounced incluído por default — premissa registrada do #7660", () => {
    assert.ok(KIT_STATE_TRANSITION_ALARM_STATES.includes("bounced"));
    assert.equal(detectKitStateTransitions(PREV, [sub(2, "bounced")], NOW).length, 1);
  });

  it("active → active não é transição", () => {
    assert.equal(detectKitStateTransitions(PREV, [sub(1, "active")], NOW).length, 0);
  });

  it("cadastro novo (sem entry no snapshot anterior) não conta — é assunto do DOI orphan guard", () => {
    assert.equal(detectKitStateTransitions(PREV, [sub(99, "complained")], NOW).length, 0);
  });

  it("quem JÁ estava num estado de alarme não realarma (só sai de `active`)", () => {
    assert.equal(detectKitStateTransitions(PREV, [sub(3, "bounced")], NOW).length, 0);
  });

  it("estado fora da lista de alarme (ex: `unconfirmed`) é ignorado", () => {
    assert.equal(detectKitStateTransitions(PREV, [sub(1, "unconfirmed")], NOW).length, 0);
  });

  it("apoioNivel vem do custom field do snapshot ATUAL", () => {
    const res = detectKitStateTransitions(PREV, [sub(1, "cancelled", { apoio_nivel: "mantenedor" })], NOW);
    assert.equal(res[0].apoioNivel, "mantenedor");
  });
});

describe("latch por assinante (#7660)", () => {
  it("1ª detecção alarma; depois do advance, a mesma não realarma", () => {
    const s = emptyKitStateTransitionAlarmState();
    const t = detectKitStateTransitions(PREV, [sub(1, "complained")], NOW);
    assert.equal(shouldAlarmKitStateTransition(s, t), true);
    const next = advanceKitStateTransitionAlarmState(s, t, [2, 3], NOW);
    assert.equal(shouldAlarmKitStateTransition(next, t), false);
    assert.deepEqual(next.alertedSubscriberIds, [1]);
    assert.equal(next.lastCheckedAt, NOW.toISOString());
  });

  it("assinante que voltou a `active` sai do latch — re-arma pra uma próxima transição", () => {
    const s = { alertedSubscriberIds: [1, 2], lastCheckedAt: "2026-09-07T00:00:00Z" };
    // id 1 aparece na lista de ativos → limpo do latch; id 2 não → permanece.
    const next = advanceKitStateTransitionAlarmState(s, [], [1], NOW);
    assert.deepEqual(next.alertedSubscriberIds, [2]);
  });

  it("transição já alertada não realarma enquanto o assinante não voltar a active", () => {
    const s = { alertedSubscriberIds: [1], lastCheckedAt: "2026-09-07T00:00:00Z" };
    const t = detectKitStateTransitions([{ id: 1, state: "active" }], [sub(1, "complained")], NOW);
    assert.equal(shouldAlarmKitStateTransition(s, t), false);
  });
});

describe("toStateTransitionAlarmFindings (#7660)", () => {
  it("apoiador aparece no título, e a finding é P1/evento (nunca fecha sozinha)", () => {
    const [f] = toStateTransitionAlarmFindings([
      {
        id: 4264399626,
        address: "pedro@x.com",
        fromState: "active",
        toState: "complained",
        detectedAt: NOW.toISOString(),
        apoioNivel: "apoiador",
      },
    ]);
    assert.match(f.title, /apoiador/);
    assert.equal(f.priority, "P1");
    assert.equal(f.family, "evento");
    assert.match(f.body, /re-registrar o assinante via form de DOI/);
  });

  it("sem apoio_nivel o título diz 'assinante', não 'apoiador'", () => {
    const [f] = toStateTransitionAlarmFindings([
      { id: 7, address: "x@x.com", fromState: "active", toState: "bounced", detectedAt: NOW.toISOString() },
    ]);
    assert.match(f.title, /assinante/);
    assert.doesNotMatch(f.title, /apoiador/);
  });

  it("fingerprint é por assinante — dois assinantes distintos nunca colapsam numa issue só", () => {
    const fs = toStateTransitionAlarmFindings([
      { id: 1, address: "a@x.com", fromState: "active", toState: "bounced", detectedAt: NOW.toISOString() },
      { id: 2, address: "b@x.com", fromState: "active", toState: "bounced", detectedAt: NOW.toISOString() },
    ]);
    assert.equal(new Set(fs.map((f) => f.fingerprint)).size, 2);
  });
});

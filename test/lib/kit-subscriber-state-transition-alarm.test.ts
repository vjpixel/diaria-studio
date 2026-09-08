import { describe, test, expect } from "vitest";
import {
  detectKitStateTransitions,
  toStateTransitionAlarmFindings,
  shouldAlarmKitStateTransition,
  advanceKitStateTransitionAlarmState,
  emptyKitStateTransitionAlarmState,
  KIT_STATE_TRANSITION_ALARM_STATES,
} from "../../scripts/lib/kit-subscriber-state-transition-alarm.ts";

describe("#7660 kit-subscriber-state-transition-alarm", () => {
  const prev = [{ id: 1, state: "active" }, { id: 2, state: "active" }, { id: 3, state: "bounced" }];
  const now = new Date("2026-09-08T12:00:00Z");

  test("detecta active → complained", () => {
    const cur = [{ id: 1, email_address: "a@x.com", state: "complained", fields: {} }];
    const res = detectKitStateTransitions(prev, cur as any, now);
    expect(res.length).toBe(1);
    expect(res[0].toState).toBe("complained");
  });

  test("bounced incluido por default (premissa #7660)", () => {
    expect(KIT_STATE_TRANSITION_ALARM_STATES).toContain("bounced");
    const cur = [{ id: 2, email_address: "b@x.com", state: "bounced", fields: {} }];
    expect(detectKitStateTransitions(prev, cur as any, now).length).toBe(1);
  });

  test("não alarma active → active", () => {
    const cur = [{ id: 1, email_address: "a@x.com", state: "active", fields: {} }];
    expect(detectKitStateTransitions(prev, cur as any, now).length).toBe(0);
  });

  test("não conta sem entry prev (novo cadastro)", () => {
    const cur = [{ id: 99, email_address: "n@x.com", state: "complained", fields: {} }];
    expect(detectKitStateTransitions(prev, cur as any, now).length).toBe(0);
  });

  test("não alarmar se already alerted (latch)", () => {
    const s = emptyKitStateTransitionAlarmState();
    const t = detectKitStateTransitions(prev, [{ id: 1, email_address: "a@x.com", state: "complained", fields: {} }] as any, now);
    expect(shouldAlarmKitStateTransition(s, t)).toBe(true);
    const next = advanceKitStateTransitionAlarmState(s, t, [2,3], now);
    expect(shouldAlarmKitStateTransition(next, t)).toBe(false);
  });

  test("re-arma quando volta a active e transitiona de novo", () => {
    const s = { alertedSubscriberIds: [1], lastCheckedAt: "2026-09-07T00:00:00Z" };
    const t = detectKitStateTransitions(
      [{ id: 1, state: "active" }],
      [{ id: 1, email_address: "a@x.com", state: "complained", fields: {} }] as any,
      now,
    );
    expect(shouldAlarmKitStateTransition(s, t)).toBe(false); // já alertado — latch impede re-aviso
  });

  test("toStateTransitionAlarmFindings com apoioNivel", () => {
    const findings = toStateTransitionAlarmFindings([{
      id: 4264399626, email_address: "pedro@x.com", fromState: "active", toState: "complained",
      detectedAt: now.toISOString(), apoioNivel: "apoiador", engagement: { sent: 248, opened: 210, clicked: 23 },
    }]);
    expect(findings.length).toBe(1);
    expect(findings[0].title).toContain("apoiador");
    expect(findings[0].priority).toBe("P1");
    expect(findings[0].family).toBe("evento");
  });
});

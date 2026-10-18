/**
 * #10389: slot do carrossel semanal vencido detectado cedo, com as opções de
 * saída. Cenário real da issue: `/diaria-retro-semanal` invocada no sábado
 * por volta das 12:00 BRT, `highlights` agendado pras 11:00 do mesmo dia.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkWeeklySlot,
  suggestSameDayTime,
  formatSlotAdvice,
  WEEKLY_SLOT_MIN_OFFSET_SECONDS,
} from "../scripts/lib/weekly-slot-check.ts";
import { validateScheduledTime } from "../scripts/publish-facebook.ts";

const SLOT = "2026-10-17T11:00:00-03:00";
const at = (iso: string) => new Date(iso);

describe("checkWeeklySlot (#10389)", () => {
  it("cenário da issue: sábado 12:01 BRT, slot 11:00 → expired, 61min atrás", () => {
    const r = checkWeeklySlot(SLOT, at("2026-10-17T12:01:00-03:00"));
    assert.equal(r.status, "expired");
    assert.equal(r.minutesFromNow, -61);
  });

  it("slot a menos de 10min → too-soon", () => {
    assert.equal(checkWeeklySlot(SLOT, at("2026-10-17T10:55:00-03:00")).status, "too-soon");
  });

  it("slot com folga → ok", () => {
    assert.equal(checkWeeklySlot(SLOT, at("2026-10-17T09:00:00-03:00")).status, "ok");
  });

  it("data inválida lança", () => {
    assert.throws(() => checkWeeklySlot("nao-e-data", new Date()));
  });

  it("paridade com validateScheduledTime: status != ok exatamente quando o publisher rejeitaria", () => {
    const nows = [
      "2026-10-17T08:00:00-03:00",
      "2026-10-17T10:49:00-03:00",
      "2026-10-17T10:50:00-03:00",
      "2026-10-17T10:51:00-03:00",
      "2026-10-17T11:00:00-03:00",
      "2026-10-17T13:00:00-03:00",
    ];
    for (const n of nows) {
      const now = at(n);
      let rejects = false;
      try {
        validateScheduledTime(SLOT, now, WEEKLY_SLOT_MIN_OFFSET_SECONDS);
      } catch {
        rejects = true;
      }
      assert.equal(checkWeeklySlot(SLOT, now).status !== "ok", rejects, `divergência em now=${n}`);
    }
  });
});

describe("suggestSameDayTime (#10389)", () => {
  it("12:01 → 12:45 (now + 30min, arredondado pro quarto de hora seguinte), no fuso do slot", () => {
    assert.equal(suggestSameDayTime(SLOT, at("2026-10-17T12:01:00-03:00")), "12:45");
  });

  it("exato no quarto de hora não arredonda pra cima de novo", () => {
    assert.equal(suggestSameDayTime(SLOT, at("2026-10-17T12:00:00-03:00")), "12:30");
  });

  it("perto da meia-noite não cabe no mesmo dia → null (só --day-offset resolve)", () => {
    assert.equal(suggestSameDayTime(SLOT, at("2026-10-17T23:40:00-03:00")), null);
  });

  it("now já no dia seguinte ao slot → null", () => {
    assert.equal(suggestSameDayTime(SLOT, at("2026-10-18T09:00:00-03:00")), null);
  });
});

describe("formatSlotAdvice (#10389)", () => {
  it("slot ok → nenhum aviso", () => {
    const now = at("2026-10-17T09:00:00-03:00");
    assert.deepEqual(formatSlotAdvice({ mode: "highlights", saturday: "261017", check: checkWeeklySlot(SLOT, now), now, dayOffset: 0 }), []);
  });

  it("slot vencido → as 3 opções: --time, --day-offset (offset do modo + 1) e pular o modo", () => {
    const now = at("2026-10-17T12:01:00-03:00");
    const text = formatSlotAdvice({ mode: "highlights", saturday: "261017", check: checkWeeklySlot(SLOT, now), now, dayOffset: 0 }).join("\n");
    assert.match(text, /já passou \(61min atrás\)/);
    assert.match(text, /--saturday 261017 --mode highlights --time 12:45/);
    assert.match(text, /--mode highlights --day-offset 1/);
    assert.match(text, /pular o modo highlights/);
  });

  it("sem horário viável no mesmo dia, omite --time mas mantém --day-offset", () => {
    const now = at("2026-10-17T23:40:00-03:00");
    const text = formatSlotAdvice({ mode: "highlights", saturday: "261017", check: checkWeeklySlot(SLOT, now), now, dayOffset: 0 }).join("\n");
    assert.doesNotMatch(text, /--time/);
    assert.match(text, /--day-offset 1/);
  });
});

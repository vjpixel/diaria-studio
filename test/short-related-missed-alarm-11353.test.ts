/**
 * test/short-related-missed-alarm-11353.test.ts (#11353)
 *
 * Lógica pura do alarme que pega a task do vídeo relacionado do Short
 * (#10811) quando ela não roda no Neo, e a entrada no registro de tasks.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildShortRelatedMissedAlarm,
  evaluateShortRelatedMissed,
  isAlarmingShortRelatedVerdict,
  type FileRead,
  type ShortRelatedMissedInput,
} from "../scripts/lib/diaria/short-related-missed-alarm.ts";
import { brtInstant, studioShortsListUrl, type ShortRelatedRecord } from "../scripts/lib/diaria/youtube-short-related.ts";
import type { ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";
import { SCHEDULED_TASKS, getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

// 261027 é terça; 261031 é sábado.
const WEEKDAY = "261027";
const SHORT_AT = brtInstant(WEEKDAY, "12:00");
const AFTER_DEADLINE = brtInstant(WEEKDAY, "13:30");

const registry: FileRead<ShortsPublishedFile> = {
  kind: "ok",
  value: {
    aammdd: WEEKDAY,
    entries: [
      { destination: "instagram", status: "published", id: "ig1", at: "2026-10-27T15:00:00.000Z" },
      { destination: "youtube_shorts", status: "published", id: "abcdefghijk", url: "https://youtube.com/shorts/abcdefghijk", at: "2026-10-27T15:00:00.000Z" },
    ],
  },
};

function record(over: Partial<ShortRelatedRecord> & Pick<ShortRelatedRecord, "status">): FileRead<ShortRelatedRecord> {
  return {
    kind: "ok",
    value: {
      aammdd: WEEKDAY,
      horizontalId: "hhhhhhhhhhh",
      shortId: "abcdefghijk",
      note: null,
      at: "2026-10-27T15:30:00.000Z",
      alertedAt: null,
      ...over,
    } as ShortRelatedRecord,
  };
}

function input(over: Partial<ShortRelatedMissedInput> = {}): ShortRelatedMissedInput {
  return {
    aammdd: WEEKDAY,
    now: AFTER_DEADLINE,
    editionExists: true,
    noVideo: false,
    shortsRegistry: registry,
    record: { kind: "absent" },
    shortAt: SHORT_AT,
    ...over,
  };
}

describe("#11353 evaluateShortRelatedMissed", () => {
  it("cenário da issue: dia útil, Short registrado, sem registro do vínculo depois do prazo → alarma", () => {
    const ev = evaluateShortRelatedMissed(input());
    assert.equal(ev.verdict, "missing-record");
    assert.ok(isAlarmingShortRelatedVerdict(ev.verdict));
    assert.equal(ev.shortRef, "https://youtube.com/shorts/abcdefghijk");
    assert.equal(ev.deadline, brtInstant(WEEKDAY, "13:00").toISOString());
  });

  it("registro com alertedAt: a task já avisou, não alarma de novo", () => {
    const ev = evaluateShortRelatedMissed(input({ record: record({ status: "failed", alertedAt: "2026-10-27T15:05:00.000Z" }) }));
    assert.equal(ev.verdict, "task-alerted");
    assert.equal(isAlarmingShortRelatedVerdict(ev.verdict), false);
  });

  it("registro 'alerted' (só o alerta saiu) também não alarma", () => {
    const ev = evaluateShortRelatedMissed(
      input({ record: record({ status: "alerted", alertedAt: "2026-10-27T15:05:00.000Z", horizontalId: null, shortId: null }) }),
    );
    assert.equal(ev.verdict, "task-alerted");
  });

  it("registro linked: não alarma", () => {
    const ev = evaluateShortRelatedMissed(input({ record: record({ status: "linked" }) }));
    assert.equal(ev.verdict, "linked");
    assert.equal(isAlarmingShortRelatedVerdict(ev.verdict), false);
  });

  it("registro failed sem alertedAt: a falha não chegou ao editor → alarma", () => {
    const ev = evaluateShortRelatedMissed(input({ record: record({ status: "failed" }) }));
    assert.equal(ev.verdict, "failed-not-alerted");
    assert.ok(isAlarmingShortRelatedVerdict(ev.verdict));
  });

  it("registro ilegível → alarma", () => {
    const ev = evaluateShortRelatedMissed(input({ record: { kind: "unreadable", error: "JSON inválido" } }));
    assert.equal(ev.verdict, "record-unreadable");
    assert.ok(isAlarmingShortRelatedVerdict(ev.verdict));
  });

  it("antes de shortAt + 60 min não alarma, mesmo sem registro", () => {
    const ev = evaluateShortRelatedMissed(input({ now: brtInstant(WEEKDAY, "12:59") }));
    assert.equal(ev.verdict, "before-deadline");
    assert.equal(isAlarmingShortRelatedVerdict(ev.verdict), false);
  });

  it("exatamente no prazo já alarma", () => {
    assert.equal(evaluateShortRelatedMissed(input({ now: brtInstant(WEEKDAY, "13:00") })).verdict, "missing-record");
  });

  it("slot cedo (06:30): às 13:30 o prazo de 07:30 já passou", () => {
    const ev = evaluateShortRelatedMissed(input({ shortAt: brtInstant(WEEKDAY, "06:30") }));
    assert.equal(ev.verdict, "missing-record");
  });

  it("horário do Short não derivado: o prazo é o próprio instante da checagem", () => {
    const ev = evaluateShortRelatedMissed(input({ shortAt: null }));
    assert.equal(ev.verdict, "missing-record");
    assert.equal(ev.deadline, null);
  });

  it("fim de semana não alarma", () => {
    const sat = "261031";
    const ev = evaluateShortRelatedMissed(input({ aammdd: sat, now: brtInstant(sat, "13:30"), shortAt: brtInstant(sat, "12:00") }));
    assert.equal(ev.verdict, "weekend");
  });

  it("sem pasta da edição não alarma", () => {
    assert.equal(evaluateShortRelatedMissed(input({ editionExists: false })).verdict, "no-edition");
  });

  it("edição marcada sem vídeo não alarma", () => {
    assert.equal(evaluateShortRelatedMissed(input({ noVideo: true })).verdict, "no-video");
  });

  it("sem registro do vertical não alarma (não houve Short)", () => {
    assert.equal(evaluateShortRelatedMissed(input({ shortsRegistry: { kind: "absent" } })).verdict, "no-short");
  });

  it("registro do vertical sem youtube_shorts não alarma", () => {
    const only: FileRead<ShortsPublishedFile> = {
      kind: "ok",
      value: { aammdd: WEEKDAY, entries: [{ destination: "instagram", status: "published", id: "ig1", at: "x" }] },
    };
    assert.equal(evaluateShortRelatedMissed(input({ shortsRegistry: only })).verdict, "no-short");
  });

  it("youtube_shorts em send_unknown conta como Short registrado", () => {
    const unk: FileRead<ShortsPublishedFile> = {
      kind: "ok",
      value: { aammdd: WEEKDAY, entries: [{ destination: "youtube_shorts", status: "send_unknown", id: "pending", at: "x" }] },
    };
    assert.equal(evaluateShortRelatedMissed(input({ shortsRegistry: unk })).verdict, "missing-record");
  });

  it("registro do vertical ilegível depois do prazo → alarma; antes do prazo, espera", () => {
    const bad: FileRead<ShortsPublishedFile> = { kind: "unreadable", error: "sem entries" };
    assert.equal(evaluateShortRelatedMissed(input({ shortsRegistry: bad })).verdict, "shorts-registry-unreadable");
    assert.equal(
      evaluateShortRelatedMissed(input({ shortsRegistry: bad, now: brtInstant(WEEKDAY, "12:30") })).verdict,
      "before-deadline",
    );
  });
});

describe("#11353 buildShortRelatedMissedAlarm", () => {
  it("assunto cita a edição; corpo traz o passo manual e a ressalva do OneDrive", () => {
    const ev = evaluateShortRelatedMissed(input());
    const { subject, body } = buildShortRelatedMissedAlarm(ev, studioShortsListUrl());
    assert.match(subject, /261027/);
    assert.match(body, /missing-record/);
    assert.match(body, /Vídeo relacionado/);
    assert.match(body, /OneDrive/);
    assert.ok(body.includes(studioShortsListUrl()));
  });
});

describe("#11353 Diaria-Short-Related-Missed-Alarm no registro", () => {
  it("diária 13:30 BRT, depois do prazo do slot mais tardio (12:00 + 60 min)", () => {
    const t = getScheduledTaskByName("Diaria-Short-Related-Missed-Alarm");
    assert.ok(t);
    assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/short-related-missed-alarm.ts"]);
    assert.deepEqual(t!.schedule, { kind: "daily", hour: 13, minute: 30 });
    assert.equal(t!.guard?.requiredFile, "editions");
    assert.equal(t!.issue, "#11353");
  });

  it("13:30 não colide com outra daily", () => {
    const collisions = SCHEDULED_TASKS.filter(
      (t) =>
        t.name !== "Diaria-Short-Related-Missed-Alarm" &&
        t.schedule.kind === "daily" &&
        t.schedule.hour === 13 &&
        t.schedule.minute === 30,
    );
    assert.deepEqual(collisions, []);
  });
});

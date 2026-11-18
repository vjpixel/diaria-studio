/**
 * test/short-related-late-short-13571.test.ts (#13571)
 *
 * Edição 261118: o horário configurado do Short era 06:30 BRT (prazo da task
 * do Neo 07:30 BRT), mas o vertical só ficou pronto à tarde e o Short foi ao
 * ar às 16:12Z (13:12 BRT). A task do Neo roda uma vez por dia (06:05 BRT) e
 * não vinculou nada. O alarme saiu `missing-record` dizendo "possível atraso
 * de replicação", quando a causa era o Short publicado depois do prazo da task.
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
import { brtInstant, studioShortsListUrl } from "../scripts/lib/diaria/youtube-short-related.ts";
import type { ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";

const ED = "261118"; // quarta-feira
const SHORT_AT = brtInstant(ED, "06:30");
const ALARM_NOW = brtInstant(ED, "13:30");

function registry(at: string, scheduledAt: string | null = null): FileRead<ShortsPublishedFile> {
  return {
    kind: "ok",
    value: {
      aammdd: ED,
      entries: [{ destination: "youtube_shorts", status: "published", id: "01fQoXMLBnM", url: "https://youtube.com/shorts/01fQoXMLBnM", at, scheduled_at: scheduledAt }],
    },
  };
}

function input(over: Partial<ShortRelatedMissedInput> = {}): ShortRelatedMissedInput {
  return {
    aammdd: ED,
    now: ALARM_NOW,
    editionExists: true,
    noVideo: false,
    shortsRegistry: registry("2026-11-18T16:12:01.072Z"),
    record: { kind: "absent" },
    shortAt: SHORT_AT,
    ...over,
  };
}

describe("#13571 Short publicado depois do prazo da task do Neo", () => {
  it("cenário da 261118: alarma (o vínculo é à mão) e diz que o Short foi ao ar depois do prazo", () => {
    const ev = evaluateShortRelatedMissed(input());
    assert.equal(ev.verdict, "missing-record");
    assert.ok(isAlarmingShortRelatedVerdict(ev.verdict));
    assert.equal(ev.shortAfterTaskDeadline, "2026-11-18T16:12:01.072Z");
    assert.match(ev.reason, /foi ao ar em 2026-11-18T16:12:01\.072Z, depois do prazo da task do Neo/);
    assert.doesNotMatch(ev.reason, /atraso de replicação/);
    const { body } = buildShortRelatedMissedAlarm(ev, studioShortsListUrl());
    assert.match(body, /Short publicado depois do prazo/);
    assert.doesNotMatch(body, /pode atrasar/);
  });

  it("Short no horário: segue o texto de antes (sem afirmar atraso do Short)", () => {
    const ev = evaluateShortRelatedMissed(input({ shortsRegistry: registry("2026-11-18T09:30:05.000Z") }));
    assert.equal(ev.verdict, "missing-record");
    assert.equal(ev.shortAfterTaskDeadline, null);
    assert.match(ev.reason, /atraso de replicação/);
  });

  it("Short agendado: vale o scheduled_at, não o instante do registro", () => {
    const ev = evaluateShortRelatedMissed(input({ shortsRegistry: registry("2026-11-18T05:00:00.000Z", "2026-11-18T15:00:00.000Z") }));
    assert.equal(ev.shortAfterTaskDeadline, "2026-11-18T15:00:00.000Z");
  });

  it("horário do Short não derivado: não afirma atraso", () => {
    const ev = evaluateShortRelatedMissed(input({ shortAt: null }));
    assert.equal(ev.shortAfterTaskDeadline, null);
  });

  it("registro vinculado: não alarma, mesmo com Short tardio", () => {
    const ev = evaluateShortRelatedMissed(
      input({
        record: {
          kind: "ok",
          value: { aammdd: ED, horizontalId: "Y56-d-sT6OY", shortId: "01fQoXMLBnM", note: null, at: "2026-11-18T17:00:00.000Z", alertedAt: null, status: "linked" },
        },
      }),
    );
    assert.equal(ev.verdict, "linked");
  });
});

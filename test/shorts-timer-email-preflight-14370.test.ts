/**
 * test/shorts-timer-email-preflight-14370.test.ts (#14370)
 *
 * Pre-flight da credencial de e-mail nos timers de Shorts do 300. Caso real:
 * 18/11, alarme `publish-failed` do Instagram aberto como issue sem o e-mail
 * sair (faltava `data/.credentials.json`), e nada dizia que a credencial tinha
 * sumido. Decisão do editor (briefing 261128): a própria issue de alarme leva
 * rótulo e título "e-mail sem credencial".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALARM_EMAIL_NO_CREDENTIAL_LABEL,
  EMAIL_NO_CREDENTIAL_BODY_NOTE,
  EMAIL_NO_CREDENTIAL_TITLE_PREFIX,
  emailCredentialPresent,
  markAlarmEmailWithoutCredential,
  withEmailCredentialPreflight,
} from "../scripts/lib/diaria/shorts-timer-email-preflight.ts";
import { corteAlarm } from "../scripts/shorts-corte-timer.ts";
import type { GhRunFn } from "../scripts/lib/alarm-issues.ts";

const alarm = { check: "shorts-instagram-timer", subject: "[diar.ia.br] Reels 261118 não saiu", body: "corpo", labels: ["x"] };

describe("#14370 markAlarmEmailWithoutCredential", () => {
  it("credencial presente: o alarme sai intacto", () => {
    assert.deepEqual(markAlarmEmailWithoutCredential(alarm, true), alarm);
  });

  it("credencial ausente: título, label e corpo dizem que o e-mail está sem credencial", () => {
    const m = markAlarmEmailWithoutCredential(alarm, false);
    assert.ok(m.subject.startsWith(EMAIL_NO_CREDENTIAL_TITLE_PREFIX));
    assert.match(m.subject, /Reels 261118 não saiu/);
    assert.deepEqual(m.labels, ["x", ALARM_EMAIL_NO_CREDENTIAL_LABEL]);
    assert.ok(m.body.startsWith(EMAIL_NO_CREDENTIAL_BODY_NOTE));
    assert.match(m.body, /corpo$/);
    assert.equal(m.check, "shorts-instagram-timer");
  });

  it("idempotente: marcar duas vezes não duplica prefixo, label nem nota", () => {
    const twice = markAlarmEmailWithoutCredential(markAlarmEmailWithoutCredential(alarm, false), false);
    assert.equal(twice.subject.split(EMAIL_NO_CREDENTIAL_TITLE_PREFIX).length, 2);
    assert.equal(twice.labels!.filter((l) => l === ALARM_EMAIL_NO_CREDENTIAL_LABEL).length, 1);
    assert.equal(twice.body.split(EMAIL_NO_CREDENTIAL_BODY_NOTE).length, 2);
  });
});

describe("#14370 emailCredentialPresent", () => {
  it("usa a checagem injetada; erro na checagem conta como presente", () => {
    assert.equal(emailCredentialPresent({ emailCredentialsPresent: () => false }), false);
    assert.equal(emailCredentialPresent({ emailCredentialsPresent: () => true }), true);
    assert.equal(
      emailCredentialPresent({
        emailCredentialsPresent: () => {
          throw new Error("EACCES");
        },
      }),
      true,
    );
  });

  it("withEmailCredentialPreflight aplica a checagem", () => {
    assert.ok(withEmailCredentialPreflight(alarm, { emailCredentialsPresent: () => false }).subject.startsWith(EMAIL_NO_CREDENTIAL_TITLE_PREFIX));
    assert.equal(withEmailCredentialPreflight(alarm, { emailCredentialsPresent: () => true }).subject, alarm.subject);
  });
});

describe("#14370 timer real: a issue de alarme nasce com o rótulo e o título", () => {
  function captureGh() {
    const creates: string[][] = [];
    const ghRun: GhRunFn = (args) => {
      if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: "[]", stderr: "" };
      if (args[0] === "issue" && args[1] === "create") {
        creates.push(args);
        return { status: 0, stdout: "https://github.com/vjpixel/diaria-studio/issues/99999\n", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    return { creates, ghRun };
  }
  const spec = { slug: "261118-corte-1", date: "261118", hhmm: "12:00", title: "Corte" } as unknown as Parameters<typeof corteAlarm>[1];

  for (const present of [false, true]) {
    it(`corte-timer com credencial ${present ? "presente" : "ausente"}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "corte-14370-"));
      try {
        const { creates, ghRun } = captureGh();
        const sent: string[] = [];
        await corteAlarm(dir, spec, "instagram", "publish-failed", "HTTP 500", {
          ghRun,
          sendPush: async (m) => (sent.push(m.subject), { ok: false, error: "sem credencial" }),
          emailPolicy: "urgent_only",
          log: () => true,
          emailCredentialsPresent: () => present,
        });
        assert.equal(creates.length, 1);
        const args = creates[0];
        const title = args[args.indexOf("--title") + 1];
        const labels = args[args.indexOf("--label") + 1];
        if (present) {
          assert.ok(!title.startsWith(EMAIL_NO_CREDENTIAL_TITLE_PREFIX), title);
          assert.ok(!labels.split(",").includes(ALARM_EMAIL_NO_CREDENTIAL_LABEL), labels);
        } else {
          assert.ok(title.startsWith(EMAIL_NO_CREDENTIAL_TITLE_PREFIX), title);
          assert.ok(labels.split(",").includes(ALARM_EMAIL_NO_CREDENTIAL_LABEL), labels);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

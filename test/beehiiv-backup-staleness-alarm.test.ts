/**
 * test/beehiiv-backup-staleness-alarm.test.ts (#5494)
 *
 * Cobertura da lógica pura do alarme de staleness do snapshot semanal
 * `Diaria-Beehiiv-Backup`: dois motivos de alarme (stale/unusable), o caso
 * "nenhum snapshot ainda" (missing vs too-early), e a idempotência por
 * fingerprint.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateBeehiivBackupStalenessAlarm,
  computeBeehiivBackupStalenessFingerprint,
  shouldSendBeehiivBackupStalenessAlarm,
  markBeehiivBackupStalenessAlarmed,
  emptyBeehiivBackupStalenessAlarmState,
  buildBeehiivBackupStalenessAlarmEmail,
  isAlarmVerdict,
} from "../scripts/lib/beehiiv-backup-staleness-alarm.ts";
import { notifyEditor } from "../scripts/lib/editor-notify.ts";
import { alarmFindingMarker } from "../scripts/lib/alarm-issues.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const DAY = 86400;
const NOW = 1_755_000_000; // época fixa arbitrária pros testes

describe("evaluateBeehiivBackupStalenessAlarm", () => {
  it("snapshot recente e utilizável → ok", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-16", NOW - 2 * DAY, true, 7);
    assert.equal(evaluation.verdict, "ok");
  });

  it("snapshot com mais de maxAgeDays → alarm-stale", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 15 * DAY, true, 7);
    assert.equal(evaluation.verdict, "alarm-stale");
    assert.ok(evaluation.ageDays !== null && evaluation.ageDays > 7);
  });

  it("snapshot no prazo mas inutilizável (manifest error/skip, subscribers.jsonl vazio) → alarm-unusable, mesmo dentro do prazo", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-16", NOW - 1 * DAY, false, 7);
    assert.equal(evaluation.verdict, "alarm-unusable");
  });

  it("nenhum snapshot, mas ainda antes do 1º prazo esperado → ok-too-early, nunca alarm-missing", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, null, null, false, 7, NOW + DAY);
    assert.equal(evaluation.verdict, "ok-too-early");
  });

  it("nenhum snapshot, e já passou do 1º prazo esperado → alarm-missing", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, null, null, false, 7, NOW - DAY);
    assert.equal(evaluation.verdict, "alarm-missing");
  });

  it("exatamente no limite (ageDays == maxAgeDays) ainda é ok — só > maxAgeDays alarma", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-09", NOW - 7 * DAY, true, 7);
    assert.equal(evaluation.verdict, "ok");
  });
});

describe("isAlarmVerdict", () => {
  it("ok e ok-too-early não são alarme; os 3 alarm-* são", () => {
    assert.equal(isAlarmVerdict("ok"), false);
    assert.equal(isAlarmVerdict("ok-too-early"), false);
    assert.equal(isAlarmVerdict("alarm-stale"), true);
    assert.equal(isAlarmVerdict("alarm-unusable"), true);
    assert.equal(isAlarmVerdict("alarm-missing"), true);
  });
});

describe("idempotência (fingerprint + should-send)", () => {
  it("nunca envia pra veredito ok/ok-too-early", () => {
    const ok = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-16", NOW - 1 * DAY, true, 7);
    assert.equal(shouldSendBeehiivBackupStalenessAlarm(ok, emptyBeehiivBackupStalenessAlarmState()), false);
  });

  it("envia na 1ª vez que um alarme aparece, e não reenvia o MESMO veredito+snapshot", () => {
    const stale = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 15 * DAY, true, 7);
    assert.equal(shouldSendBeehiivBackupStalenessAlarm(stale, emptyBeehiivBackupStalenessAlarmState()), true);
    const nextState = markBeehiivBackupStalenessAlarmed(stale);
    assert.equal(shouldSendBeehiivBackupStalenessAlarm(stale, nextState), false);
  });

  it("reenvia se o veredito mudar (ex.: unusable → stale) mesmo pro mesmo snapshot", () => {
    const unusable = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 1 * DAY, false, 7);
    const state = markBeehiivBackupStalenessAlarmed(unusable);
    const staleLater = evaluateBeehiivBackupStalenessAlarm(NOW + 10 * DAY, "2026-08-01", NOW - 1 * DAY, true, 7);
    assert.equal(shouldSendBeehiivBackupStalenessAlarm(staleLater, state), true);
  });

  it("computeBeehiivBackupStalenessFingerprint é estável (mesmo veredito+snapshot → mesmo fingerprint)", () => {
    const a = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 15 * DAY, true, 7);
    const b = evaluateBeehiivBackupStalenessAlarm(NOW + 3600, "2026-08-01", NOW - 15 * DAY, true, 7);
    assert.equal(computeBeehiivBackupStalenessFingerprint(a), computeBeehiivBackupStalenessFingerprint(b));
  });
});

describe("buildBeehiivBackupStalenessAlarmEmail", () => {
  it("subject/body citam o veredito e a data do snapshot", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-01", NOW - 15 * DAY, true, 7);
    const { subject, body } = buildBeehiivBackupStalenessAlarmEmail(evaluation, 7);
    assert.match(subject, /alarm-stale/);
    assert.match(subject, /2026-08-01/);
    assert.match(body, /2026-08-01/);
    assert.match(body, /DELETE\+CREATE/);
  });

  it("caso alarm-missing cita 'nenhum snapshot' no body", () => {
    const evaluation = evaluateBeehiivBackupStalenessAlarm(NOW, null, null, false, 7, NOW - DAY);
    const { body } = buildBeehiivBackupStalenessAlarmEmail(evaluation, 7);
    assert.match(body, /Nenhum snapshot/);
  });
});

describe("notifyEditor + fingerprint (#7969 — regressão)", () => {
  const CHECK = "beehiiv-backup-staleness-alarm";

  /** `gh` mockado com um "banco" mutável de issues já criadas — reproduz o
   * comportamento real de `findExistingAlarmIssue`/`ensureAlarmIssue`:
   * `issue create` grava uma issue nova com o marcador do fingerprint;
   * `issue list --search` devolve as issues cujo corpo contém o marcador
   * exato buscado. Isso deixa o teste indiferente a COMO o fingerprint é
   * calculado — só ao resultado observável (created vs. reused). */
  function makeStatefulGhRun(): {
    run: (args: string[], cwd: string) => GhSpawnResult;
    issues: { number: number; url: string; body: string; state: "OPEN" | "CLOSED" }[];
  } {
    const issues: { number: number; url: string; body: string; state: "OPEN" | "CLOSED" }[] = [];
    let nextNumber = 100;
    const run = (args: string[]): GhSpawnResult => {
      if (args[0] === "issue" && args[1] === "list") {
        // Mesmo filtro client-side de `findExistingAlarmIssue`: o body tem
        // que conter o marcador exato — a busca --search em si é
        // best-effort no `gh` real, então o mock devolve TODAS as issues e
        // deixa `alarm-issues.ts` filtrar, igual em produção.
        return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "create") {
        const bodyIdx = args.indexOf("--body");
        const body = bodyIdx >= 0 ? args[bodyIdx + 1] : "";
        const number = nextNumber++;
        const url = `https://github.com/vjpixel/diaria-studio/issues/${number}`;
        issues.push({ number, url, body, state: "OPEN" });
        return { status: 0, stdout: `${url}\n`, stderr: "" };
      }
      if (args[0] === "issue" && args[1] === "view") {
        return { status: 0, stdout: JSON.stringify({ state: "OPEN" }), stderr: "" };
      }
      throw new Error(`unexpected gh call in test: ${args.join(" ")}`);
    };
    return { run, issues };
  }

  it("2 incidentes com snapshots DIFERENTES (issue do 1º ainda aberta) → o 2º cria issue nova, nunca reusa (#7969)", async () => {
    const { run } = makeStatefulGhRun();

    // Semana 1: snapshot D0 stale.
    const week1 = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-16", NOW - 15 * DAY, true, 7);
    const result1 = await notifyEditor(
      {
        check: CHECK,
        fingerprint: computeBeehiivBackupStalenessFingerprint(week1),
        severity: "acao",
        subject: "s1",
        body: "b1",
      },
      { cwd: "/tmp", ghRun: run, emailPolicy: "urgent_only" },
    );
    assert.equal(result1.issue?.action, "created");

    // Semana 3: incidente NOVO e genuíno, snapshot D2 diferente — o editor
    // ainda não fechou a issue da semana 1.
    const week3 = evaluateBeehiivBackupStalenessAlarm(NOW + 14 * DAY, "2026-08-30", NOW + 14 * DAY - 15 * DAY, true, 7);
    assert.equal(week3.verdict, week1.verdict, "pré-condição do cenário: mesmo veredito, snapshot diferente");
    const result2 = await notifyEditor(
      {
        check: CHECK,
        fingerprint: computeBeehiivBackupStalenessFingerprint(week3),
        severity: "acao",
        subject: "s2",
        body: "b2",
      },
      { cwd: "/tmp", ghRun: run, emailPolicy: "urgent_only" },
    );

    // Bug do #7969: usar `evaluation.verdict` (sem a data) como fingerprint
    // faria isto sair "reused", apontando ainda pra issue da semana 1 —
    // sem comentário nem e-mail sob `email_policy: "urgent_only"`.
    assert.equal(result2.issue?.action, "created");
    assert.notEqual(result1.issue?.issueNumber, result2.issue?.issueNumber);
  });

  it("reproduz literalmente o bug ANTES do fix: fingerprint = evaluation.verdict faz o 2º incidente casar com a issue do 1º (reused)", async () => {
    const { run } = makeStatefulGhRun();

    const week1 = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-16", NOW - 15 * DAY, true, 7);
    const result1 = await notifyEditor(
      { check: CHECK, fingerprint: week1.verdict, severity: "acao", subject: "s1", body: "b1" },
      { cwd: "/tmp", ghRun: run, emailPolicy: "urgent_only" },
    );
    assert.equal(result1.issue?.action, "created");

    const week3 = evaluateBeehiivBackupStalenessAlarm(NOW + 14 * DAY, "2026-08-30", NOW + 14 * DAY - 15 * DAY, true, 7);
    const result2 = await notifyEditor(
      { check: CHECK, fingerprint: week3.verdict, severity: "acao", subject: "s2", body: "b2" },
      { cwd: "/tmp", ghRun: run, emailPolicy: "urgent_only" },
    );

    // Documenta o bug (não o comportamento desejado): com o fingerprint
    // grosso, os dois incidentes casam no MESMO marcador de issue.
    assert.equal(result2.issue?.action, "reused");
    assert.equal(result1.issue?.issueNumber, result2.issue?.issueNumber);
  });

  it("alarmFindingMarker embute a data do snapshot quando o fingerprint é o composto, não só o veredito", () => {
    const week1 = evaluateBeehiivBackupStalenessAlarm(NOW, "2026-08-16", NOW - 15 * DAY, true, 7);
    const week3 = evaluateBeehiivBackupStalenessAlarm(NOW + 14 * DAY, "2026-08-30", NOW + 14 * DAY - 15 * DAY, true, 7);
    const marker1 = alarmFindingMarker(CHECK, computeBeehiivBackupStalenessFingerprint(week1));
    const marker3 = alarmFindingMarker(CHECK, computeBeehiivBackupStalenessFingerprint(week3));
    assert.notEqual(marker1, marker3);
    assert.match(marker1, /2026-08-16/);
    assert.match(marker3, /2026-08-30/);
  });
});

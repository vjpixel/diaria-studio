/**
 * test/audience-profile-staleness-alarm-8148.test.ts (#8148 item 1)
 *
 * Cobre `scripts/lib/audience-profile-staleness-alarm.ts` — o parse do
 * warning do guard #4366 em `data/run-log.jsonl` e a conversão pra
 * `AlarmFinding` (`family: "evento"`, mesmo racional já validado por
 * `test/clarice-guardrail-alarm.test.ts` pro #5553/#5525 — cada ocorrência
 * é um fato histórico sobre um `today_file` específico, nunca se
 * "resolve" na execução seguinte).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseRunLogLine,
  findDuplicateArchiveEntries,
  toAlarmFinding,
  buildAlarmFindings,
  DUPLICATE_ARCHIVE_ISSUE_TAG,
  type AudienceStalenessLogEntry,
} from "../scripts/lib/audience-profile-staleness-alarm.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";

const REAL_WARNING_LINE = JSON.stringify({
  timestamp: "2026-09-14T19:36:52.367Z",
  edition: null,
  stage: 0,
  agent: "update-audience",
  level: "warn",
  message:
    "snapshot arquivado (2026-09-14.md) é idêntico ao mais recente já arquivado (2026-09-12.md) — possível regeneração que falhou silenciosamente numa rodada anterior (#4366)",
  details: { today_file: "2026-09-14.md", latest_file: "2026-09-12.md", issue: "#4366" },
});

describe("parseRunLogLine", () => {
  it("parseia uma linha JSON válida", () => {
    const parsed = parseRunLogLine(REAL_WARNING_LINE);
    assert.ok(parsed);
    assert.equal(parsed!.agent, "update-audience");
    assert.equal(parsed!.details?.today_file, "2026-09-14.md");
  });

  it("linha vazia/whitespace -> null (sem lançar)", () => {
    assert.equal(parseRunLogLine(""), null);
    assert.equal(parseRunLogLine("   "), null);
  });

  it("JSON malformado -> null (sem lançar)", () => {
    assert.equal(parseRunLogLine("{ isso nao e json"), null);
  });

  it("JSON válido mas não-objeto (array/número/string) -> null", () => {
    assert.equal(parseRunLogLine("42"), null);
    assert.equal(parseRunLogLine('"string solta"'), null);
    assert.equal(parseRunLogLine("[1,2,3]"), null, "array é 'object' em JS (typeof), mas nunca um evento de run-log válido");
  });
});

describe("findDuplicateArchiveEntries", () => {
  it("casa a linha real do guard #4366 (agent=update-audience + details.issue=#4366)", () => {
    const entries = findDuplicateArchiveEntries([REAL_WARNING_LINE]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].details?.issue, DUPLICATE_ARCHIVE_ISSUE_TAG);
  });

  it("ignora linhas de OUTROS agents/warnings, mesmo com 'issue' parecido", () => {
    const otherAgent = JSON.stringify({
      timestamp: "2026-09-10T10:00:00.000Z",
      agent: "source-researcher",
      level: "warn",
      message: "algo não relacionado",
      details: { issue: "#4366" }, // mesmo issue tag, agent diferente — não deve casar
    });
    const otherIssue = JSON.stringify({
      timestamp: "2026-09-10T10:00:00.000Z",
      agent: "update-audience",
      level: "warn",
      message: "outro warning qualquer do mesmo agent",
      details: { issue: "#8150" }, // agent certo, issue tag diferente — não deve casar
    });
    const entries = findDuplicateArchiveEntries([otherAgent, otherIssue]);
    assert.equal(entries.length, 0);
  });

  it("ignora linhas malformadas/em branco no meio do arquivo, sem lançar", () => {
    const entries = findDuplicateArchiveEntries(["", "{ quebrado", REAL_WARNING_LINE, "   "]);
    assert.equal(entries.length, 1);
  });

  it("as 5 ocorrências medidas no #8148 — todas casam, cada uma com today_file distinto", () => {
    const dates = [
      ["2026-08-18", "2026-08-17"],
      ["2026-08-19", "2026-08-18"],
      ["2026-08-29", "2026-08-27"],
      ["2026-09-02", "2026-09-01"],
      ["2026-09-14", "2026-09-12"],
    ];
    const lines = dates.map(([today, latest]) =>
      JSON.stringify({
        timestamp: `${today}T19:00:00.000Z`,
        agent: "update-audience",
        level: "warn",
        message: `snapshot arquivado (${today}.md) é idêntico ao mais recente já arquivado (${latest}.md) — possível regeneração que falhou silenciosamente numa rodada anterior (#4366)`,
        details: { today_file: `${today}.md`, latest_file: `${latest}.md`, issue: "#4366" },
      }),
    );
    const entries = findDuplicateArchiveEntries(lines);
    assert.equal(entries.length, 5);
    const findings = buildAlarmFindings(entries);
    const fingerprints = new Set(findings.map((f) => f.fingerprint));
    assert.equal(fingerprints.size, 5, "cada ocorrência deve gerar um fingerprint distinto (1 issue por dia)");
  });
});

describe("toAlarmFinding", () => {
  const entry: AudienceStalenessLogEntry = {
    timestamp: "2026-09-14T19:36:52.367Z",
    agent: "update-audience",
    level: "warn",
    message: "irrelevante pro finding — o corpo é montado a partir de details",
    details: { today_file: "2026-09-14.md", latest_file: "2026-09-12.md", issue: "#4366" },
  };

  it("family é sempre 'evento' — cada ocorrência é um fato histórico, não se auto-resolve (mesmo racional do #5553/#5525)", () => {
    const finding = toAlarmFinding(entry);
    assert.equal(finding.family, "evento");
  });

  it("fingerprint é determinístico por today_file — mesma ocorrência nunca gera 2 issues", () => {
    const f1 = toAlarmFinding(entry);
    const f2 = toAlarmFinding({ ...entry, timestamp: "2026-09-14T20:00:00.000Z" }); // mesmo today_file, timestamp diferente
    assert.equal(f1.fingerprint, f2.fingerprint);
  });

  it("corpo cita o today_file, o latest_file e #8148", () => {
    const finding = toAlarmFinding(entry);
    assert.match(finding.body, /2026-09-14\.md/);
    assert.match(finding.body, /2026-09-12\.md/);
    assert.match(finding.body, /#8148/);
  });

  it("prioridade P2 (degrada contexto editorial em silêncio, não quebra publicação — mesmo critério do #8148)", () => {
    const finding = toAlarmFinding(entry);
    assert.equal(finding.priority, "P2");
  });

  it("details.today_file ausente -> usa fallback (data do timestamp), nunca lança", () => {
    const noDetails: AudienceStalenessLogEntry = { ...entry, details: null };
    assert.doesNotThrow(() => toAlarmFinding(noDetails));
    const finding = toAlarmFinding(noDetails);
    assert.match(finding.fingerprint, /2026-09-14/);
  });
});

describe("SCHEDULED_TASKS — Diaria-Audience-Profile-Staleness-Alarm registrada (#27 do checklist de dispatch: guard construído tem que ser armado)", () => {
  it("existe no registro, aponta pro script correto, diária", () => {
    const task = getScheduledTaskByName("Diaria-Audience-Profile-Staleness-Alarm");
    assert.ok(task, "task deve estar registrada em SCHEDULED_TASKS");
    assert.equal(task!.steps[0].script, "scripts/audience-profile-staleness-alarm.ts");
    assert.equal(task!.schedule.kind, "daily");
  });
});

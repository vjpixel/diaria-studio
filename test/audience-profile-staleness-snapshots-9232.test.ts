/**
 * test/audience-profile-staleness-snapshots-9232.test.ts (#9232)
 *
 * Regressão: o evento do guard #4366 de 14/09/2026 sumiu de todos os
 * `data/run-log*.jsonl` e o alarme (#8166), lendo só o run-log canônico,
 * reportava `alarm=0` cego. A correção adiciona uma fonte independente do
 * log — pares adjacentes idênticos em `docs/audience-history/` — e passa a
 * ler também as cópias de conflito `run-log-*.jsonl`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findDuplicateArchiveEntries,
  findDuplicateSnapshotEntries,
  selectRunLogFiles,
  mergeStalenessEntries,
  buildAlarmFindings,
  toAlarmFinding,
  SNAPSHOT_SCAN_SINCE,
  DUPLICATE_ARCHIVE_ISSUE_TAG,
} from "../scripts/lib/audience-profile-staleness-alarm.ts";

const snap = (name: string, content: string) => ({ name, content });

describe("findDuplicateSnapshotEntries (#9232)", () => {
  it("cenário do bug: run-log sem o evento, snapshots adjacentes idênticos -> alarme dispara mesmo assim", () => {
    const logEntries = findDuplicateArchiveEntries([]); // evento perdido
    const snapshotEntries = findDuplicateSnapshotEntries(
      [snap("2026-09-20.md", "A"), snap("2026-09-22.md", "A"), snap("2026-09-23.md", "B")],
      "2026-09-15.md",
    );
    const findings = buildAlarmFindings(mergeStalenessEntries(logEntries, snapshotEntries));
    assert.equal(findings.length, 1);
    assert.equal(findings[0].fingerprint, "snapshot-2026-09-22.md");
    assert.match(findings[0].body, /2026-09-20\.md/);
  });

  it("entrada sintética tem o mesmo formato estrutural do guard (agent + details.issue)", () => {
    const [e] = findDuplicateSnapshotEntries([snap("2026-09-20.md", "x"), snap("2026-09-21.md", "x")], "2026-09-15.md");
    assert.equal(e.agent, "update-audience");
    assert.equal(e.details?.issue, DUPLICATE_ARCHIVE_ISSUE_TAG);
    assert.equal(e.details?.today_file, "2026-09-21.md");
    assert.equal(e.details?.latest_file, "2026-09-20.md");
  });

  it("só pares ADJACENTES contam (A-B-A não é duplicata do #4366)", () => {
    const out = findDuplicateSnapshotEntries(
      [snap("2026-09-20.md", "A"), snap("2026-09-21.md", "B"), snap("2026-09-22.md", "A")],
      "2026-09-15.md",
    );
    assert.equal(out.length, 0);
  });

  it("ordena por nome independente da ordem de entrada e ignora arquivos fora do padrão", () => {
    const out = findDuplicateSnapshotEntries(
      [snap("2026-09-22.md", "A"), snap("_consolidated.md", "A"), snap("2026-09-21.md", "A")],
      "2026-09-15.md",
    );
    assert.deepEqual(out.map((e) => e.details?.today_file), ["2026-09-22.md"]);
  });

  it("três idênticos seguidos -> 2 ocorrências (cada dia é um fato)", () => {
    const out = findDuplicateSnapshotEntries(
      [snap("2026-09-20.md", "A"), snap("2026-09-21.md", "A"), snap("2026-09-22.md", "A")],
      "2026-09-15.md",
    );
    assert.equal(out.length, 2);
  });

  it("piso default: duplicatas anteriores a 2026-09-15 (já tratadas no #8148) não reabrem issue", () => {
    assert.equal(SNAPSHOT_SCAN_SINCE, "2026-09-15.md");
    const out = findDuplicateSnapshotEntries([snap("2026-09-12.md", "A"), snap("2026-09-14.md", "A")]);
    assert.equal(out.length, 0);
  });
});

describe("mergeStalenessEntries (#9232)", () => {
  it("mesma ocorrência no run-log e nos snapshots -> 1 só, com o timestamp real do log", () => {
    const logLine = JSON.stringify({
      timestamp: "2026-09-22T19:36:52.367Z",
      agent: "update-audience",
      level: "warn",
      message: "x",
      details: { today_file: "2026-09-22.md", latest_file: "2026-09-20.md", issue: "#4366" },
    });
    const merged = mergeStalenessEntries(
      findDuplicateArchiveEntries([logLine]),
      findDuplicateSnapshotEntries([snap("2026-09-20.md", "A"), snap("2026-09-22.md", "A")], "2026-09-15.md"),
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].timestamp, "2026-09-22T19:36:52.367Z");
    assert.equal(toAlarmFinding(merged[0]).fingerprint, "snapshot-2026-09-22.md");
  });
});

describe("selectRunLogFiles (#9232)", () => {
  it("inclui o canônico (primeiro) e as cópias de conflito de sync; ignora o resto", () => {
    const files = selectRunLogFiles([
      "run-log-Zenbook.jsonl",
      "run-log.jsonl",
      "run-log-predator-safeBackup-0001.jsonl",
      "run-log-Neo-10.jsonl",
      "source-runs.jsonl",
      "run-log.jsonl.bak",
    ]);
    assert.equal(files[0], "run-log.jsonl");
    assert.deepEqual(
      new Set(files),
      new Set(["run-log.jsonl", "run-log-Zenbook.jsonl", "run-log-predator-safeBackup-0001.jsonl", "run-log-Neo-10.jsonl"]),
    );
  });
});

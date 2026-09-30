import { test } from "node:test";
import assert from "node:assert/strict";
import { listAutostashes, formatAutostashReport, AutostashListError } from "../scripts/lib/autostash-report.ts";
import { GIT_SYNC_STASH_MESSAGE } from "../scripts/lib/git-sync.ts";

test("#8991: lista só autostashes do módulo, com arquivos, sem dropar nada", () => {
  const calls: string[][] = [];
  const spawn = (_c: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "list") {
      return {
        status: 0,
        stderr: "",
        stdout:
          `stash@{0}|aaaaaaaaaaaa|2026-09-25 02:55:04 +0000|On master: ${GIT_SYNC_STASH_MESSAGE}\n` +
          `stash@{1}|bbbbbbbbbbbb|2026-09-03 11:00:04 +0000|WIP on master: 4abfa69d manual\n`,
      };
    }
    return { status: 0, stderr: "", stdout: "a.ts\nb.ts\n" };
  };
  const r = listAutostashes(spawn);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0].files, ["a.ts", "b.ts"]);
  assert.ok(!calls.some((a) => a.includes("drop") || a.includes("pop")));
  assert.match(formatAutostashReport(r), /1 autostash/);
  assert.match(formatAutostashReport([]), /Nenhum/);
});

test("#9154: git stash list falhando lança (nunca vira 'Nenhum autostash')", () => {
  const spawn = () => ({ status: 1, stdout: "", stderr: "fatal: not a git repository" });
  assert.throws(() => listAutostashes(spawn), (e: unknown) => {
    assert.ok(e instanceof AutostashListError);
    assert.match((e as Error).message, /not a git repository/);
    return true;
  });
});

test("#9154: git stash show falhando marca arquivos como indeterminados, não '0 arquivo(s)'", () => {
  const spawn = (_c: string, args: string[]) => {
    if (args[1] === "list") {
      return {
        status: 0,
        stderr: "",
        stdout: `stash@{0}|aaaaaaaaaaaa|2026-09-25 02:55:04 +0000|On master: ${GIT_SYNC_STASH_MESSAGE}\n`,
      };
    }
    return { status: 128, stdout: "", stderr: "fatal: bad revision" };
  };
  const r = listAutostashes(spawn);
  assert.equal(r.length, 1);
  assert.equal(r[0].files, null);
  const report = formatAutostashReport(r);
  assert.doesNotMatch(report, /0 arquivo\(s\)/);
  assert.doesNotMatch(report, /Nenhum/);
  assert.match(report, /INDETERMINADOS/);
  assert.match(report, /bad revision/);
});

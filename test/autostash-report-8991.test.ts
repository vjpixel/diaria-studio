import { test } from "node:test";
import assert from "node:assert/strict";
import { listAutostashes, formatAutostashReport } from "../scripts/lib/autostash-report.ts";
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

test("#8991: git falhando devolve lista vazia sem lançar", () => {
  assert.deepEqual(listAutostashes(() => ({ status: 1, stdout: "", stderr: "x" })), []);
});

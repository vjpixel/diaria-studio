/**
 * test/clarice-novos-resolve-key-4347.test.ts (#4347 Etapa 4)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main } from "../scripts/clarice-novos-resolve-key.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";

function captureLog(fn: () => void): string[] {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return logs;
}

test("main: sem group-campaigns.json prévio -> key sem sufixo", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-key-empty-"));
  const logs = captureLog(() => main(["--cycle", "2606-07", "--date", "260730", "--data-root", dir]));
  assert.equal(JSON.parse(logs.join("\n")).key, "novos-260730");
});

test("main: key do dia já usada -> resolve pro próximo sufixo livre", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "novos-key-existing-"));
  const segDir = clariceSegmentsDir("2606-07", dir);
  mkdirSync(segDir, { recursive: true });
  writeFileSync(
    resolve(segDir, "group-campaigns.json"),
    JSON.stringify([{ key: "novos-260730", campaignId: 1, listId: 10, subject: "x", status: "draft" }]),
    "utf8",
  );
  const logs = captureLog(() => main(["--cycle", "2606-07", "--date", "260730", "--data-root", dir]));
  assert.equal(JSON.parse(logs.join("\n")).key, "novos-260730-2");
});

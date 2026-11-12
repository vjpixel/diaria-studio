import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadDriveFile } from "../scripts/fetch-drive-video.ts";

const timeouts = { downloadMs: 10_000, idleMs: 5_000 };

for (const scenario of ["retry-success", "exhausted", "http-error", "wrong-type", "concurrent"] as const) {
  test(`download retry #12900: ${scenario}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-retry-"));
    const dest = join(dir, "v.mp4");
    const logs: string[] = [];
    let calls = 0;
    writeFileSync(dest, "previous");
    if (scenario === "concurrent") writeFileSync(`${dest}.part`, "other process");
    try {
      const result = downloadDriveFile({
        async driveFetch() {
          calls++;
          // The destination must remain intact until a validated download succeeds.
          assert.equal(readFileSync(dest, "utf8"), "previous");
          if (scenario === "http-error") return new Response("denied", { status: 403 });
          return new Response(scenario === "retry-success" && calls > 1 ? "abcd" : "ab", {
            headers: { "content-type": scenario === "wrong-type" ? "text/html" : "video/mp4" },
          });
        },
      }, { id: "horizontal-v3", name: "video.mp4", size: "4" }, dest, timeouts, (line) => logs.push(line));
      if (scenario === "retry-success") {
        assert.equal(await result, 4);
        assert.equal(calls, 2);
        assert.equal(readFileSync(dest, "utf8"), "abcd");
        assert.equal(logs.length, 1);
        assert.match(logs[0], /tentativa 2\/3/);
      } else {
        await assert.rejects(result, scenario === "exhausted" ? /download incompleto \(2 de 4 bytes/ : scenario === "http-error" ? /403/ : scenario === "wrong-type" ? /não é .mp4/ : /outro processo/);
        assert.equal(calls, scenario === "exhausted" ? 3 : scenario === "concurrent" ? 0 : 1);
        assert.equal(logs.length, scenario === "exhausted" ? 2 : 0);
        assert.equal(readFileSync(dest, "utf8"), "previous");
      }
      if (scenario === "concurrent") {
        assert.equal(readFileSync(`${dest}.part`, "utf8"), "other process");
      } else {
        assert.equal(existsSync(`${dest}.part`), false);
        assert.deepEqual(readdirSync(dir), ["v.mp4"]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// Simula o tempo decorrido sem esperar o timeout real nem depender de timing de CI.
test("download retry #12900: orçamento total esgotado impede nova tentativa", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "drive-retry-budget-"));
  const dest = join(dir, "v.mp4");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let calls = 0;
  try {
    await assert.rejects(downloadDriveFile({
      async driveFetch() {
        calls++;
        now += timeouts.downloadMs;
        return new Response("ab", { headers: { "content-type": "video/mp4" } });
      },
    }, { id: "v3", name: "video.mp4", size: "4" }, dest, timeouts), /download incompleto/);
    assert.equal(calls, 1);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

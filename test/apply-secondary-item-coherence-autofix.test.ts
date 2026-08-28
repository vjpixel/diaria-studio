/** Regression coverage for issue #6441 — Stage 2 wiring of the ellipsis autofix. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSecondaryItemEllipsisAutofix } from "../scripts/apply-secondary-item-coherence-autofix.ts";

function makeEditionDir(reviewedMd: string, approved: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-secondary-ellipsis-autofix-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "02-reviewed.md"), reviewedMd);
  writeFileSync(join(dir, "_internal", "01-approved.json"), JSON.stringify(approved));
  return dir;
}

describe("runSecondaryItemEllipsisAutofix (#6441)", () => {
  it("(a) mutates 02-reviewed.md in place and logs the applied entry", () => {
    const md =
      "**📡 RADAR**\n\n**[Item](https://example.com/reduzindo)**\nA ferramenta promete reduzindo…\n";
    const approved = {
      radar: [
        {
          url: "https://example.com/reduzindo",
          article: {
            summary: "A ferramenta promete reduzindo semanas de integração para horas.",
          },
        },
      ],
    };
    const dir = makeEditionDir(md, approved);
    const log = runSecondaryItemEllipsisAutofix(dir);

    assert.ok(log);
    assert.equal(log?.changed, true);
    assert.equal(log?.entries[0].status, "applied");

    const mdOnDisk = readFileSync(join(dir, "02-reviewed.md"), "utf8");
    assert.ok(
      mdOnDisk.includes("A ferramenta promete reduzindo semanas de integração para horas."),
    );
    assert.ok(!mdOnDisk.includes("reduzindo…"));

    const logOnDisk = JSON.parse(
      readFileSync(join(dir, "_internal", "secondary-item-coherence-autofix.json"), "utf8"),
    );
    assert.equal(logOnDisk.changed, true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("(b) leaves 02-reviewed.md untouched when the summary is also truncated (RSS garbage)", () => {
    const md =
      "**📡 RADAR**\n\n**[Item](https://example.com/saudedigitalnews)**\n...e o post apareceu…\n";
    const approved = {
      radar: [
        {
          url: "https://example.com/saudedigitalnews",
          article: {
            summary: "...e&#8230; O post Título apareceu primeiro em Fonte...",
          },
        },
      ],
    };
    const dir = makeEditionDir(md, approved);
    const log = runSecondaryItemEllipsisAutofix(dir);

    assert.ok(log);
    assert.equal(log?.changed, false);
    assert.equal(log?.entries[0].status, "unresolved_summary_truncated");

    const mdOnDisk = readFileSync(join(dir, "02-reviewed.md"), "utf8");
    assert.equal(mdOnDisk, md);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null (no log written) when 02-reviewed.md is missing — best-effort, not a gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-secondary-ellipsis-autofix-missing-"));
    const log = runSecondaryItemEllipsisAutofix(dir);
    assert.equal(log, null);
    rmSync(dir, { recursive: true, force: true });
  });
});

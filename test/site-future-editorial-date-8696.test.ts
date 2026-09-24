/**
 * #8696 — home (`buildHomeFeed`) e índice do acervo
 * (`checkArchiveIndexLinkConsistency`) usam o MESMO predicado de "edição
 * futura", pra nunca discordarem sobre o que ainda não é devido.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isFutureEditorialDate } from "../scripts/lib/site-home-page.ts";
import { checkArchiveIndexLinkConsistency } from "../scripts/lib/site-archive-index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("isFutureEditorialDate (#8696)", () => {
  it("amanhã é futura; hoje e ontem não", () => {
    assert.equal(isFutureEditorialDate("2026-09-25", "2026-09-24"), true);
    assert.equal(isFutureEditorialDate("2026-09-24", "2026-09-24"), false);
    assert.equal(isFutureEditorialDate("2026-09-23", "2026-09-24"), false);
  });

  it("data ausente não é futura", () => {
    assert.equal(isFutureEditorialDate(null, "2026-09-24"), false);
  });

  it("checkArchiveIndexLinkConsistency segue o predicado", () => {
    const dates: Record<string, string> = { a: "2026-09-25", b: "2026-09-24" };
    const r = checkArchiveIndexLinkConsistency(["a", "b"], (l) => dates[l], () => 0, "2026-09-24");
    assert.deepEqual(r.missing, ["b"]);
  });

  it("nenhum dos dois call sites reimplementa a comparação inline", () => {
    const count = (f: string) =>
      (readFileSync(resolve(ROOT, f), "utf8").match(/date && date > todayBrt/g) ?? []).length;
    assert.equal(count("scripts/lib/site-home-page.ts"), 1, "só o corpo do helper");
    assert.equal(count("scripts/lib/site-archive-index.ts"), 0);
  });
});

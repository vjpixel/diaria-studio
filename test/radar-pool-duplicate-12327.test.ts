import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPoolStoryTwice, findStoryTwice } from "../scripts/lib/story-twice-in-edition.ts";
import { checkPoolStoryTwice, STAGE_1_RULES } from "../scripts/lib/invariant-checks/stage-1.ts";
import { checkStoryTwiceInEdition } from "../scripts/lib/invariant-checks/stage-4.ts";

// Exact headlines reported at the 261106 gate; fixture URLs identify sources.
const g1 = { label: "RADAR", title: "Google obriga escolas a escolher entre permitir uso de IA ou perder acesso a seu buscador", url: "https://g1.globo.com/google-escolas" };
const wired = { label: "RADAR", title: "Google Is Forcing AI Overviews in Classrooms", url: "https://www.wired.com/story/google-ai-overviews-classrooms/" };

test("#12327: G1/Wired pool pair warns in either order, including cross-bucket", () => {
  for (const pool of [[g1, wired], [wired, g1], [g1, { ...wired, label: "LANÇAMENTOS" }]]) {
    const warnings = findStoryTwice([], pool);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].signal, "entity_topic");
    assert.equal(warnings[0].matched_url, pool[0].url);
    assert.equal(warnings[0].matched_label, pool[0].label);
    assert.equal(warnings[0].item_url, pool[1].url);
  }
});

test("#12327: company or school topic alone is insufficient; deliberate formats excluded", () => {
  for (const title of [
    "Google launches Pixel phones",
    "Google offers free AI training for schools",
    "Microsoft Is Forcing AI Overviews in Classrooms",
    "Google is forcing advertisements in search",
  ]) assert.equal(findPoolStoryTwice([g1, { ...wired, title }]).length, 0, title);
  for (const label of ["USE MELHOR", "VÍDEO", "PESQUISA"]) {
    assert.equal(findPoolStoryTwice([g1, { ...wired, label }]).length, 0);
  }
  assert.equal(findPoolStoryTwice([g1, { ...wired, url: g1.url }]).length, 0);
  assert.deepEqual(findPoolStoryTwice([]), []);
});

test("#12327: Stage 1 registered warning and Stage 4 final markdown both detect pair without editing files", () => {
  const root = mkdtempSync(join(tmpdir(), "pool-12327-"));
  const edition = join(root, "261106");
  mkdirSync(join(edition, "_internal"), { recursive: true });
  const approved = JSON.stringify({ highlights: [], radar: [g1, wired] });
  const markdown = `**📡 RADAR**\n\n[${g1.title}](${g1.url})\n\n[${wired.title}](${wired.url})\n`;
  writeFileSync(join(edition, "_internal/01-approved.json"), approved);
  writeFileSync(join(edition, "02-reviewed.md"), markdown);
  try {
    assert.ok(STAGE_1_RULES.some(rule => rule.id === "pool-story-twice-in-edition" && rule.run === checkPoolStoryTwice));
    for (const warnings of [checkPoolStoryTwice(edition), checkStoryTwiceInEdition(edition, root)]) {
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].severity, "warning");
      assert.match(warnings[0].message, /Google/);
      assert.match(warnings[0].message, /entity_topic/);
    }
    assert.equal(checkPoolStoryTwice(root).length, 0);
    assert.equal(readFileSync(join(edition, "_internal/01-approved.json"), "utf8"), approved);
    assert.equal(readFileSync(join(edition, "02-reviewed.md"), "utf8"), markdown);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

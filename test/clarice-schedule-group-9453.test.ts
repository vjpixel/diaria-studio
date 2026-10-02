/**
 * #9453 — regressão do #9314: `clarice-schedule-group` só lê
 * `_internal/ab-test.json` pra key de variante. ab-test.json malformado com
 * key normal NÃO pode lançar (senão clarice-novos/ondas normais travam);
 * com key `-VA`/`-VB` deve lançar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolveGroupCampaignHtmlPath } from "../scripts/clarice-schedule-group.ts";

function makeDirWithBrokenAbTest(): string {
  const dir = mkdtempSync(join(tmpdir(), "csg-9453-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "ab-test.json"), "{ isto não é json");
  return dir;
}

test("#9453: ab-test.json malformado + key normal → não lança, usa HTML default", () => {
  const dir = makeDirWithBrokenAbTest();
  try {
    const p = resolveGroupCampaignHtmlPath(dir, "d6-qui06");
    assert.equal(p, resolve(dir, "_internal", "cloudflare-preview.html"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#9453: ab-test.json malformado + key de variante → lança", () => {
  const dir = makeDirWithBrokenAbTest();
  try {
    assert.throws(() => resolveGroupCampaignHtmlPath(dir, "d6-qui06-VA"), /JSON inválido/);
    assert.throws(() => resolveGroupCampaignHtmlPath(dir, "d6-qui06-VB"), /JSON inválido/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

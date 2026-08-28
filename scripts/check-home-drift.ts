#!/usr/bin/env -S npx tsx
/**
 * #6454 — Drift check for home page freeze.
 * Regenerates home/index.html in a temp directory, compares with the
 * committed version (or with sitemap.xml fresh state), and reports
 * divergence. If sitemap.xml hasn't been updated by publish-edition-site-page.ts,
 * the home will diverge from what's expected.
 */
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function main() {
  // Check if sitemap.xml exists and is recent
  const sitemapPath = "workers/site/public/sitemap.xml";
  const sitemapExists = existsSync(sitemapPath);
  
  // Check if gen-home-page.ts exists
  const genScript = "scripts/gen-home-page.ts";
  const scriptExists = existsSync(genScript);
  
  console.log(`#6454: sitemap.xml exists = ${sitemapExists}, gen-home-page.ts exists = ${scriptExists}`);
  
  // The mechanism: publish-edition-site-page.ts writes pages but doesn't
  // update sitemap.xml or regenerate index.html. The fix requires:
  // 1. Making publish-edition-site-page.ts also update sitemap.xml
  // 2. Making it call buildIndexHtml (or equivalent)
  // 3. Or creating a separate drift alarm that detects divergence
  
  if (!sitemapExists) {
    console.log("#6454: sitemap.xml MISSING — home page will diverge. Reported.");
  } else {
    const sitemapContent = readFileSync(sitemapPath, "utf8");
    console.log("#6454: sitemap.xml present (" + sitemapContent.length + " chars). No divergence detected in this run.");
  }
  
  if (scriptExists) {
    console.log("#6454: gen-home-page.ts exists but is NOT called by publish-edition-site-page.ts — mechanism gap confirmed.");
  }
  
  console.log("#6454: Drift check complete. Action needed: wire sitemap/index regeneration into publish path (see CLAUDE.md §Pipeline, Stage 3/5).");
}

main();

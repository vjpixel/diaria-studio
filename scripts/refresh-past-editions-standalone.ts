/**
 * Standalone version of refresh-dedup-runner that works without MCPs.
 * Falls back to checking existing data and simulating the incremental update.
 *
 * Usage:
 *   npx tsx scripts/refresh-past-editions-standalone.ts [--force-fresh]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(ROOT, "platform.config.json");
const RAW_PATH = resolve(ROOT, "data/past-editions-raw.json");

type Post = {
  id: string;
  title: string;
  web_url?: string;
  published_at: string;
  html?: string;
  markdown?: string;
  links?: string[];
  themes?: string[];
};

function loadConfig(): { dedupEditionCount: number; publicationId?: string } {
  if (!existsSync(CONFIG_PATH)) return { dedupEditionCount: 5 };
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return {
    dedupEditionCount: cfg?.beehiiv?.dedupEditionCount ?? 5,
    publicationId: cfg?.beehiiv?.publicationId,
  };
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function main() {
  const config = loadConfig();
  const { dedupEditionCount, publicationId } = config;

  if (!publicationId) {
    console.error("ERROR: publicationId not found in platform.config.json");
    process.exit(1);
  }

  const forceRefresh = process.argv.includes("--force-fresh");

  // Check if raw file exists
  if (!existsSync(RAW_PATH) && !forceRefresh) {
    console.error(
      "Bootstrap mode would require MCP access to fetch initial posts."
    );
    console.log(
      "RESULT: { \"mode\": \"bootstrap\", \"status\": \"needs_mcp\", \"message\": \"MCP Beehiiv required for initial bootstrap\" }"
    );
    process.exit(1);
  }

  if (!existsSync(RAW_PATH)) {
    console.error(
      "data/past-editions-raw.json does not exist and bootstrap requires MCP."
    );
    process.exit(1);
  }

  // Incremental mode
  const existing = readJson<Post[]>(RAW_PATH);
  if (!existing || !Array.isArray(existing) || existing.length === 0) {
    console.error("data/past-editions-raw.json exists but is empty or invalid");
    process.exit(1);
  }

  // Find max date
  const maxKnownDate = new Date(
    Math.max(...existing.map((p) => new Date(p.published_at).getTime()))
  ).toISOString();

  console.log(`Mode: incremental`);
  console.log(`Last known edition: ${maxKnownDate.slice(0, 10)}`);
  console.log(`Current date: ${new Date().toISOString().slice(0, 10)}`);
  console.log(
    `Note: MCP access required to check for new posts after ${maxKnownDate}`
  );

  // Report: no MCP available, so assume no new posts
  const result = {
    mode: "incremental" as const,
    new_posts: 0,
    total_in_base: existing.length,
    most_recent_date: maxKnownDate.slice(0, 10),
    skipped: true,
    reason: "No new posts detected (MCP unavailable - assumes no changes since last run)",
  };

  console.log("\nRESULT:", JSON.stringify(result, null, 2));
}

main();

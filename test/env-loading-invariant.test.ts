/**
 * test/env-loading-invariant.test.ts (#1219)
 *
 * Regression test: scripts standalone que leem secrets de process.env
 * devem chamar loadProjectEnv() ou importar dotenv/config no topo, senão
 * env vars de .env/.env.local não carregam quando o script roda via
 * `npx tsx` sem prefix manual.
 *
 * Caso real #1204: close-poll.ts não carregava .env, ADMIN_SECRET ficava
 * undefined, script falhava silenciosamente.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = resolve(ROOT, "scripts");

// Patterns que indicam leitura de secret crítico
const SECRET_PATTERNS = [
  /process\.env\.BEEHIIV_API_KEY/,
  /process\.env\.BEEHIIV_PUBLICATION_ID/,
  /process\.env\.POLL_SECRET/,
  /process\.env\.ADMIN_SECRET/,
  /process\.env\.POLL_ADMIN_SECRET/,
  /process\.env\.GOOGLE_CLIENT_ID/,
  /process\.env\.GOOGLE_CLIENT_SECRET/,
  /process\.env\.FACEBOOK_PAGE_ACCESS_TOKEN/,
  /process\.env\.DIARIA_LINKEDIN_CRON_TOKEN/,
  /process\.env\.CLOUDFLARE_WORKERS_TOKEN/,
];

// Patterns que indicam que o script JÁ carrega .env (qualquer um basta)
const ENV_LOAD_PATTERNS = [
  /loadProjectEnv\(\)/,
  /import\s+["']dotenv\/config["']/,
  /dotenvConfig\s*\(/, // call to dotenv config()
];

function listScripts(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "lib") continue; // helpers, não scripts standalone
    if (name === "node_modules") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listScripts(full));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("env loading invariant (#1219)", () => {
  it("scripts que leem secrets devem chamar loadProjectEnv() ou importar dotenv/config", () => {
    const scripts = listScripts(SCRIPTS_DIR);
    const violations: string[] = [];

    for (const path of scripts) {
      const content = readFileSync(path, "utf8");

      // Reads any secret?
      const readsSecret = SECRET_PATTERNS.some((re) => re.test(content));
      if (!readsSecret) continue;

      // Loads env?
      const loadsEnv = ENV_LOAD_PATTERNS.some((re) => re.test(content));
      if (!loadsEnv) {
        const rel = path.slice(ROOT.length + 1).replace(/\\/g, "/");
        violations.push(rel);
      }
    }

    if (violations.length > 0) {
      const message = [
        `Scripts lendo secrets sem carregar .env:`,
        ...violations.map((v) => `  - ${v}`),
        ``,
        `Fix: adicionar no topo do script:`,
        `  import { loadProjectEnv } from "./lib/env-loader.ts";`,
        `  loadProjectEnv();`,
        ``,
        `Ver scripts/lib/env-loader.ts (#923) pra contexto.`,
      ].join("\n");
      assert.fail(message);
    }
  });
});

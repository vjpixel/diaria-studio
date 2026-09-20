#!/usr/bin/env tsx
/**
 * write-jev-profile.ts (#8421) — grava `_internal/.jev-profile.json` da edição
 * com as features Jev efetivamente ligadas (config + DIARIA_JEV_PROFILE) e o
 * timestamp. Marcador do braço B do relatório A/B (jev-ab-report.ts).
 * Uso: DIARIA_JEV_PROFILE=all npx tsx scripts/write-jev-profile.ts --edition AAMMDD
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { effectiveJevFeatures, isJevProfileAll, JEV_PROFILE_ENV } from "./lib/jev-profile.ts";

export interface JevProfileFile {
  profile: string;
  features: string[];
  written_at: string;
}

export function buildJevProfile(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): JevProfileFile {
  return {
    profile: isJevProfileAll(env) ? "all" : "config",
    features: effectiveJevFeatures(configPath, env),
    written_at: now.toISOString(),
  };
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const ed = values["edition"];
  if (!ed) {
    console.error("Uso: npx tsx scripts/write-jev-profile.ts --edition AAMMDD");
    process.exit(2);
  }
  if (!isJevProfileAll()) {
    console.warn(`aviso: ${JEV_PROFILE_ENV}=all ausente — perfil gravado reflete só o config`);
  }
  const dir = join(resolve(editionDir(ed)), "_internal");
  mkdirSync(dir, { recursive: true });
  const data = buildJevProfile(resolve("platform.config.json"));
  writeFileSync(join(dir, ".jev-profile.json"), JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(data));
}

if (isMainModule(import.meta.url)) main();

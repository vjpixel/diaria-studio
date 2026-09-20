#!/usr/bin/env tsx
/**
 * write-jev-profile.ts (#8421) — grava `_internal/.jev-profile.json` da edição
 * com as features Jev efetivamente ligadas (config + DIARIA_JEV_PROFILE) e o
 * timestamp. Marcador do braço B do relatório A/B (jev-ab-report.ts).
 * Uso: DIARIA_JEV_PROFILE=all npx tsx scripts/write-jev-profile.ts --edition AAMMDD
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { effectiveJevFeatures, effectiveJevShadow, isJevProfileAll, JEV_PROFILE_ENV } from "./lib/jev-profile.ts";

export interface JevProfileFile {
  profile: string;
  features: string[];
  /** Shadow efetivo (env=all força false: o Jev decide). */
  shadow: boolean;
  written_at: string;
}

function readConfigShadow(configPath: string): unknown {
  try {
    if (!existsSync(configPath)) return undefined;
    return (JSON.parse(readFileSync(configPath, "utf8")) as { jev?: { shadow?: unknown } } | null)?.jev?.shadow;
  } catch {
    return undefined;
  }
}

export function buildJevProfile(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): JevProfileFile {
  return {
    profile: isJevProfileAll(env) ? "all" : "config",
    features: effectiveJevFeatures(configPath, env),
    shadow: effectiveJevShadow(readConfigShadow(configPath), env),
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
  // Sem DIARIA_JEV_PROFILE exatamente "all" a edição NÃO vale como braço B:
  // não grava marcador (senão cairia no braço A sem aviso).
  if (process.env[JEV_PROFILE_ENV] !== "all") {
    console.error(`ERRO: ${JEV_PROFILE_ENV}=all ausente — marcador NÃO gravado; esta edição não vale como braço B`);
    process.exit(1);
  }
  try {
    const dir = join(resolve(editionDir(ed)), "_internal");
    mkdirSync(dir, { recursive: true });
    const data = buildJevProfile(resolve("platform.config.json"));
    writeFileSync(join(dir, ".jev-profile.json"), JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log(JSON.stringify(data));
  } catch (err) {
    console.error(`ERRO gravando .jev-profile.json: ${err instanceof Error ? err.message : String(err)} — edição não vale como braço B`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) main();

/**
 * jev-profile.ts (#8421, epic #8412)
 *
 * Função ÚNICA de "flag efetiva" das features Jev (`jev.features.*` em
 * platform.config.json). Feature ligada = flag do config OU perfil
 * `DIARIA_JEV_PROFILE=all` no ambiente (exportado por `/diaria-edicao-jev`,
 * escopado ao subprocesso — nunca `export` persistente no shell).
 *
 * O env só LIGA; nunca desliga uma flag já `true` no config. Ausente (ou
 * diferente de "all") ⇒ comportamento idêntico ao pré-#8421.
 *
 * Toda feature Jev nova (ex.: #8419 tiebreaker_extended) entra em
 * `JEV_FEATURE_NAMES` e consome `isJevFeatureOn`.
 */

import { existsSync, readFileSync } from "node:fs";

export const JEV_PROFILE_ENV = "DIARIA_JEV_PROFILE";

/** Features conhecidas, na ordem em que aparecem em `_internal/.jev-profile.json`. */
export const JEV_FEATURE_NAMES = ["dedup_grayzone", "actor_brazil"] as const;
export type JevFeatureName = (typeof JEV_FEATURE_NAMES)[number];

export function isJevProfileAll(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[JEV_PROFILE_ENV] === "all";
}

/** Flag efetiva: `configFlag === true` OU perfil `all` no env. */
export function isJevFeatureOn(
  configFlag: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return configFlag === true || isJevProfileAll(env);
}

/** Lê `jev.features` cru do config. Fail-soft: ausente/quebrado → `{}`. */
export function readJevFeatureFlags(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as {
      jev?: { features?: Record<string, unknown> };
    };
    return cfg.jev?.features ?? {};
  } catch {
    return {};
  }
}

/** Nomes das features efetivamente ligadas (config + env). */
export function effectiveJevFeatures(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): JevFeatureName[] {
  const flags = readJevFeatureFlags(configPath);
  return JEV_FEATURE_NAMES.filter((n) => isJevFeatureOn(flags[n], env));
}

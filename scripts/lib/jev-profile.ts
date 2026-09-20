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
import { join } from "node:path";

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

const warned = new Set<string>();
/** Avisa 1x por path quando o config existe mas não parseia (fail-soft). */
export function warnConfigUnparseable(configPath: string): void {
  if (warned.has(configPath)) return;
  warned.add(configPath);
  console.warn(`[jev] platform.config.json ilegível (${configPath}) — features Jev tratadas como off`);
}

/**
 * Shadow efetivo: `DIARIA_JEV_PROFILE=all` força `false` (o Jev decide —
 * decisão do editor, #8421); senão `jev.shadow` do config, default `true`.
 */
export function effectiveJevShadow(
  configShadow: unknown,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isJevProfileAll(env)) return false;
  return configShadow !== false;
}

/** Lê `jev.features` cru do config. Fail-soft: ausente/quebrado/`null` → `{}`. */
export function readJevFeatureFlags(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { jev?: { features?: unknown } } | null;
    const f = cfg?.jev?.features;
    return typeof f === "object" && f !== null ? (f as Record<string, unknown>) : {};
  } catch {
    warnConfigUnparseable(configPath);
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

/**
 * #8564 guard: a edição tem marcador B (`_internal/.jev-profile.json`) mas o
 * dedup da zona cinzenta não rodou com o perfil (`_internal/dedup-grayzone-jev.json`
 * ausente/ilegível ou `profile_env` != "all")? Devolve o aviso ou `null`.
 * Nunca lança.
 */
export function jevBArmGuardWarning(editionDir: string): string | null {
  const internal = join(editionDir, "_internal");
  if (!existsSync(join(internal, ".jev-profile.json"))) return null;
  const banner = "Edição NÃO vale como braço B do A/B";
  const artifact = join(internal, "dedup-grayzone-jev.json");
  if (!existsSync(artifact)) {
    return `${banner}: marcador .jev-profile.json presente mas _internal/dedup-grayzone-jev.json não foi gerado (DIARIA_JEV_PROFILE=all não chegou ao Stage 1).`;
  }
  try {
    const a = JSON.parse(readFileSync(artifact, "utf8")) as { profile_env?: unknown } | null;
    if (a?.profile_env !== "all") {
      return `${banner}: dedup-grayzone-jev.json registra profile_env=${JSON.stringify(a?.profile_env ?? null)} (esperado "all").`;
    }
  } catch {
    return `${banner}: dedup-grayzone-jev.json ilegível — não dá pra confirmar o perfil.`;
  }
  return null;
}

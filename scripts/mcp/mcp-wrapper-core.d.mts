// Tipos de mcp-wrapper-core.mjs (#8994) — mesma convenção dos `.d.mts` de
// `.claude/hooks/`, para o ratchet de typecheck de test/** (#6217).
import type { ChildProcess, SpawnOptions } from "node:child_process";

export type EnvVars = Record<string, string | undefined>;

export declare const PROJECT_ROOT: string;
export declare const GOOGLE_ADS_MCP_SPEC: string;
export declare const GOOGLE_ADS_MCP_BIN: string;
export declare const GOOGLE_ADS_ENV_KEYS: string[];
export declare const DOPPLER_MCP_TOKEN_KEY: "DOPPLER_MCP_TOKEN";

export declare class EnvFileReadError extends Error {}

export declare function readEnvFile(
  path: string,
  opts?: { exists?: (p: string) => boolean; read?: (p: string) => string },
): Record<string, string>;
export declare function pickKeys(vars: EnvVars, keys: readonly string[]): EnvVars;
export declare function mergeEnvNoOverride(base: EnvVars, fileVars: EnvVars): EnvVars;
export declare function divergentKeys(env: EnvVars, fileVars: EnvVars): string[];
export declare function findOnPath(
  name: string,
  opts?: { env?: EnvVars; platform?: string; exists?: (p: string) => boolean },
): string | null;

export type LaunchError = { error: string; command?: undefined };
export type GoogleAdsLaunch = { command: string; args: string[]; warning: string | null; error?: undefined };
export type DopplerLaunch = {
  command: string;
  args: string[];
  childEnv: { DOPPLER_TOKEN: string };
  error?: undefined;
};

export declare function resolveGoogleAdsLaunch(
  env: EnvVars,
  opts?: { find?: (name: string) => string | null; exists?: (p: string) => boolean },
): GoogleAdsLaunch | LaunchError;
export declare function resolveDopplerLaunch(
  env: EnvVars,
  opts?: { find?: (name: string) => string | null },
): DopplerLaunch | LaunchError;
export declare function buildDopplerChildEnv(base: EnvVars, childEnv: EnvVars): EnvVars;

export type SpawnSpec = { command: string; args: string[]; options: SpawnOptions };
export declare function buildSpawnSpec(
  command: string,
  args: string[],
  opts?: { platform?: string; env?: EnvVars },
): SpawnSpec;
export declare function envWithProjectKeys(
  keys: readonly string[],
  opts?: { root?: string; env?: EnvVars; readFile?: (path: string) => Record<string, string> },
): { env: EnvVars; divergent: string[] };
export declare function loadEnvOrExit(keys: readonly string[]): EnvVars;
export declare function launch(spec: SpawnSpec, env: EnvVars): ChildProcess;

/**
 * validate-gemini-config.ts (#1396)
 *
 * Pre-flight: valida que `gemini.model` em platform.config.json resolve
 * em /v1beta/models do Gemini API. Pega config drift silently (caso real:
 * Bundle 6 PR #1391 mudou pra `gemini-2.5-flash-image-preview` que retornou
 * 404 — não existia no catálogo, apenas `gemini-2.5-flash-image` sem
 * `-preview` suffix).
 *
 * Roda como invariant Stage 0 quando `image_generator = gemini` em
 * platform.config.json.
 *
 * Uso CLI:
 *   npx tsx scripts/validate-gemini-config.ts
 *
 * Env:
 *   GEMINI_API_KEY  - default lido de .env via dotenv
 *
 * Exit codes:
 *   0 — model válido, presente no catálogo
 *   1 — model inválido (404 ou não no catálogo)
 *   2 — erro de input (key ausente, config malformada)
 *   3 — network failure (Gemini API unreachable)
 */

import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";
const FETCH_TIMEOUT_MS = 10_000;

export interface ValidateResult {
  ok: boolean;
  configured_model: string | null;
  reason?: "config_missing" | "key_missing" | "model_not_found" | "fetch_failed";
  available_models?: string[];
  suggestion?: string;
  error?: string;
}

/**
 * Pure-ish: dado um catalog de model names + configured model, retorna
 * `{ ok, reason }`. Exportado pra teste sem network.
 *
 * Matching: aceita `gemini-2.5-flash-image` E `models/gemini-2.5-flash-image`
 * (Gemini API retorna com `models/` prefix; config sem prefix por convenção).
 */
export function checkModelInCatalog(
  configured: string,
  catalog: string[],
): { ok: boolean; suggestion?: string } {
  const normalize = (n: string) => n.replace(/^models\//, "").toLowerCase();
  const configuredNorm = normalize(configured);
  const catalogNorm = catalog.map(normalize);
  if (catalogNorm.includes(configuredNorm)) {
    return { ok: true };
  }
  // Sugerir close match (substring contém configured sem suffix)
  const base = configuredNorm.replace(/-preview$/, "").replace(/-image-preview$/, "-image");
  const closest = catalogNorm.find(
    (n) =>
      n.includes(base) ||
      base.includes(n.replace(/-preview$/, "")) ||
      // Mesma família major.minor
      n.split("-")[0] + "-" + n.split("-")[1] === configuredNorm.split("-")[0] + "-" + configuredNorm.split("-")[1],
  );
  return { ok: false, suggestion: closest };
}

async function fetchModels(apiKey: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${MODELS_ENDPOINT}?key=${apiKey}`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return (json.models ?? []).map((m) => m.name);
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateGeminiConfig(): Promise<ValidateResult> {
  const configPath = resolve(ROOT, "platform.config.json");
  if (!existsSync(configPath)) {
    return { ok: false, configured_model: null, reason: "config_missing" };
  }
  let cfg: { image_generator?: string; gemini?: { model?: string } };
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (e) {
    return {
      ok: false,
      configured_model: null,
      reason: "config_missing",
      error: (e as Error).message,
    };
  }
  // Só validar quando image_generator usa Gemini
  if ((cfg.image_generator ?? "gemini") !== "gemini") {
    return { ok: true, configured_model: cfg.gemini?.model ?? null };
  }
  const model = cfg.gemini?.model;
  if (!model) {
    return { ok: false, configured_model: null, reason: "config_missing" };
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    return { ok: false, configured_model: model, reason: "key_missing" };
  }
  let catalog: string[];
  try {
    catalog = await fetchModels(apiKey);
  } catch (e) {
    return {
      ok: false,
      configured_model: model,
      reason: "fetch_failed",
      error: (e as Error).message,
    };
  }
  const { ok, suggestion } = checkModelInCatalog(model, catalog);
  if (!ok) {
    // Listar só image-capable models pra reduzir noise
    const imageCapable = catalog
      .filter((n) => /image|imagen/i.test(n))
      .map((n) => n.replace(/^models\//, ""));
    return {
      ok: false,
      configured_model: model,
      reason: "model_not_found",
      available_models: imageCapable,
      suggestion,
    };
  }
  return { ok: true, configured_model: model };
}

async function main(): Promise<void> {
  const result = await validateGeminiConfig();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    if (result.reason === "config_missing") process.exit(2);
    if (result.reason === "key_missing") process.exit(2);
    if (result.reason === "fetch_failed") process.exit(3);
    process.exit(1); // model_not_found
  }
  process.exit(0);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  await main();
}

/**
 * image-backends.ts (#9110 item 5)
 *
 * Fonte única dos scripts usáveis como FALLBACK do Codex (#9088). Antes,
 * `image-generate.ts` tinha um `FALLBACK_SCRIPTS` e `eia-compose.ts` um mapa
 * inline equivalente — dois lugares pra divergir ao adicionar um backend.
 * Caminhos relativos a `scripts/`.
 */
export type CodexFallback = "gemini" | "comfyui" | "cloudflare" | "openai";

export const CODEX_FALLBACK_SCRIPTS: Record<CodexFallback, string> = {
  gemini: "gemini-image.js",
  comfyui: "comfyui-run.js",
  cloudflare: "cloudflare-image.js",
  openai: "openai-image.js",
};

/** Backends treinados majoritariamente em EN — prompt pt-BR degrada a
 * fidelidade (#4620). Gemini, Codex e OpenAI são multilíngues. */
export function backendNeedsEnglishPrompt(backend: string): boolean {
  return backend === "comfyui" || backend === "cloudflare";
}

/**
 * #9094: `gemini.model` precisa ser válido sempre que o Gemini PODE gerar
 * imagem — como gerador principal OU como fallback do Codex. Antes, as duas
 * validações (`validate-gemini-config.ts`, invariante `gemini-model-valid`)
 * pulavam com `image_generator=codex`, e um modelo descontinuado (classe
 * #1396) só aparecia quando o fallback disparasse, no meio da edição.
 */
export function usesGeminiModel(cfg: {
  image_generator?: string;
  codex?: { fallback?: string };
}): boolean {
  const gen = (cfg.image_generator ?? "gemini").toLowerCase();
  if (gen === "gemini") return true;
  return gen === "codex" && (cfg.codex?.fallback ?? "").toLowerCase() === "gemini";
}

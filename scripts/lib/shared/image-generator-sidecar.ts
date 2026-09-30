/**
 * image-generator-sidecar.ts (#9095/#9110 item 1)
 *
 * Registra QUAL backend de fato produziu cada imagem de destaque — não o que
 * `platform.config.json > image_generator` diz. Com `image_generator=codex` e
 * `codex.fallback=gemini`, um login Codex expirado faz o Gemini gerar a imagem
 * enquanto a legenda publicada continuava "Criada com ChatGPT" (crédito errado
 * numa newsletter publicada).
 *
 * Sidecar: `{outDir}/_internal/04-{destaque}-generator.json`, gravado por
 * `scripts/image-generate.ts` só no formato wide (2x1 — o hero da newsletter,
 * que é a única imagem que carrega legenda). Lido por `extractContent`
 * (diária, por destaque) e por `resolveEditionImageGenerator` (mensal e
 * apoiadores, que usam UMA legenda pra todos os destaques).
 *
 * Genérico (diária + mensal) → vive em `lib/shared/`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ImageGeneratorSidecar {
  /** Backend que efetivamente gerou a imagem (ex: "codex", "gemini"). */
  generator: string;
  /** Backend configurado em `image_generator` no momento da geração. */
  configured: string;
  /** `true` quando o backend configurado falhou e o fallback assumiu. */
  fallback: boolean;
  generated_at: string;
}

/** Valor devolvido por `resolveEditionImageGenerator` quando destaques divergem. */
export const MIXED_GENERATORS = "mixed";

export function imageGeneratorSidecarPath(outDir: string, destaque: string): string {
  return join(outDir, "_internal", `04-${destaque}-generator.json`);
}

export function writeImageGeneratorSidecar(
  outDir: string,
  destaque: string,
  data: Omit<ImageGeneratorSidecar, "generated_at">,
  now: Date = new Date(),
): string {
  const p = imageGeneratorSidecarPath(outDir, destaque);
  mkdirSync(join(outDir, "_internal"), { recursive: true });
  const payload: ImageGeneratorSidecar = { ...data, generated_at: now.toISOString() };
  writeFileSync(p, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return p;
}

/** Backend efetivo do destaque, ou `null` se o sidecar não existe/é inválido
 * (edições anteriores ao #9095 — o caller cai no `image_generator` do config). */
export function readImageGeneratorSidecar(outDir: string, destaque: string): string | null {
  const p = imageGeneratorSidecarPath(outDir, destaque);
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Partial<ImageGeneratorSidecar>;
    return typeof j.generator === "string" && j.generator ? j.generator : null;
  } catch {
    return null;
  }
}

/**
 * Gerador único pra uma edição inteira (mensal/apoiadores: uma legenda só).
 * - nenhum sidecar → `configured` (comportamento pré-#9095);
 * - todos os sidecars presentes concordam → esse gerador;
 * - divergem → `MIXED_GENERATORS` (o caller mapeia pro genérico "Criada com IA",
 *   nunca nomeia um gerador que não fez todas as imagens).
 */
export function resolveEditionImageGenerator(
  dir: string,
  configured: string,
  destaques: readonly string[] = ["d1", "d2", "d3"],
): string {
  const found = new Set<string>();
  for (const d of destaques) {
    const g = readImageGeneratorSidecar(dir, d);
    if (g) found.add(g);
  }
  if (found.size === 0) return configured;
  if (found.size === 1) return [...found][0];
  return MIXED_GENERATORS;
}

/**
 * carousel-keep-art.ts (#11210)
 *
 * Exceção EXPLÍCITA do editor, por destaque, para manter a arte já gerada do
 * carrossel diário mesmo com o texto do `## d{N}` de `03-social.md` alterado.
 * Caso que motivou (edição 261027, gate 4): o editor reparagrafou o texto
 * social de d2 e d3 ("a alteração é só no texto") e quis o carrossel antigo;
 * `carousel-cards-stale` e `carousel-text-overflow` bloqueavam o gate sem ter
 * como registrar a decisão, e o `gen-carousel-cards.ts` abortava a geração de
 * TODOS os destaques (inclusive o 4º post) por causa deles.
 *
 * Arquivo: `{edição}/_internal/carousel-keep-art.json`
 *
 *   { "d2": "motivo em texto", "d3": "motivo" }
 *
 * Chaves válidas: `d1`, `d2`, `d3`; valor = string não vazia (o motivo, que as
 * mensagens das invariantes citam). Consumidores:
 *   - invariantes `carousel-cards-stale`/`carousel-text-overflow` (Stage 4; a
 *     segunda também no Stage 2) — para destaque com exceção e arte no disco,
 *     a violação vira `warning` citando o motivo. Nunca silencia;
 *   - `gen-carousel-cards.ts` — destaque com exceção não regera nem grava
 *     carimbo; entra como `skipped` e os arquivos existentes seguem valendo.
 *
 * Ausente → `{}` (comportamento de sempre). Presente mas malformado → LANÇA
 * (`readCarouselKeepArt`) ou devolve o erro (`readCarouselKeepArtSafe`): é uma
 * instrução editorial explícita, e ignorá-la em silêncio esconderia o problema
 * (mesmo padrão de `instagram-test-override.ts`, #8681).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CAROUSEL_KEEP_ART_FILENAME = "carousel-keep-art.json";
export const CAROUSEL_KEEP_ART_KEYS = ["d1", "d2", "d3"] as const;
export type CarouselKeepArtKey = (typeof CAROUSEL_KEEP_ART_KEYS)[number];
/** destaque → motivo do editor. */
export type CarouselKeepArt = Partial<Record<CarouselKeepArtKey, string>>;

export function carouselKeepArtPath(editionDir: string): string {
  return resolve(editionDir, "_internal", CAROUSEL_KEEP_ART_FILENAME);
}

/** Pure: valida o JSON já parseado. Lança com mensagem acionável. */
export function parseCarouselKeepArt(data: unknown, source = CAROUSEL_KEEP_ART_FILENAME): CarouselKeepArt {
  const fail = (why: string): never => {
    throw new Error(`[carousel-keep-art] ${source} inválido: ${why} (#11210)`);
  };
  if (!data || typeof data !== "object" || Array.isArray(data)) fail("esperado um objeto JSON");
  const out: CarouselKeepArt = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!(CAROUSEL_KEEP_ART_KEYS as readonly string[]).includes(key)) {
      fail(`chave '${key}' não é destaque válido (use ${CAROUSEL_KEEP_ART_KEYS.join("|")})`);
    }
    if (typeof value !== "string" || !value.trim()) fail(`'${key}' precisa ser o motivo em string não vazia`);
    out[key as CarouselKeepArtKey] = (value as string).trim();
  }
  return out;
}

/** Ausente → `{}`. JSON inválido ou entrada inválida → lança. */
export function readCarouselKeepArt(editionDir: string): CarouselKeepArt {
  const path = carouselKeepArtPath(editionDir);
  if (!existsSync(path)) return {};
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`[carousel-keep-art] ${path} não é JSON válido: ${(e as Error).message} (#11210)`);
  }
  return parseCarouselKeepArt(data, path);
}

/**
 * Versão sem lançar, para as invariantes: com erro, `keepArt` volta `{}` (nenhuma
 * exceção aplicada, severidade original preservada) e `error` traz a mensagem,
 * que o chamador reporta como violação.
 */
export function readCarouselKeepArtSafe(editionDir: string): { keepArt: CarouselKeepArt; error: string | null } {
  try {
    return { keepArt: readCarouselKeepArt(editionDir), error: null };
  } catch (e) {
    return { keepArt: {}, error: (e as Error).message };
  }
}

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
 * A chave é a posição, não a história (#11213): `reorder-destaques.ts` e
 * `promote-to-destaque.ts` reindexam o arquivo junto com os slides
 * (`remapCarouselKeepArt`); `swap-destaque.ts`/`swap-destaques.ts` apagam a
 * entrada da posição que recebe outra história (`clearCarouselKeepArt`).
 *
 * Ausente → `{}` (comportamento de sempre). Presente mas malformado → LANÇA
 * (`readCarouselKeepArt`) ou devolve o erro (`readCarouselKeepArtSafe`): é uma
 * instrução editorial explícita, e ignorá-la em silêncio esconderia o problema
 * (mesmo padrão de `instagram-test-override.ts`, #8681).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * #11213: a chave é a POSIÇÃO, então ela tem que seguir a história quando os
 * destaques se movem — senão a exceção passa a rebaixar para warning o
 * stale/overflow de OUTRA história, e um `gen-carousel-cards.ts` posterior
 * deixa de regerar a arte dela.
 *
 * Pure. `newOrder[i] = k` ⇒ a posição nova `d{i+1}` recebe a entrada da
 * posição antiga `d{k}` (mesma semântica de `reindexCarouselSourceHashes` em
 * `reorder-destaques.ts`). Chave antiga que nenhuma posição nova referencia
 * (ex: `d3` numa edição de 2 destaques) sai. `clear` remove as posições que
 * recebem história nova DEPOIS do remapeamento — o slot inserido pelo promote
 * é mapeado a partir de `d3`, que numa edição de 2 destaques pode ser um
 * resíduo de demoção.
 */
export function remapCarouselKeepArt(
  keepArt: CarouselKeepArt,
  newOrder: readonly number[],
  clear: readonly string[] = [],
): CarouselKeepArt {
  const out: CarouselKeepArt = {};
  for (let i = 0; i < newOrder.length; i++) {
    const novo = `d${i + 1}`;
    const antigo = `d${newOrder[i]}`;
    if (!(CAROUSEL_KEEP_ART_KEYS as readonly string[]).includes(novo)) continue;
    const motivo = keepArt[antigo as CarouselKeepArtKey];
    if (motivo !== undefined) out[novo as CarouselKeepArtKey] = motivo;
  }
  for (const k of clear) delete out[k as CarouselKeepArtKey];
  return out;
}

/**
 * Pure: texto das posições afetadas por `remapCarouselKeepArt(k, newOrder,
 * clear)`, pro aviso do caso malformado — ex.: `newOrder=[2,1,3]` →
 * `"newOrder=[2,1,3] (d1←d2, d2←d1, d3←d3)"`; com `clear=["d1"]`, acrescenta
 * `"; d1 sem exceção (história nova)"`.
 */
export function describeCarouselKeepArtRemap(newOrder: readonly number[], clear: readonly string[] = []): string {
  const moves = newOrder.map((k, i) => `d${i + 1}←d${k}`).join(", ");
  const base = `newOrder=[${newOrder.join(",")}] (${moves})`;
  return clear.length > 0 ? `${base}; ${clear.join(", ")} sem exceção (história nova)` : base;
}

/** Pure: remove as posições que receberam outra história (swap), sem mover as demais. */
export function clearCarouselKeepArt(keepArt: CarouselKeepArt, positions: readonly string[]): CarouselKeepArt {
  const out: CarouselKeepArt = { ...keepArt };
  for (const k of positions) delete out[k as CarouselKeepArtKey];
  return out;
}

/**
 * Aplica `transform` ao arquivo da edição. Ausente → no-op. Malformado → NÃO
 * mexe (a instrução do editor fica como estava, e o `carousel-text-overflow`
 * já a acusa como error) e devolve `warning` — fail-soft como os demais JSONs
 * secundários de reorder/promote/swap: nunca aborta a operação editorial.
 * Resultado vazio grava `{}` (equivale a ausente para os leitores).
 */
export function updateCarouselKeepArtFile(
  editionDir: string,
  transform: (keepArt: CarouselKeepArt) => CarouselKeepArt,
  dryRun = false,
  write: (path: string, content: string) => void = (path, content) => writeFileSync(path, content, "utf8"),
  /**
   * Descreve as posições que a operação mexeu (ex.: saída de
   * `describeCarouselKeepArtRemap`). Entra no `warning` do caso malformado pra
   * quem consertar o JSON à mão aplicar o remapeamento certo — sem ele, o
   * conserto reintroduz a exceção na posição velha (#11213).
   */
  operation?: string,
): { rewritten: string | null; before: CarouselKeepArt; after: CarouselKeepArt; warning?: string } {
  const path = carouselKeepArtPath(editionDir);
  if (!existsSync(path)) return { rewritten: null, before: {}, after: {} };
  let before: CarouselKeepArt;
  try {
    before = readCarouselKeepArt(editionDir);
  } catch (e) {
    return {
      rewritten: null,
      before: {},
      after: {},
      warning: operation
        ? `${(e as Error).message} — exceção de arte mantida NÃO reindexada: ${operation}; remapear as chaves à mão ao consertar o arquivo (#11213).`
        : `${(e as Error).message} — exceção de arte mantida NÃO reindexada; conferir o arquivo à mão (#11213).`,
    };
  }
  const after = transform(before);
  const canon = (k: CarouselKeepArt) => JSON.stringify(CAROUSEL_KEEP_ART_KEYS.map((key) => k[key] ?? null));
  if (canon(after) === canon(before)) return { rewritten: null, before, after };
  if (!dryRun) write(path, JSON.stringify(after, null, 2) + "\n");
  return { rewritten: path, before, after };
}

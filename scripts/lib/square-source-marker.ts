/**
 * square-source-marker.ts (#11672)
 *
 * Registro de que `04-{dN}-1x1.jpg` foi derivado do 4:5 nativo
 * (`derive-square-from-native.ts`) e não do hero 2:1 (`image-generate.ts`).
 * O revisor de crop compara o quadrado com a FONTE dele; sem este registro,
 * `discoverCropPairs` mostraria o 2:1 como fonte e o revisor julgaria um corte
 * que não aconteceu.
 *
 * O registro vale só para o arquivo que o gerou: guarda o md5 do 1:1 gravado.
 * Se o 1:1 for regerado depois (image-generate, swap, reorder), o md5 não bate
 * e o registro é ignorado, sem precisar de limpeza.
 *
 * Arquivo: `{editionDir}/_internal/04-square-source.json`
 *   { "d3": { "source": "04-d3-4x5-nativo.jpg", "image_md5": "...", "derived_at": "..." } }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { md5OfFile } from "./shared/file-md5.ts";

export interface SquareSourceEntry {
  /** Nome do arquivo-fonte, relativo ao diretório da edição. */
  source: string;
  /** md5 de `04-{dN}-1x1.jpg` no momento da derivação. */
  image_md5: string;
  derived_at?: string;
}

export type SquareSourceMarker = Record<string, SquareSourceEntry>;

export function squareSourceMarkerPath(editionDir: string): string {
  return join(editionDir, "_internal", "04-square-source.json");
}

/** Lê o registro; ausente ou ilegível = `{}` (o fallback é o 2:1 de sempre). */
export function readSquareSourceMarker(editionDir: string): SquareSourceMarker {
  const path = squareSourceMarkerPath(editionDir);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: SquareSourceMarker = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const e = v as Record<string, unknown>;
      if (typeof e.source === "string" && typeof e.image_md5 === "string") {
        out[k] = {
          source: e.source,
          image_md5: e.image_md5,
          ...(typeof e.derived_at === "string" ? { derived_at: e.derived_at } : {}),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function writeSquareSourceEntry(editionDir: string, destaque: string, entry: SquareSourceEntry): void {
  const marker = readSquareSourceMarker(editionDir);
  marker[destaque] = entry;
  mkdirSync(join(editionDir, "_internal"), { recursive: true });
  writeFileSync(squareSourceMarkerPath(editionDir), JSON.stringify(marker, null, 2) + "\n", "utf8");
}

/**
 * Fonte registrada do 1:1 ATUAL de `destaque`, como path absoluto, ou `null`
 * quando não há registro, o md5 não bate (1:1 regerado depois) ou a fonte
 * sumiu do disco.
 */
export function resolveSquareSource(editionDir: string, destaque: string): string | null {
  const entry = readSquareSourceMarker(editionDir)[destaque];
  if (!entry) return null;
  const squarePath = join(editionDir, `04-${destaque}-1x1.jpg`);
  const sourcePath = join(editionDir, entry.source);
  if (!existsSync(squarePath) || !existsSync(sourcePath)) return null;
  return md5OfFile(squarePath) === entry.image_md5 ? sourcePath : null;
}

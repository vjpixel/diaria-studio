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
 * e o registro é ignorado, sem precisar de limpeza. Se o 1:1 só mudou de
 * posição (reorder renomeia os arquivos), o md5 acha o registro na chave
 * antiga (#11685 item 4).
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
  const marker = readSquareSourceMarker(editionDir);
  const squarePath = join(editionDir, `04-${destaque}-1x1.jpg`);
  if (!existsSync(squarePath)) return null;
  const squareMd5 = md5OfFile(squarePath);

  const own = marker[destaque];
  if (own && own.image_md5 === squareMd5) {
    const sourcePath = join(editionDir, own.source);
    return existsSync(sourcePath) ? sourcePath : null;
  }

  // #11685 item 4: o registro é indexado pela posição, mas `reorder-destaques`
  // renomeia `04-d{N}-*.jpg` (1x1 e 4x5-nativo juntos) sem tocar neste
  // arquivo. Depois de D1↔D3, o quadrado derivado do D3 está em
  // `04-d1-1x1.jpg` e o registro dele continua em `d3`. O md5 identifica o
  // arquivo; a fonte acompanhou o rename, então troca o `d{N}` do nome.
  for (const [key, entry] of Object.entries(marker)) {
    if (key === destaque || entry.image_md5 !== squareMd5) continue;
    const prefix = `04-${key}-`;
    if (!entry.source.startsWith(prefix)) continue;
    const sourcePath = join(editionDir, `04-${destaque}-${entry.source.slice(prefix.length)}`);
    if (existsSync(sourcePath)) return sourcePath;
  }
  return null;
}

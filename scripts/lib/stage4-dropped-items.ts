/**
 * stage4-dropped-items.ts (#10100)
 *
 * Registro durável dos destaques DESCARTADOS de propósito no Stage 4 via
 * `swap-destaque.ts --drop` / `swap-destaques.ts --drop`.
 *
 * O `--drop` tira a URL de TODOS os buckets de `01-approved.json` (#9990 —
 * senão o writer publicava o item descartado no pool). O invariante
 * `approved-item-removed` (#8121) acusa qualquer item que sumiu de
 * `01-approved.json` em relação ao snapshot pós-Stage 1/2 — então todo
 * `--drop` legítimo virava warning, com uma mensagem mandando fazer o
 * contrário do que o script acabou de fazer. Este arquivo é a declaração
 * explícita do descarte: o invariante ignora as URLs registradas aqui, e
 * `analyze-bucket-overrides.ts` passa a contar os descartes do Stage 4 como
 * decisão editorial à parte (em vez de o item simplesmente sumir do sinal).
 *
 * Arquivo separado de `01-approved.json` de propósito: nenhuma chave nova
 * entra no JSON que writer/linters/validadores varrem por bucket.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalize } from "./url-utils.ts";

export interface Stage4DroppedItem {
  url: string;
  title: string;
  /** Posição do destaque descartado no momento do drop (1-based). */
  position: number;
  /** Script que registrou o descarte. */
  source: "swap-destaque" | "swap-destaques";
  /** ISO timestamp. */
  dropped_at: string;
}

export interface Stage4DroppedFile {
  items: Stage4DroppedItem[];
}

export function stage4DroppedItemsPath(editionDir: string): string {
  return join(editionDir, "_internal", "stage4-dropped-items.json");
}

/** Parse tolerante: arquivo ausente/corrompido/sem `items` → lista vazia. */
export function parseStage4DroppedItems(raw: string | null): Stage4DroppedItem[] {
  if (raw === null) return [];
  try {
    const data = JSON.parse(raw) as Partial<Stage4DroppedFile> | null;
    if (!data || !Array.isArray(data.items)) return [];
    return data.items.filter(
      (it): it is Stage4DroppedItem => !!it && typeof it.url === "string" && it.url !== "",
    );
  } catch {
    return [];
  }
}

export function readStage4DroppedItems(editionDir: string): Stage4DroppedItem[] {
  const path = stage4DroppedItemsPath(editionDir);
  if (!existsSync(path)) return [];
  try {
    return parseStage4DroppedItems(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Conteúdo novo do arquivo com `entries` anexadas ao `existingRaw` (pode ser
 * `null`). Idempotente por URL canonicalizada — re-registrar a mesma URL
 * substitui a entrada antiga em vez de duplicar.
 */
export function appendStage4DroppedItems(
  existingRaw: string | null,
  entries: Stage4DroppedItem[],
): string {
  const current = parseStage4DroppedItems(existingRaw);
  const incoming = new Set(entries.map((e) => canonicalize(e.url)));
  const items = [...current.filter((it) => !incoming.has(canonicalize(it.url))), ...entries];
  return JSON.stringify({ items } satisfies Stage4DroppedFile, null, 2) + "\n";
}

/** URLs canonicalizadas dos descartes registrados. */
export function stage4DroppedUrlSet(items: Stage4DroppedItem[]): Set<string> {
  return new Set(items.map((it) => canonicalize(it.url)));
}

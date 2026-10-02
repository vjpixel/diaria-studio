/**
 * kit-draft-freshness.ts (#9428) — detecta quando os INSUMOS do rascunho Kit
 * mudaram DEPOIS que `publish-newsletter-kit.ts` publicou o draft.
 *
 * Achado na edição 261002: o publisher criou o rascunho às ~19:42 BRT; o
 * editor corrigiu `02-reviewed.md` às 19:54 e o e-mail de teste (e o broadcast
 * de produção) continuaram com o texto velho. Nada no pipeline comparava o
 * source com o que foi enviado ao Kit antes do gate do Stage 6 — só o
 * `review-test-email` pegou, por acaso.
 *
 * Mecanismo (precedente: `01-render-hash.json`, `render-categorized-md.ts`):
 * no publish, gravamos em `_internal/newsletter-kit-published.json` o sha256
 * de cada arquivo que `publish-newsletter-kit.ts` lê pra montar o `content`
 * do broadcast (`KIT_DRAFT_SOURCE_FILES`). No check, recalculamos e
 * comparamos. Divergência = o draft no Kit está defasado em relação ao disco.
 *
 * Só leitura/hash — nunca re-publica nada sozinho. A ação é do orchestrator/
 * editor: re-rodar `publish-newsletter-kit.ts <edition-dir> --send-test`
 * (idempotente: PATCH do mesmo `broadcast_id` + novo e-mail de teste).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Arquivos (relativos ao edition dir) que entram no `content`/subject/preview
 * do broadcast Kit:
 * - `02-reviewed.md` — texto da edição, título/subtítulo (subject/preview);
 * - `01-eia.md` — bloco "É IA?" (lido por `extractContent`);
 * - `06-public-images.json` — URLs das imagens substituídas no HTML (muda,
 *   p.ex., quando `apply-box-slot.ts` sobe a imagem de um box novo).
 */
export const KIT_DRAFT_SOURCE_FILES = ["02-reviewed.md", "01-eia.md", "06-public-images.json"] as const;

/** sha256 por arquivo; `null` = arquivo ausente no momento do hash. */
export type SourceHashes = Record<string, string | null>;

export function sha256OfFile(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function computeKitDraftSourceHashes(
  editionDir: string,
  files: readonly string[] = KIT_DRAFT_SOURCE_FILES,
): SourceHashes {
  const out: SourceHashes = {};
  for (const rel of files) {
    out[rel] = sha256OfFile(resolve(editionDir, rel));
  }
  return out;
}

export type KitDraftFreshness =
  /** Estado sem `source_hashes` (publicado antes do #9428) — nada a comparar. */
  | { status: "unknown"; reason: string }
  | { status: "fresh" }
  | { status: "stale"; changed: string[] };

/**
 * Pura — compara os hashes gravados no publish com os atuais. Só compara as
 * chaves GRAVADAS (um arquivo novo em `KIT_DRAFT_SOURCE_FILES` adicionado
 * depois do publish não acusa divergência retroativa).
 */
export function compareSourceHashes(
  recorded: SourceHashes | undefined | null,
  current: SourceHashes,
): KitDraftFreshness {
  if (!recorded || typeof recorded !== "object" || Object.keys(recorded).length === 0) {
    return {
      status: "unknown",
      reason: "newsletter-kit-published.json sem source_hashes (publicado antes do #9428)",
    };
  }
  const changed: string[] = [];
  for (const [rel, hash] of Object.entries(recorded)) {
    if ((current[rel] ?? null) !== hash) changed.push(rel);
  }
  return changed.length === 0 ? { status: "fresh" } : { status: "stale", changed };
}

/** Lê o estado gravado e compara com o disco agora (hash só das chaves gravadas). */
export function checkKitDraftFreshness(editionDir: string, recorded: SourceHashes | undefined | null): KitDraftFreshness {
  const keys = recorded && typeof recorded === "object" ? Object.keys(recorded) : [];
  return compareSourceHashes(recorded, computeKitDraftSourceHashes(editionDir, keys));
}

/**
 * kit-draft-freshness.ts (#9428) — detecta quando o conteúdo do rascunho Kit
 * ficou defasado em relação ao disco DEPOIS que `publish-newsletter-kit.ts`
 * publicou o draft.
 *
 * Achado na edição 261002: o publisher criou o rascunho às ~19:42 BRT; o
 * editor corrigiu `02-reviewed.md` às 19:54 e o e-mail de teste (e o broadcast
 * de produção) continuaram com o texto velho. Nada no pipeline comparava o
 * source com o que foi enviado ao Kit antes do gate do Stage 6 — só o
 * `review-test-email` pegou, por acaso.
 *
 * Mecanismo (precedente: `01-render-hash.json`, `render-categorized-md.ts`):
 * - **Decisão:** `content_hash` = sha256 de subject + preview + HTML exatamente
 *   como enviados ao Kit. O check re-renderiza com a mesma função do publisher
 *   (`renderKitPayload`) e compara. Cobre todo insumo, direto ou indireto
 *   (02-reviewed.md, 01-eia.md, imagens, snippets, leaderboard, config de
 *   afiliado), sem falso positivo de mudança que não chega ao e-mail.
 * - **Diagnóstico:** `source_hashes` (sha256 por arquivo de
 *   `KIT_DRAFT_SOURCE_FILES`) só serve pra nomear, na mensagem, qual arquivo
 *   mudou — nunca decide sozinho.
 *
 * Escopo: o check compara contra o DRAFT. Se um `--send-test` falhar depois
 * do PATCH, o draft fica em dia e o e-mail de teste velho não é acusado aqui.
 *
 * Só leitura/hash — nunca re-publica nada sozinho. A ação é do editor:
 * re-rodar `publish-newsletter-kit.ts <edition-dir> --send-test` (idempotente:
 * PATCH do mesmo `broadcast_id` + novo e-mail de teste).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Insumos diretos do `content` — usados só pra diagnóstico (ver docstring). */
export const KIT_DRAFT_SOURCE_FILES = ["02-reviewed.md", "01-eia.md", "06-public-images.json"] as const;

/** sha256 por arquivo; `null` = arquivo ausente (ou ilegível) no momento do hash. */
export type SourceHashes = Record<string, string | null>;

/** sha256 do payload do broadcast (separador NUL evita colisão por concatenação). */
export function kitContentHash(subject: string, previewText: string, html: string): string {
  return createHash("sha256").update(`${subject}\0${previewText}\0${html}`).digest("hex");
}

/** Nunca lança: ausente, diretório ou ilegível → `null`. */
export function sha256OfFile(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
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

/** Pura — quais arquivos registrados mudaram (só diagnóstico). */
export function changedSourceFiles(recorded: SourceHashes | undefined | null, current: SourceHashes): string[] {
  if (!recorded || typeof recorded !== "object") return [];
  return Object.entries(recorded)
    .filter(([rel, hash]) => (current[rel] ?? null) !== hash)
    .map(([rel]) => rel);
}

/** Lê o disco e devolve os arquivos registrados que mudaram desde o publish. */
export function changedSourceFilesOnDisk(editionDir: string, recorded: SourceHashes | undefined | null): string[] {
  const keys = recorded && typeof recorded === "object" ? Object.keys(recorded) : [];
  return changedSourceFiles(recorded, computeKitDraftSourceHashes(editionDir, keys));
}

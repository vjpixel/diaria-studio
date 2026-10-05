/**
 * humanizer-social-seal.ts (#9679)
 *
 * Re-selo do sentinel `_internal/.humanizer-social-done.json` (#2373/#3446)
 * depois de uma mudança MECÂNICA de `03-social.md` que só renumera headers
 * `## d{N}` — `reorder-destaques.ts` e `promote-to-destaque.ts`.
 *
 * Por que existe: o sentinel guarda o sha256 do `03-social.md` humanizado. Um
 * reorder troca `## d1`/`## d3` de lugar sem mexer em uma letra do texto, mas o
 * sha256 muda — e `check-humanizer-social --check` acusava `hash_mismatch`,
 * obrigando o editor a rodar `--write --bypass-reason` à mão (edição 261006).
 *
 * Regra de segurança (o motivo do guard #2373 continua valendo): só re-sela
 * quando o sentinel batia com o social ANTES da mudança mecânica. Se o social
 * já divergia do selo (editado à mão depois da humanização), re-selar aqui
 * lavaria essa edição não humanizada — nesse caso não toca e devolve
 * `stale_before`, pro chamador listar em `next_steps`.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { computeSectionHashes } from "./social-lint-rules.ts";

export const HUMANIZER_SOCIAL_SENTINEL = ".humanizer-social-done.json";

/** sha256 do conteúdo do `03-social.md` — mesma normalização (CRLF→LF) do `check-humanizer-social`. */
export function hashSocialContent(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

export type HumanizerResealPlan =
  | { status: "absent" }
  | { status: "stale_before"; stored: string; before: string }
  | { status: "unchanged" }
  | { status: "reseal"; path: string; content: string };

/**
 * Pure (lê só o sentinel): decide o re-selo. `before`/`after` são o conteúdo do
 * `03-social.md` antes e depois da renumeração. Não grava — o chamador põe
 * `content` no lote verificado dele.
 */
export function planHumanizerReseal(
  editionDir: string,
  before: string,
  after: string,
  resealedBy: string,
): HumanizerResealPlan {
  const path = join(editionDir, "_internal", HUMANIZER_SOCIAL_SENTINEL);
  if (!existsSync(path)) return { status: "absent" };
  let stored: Record<string, unknown>;
  try {
    stored = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return { status: "absent" };
  }
  if (typeof stored?.social_sha256 !== "string") return { status: "absent" };

  const beforeHash = hashSocialContent(before);
  if (stored.social_sha256 !== beforeHash) {
    return { status: "stale_before", stored: stored.social_sha256, before: beforeHash };
  }
  const afterHash = hashSocialContent(after);
  if (afterHash === beforeHash) return { status: "unchanged" };

  const sentinel = {
    ...stored,
    social_sha256: afterHash,
    written_at: new Date().toISOString(),
    section_hashes: computeSectionHashes(after),
    resealed_by: resealedBy,
  };
  return { status: "reseal", path, content: JSON.stringify(sentinel, null, 2) + "\n" };
}

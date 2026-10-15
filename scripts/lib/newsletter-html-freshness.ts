/**
 * newsletter-html-freshness.ts (#10245, #10258) — decide se
 * `_internal/newsletter-final.html` ficou atrás de `02-reviewed.md`.
 *
 * Contexto: o replant do erro intencional (e qualquer edição no gate 4)
 * regrava `02-reviewed.md` sem re-renderizar o HTML; o Stage 5 publicava a
 * página do site e o broadcast Kit com o texto velho. Desde #10258 o
 * invariante é `error` e `pipeline-sentinel.ts write --step 4` recusa.
 *
 * Como `error` bloqueia o sentinel, o critério não pode ser só mtime — um
 * `02-reviewed.md` regravado com o MESMO conteúdo depois do render (save
 * no-op do Studio, sync de nuvem, apply do docs-sync sem edição) bloquearia
 * a edição à toa. Por isso `render-newsletter-html.ts` carimba o sha256 do
 * `02-reviewed.md` que usou em `RENDER_SOURCE_STAMP` (carimbo de proveniência,
 * mesmo precedente de `01-render-hash.json`/`kit-draft-freshness.ts`).
 *
 * Decisão (pura, `evaluateNewsletterHtmlFreshness`):
 * 1. HTML ausente → não acusa (o pré-render ausente é outra regra).
 * 2. HTML com mtime ≥ reviewed (tolerância `toleranceMs`) → fresco. Mantém o
 *    fluxo normal (render depois do reviewed) e cobre caminhos que escrevem o
 *    HTML sem carimbar (edição de última milha do Studio no
 *    `newsletter-final.html`).
 * 3. HTML mais antigo, mas o carimbo registra o sha256 ATUAL do reviewed e
 *    não é mais novo que o HTML → fresco: o reviewed só foi tocado, o
 *    conteúdo que o HTML reflete é o mesmo. A exigência "carimbo não mais
 *    novo que o HTML" evita aceitar um re-render só do `newsletter-draft.html`
 *    (que atualiza o carimbo) sem o `substitute-image-urls.ts` que regrava o
 *    `newsletter-final.html`.
 * 4. Caso contrário → defasado.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Relativo ao diretório da edição. */
export const NEWSLETTER_FINAL_HTML = "_internal/newsletter-final.html";
export const REVIEWED_MD = "02-reviewed.md";
export const RENDER_SOURCE_STAMP = "_internal/newsletter-render-source.json";

/** Tolerância de mtime (ms) — mesma de `social-not-behind-reviewed`. */
export const HTML_FRESHNESS_TOLERANCE_MS = 1000;

export interface RenderSourceStamp {
  /** sha256 do `02-reviewed.md` usado no render. */
  reviewed_sha256: string;
  /** mtime (ms) do arquivo de carimbo em disco. */
  mtimeMs: number;
}

export interface NewsletterHtmlFreshnessInput {
  htmlMtimeMs: number | null;
  reviewedMtimeMs: number | null;
  /** sha256 atual do `02-reviewed.md`; `null` = ausente/ilegível. */
  reviewedSha256: string | null;
  stamp: RenderSourceStamp | null;
  toleranceMs?: number;
}

export type NewsletterHtmlFreshness =
  | { stale: false; reason: "no-html" | "no-reviewed" | "mtime-fresh" | "stamp-matches" }
  | { stale: true; reason: "stamp-mismatch" | "no-stamp" | "stamp-newer-than-html"; lagMinutes: number };

export function evaluateNewsletterHtmlFreshness(input: NewsletterHtmlFreshnessInput): NewsletterHtmlFreshness {
  const tol = input.toleranceMs ?? HTML_FRESHNESS_TOLERANCE_MS;
  if (input.htmlMtimeMs === null) return { stale: false, reason: "no-html" };
  if (input.reviewedMtimeMs === null) return { stale: false, reason: "no-reviewed" };
  if (input.htmlMtimeMs + tol >= input.reviewedMtimeMs) return { stale: false, reason: "mtime-fresh" };
  const lagMinutes = Math.round((input.reviewedMtimeMs - input.htmlMtimeMs) / 60000);
  const { stamp } = input;
  if (!stamp) return { stale: true, reason: "no-stamp", lagMinutes };
  if (stamp.mtimeMs > input.htmlMtimeMs + tol) return { stale: true, reason: "stamp-newer-than-html", lagMinutes };
  if (input.reviewedSha256 !== null && stamp.reviewed_sha256 === input.reviewedSha256) {
    return { stale: false, reason: "stamp-matches" };
  }
  return { stale: true, reason: "stamp-mismatch", lagMinutes };
}

export function sha256OfFileOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function mtimeOrNull(path: string): number | null {
  try {
    return existsSync(path) ? statSync(path).mtimeMs : null;
  } catch {
    return null;
  }
}

/** Lê o carimbo; ausente, malformado ou sem `reviewed_sha256` string → `null`. */
export function readRenderSourceStamp(editionDir: string): RenderSourceStamp | null {
  const path = resolve(editionDir, RENDER_SOURCE_STAMP);
  const mtimeMs = mtimeOrNull(path);
  if (mtimeMs === null) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { reviewed_sha256?: unknown };
    if (typeof parsed.reviewed_sha256 !== "string" || parsed.reviewed_sha256.length === 0) return null;
    return { reviewed_sha256: parsed.reviewed_sha256, mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Grava o carimbo com o sha256 do `02-reviewed.md` atual. Chamado por
 * `render-newsletter-html.ts` a cada render HTML com `--out`. Reviewed
 * ausente → não grava (nada a carimbar).
 */
export function writeRenderSourceStamp(editionDir: string): void {
  const sha = sha256OfFileOrNull(resolve(editionDir, REVIEWED_MD));
  if (sha === null) return;
  const path = resolve(editionDir, RENDER_SOURCE_STAMP);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ reviewed_sha256: sha, generated_at: new Date().toISOString() }, null, 2) + "\n",
  );
}

/** Lê o disco e avalia. */
export function evaluateNewsletterHtmlFreshnessOnDisk(editionDir: string): NewsletterHtmlFreshness {
  const reviewedPath = resolve(editionDir, REVIEWED_MD);
  const htmlMtimeMs = mtimeOrNull(resolve(editionDir, NEWSLETTER_FINAL_HTML));
  const reviewedMtimeMs = mtimeOrNull(reviewedPath);
  // Hash só quando o mtime já acusou — evita ler o reviewed no caminho comum.
  const needsHash = htmlMtimeMs !== null && reviewedMtimeMs !== null && htmlMtimeMs + HTML_FRESHNESS_TOLERANCE_MS < reviewedMtimeMs;
  return evaluateNewsletterHtmlFreshness({
    htmlMtimeMs,
    reviewedMtimeMs,
    reviewedSha256: needsHash ? sha256OfFileOrNull(reviewedPath) : null,
    stamp: needsHash ? readRenderSourceStamp(editionDir) : null,
  });
}

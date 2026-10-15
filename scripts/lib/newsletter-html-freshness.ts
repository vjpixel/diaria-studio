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
 * 2. Com carimbo e sha256 do reviewed legível, o CARIMBO decide (#10268) —
 *    o mtime não tem voto:
 *    a. sha do carimbo ≠ sha atual → defasado (`stamp-mismatch`), mesmo com
 *       o HTML mais novo que o reviewed. Cobre o `newsletter-final.html`
 *       regravado sem re-render depois de o reviewed mudar (edição de última
 *       milha no Studio, OneDrive re-baixando com mtime novo) — antes o
 *       `mtime-fresh` respondia primeiro e o texto velho passava.
 *    b. sha igual e HTML com mtime ≥ reviewed → fresco (`mtime-fresh`).
 *    c. sha igual, HTML mais antigo que o reviewed, carimbo não mais novo que
 *       o HTML → fresco (`stamp-matches`): o reviewed só foi tocado.
 *    d. sha igual, HTML mais antigo que o reviewed e carimbo mais novo que o
 *       HTML → defasado (`stamp-newer-than-html`): re-render só do
 *       `newsletter-draft.html` sem o `substitute-image-urls.ts` que regrava o
 *       `newsletter-final.html`.
 * 3. Sem carimbo (ou reviewed ilegível) → fallback por mtime: HTML com mtime
 *    ≥ reviewed (tolerância `toleranceMs`) é fresco; senão defasado
 *    (`no-stamp`).
 *
 * O carimbo registra o sha256 dos BYTES que o render de fato leu
 * (`render-newsletter-html.ts` hasheia o buffer que passa ao
 * `extractContent`, #10268) — não uma releitura do arquivo depois de gravar
 * a saída, que pegaria um save do editor no meio do render e carimbaria um
 * sha que o HTML não reflete.
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
  const mtimeFresh = input.htmlMtimeMs + tol >= input.reviewedMtimeMs;
  // Defasagem por mtime; 0 quando o HTML é mais novo (stamp-mismatch com mtime fresco).
  const lagMinutes = Math.max(0, Math.round((input.reviewedMtimeMs - input.htmlMtimeMs) / 60000));
  const { stamp } = input;
  // #10268: com carimbo, ele decide — o mtime só desempata o caso "draft
  // re-renderizado sem substitute" (carimbo mais novo que o HTML).
  if (stamp && input.reviewedSha256 !== null) {
    if (stamp.reviewed_sha256 !== input.reviewedSha256) return { stale: true, reason: "stamp-mismatch", lagMinutes };
    if (mtimeFresh) return { stale: false, reason: "mtime-fresh" };
    if (stamp.mtimeMs > input.htmlMtimeMs + tol) return { stale: true, reason: "stamp-newer-than-html", lagMinutes };
    return { stale: false, reason: "stamp-matches" };
  }
  // Sem carimbo (ou reviewed ilegível): fallback por mtime.
  if (mtimeFresh) return { stale: false, reason: "mtime-fresh" };
  return { stale: true, reason: "no-stamp", lagMinutes };
}

export function sha256OfFileOrNull(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return sha256Hex(readFileSync(path));
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
 * Grava o carimbo. Chamado por `render-newsletter-html.ts` a cada render HTML
 * com `--out`, passando o sha256 dos bytes que o render LEU (#10268) — reler o
 * arquivo aqui, depois de gravar a saída, carimbaria um save do editor feito
 * no meio do render. Sem `reviewedSha256` (uso legado/teste), hasheia o
 * `02-reviewed.md` atual; reviewed ausente → não grava (nada a carimbar).
 */
export function writeRenderSourceStamp(editionDir: string, reviewedSha256?: string): void {
  const sha = reviewedSha256 ?? sha256OfFileOrNull(resolve(editionDir, REVIEWED_MD));
  if (sha === null) return;
  const path = resolve(editionDir, RENDER_SOURCE_STAMP);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ reviewed_sha256: sha, generated_at: new Date().toISOString() }, null, 2) + "\n",
  );
}

/** sha256 hex de um buffer/texto — mesmo algoritmo de `sha256OfFileOrNull`. */
export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Lê o disco e avalia. */
export function evaluateNewsletterHtmlFreshnessOnDisk(editionDir: string): NewsletterHtmlFreshness {
  const reviewedPath = resolve(editionDir, REVIEWED_MD);
  const htmlMtimeMs = mtimeOrNull(resolve(editionDir, NEWSLETTER_FINAL_HTML));
  const reviewedMtimeMs = mtimeOrNull(reviewedPath);
  // #10268: o carimbo decide sempre que existe, então o hash é lido mesmo no
  // caminho mtime-fresco (custo: 1 leitura do reviewed, ~dezenas de KB).
  const needsHash = htmlMtimeMs !== null && reviewedMtimeMs !== null;
  return evaluateNewsletterHtmlFreshness({
    htmlMtimeMs,
    reviewedMtimeMs,
    reviewedSha256: needsHash ? sha256OfFileOrNull(reviewedPath) : null,
    stamp: needsHash ? readRenderSourceStamp(editionDir) : null,
  });
}

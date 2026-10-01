/**
 * lint-checks/destaque-url-matches-approved.ts (#9252)
 *
 * A URL de cada destaque (D1/D2/D3) no draft tem de ser EXATAMENTE a URL do
 * highlight correspondente em `01-approved*.json` (`highlights[N-1].article.url`,
 * ou `.url` no shape flat). Gate-blocking.
 *
 * Incidente que motivou (edição 261001, Stage 2 headless): o `writer-destaque`
 * do D1 emitiu uma URL inventada (faltava o segmento `/gemini-models/`) — a
 * URL "parecia" a do anúncio, mas não era a aprovada. Nenhum lint de Stage 2
 * comparava a URL do destaque com a do approved (o `url-bucket` só olha as
 * seções secundárias), então o erro só foi pego pelo fact-check do Stage 4.
 *
 * Normalização: só o fragmento (`#...`) é ignorado — mesma regra de
 * `normalizeUrlForMatch` em url-bucket.ts (#1691/#720: query, trailing slash e
 * www podem ser semânticos; URLs são opacas).
 */

import { parseDestaques } from "../../extract-destaques.ts";

export interface DestaqueUrlApprovedHighlight {
  url?: string;
  article?: { url?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface DestaqueUrlMismatch {
  destaque: number;
  type: "url_mismatch" | "missing_url" | "no_approved_highlight";
  found: string;
  expected: string;
}

export interface DestaqueUrlMatchesApprovedReport {
  ok: boolean;
  errors: DestaqueUrlMismatch[];
}

function stripFragment(url: string): string {
  const t = url.trim();
  const hash = t.indexOf("#");
  return hash === -1 ? t : t.slice(0, hash);
}

function approvedUrlOf(h: DestaqueUrlApprovedHighlight | undefined): string {
  if (!h) return "";
  return (h.article?.url ?? h.url ?? "").trim();
}

export function checkDestaqueUrlMatchesApproved(
  md: string,
  approved: { highlights?: DestaqueUrlApprovedHighlight[] },
): DestaqueUrlMatchesApprovedReport {
  const highlights = approved.highlights ?? [];
  const errors: DestaqueUrlMismatch[] = [];
  for (const d of parseDestaques(md)) {
    const expected = approvedUrlOf(highlights[d.n - 1]);
    const found = (d.url ?? "").trim();
    if (!expected) {
      errors.push({ destaque: d.n, type: "no_approved_highlight", found, expected: "" });
      continue;
    }
    if (!found) {
      errors.push({ destaque: d.n, type: "missing_url", found: "", expected });
      continue;
    }
    if (stripFragment(found) !== stripFragment(expected)) {
      errors.push({ destaque: d.n, type: "url_mismatch", found, expected });
    }
  }
  return { ok: errors.length === 0, errors };
}

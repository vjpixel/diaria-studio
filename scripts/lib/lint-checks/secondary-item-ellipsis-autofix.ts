/**
 * lib/lint-checks/secondary-item-ellipsis-autofix.ts (#6441)
 *
 * Deterministic autofix for the `fabricated-ellipsis` failure mode that
 * `secondary-item-coherence.ts` (#5663) detects: a secondary-item
 * description ends in "…"/"..." while the raw summary in `01-approved.json`
 * for the same URL is intact — the truncation happened somewhere between
 * the stitch and the humanizer, and the fix is 100% mechanical: paste the
 * missing tail back from the summary.
 *
 * Same convention as `apply-factcheck-autofix.ts` (#2598): pure planning
 * function (`planEllipsisRestore`) + a mutating pass over the markdown
 * (`applySecondaryItemEllipsisAutofix`) that a CLI/caller persists.
 *
 * Scope, deliberately narrow (mirrors the "no semantic-similarity
 * threshold" philosophy of secondary-item-coherence.ts):
 *   - Only descriptions with a TRAILING ellipsis are considered — this
 *     module does not gate on `checkSecondaryItemCoherence`'s broader
 *     "ellipsis anywhere in description" condition, it scans independently
 *     via the same walker.
 *   - Restoration requires an EXACT prefix match (after whitespace
 *     normalization) between the description (minus its trailing ellipsis)
 *     and the summary — no fuzzy/semantic matching, ever. A paraphrase that
 *     diverges from the summary's wording before the truncation point is
 *     left untouched (`unresolved_no_prefix_match`) rather than guessed.
 *   - A summary that ITSELF ends in a trailing ellipsis (RSS truncation
 *     garbage — the "saudedigitalnews" example in #6441) has nothing to
 *     restore from — left untouched (`unresolved_summary_truncated`),
 *     requires manual editorial rewrite.
 *
 * Never produces a description that is empty or still ends in the
 * fabricated ellipsis when a fix is "applied" — those are exactly the two
 * failure shapes the self-review for #6441 checked for.
 */

import {
  forEachSecondaryItem,
  type SecondaryItemFound,
} from "./secondary-item-walker.ts";
import { TRAILING_ELLIPSIS_RE } from "../sanitize-description-ellipsis.ts";
import {
  summaryByUrl,
  type CoherenceApprovedJson,
} from "./secondary-item-coherence.ts";

export type EllipsisAutofixStatus =
  | "applied"
  | "skipped_summary_unavailable"
  | "unresolved_summary_truncated"
  | "unresolved_no_prefix_match"
  | "unresolved_structure_changed";

export interface EllipsisAutofixEntry {
  url: string;
  section: string;
  line: number;
  status: EllipsisAutofixStatus;
  before?: string;
  after?: string;
}

export interface EllipsisAutofixResult {
  changed: boolean;
  content: string;
  entries: EllipsisAutofixEntry[];
}

function normalizeWhitespace(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

export type EllipsisRestorePlan =
  | { fixedDescription: string }
  | { unresolved: "summary_truncated" | "no_prefix_match" };

/**
 * Pure (#6441): dado o par (descrição truncada, summary bruto de origem),
 * calcula a descrição restaurada colando o trecho correspondente do
 * summary, ou retorna `unresolved` quando não é seguro restaurar.
 *
 * Precondição do caller: `description` termina em reticência (o caller já
 * filtrou por isso antes de chamar). Se não terminar, o common-prefix check
 * abaixo ainda funciona corretamente (comportamento degrada pra "prefixo
 * inteiro bate" → sem tail a colar), mas este caso não deveria surgir na
 * prática.
 */
export function planEllipsisRestore(
  description: string,
  summary: string,
): EllipsisRestorePlan {
  const normalizedSummary = normalizeWhitespace(summary);
  if (TRAILING_ELLIPSIS_RE.test(normalizedSummary)) {
    return { unresolved: "summary_truncated" };
  }

  const descCore = description.replace(TRAILING_ELLIPSIS_RE, "").trim();
  const normalizedDescCore = normalizeWhitespace(descCore);

  if (!normalizedSummary.startsWith(normalizedDescCore)) {
    return { unresolved: "no_prefix_match" };
  }

  const tail = normalizedSummary.slice(normalizedDescCore.length).trim();
  const fixedDescription = tail
    ? normalizeWhitespace(`${descCore} ${tail}`)
    : normalizeWhitespace(descCore);

  // Self-review guard (#6441): nunca devolver algo pior que o original —
  // vazio, ou ainda terminando em reticência (só pode acontecer se o
  // summary normalizado também terminasse em reticência, já barrado acima,
  // mas mantido como defesa em profundidade caso a regex mude).
  if (!fixedDescription || TRAILING_ELLIPSIS_RE.test(fixedDescription)) {
    return { unresolved: "no_prefix_match" };
  }

  return { fixedDescription };
}

/**
 * Varre `md` e aplica `planEllipsisRestore` a cada item secundário cuja
 * descrição termina em reticência. Substituição é feita LINHA A LINHA (a
 * mesma linha que o walker reportou como `descriptionLine`) via replacer
 * FUNCTION — nunca string literal — pra não deixar `$&`/`` $` ``/`$'` do
 * texto colado (vindo de `summary`, texto livre sem escaping) serem
 * interpretados como padrão de substituição (mesma cautela de
 * `applyTextSubstitution` em `apply-factcheck-autofix.ts`).
 */
export function applySecondaryItemEllipsisAutofix(
  md: string,
  approved: CoherenceApprovedJson,
): EllipsisAutofixResult {
  const summaries = summaryByUrl(approved);
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const entries: EllipsisAutofixEntry[] = [];
  let changed = false;

  forEachSecondaryItem(md, {
    onFound: (item: SecondaryItemFound) => {
      if (!TRAILING_ELLIPSIS_RE.test(item.description)) return;

      const summary = summaries.get(item.url.split("#", 1)[0]);
      if (!summary) {
        entries.push({
          url: item.url,
          section: item.section,
          line: item.descriptionLine,
          status: "skipped_summary_unavailable",
        });
        return;
      }

      const plan = planEllipsisRestore(item.description, summary);
      if ("unresolved" in plan) {
        entries.push({
          url: item.url,
          section: item.section,
          line: item.descriptionLine,
          status:
            plan.unresolved === "summary_truncated"
              ? "unresolved_summary_truncated"
              : "unresolved_no_prefix_match",
        });
        return;
      }

      const lineIdx = item.descriptionLine - 1;
      const rawLine = lines[lineIdx];
      if (rawLine === undefined || !rawLine.includes(item.description)) {
        // Linha não bate mais com o que o walker reportou (estrutura mudou
        // entre o parse e a substituição) — nunca arriscar substituição às
        // cegas na linha errada.
        entries.push({
          url: item.url,
          section: item.section,
          line: item.descriptionLine,
          status: "unresolved_structure_changed",
        });
        return;
      }

      lines[lineIdx] = rawLine.replace(item.description, () => plan.fixedDescription);
      changed = true;
      entries.push({
        url: item.url,
        section: item.section,
        line: item.descriptionLine,
        status: "applied",
        before: item.description,
        after: plan.fixedDescription,
      });
    },
  });

  return { changed, content: changed ? lines.join("\n") : md, entries };
}

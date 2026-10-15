/**
 * record-kit-review.ts (#9594)
 *
 * Grava `_internal/05-review-kit.json` com o resultado do loop
 * `review-test-email` (§5f do Stage 5) no backend Kit — o equivalente aos
 * campos `review_*` que o caminho Beehiiv grava em `05-published.json`.
 * É o que o invariante `stage-5-review-completed` (ramo Kit) e o gate do
 * Stage 6 (§6b) leem; sem o arquivo, os dois acusam que o review NÃO rodou.
 *
 * Uso:
 *   npx tsx scripts/record-kit-review.ts --edition-dir data/editions/2610/261005 \
 *     --status ok|inconclusive|issues_unfixable [--attempts 0|1|2] \
 *     [--reason mcp_unavailable|not_found_timeout|truncated_fetch] \
 *     [--issues-json '["issue 1","issue 2"]'] [--email-file <corpo do e-mail entregue>]
 *
 * `--email-file` (#10243): confere em TS que `wrong_value` de
 * `_internal/intentional-error.json` aparece no e-mail ENTREGUE e grava
 * `intentional_error_check`; `--status ok` com `missing` é recusado (o agente
 * pode ter alucinado o texto correto).
 *
 * `--attempts` (default 1) conta despachos do agente: `0` quando o §5f saiu
 * `inconclusive` no passo 0 sem despachar o `review-test-email` (#9885) —
 * aceito só com `--status inconclusive`.
 *
 * Exit 1 = argumento inválido / edition-dir ausente (nada gravado).
 * Escrita verificada (`writeFilesVerified`, #9173 — `data/` vive no OneDrive).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule, parseArgsSimple } from "./lib/cli-args.ts";
import { writeFilesVerified } from "./lib/write-files-verified.ts";
import {
  buildKitReviewRecord,
  checkIntentionalErrorInEmail,
  KIT_REVIEW_FILENAME,
  type KitReviewRecord,
} from "./lib/kit-review-record.ts";

export function recordKitReview(
  editionDir: string,
  input: Parameters<typeof buildKitReviewRecord>[0],
): { path: string; record: KitReviewRecord } {
  const internalDir = resolve(editionDir, "_internal");
  if (!existsSync(internalDir)) throw new Error(`_internal/ ausente em ${editionDir}`);
  const record = buildKitReviewRecord(input);
  const path = resolve(internalDir, KIT_REVIEW_FILENAME);
  writeFilesVerified([{ path, content: JSON.stringify(record, null, 2) + "\n" }], "record-kit-review");
  return { path, record };
}

/** #10243 — lê `wrong_value` do erro intencional da edição e confere no corpo. */
export function checkEditionEmail(editionDir: string, emailFile: string) {
  const ie = resolve(editionDir, "_internal", "intentional-error.json");
  let wrong: string | undefined;
  if (existsSync(ie)) {
    try {
      wrong = (JSON.parse(readFileSync(ie, "utf8")) as { wrong_value?: string }).wrong_value;
    } catch {
      wrong = undefined;
    }
  }
  const body = existsSync(emailFile) ? readFileSync(emailFile, "utf8") : undefined;
  return checkIntentionalErrorInEmail(body, wrong);
}

if (isMainModule(import.meta.url)) {
  const args = parseArgsSimple(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  if (!editionDir || !args.status) {
    console.error(
      "uso: record-kit-review.ts --edition-dir <dir> --status ok|inconclusive|issues_unfixable " +
        "[--attempts N] [--reason R] [--issues-json '[...]']",
    );
    process.exit(1);
  }
  try {
    const issues = args["issues-json"] !== undefined ? (JSON.parse(args["issues-json"]) as unknown) : undefined;
    const r = recordKitReview(editionDir, {
      status: args.status,
      attempts: args.attempts !== undefined ? Number(args.attempts) : undefined,
      reason: args.reason,
      issues,
      intentionalErrorCheck: args["email-file"] ? checkEditionEmail(editionDir, args["email-file"]) : undefined,
    });
    console.log(JSON.stringify({ path: r.path, ...r.record }));
  } catch (e) {
    console.error(`record-kit-review: ${(e as Error).message}`);
    process.exit(1);
  }
}

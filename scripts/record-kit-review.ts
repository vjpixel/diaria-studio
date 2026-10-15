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
import { basename, resolve } from "node:path";
import { isMainModule, parseArgsSimple } from "./lib/cli-args.ts";
import { logEvent } from "./lib/run-log.ts";
import { writeFilesVerified } from "./lib/write-files-verified.ts";
import {
  buildKitReviewRecord,
  checkIntentionalErrorInEmail,
  KIT_REVIEW_FILENAME,
  type IntentionalErrorCheck,
  type KitReviewRecord,
} from "./lib/kit-review-record.ts";
import { isIntentionalErrorPlaceholder } from "./lib/intentional-errors.ts";

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

/**
 * #10243 — lê `wrong_value` do erro intencional da edição e confere no corpo.
 *
 * #10267: `no_error: true` = edição sem erro declarado → `no_wrong_value` (mesmo
 * que o JSON ainda carregue um `wrong_value`). `warnings` lista as causas que
 * DESLIGAM a checagem sem ser uma decisão editorial — JSON ilegível, `wrong_value`
 * ainda placeholder `{PREENCHER}` (#10293), `--email-file` ausente/ilegível — pra que o chamador as torne visíveis em vez de engolir.
 */
export function checkEditionEmail(
  editionDir: string,
  emailFile: string,
): { check: IntentionalErrorCheck; warnings: string[] } {
  const warnings: string[] = [];
  const ie = resolve(editionDir, "_internal", "intentional-error.json");
  let wrong: string | undefined;
  if (existsSync(ie)) {
    try {
      const parsed = JSON.parse(readFileSync(ie, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("não é um objeto JSON");
      }
      const rec = parsed as { wrong_value?: unknown; no_error?: unknown };
      if (rec.no_error !== true && typeof rec.wrong_value === "string") wrong = rec.wrong_value;
      // #10293: placeholder vira `no_wrong_value` (não há o que procurar no e-mail),
      // mas NÃO é decisão editorial como `no_error: true` — é o gabarito que o gate
      // deixou passar sem preencher. Sem este aviso a edição saía sem gabarito, calada.
      if (wrong !== undefined && isIntentionalErrorPlaceholder(wrong.trim())) {
        warnings.push(
          `${ie}: wrong_value ainda é placeholder (${JSON.stringify(wrong)}) — gabarito do erro intencional ` +
            "não declarado; checagem desligada (#10293)",
        );
      }
    } catch (e) {
      warnings.push(
        `${ie} ilegível (${(e as Error).message}) — checagem do erro intencional desligada (#10267)`,
      );
    }
  }
  let body: string | undefined;
  if (!existsSync(emailFile)) {
    warnings.push(`--email-file ${emailFile} não existe — checagem do erro intencional desligada (#10267)`);
  } else {
    try {
      body = readFileSync(emailFile, "utf8");
    } catch (e) {
      warnings.push(
        `--email-file ${emailFile} ilegível (${(e as Error).message}) — checagem do erro intencional desligada (#10267)`,
      );
    }
  }
  return { check: checkIntentionalErrorInEmail(body, wrong), warnings };
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
    let intentionalErrorCheck: IntentionalErrorCheck | undefined;
    if (args["email-file"]) {
      const res = checkEditionEmail(editionDir, args["email-file"]);
      intentionalErrorCheck = res.check;
      for (const w of res.warnings) {
        console.error(`record-kit-review: WARN ${w}`);
        logEvent({
          edition: basename(resolve(editionDir)),
          stage: 5,
          agent: "record-kit-review",
          level: "warn",
          message: w,
          details: { intentional_error_check: res.check },
        });
      }
    }
    const r = recordKitReview(editionDir, {
      status: args.status,
      attempts: args.attempts !== undefined ? Number(args.attempts) : undefined,
      reason: args.reason,
      issues,
      intentionalErrorCheck,
    });
    console.log(JSON.stringify({ path: r.path, ...r.record }));
  } catch (e) {
    console.error(`record-kit-review: ${(e as Error).message}`);
    process.exit(1);
  }
}

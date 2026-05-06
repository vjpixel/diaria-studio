#!/usr/bin/env npx tsx
/**
 * lint-test-email.ts (#603)
 *
 * Roda lints determinísticos sobre o email de teste renderizado da Beehiiv:
 *   - Check 8: version-consistency intra-destaque (V\d+, GPT-X, etc.)
 *   - Check 9: semantic-drift email vs 02-reviewed.md (números, datas)
 *
 * Cada detecção é cross-referenciada com `data/intentional-errors.jsonl` —
 * matches viram `info` (erro intencional do concurso mensal); sem match viram
 * `blocker`.
 *
 * Substitui as instruções textuais que o agent `review-test-email` (Haiku)
 * recebia. Determinístico = não depende de modelo seguir prompt (#588, #602).
 *
 * Uso:
 *   npx tsx scripts/lint-test-email.ts \
 *     --email-file /tmp/test-email.txt \
 *     --source-md data/editions/260506/02-reviewed.md \
 *     --edition 260506 \
 *     [--intentional-errors data/intentional-errors.jsonl] \
 *     [--out /tmp/lint-result.json]
 *
 * Output (JSON em stdout ou no arquivo --out):
 *   {
 *     "issues": [
 *       { "type": "blocker", "category": "version_inconsistency",
 *         "destaque": "DESTAQUE 2", "detail": "...", "source_md_value": "..." },
 *       { "type": "info", "category": "intentional_error_confirmed",
 *         "destaque": "DESTAQUE 2", "detail": "..." }
 *     ]
 *   }
 *
 * Exit codes:
 *   0 — sem blockers (warns/infos OK)
 *   1 — pelo menos 1 blocker (caller pode bloquear publicação)
 *   2 — erro de uso (args inválidos, paths não existem)
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import {
  extractVersionMentions,
  detectInconsistencies,
} from "./lib/version-consistency.ts";
import { detectDrift } from "./lib/semantic-drift.ts";
import {
  loadIntentionalErrors,
  isIntentionalError,
  type IntentionalError,
} from "./lib/intentional-errors.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type IssueType = "blocker" | "warning" | "info";
export type IssueCategory = "version_inconsistency" | "semantic_drift" | "intentional_error_confirmed";

export interface LintIssue {
  type: IssueType;
  category: IssueCategory;
  destaque: string;
  detail: string;
  source_md_value?: string;
}

export interface LintResult {
  issues: LintIssue[];
  summary: {
    blockers: number;
    warnings: number;
    infos: number;
  };
}

/**
 * Pure: roda os lints sobre email + source e retorna issues classificadas.
 * Cross-referenciada com intentional errors da edição.
 */
export function runLints(
  emailText: string,
  sourceMd: string,
  edition: string,
  intentionalErrors: IntentionalError[],
): LintResult {
  const issues: LintIssue[] = [];

  // Check 8: version consistency intra-destaque (no email).
  // Detectamos no email — divergência V4 vs V5 dentro do mesmo destaque é o caso.
  const emailMentions = extractVersionMentions(emailText);
  const inconsistencies = detectInconsistencies(emailMentions);

  for (const group of inconsistencies) {
    const versions = [...new Set(group.mentions.map((m) => m.version))].sort();
    const detail = `Versões inconsistentes em ${group.destaque}: ${versions.join(" / ")}`;
    const isIntentional = isIntentionalError(
      { error_type: "version_inconsistency", destaque: group.destaque },
      edition,
      intentionalErrors,
    );
    if (isIntentional) {
      issues.push({
        type: "info",
        category: "intentional_error_confirmed",
        destaque: group.destaque,
        detail: `${detail} — feature do concurso mensal (catalogado em intentional-errors.jsonl)`,
      });
    } else {
      // Source value: extrai versão dominante do source MD pra mesmo destaque
      const sourceMentions = extractVersionMentions(sourceMd).filter(
        (m) => m.destaque === group.destaque,
      );
      const sourceVersions = [...new Set(sourceMentions.map((m) => m.version))];
      issues.push({
        type: "blocker",
        category: "version_inconsistency",
        destaque: group.destaque,
        detail,
        source_md_value: sourceVersions.length > 0 ? sourceVersions.join(" / ") : "(nenhuma menção V\\d+ no source)",
      });
    }
  }

  // Check 9: semantic drift (email vs source).
  // Detecções cross-referenciadas com `numeric` / `factual` intentional errors.
  const drifts = detectDrift(emailText, sourceMd);
  // Agrupa drifts por destaque pra gerar 1 issue por destaque (em vez de 1 por valor).
  const driftsByDestaque = new Map<string, typeof drifts>();
  for (const d of drifts) {
    const arr = driftsByDestaque.get(d.destaque) ?? [];
    arr.push(d);
    driftsByDestaque.set(d.destaque, arr);
  }

  for (const [destaque, group] of driftsByDestaque) {
    const onlyEmail = group.filter((d) => d.side === "email");
    const onlySource = group.filter((d) => d.side === "source");
    if (onlyEmail.length === 0 && onlySource.length === 0) continue;

    const parts: string[] = [];
    if (onlyEmail.length > 0) {
      parts.push(`email-only: ${onlyEmail.map((d) => `${d.kind}=${d.value}`).slice(0, 5).join(", ")}`);
    }
    if (onlySource.length > 0) {
      parts.push(`source-only: ${onlySource.map((d) => `${d.kind}=${d.value}`).slice(0, 5).join(", ")}`);
    }
    const detail = `Drift em ${destaque}: ${parts.join(" / ")}`;

    // Cross-ref: numeric intentional ou factual coberto?
    const isIntentional =
      isIntentionalError(
        { error_type: "numeric", destaque },
        edition,
        intentionalErrors,
      ) ||
      isIntentionalError(
        { error_type: "factual", destaque },
        edition,
        intentionalErrors,
      );

    if (isIntentional) {
      issues.push({
        type: "info",
        category: "intentional_error_confirmed",
        destaque,
        detail: `${detail} — feature do concurso mensal (catalogado em intentional-errors.jsonl)`,
      });
    } else {
      // Drift é warning, não blocker — números novos podem ser legítimos
      // (editor adicionou contexto). Caller decide se bloqueia.
      issues.push({
        type: "warning",
        category: "semantic_drift",
        destaque,
        detail,
      });
    }
  }

  const summary = {
    blockers: issues.filter((i) => i.type === "blocker").length,
    warnings: issues.filter((i) => i.type === "warning").length,
    infos: issues.filter((i) => i.type === "info").length,
  };

  return { issues, summary };
}

function main(): void {
  const { values } = parseCliArgs(process.argv.slice(2));
  const emailFile = values["email-file"];
  const sourceMdPath = values["source-md"];
  const edition = values["edition"];
  const intentionalPath = values["intentional-errors"] ?? "data/intentional-errors.jsonl";
  const outPath = values["out"];

  if (!emailFile || !sourceMdPath || !edition) {
    console.error(
      "Uso: lint-test-email.ts --email-file <path> --source-md <path> --edition <AAMMDD> [--intentional-errors <path>] [--out <path>]",
    );
    process.exit(2);
  }

  const emailAbs = resolve(ROOT, emailFile);
  const sourceAbs = resolve(ROOT, sourceMdPath);
  const intentionalAbs = resolve(ROOT, intentionalPath);

  if (!existsSync(emailAbs)) {
    console.error(`ERRO: email-file não existe: ${emailAbs}`);
    process.exit(2);
  }
  if (!existsSync(sourceAbs)) {
    console.error(`ERRO: source-md não existe: ${sourceAbs}`);
    process.exit(2);
  }

  const emailText = readFileSync(emailAbs, "utf8");
  const sourceMd = readFileSync(sourceAbs, "utf8");
  const intentionalErrors = loadIntentionalErrors(intentionalAbs);

  const result = runLints(emailText, sourceMd, edition, intentionalErrors);
  const json = JSON.stringify(result, null, 2);

  if (outPath) {
    writeFileSync(resolve(ROOT, outPath), json + "\n", "utf8");
  } else {
    console.log(json);
  }

  if (result.summary.blockers > 0) process.exit(1);
  process.exit(0);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}

#!/usr/bin/env npx tsx
/**
 * sync-intentional-error.ts (#754)
 *
 * Lê o frontmatter `intentional_error` de `02-reviewed.md` e sincroniza
 * com `data/intentional-errors.jsonl` (idempotente — só adiciona se a
 * edição ainda não tem entry com source="frontmatter_02_reviewed").
 *
 * Roda em sequência depois do lint `intentional-error-flagged` no
 * publish-newsletter (Stage 4 passo 0). Garante que `lint-test-email`
 * (Stage 4 review-test-email) reconhece o erro intencional declarado.
 *
 * Uso:
 *   npx tsx scripts/sync-intentional-error.ts \
 *     --md data/editions/{AAMMDD}/02-reviewed.md \
 *     --edition {AAMMDD} \
 *     --jsonl data/intentional-errors.jsonl
 *
 * Exit codes:
 *   0 = sync ok (added: bool no stdout)
 *   1 = frontmatter ausente ou incompleto (não deveria acontecer pós-lint)
 *   2 = erro de uso
 */

import { readFileSync, appendFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkIntentionalError } from "./lint-newsletter-md.ts";
import {
  loadIntentionalErrors,
  syncFrontmatterToEntries,
  type IntentionalError,
} from "./lib/intentional-errors.ts";
// #1860: fallback de prosa quando o frontmatter falta.
import { extractIntentionalErrorFromMd } from "./render-erro-intencional.ts";

interface Flags {
  md: string;
  edition: string;
  jsonl: string;
}

function parseArgs(argv: string[]): Flags | null {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  if (!flags.md || !flags.edition || !flags.jsonl) {
    return null;
  }
  return { md: flags.md, edition: flags.edition, jsonl: flags.jsonl };
}

function appendJsonl(path: string, entry: IntentionalError): void {
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify(entry) + "\n";
  if (!existsSync(path)) {
    // Atomic create
    const tmp = path + ".tmp";
    writeFileSync(tmp, line, "utf8");
    renameSync(tmp, path);
  } else {
    appendFileSync(path, line, "utf8");
  }
}

/**
 * #1589: re-escreve o JSONL inteiro a partir do array `entries`. Usado quando
 * uma entry pre-existente foi atualizada (não dá pra fazer in-place edit num
 * append-only JSONL — precisa re-escrever).
 */
function rewriteJsonl(path: string, entries: IntentionalError[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  const tmp = path + ".tmp";
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

function main(): number {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  if (!flags) {
    process.stderr.write(
      "Uso: sync-intentional-error.ts --md <reviewed.md> --edition <AAMMDD> --jsonl <jsonl-path>\n",
    );
    return 2;
  }

  const mdPath = resolve(process.cwd(), flags.md);
  const jsonlPath = resolve(process.cwd(), flags.jsonl);

  const lintResult = checkIntentionalError(mdPath);
  if (!lintResult.ok || !lintResult.parsed) {
    // #1860: frontmatter ausente/incompleto (publicação manual, ou erro
    // declarado só na prosa "Nessa edição, …"). Em vez de falhar — o que
    // deixa um buraco no JSONL e faz o reveal da próxima edição pular a
    // edição certa (#1854) — extrair da prosa e gravar com source="prose_block".
    const md = readFileSync(mdPath, "utf8");
    const prose = extractIntentionalErrorFromMd(md);
    if (prose) {
      const existing = loadIntentionalErrors(jsonlPath);
      if (existing.some((e) => e.edition === flags.edition)) {
        process.stderr.write(
          `[sync-intentional-error] edição ${flags.edition} já tem entry — no-op (fallback prosa)\n`,
        );
        process.stdout.write(
          JSON.stringify({ added: false, updated: false, edition: flags.edition, source: "prose_block" }, null, 2) + "\n",
        );
        return 0;
      }
      const entry: IntentionalError = {
        edition: flags.edition,
        error_type: "editor_declared",
        is_feature: true,
        detail: prose.detail ?? prose.narrative,
        ...(prose.correct_value ? { correct_value: prose.correct_value } : {}),
        source: "prose_block",
        detected_by: "sync-intentional-error.ts fallback de prosa (#1860)",
        resolution: "published_intentionally",
      };
      appendJsonl(jsonlPath, entry);
      process.stderr.write(
        `[sync-intentional-error] #1860: frontmatter ausente — entry extraída da PROSA "Nessa edição, …" pra ${flags.edition}. ` +
          `Declare intentional_error no frontmatter pra silenciar este fallback.\n`,
      );
      process.stdout.write(
        JSON.stringify({ added: true, updated: false, edition: flags.edition, source: "prose_block" }, null, 2) + "\n",
      );
      return 0;
    }
    process.stderr.write(
      `Frontmatter intentional_error ausente E sem prosa "Nessa edição, …" em ${flags.md}: ${lintResult.label}\n`,
    );
    return 1;
  }

  const existing = loadIntentionalErrors(jsonlPath);
  const { added, updated, entries } = syncFrontmatterToEntries(
    lintResult.parsed,
    flags.edition,
    existing,
  );

  if (added) {
    const newEntry = entries[entries.length - 1];
    appendJsonl(jsonlPath, newEntry);
    process.stderr.write(
      `[sync-intentional-error] entry adicionada pra edição ${flags.edition} (category: ${newEntry.error_type})\n`,
    );
  } else if (updated) {
    // #1589: entry pre-existente divergiu do frontmatter — re-escreve o JSONL
    // inteiro com a versão atualizada. MD é fonte autoritativa.
    rewriteJsonl(jsonlPath, entries);
    process.stderr.write(
      `[sync-intentional-error] entry atualizada pra edição ${flags.edition} (frontmatter divergia do JSONL)\n`,
    );
  } else {
    process.stderr.write(
      `[sync-intentional-error] edição ${flags.edition} já tem entry de frontmatter (bate) — no-op\n`,
    );
  }

  process.stdout.write(
    JSON.stringify({ added, updated, edition: flags.edition }, null, 2) + "\n",
  );
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  process.exit(main());
}

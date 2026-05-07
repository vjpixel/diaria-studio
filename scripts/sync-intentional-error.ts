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
    process.stderr.write(
      `Frontmatter intentional_error ausente ou incompleto em ${flags.md}: ${lintResult.label}\n`,
    );
    return 1;
  }

  const existing = loadIntentionalErrors(jsonlPath);
  const { added, entries } = syncFrontmatterToEntries(
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
  } else {
    process.stderr.write(
      `[sync-intentional-error] edição ${flags.edition} já tem entry de frontmatter — no-op\n`,
    );
  }

  process.stdout.write(
    JSON.stringify({ added, edition: flags.edition }, null, 2) + "\n",
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

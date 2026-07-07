#!/usr/bin/env tsx
/**
 * reconcile-intentional-errors.ts (#1589)
 *
 * One-off cleanup: varre edições publicadas em `data/editions/{AAMMDD}/02-reviewed.md`,
 * extrai `intentional_error` do frontmatter, compara com a entry correspondente
 * em `data/intentional-errors.jsonl`, e reporta drift. Com `--fix`, sobrescreve
 * o JSONL com a versão do frontmatter (MD = source of truth, #1589).
 *
 * Uso:
 *   # Dry-run — só reporta drift:
 *   npx tsx scripts/reconcile-intentional-errors.ts
 *
 *   # Aplica fix (re-escreve JSONL):
 *   npx tsx scripts/reconcile-intentional-errors.ts --fix
 *
 *   # Filtrar por edição:
 *   npx tsx scripts/reconcile-intentional-errors.ts --edition 260528
 *
 * Exit codes:
 *   0 — sem drift OU --fix aplicado com sucesso
 *   1 — drift detectado em modo dry-run (CI gate)
 *   2 — erro de I/O
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts"; // #2463/#3025: layout flat+nested
import {
  loadIntentionalErrors,
  entryDiffersFromFrontmatter,
  frontmatterToEntry,
  type IntentionalError,
} from "./lib/intentional-errors.ts";
import { checkIntentionalError } from "./lint-newsletter-md.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CliArgs {
  fix: boolean;
  editionFilter?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { fix: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fix") out.fix = true;
    else if (a === "--edition" && argv[i + 1]) {
      out.editionFilter = argv[i + 1];
      i++;
    }
  }
  return out;
}

interface DriftEntry {
  edition: string;
  jsonlEntry?: IntentionalError;
  frontmatterEntry: IntentionalError;
}

function scan(args: CliArgs): {
  drift: DriftEntry[];
  totalScanned: number;
  jsonlPath: string;
  rebuiltEntries: IntentionalError[];
} {
  const editionsDir = resolve(ROOT, "data", "editions");
  const jsonlPath = resolve(ROOT, "data", "intentional-errors.jsonl");
  if (!existsSync(editionsDir)) {
    console.error(`Editions dir não encontrado: ${editionsDir}`);
    process.exit(2);
  }
  const existing = loadIntentionalErrors(jsonlPath);
  // Map edition → existing entry (com source=frontmatter_02_reviewed)
  const byEdition = new Map<string, IntentionalError>();
  for (const e of existing) {
    if (e.source === "frontmatter_02_reviewed") byEdition.set(e.edition, e);
  }
  const drift: DriftEntry[] = [];
  let totalScanned = 0;
  // #2463/#3025: enumera AMBOS os layouts (flat legado + nested novo) — antes
  // um `readdirSync(editionsDir)` direto perdia edições no layout nested
  // pós-#3023.
  const editionDirsByAammdd = enumerateEditionDirs(editionsDir);
  const entries = [...editionDirsByAammdd.keys()].filter((name) => {
    if (args.editionFilter && name !== args.editionFilter) return false;
    return true;
  });
  for (const editionId of entries) {
    const mdPath = join(editionDirsByAammdd.get(editionId)!, "02-reviewed.md");
    if (!existsSync(mdPath)) continue;
    totalScanned++;
    const lint = checkIntentionalError(mdPath);
    if (!lint.ok) continue; // frontmatter ausente/inválido — skip

    // #2037 fix 3: `intentional_error: none` → lint.ok=true, lint.parsed=undefined.
    // Antes deste fix, `!lint.parsed` causava `continue` silencioso, deixando
    // entries sentinela pré-#2016 sem remediar. Agora: se JSONL não tem entry
    // no_error=true pra esta edição → detectar drift e (com --fix) sobrescrever
    // com entry no_error.
    if (lint.no_error) {
      const jsonlEntry = byEdition.get(editionId);
      if (jsonlEntry && !jsonlEntry.no_error) {
        const noErrorEntry: IntentionalError = {
          edition: editionId,
          error_type: "none",
          is_feature: false,
          no_error: true,
          source: "frontmatter_02_reviewed",
          detected_by: "reconcile-intentional-errors.ts no_error (#2037)",
          resolution: "no_error_declared",
        };
        drift.push({ edition: editionId, jsonlEntry, frontmatterEntry: noErrorEntry });
      }
      // no entry in JSONL at all → não há drift estruturado a corrigir aqui
      // (sync-intentional-error deve ser rodado explicitamente)
      continue;
    }

    if (!lint.parsed) continue; // não deveria acontecer, mas guarda contra shapes futuras
    const fmEntry = frontmatterToEntry(lint.parsed, editionId);
    const jsonlEntry = byEdition.get(editionId);
    if (!jsonlEntry) {
      drift.push({ edition: editionId, frontmatterEntry: fmEntry });
      continue;
    }
    if (entryDiffersFromFrontmatter(jsonlEntry, lint.parsed)) {
      drift.push({ edition: editionId, jsonlEntry, frontmatterEntry: fmEntry });
    }
  }
  // Reconstruct entries with fixes applied
  const rebuiltEntries = existing.map((e) => {
    if (e.source !== "frontmatter_02_reviewed") return e;
    const driftFix = drift.find((d) => d.edition === e.edition && d.jsonlEntry);
    return driftFix ? driftFix.frontmatterEntry : e;
  });
  // Append drift entries that weren't in JSONL
  for (const d of drift) {
    if (!d.jsonlEntry) rebuiltEntries.push(d.frontmatterEntry);
  }
  return { drift, totalScanned, jsonlPath, rebuiltEntries };
}

function reportDrift(drift: DriftEntry[]): void {
  for (const d of drift) {
    console.log(`\n[${d.edition}]`);
    if (!d.jsonlEntry) {
      console.log(`  + JSONL missing entry (frontmatter says: ${d.frontmatterEntry.detail?.slice(0, 80)}…)`);
      continue;
    }
    const fields: Array<keyof IntentionalError> = [
      "error_type",
      "destaque",
      "detail",
      "correct_value",
    ];
    for (const f of fields) {
      const j = String(d.jsonlEntry[f] ?? "");
      const m = String(d.frontmatterEntry[f] ?? "");
      if (j !== m) {
        console.log(`  ${f}:`);
        console.log(`    jsonl: ${j.slice(0, 80)}`);
        console.log(`    md   : ${m.slice(0, 80)}`);
      }
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = scan(args);
  console.log(`Scanned ${result.totalScanned} edições. Drift: ${result.drift.length}`);
  if (result.drift.length === 0) {
    console.log("Sem drift detectado.");
    return;
  }
  reportDrift(result.drift);
  if (!args.fix) {
    console.log("\nRodar com --fix pra sobrescrever JSONL com versão do frontmatter.");
    process.exit(1);
  }
  // Apply fix
  const body =
    result.rebuiltEntries.map((e) => JSON.stringify(e)).join("\n") +
    (result.rebuiltEntries.length ? "\n" : "");
  writeFileSync(result.jsonlPath, body, "utf8");
  console.log(`\n✓ ${result.jsonlPath} re-escrito com ${result.drift.length} fix(es).`);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  try {
    main();
  } catch (e) {
    console.error("Fatal:", e);
    process.exit(2);
  }
}

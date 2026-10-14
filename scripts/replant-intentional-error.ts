#!/usr/bin/env tsx
/**
 * scripts/replant-intentional-error.ts (#10176)
 *
 * Stage 4: replanta o erro intencional quando o item que o carregava saiu do
 * `02-reviewed.md` no gate (poda, movimento, retirada pelo editor — edição
 * 261014). Antes isso era à mão em 3 lugares (`_internal/intentional-error.json`,
 * `data/intentional-errors.jsonl`, narrativa "Nessa edição, …" no MD) e
 * `propose-intentional-error-candidate.ts` podia devolver `candidate: null`.
 *
 * Fluxo: propõe o próximo candidato plantável do MD ATUAL (mesmo catálogo e
 * filtro de repetição do #9101 — a entry antiga desta edição não conta como
 * histórico) → troca a menção no MD → reescreve a linha "Nessa edição, …" →
 * grava o JSON → sincroniza a entry da edição no JSONL → valida
 * `intentional-error-present-in-final` e `intentional-error-not-recent-repeat`.
 * Qualquer violação `error` desfaz tudo (nada gravado) e sai com exit 1.
 *
 * Uso: npx tsx scripts/replant-intentional-error.ts --edition-dir data/editions/AAMMDD/ [--jsonl path] [--dry-run]
 * Stdout: JSON `{ action: "replanted"|"no_candidate"|"invalid", ... }`.
 * Exit: 0 = replantado (ou dry-run ok); 1 = sem candidato / validação falhou; 2 = uso inválido.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { listIntentionalErrorCandidates } from "./lib/propose-intentional-error-candidate.ts";
import {
  intentionalErrorJsonPath,
  loadIntentionalErrors,
  syncFrontmatterToEntries,
  writeIntentionalErrorJson,
} from "./lib/intentional-errors.ts";
import { intentionalErrorsJsonlPathForEditionDir } from "./lib/intentional-error-repeat.ts";
import { buildCurrentNarrative, plantIntentionalError } from "./lib/plant-intentional-error.ts";
import { checkIntentionalErrorNotRecentRepeat } from "./lib/intentional-error-repeat.ts";
import { checkIntentionalErrorPresentInFinal } from "./lib/invariant-checks/stage-4.ts";
import type { IntentionalError, IntentionalErrorJson } from "./lib/intentional-errors.ts";

/** Linha da declaração corrente ("Nessa edição, …" — frase única até o 1º ponto final da linha). */
const CURRENT_NARRATIVE_LINE_RE = /^Nessa edição,.*$/m;

function writeJsonlAtomic(path: string, entries: IntentionalError[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  const tmp = path + ".tmp";
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const values = parseArgs(argv);
  const dryRun = values["dry-run"] === "true" || argv.includes("--dry-run");
  const editionDirArg = values["edition-dir"]?.replace(/[\\/]+$/, "");
  if (!editionDirArg) {
    console.error("Uso: npx tsx scripts/replant-intentional-error.ts --edition-dir data/editions/AAMMDD/ [--dry-run]");
    return 2;
  }
  const editionDir = resolve(editionDirArg);
  const mdPath = join(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) {
    console.error(`replant-intentional-error: ${mdPath} não existe`);
    return 2;
  }
  const jsonPath = intentionalErrorJsonPath(editionDir);
  const edition = basename(editionDir);
  const jsonlPath = values["jsonl"] ?? intentionalErrorsJsonlPathForEditionDir(editionDir);
  const history = jsonlPath ? loadIntentionalErrors(jsonlPath) : [];
  const md = readFileSync(mdPath, "utf8");
  if (!CURRENT_NARRATIVE_LINE_RE.test(md)) {
    console.log(JSON.stringify({ action: "no_narrative_line" }));
    console.error(`replant-intentional-error: linha "Nessa edição, …" ausente em ${mdPath} — rode render-erro-intencional.ts antes.`);
    return 1;
  }

  const tried: string[] = [];
  const invalid: string[] = [];
  for (const c of listIntentionalErrorCandidates(md, { history, edition })) {
    tried.push(c.location);
    const planted = plantIntentionalError(md, c);
    if (!planted) continue;
    const newMd = planted.md.replace(CURRENT_NARRATIVE_LINE_RE, () => buildCurrentNarrative(planted.section));
    // Record só do candidato: campos do record antigo (reveal etc.) descreveriam o erro velho.
    const record: IntentionalErrorJson = { ...c };
    const prevJsonRaw = existsSync(jsonPath) ? readFileSync(jsonPath, "utf8") : null;
    const restore = (): void => {
      writeFileSync(mdPath, md, "utf8");
      if (prevJsonRaw === null) rmSync(jsonPath, { force: true });
      else writeFileSync(jsonPath, prevJsonRaw, "utf8");
    };
    // Valida sobre os arquivos reais (grava, checa, desfaz se falhar); dry-run sempre desfaz.
    let violations: string[] = [];
    try {
      writeFileSync(mdPath, newMd, "utf8");
      writeIntentionalErrorJson(jsonPath, record);
      violations = [
        ...checkIntentionalErrorPresentInFinal(editionDir),
        ...checkIntentionalErrorNotRecentRepeat(editionDir, { history }),
      ]
        .filter((v) => v.severity === "error")
        .map((v) => v.message);
    } catch (err) {
      restore();
      throw err;
    }
    if (violations.length > 0 || dryRun) {
      restore();
      if (violations.length > 0) {
        invalid.push(...violations);
        continue;
      }
      console.log(JSON.stringify({ action: "replanted", dry_run: true, validated: true, section: planted.section, candidate: c }, null, 2));
      return 0;
    }
    let jsonlSynced = false;
    if (jsonlPath) {
      // Substitui TODA entry desta edição (qualquer `source`), sem deixar o erro velho no histórico.
      const others = history.filter((e) => e.edition !== edition);
      const synced = syncFrontmatterToEntries(record, edition, others);
      writeJsonlAtomic(jsonlPath, synced.entries);
      jsonlSynced = true;
    } else {
      console.error("replant-intentional-error: JSONL não resolvido — data/intentional-errors.jsonl NÃO sincronizado.");
    }
    console.log(JSON.stringify({ action: "replanted", dry_run: false, jsonl_synced: jsonlSynced, section: planted.section, candidate: c }, null, 2));
    return 0;
  }
  if (invalid.length > 0) {
    console.log(JSON.stringify({ action: "invalid", violations: invalid, tried }));
    return 1;
  }
  console.log(JSON.stringify({ action: "no_candidate", tried }));
  console.error(
    "replant-intentional-error: nenhuma menção plantável do catálogo #5742 em seção secundária — " +
      "replante à mão ou declare {\"no_error\": true} em _internal/intentional-error.json.",
  );
  return 1;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}

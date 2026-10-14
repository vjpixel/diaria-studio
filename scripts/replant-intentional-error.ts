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
 * Uso: npx tsx scripts/replant-intentional-error.ts --edition-dir data/editions/AAMMDD/ [--jsonl path] [--edition AAMMDD] [--dry-run]
 * Stdout: JSON `{ action: "replanted"|"no_candidate"|"invalid", ... }`.
 * Exit: 0 = replantado (ou dry-run ok); 1 = sem candidato / validação falhou; 2 = uso inválido.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { listIntentionalErrorCandidates } from "./lib/propose-intentional-error-candidate.ts";
import {
  intentionalErrorJsonPath,
  loadIntentionalErrorJson,
  loadIntentionalErrors,
  syncFrontmatterToEntries,
  writeIntentionalErrorJson,
} from "./lib/intentional-errors.ts";
import { intentionalErrorsJsonlPathForEditionDir } from "./lib/intentional-error-repeat.ts";
import { buildCurrentNarrative, plantIntentionalError } from "./lib/plant-intentional-error.ts";
import { checkIntentionalErrorNotRecentRepeat } from "./lib/intentional-error-repeat.ts";
import { checkIntentionalErrorPresentInFinal } from "./lib/invariant-checks/stage-4.ts";
import type { IntentionalError } from "./lib/intentional-errors.ts";

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
  const existing = loadIntentionalErrorJson(jsonPath);
  const edition = values["edition"] ?? basename(editionDir);
  const jsonlPath = values["jsonl"] ?? intentionalErrorsJsonlPathForEditionDir(editionDir);
  const history = jsonlPath ? loadIntentionalErrors(jsonlPath) : [];
  const md = readFileSync(mdPath, "utf8");
  if (!CURRENT_NARRATIVE_LINE_RE.test(md)) {
    console.log(JSON.stringify({ action: "no_narrative_line" }));
    console.error(`replant-intentional-error: linha "Nessa edição, …" ausente em ${mdPath} — rode render-erro-intencional.ts antes.`);
    return 1;
  }

  const tried: string[] = [];
  for (const c of listIntentionalErrorCandidates(md, { history, edition })) {
    tried.push(c.location);
    const planted = plantIntentionalError(md, c);
    if (!planted) continue;
    const newMd = planted.md.replace(CURRENT_NARRATIVE_LINE_RE, () => buildCurrentNarrative(planted.section));
    const record = { ...(existing ?? {}), ...c };
    delete (record as Record<string, unknown>).no_error;

    // Valida no estado FINAL antes de gravar: MD novo + JSON novo num diretório
    // não é possível sem escrever, então valida sobre os arquivos e desfaz se falhar.
    const prevJson = existing;
    if (!dryRun) {
      writeFileSync(mdPath, newMd, "utf8");
      writeIntentionalErrorJson(jsonPath, record);
    }
    const violations = dryRun
      ? []
      : [
          ...checkIntentionalErrorPresentInFinal(editionDir),
          ...checkIntentionalErrorNotRecentRepeat(editionDir, { history }),
        ].filter((v) => v.severity === "error");
    if (violations.length > 0) {
      writeFileSync(mdPath, md, "utf8");
      if (prevJson) writeIntentionalErrorJson(jsonPath, prevJson);
      console.log(JSON.stringify({ action: "invalid", violations: violations.map((v) => v.message) }));
      return 1;
    }
    if (!dryRun && jsonlPath) {
      const synced = syncFrontmatterToEntries(record, edition, history);
      if (synced.added || synced.updated) writeJsonlAtomic(jsonlPath, synced.entries);
    }
    console.log(JSON.stringify({ action: "replanted", dry_run: !!dryRun, section: planted.section, candidate: c }, null, 2));
    return 0;
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

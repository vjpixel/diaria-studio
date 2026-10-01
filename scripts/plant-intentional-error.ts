#!/usr/bin/env tsx
/**
 * scripts/plant-intentional-error.ts (#9255)
 *
 * Stage 2: planta o erro intencional de forma determinística quando
 * `_internal/intentional-error.json` ainda está em `{PREENCHER}` — roda logo
 * após `render-erro-intencional.ts`. Decisão do editor (261001, opção a): o
 * Stage 2 headless SEMPRE propõe e planta (padrão #5742); o placeholder
 * continua gate-blocking no sentinel, este script é quem garante que ele não sobre.
 *
 * Fluxo: `proposeIntentionalErrorCandidate` (#8592, + filtro de repetição
 * #9101) → troca a menção em `02-reviewed.md` → preenche
 * `Nessa edição, {PREENCHER_NARRATIVA_DO_ERRO}.` → grava o JSON com os 6 campos.
 *
 * Idempotente: JSON já preenchido (editor declarou, ou rerun) → no-op.
 *
 * Uso: npx tsx scripts/plant-intentional-error.ts --edition-dir data/editions/AAMMDD/ [--jsonl path] [--edition AAMMDD]
 * Stdout: JSON `{ action: "planted"|"already_filled"|"no_candidate", ... }`.
 * Exit: 0 = planted/already_filled; 1 = no_candidate | no_placeholder (nada plantável — o
 * placeholder fica e o sentinel barra; o orchestrator escreve à mão);
 * 2 = uso inválido / arquivo ausente.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { listIntentionalErrorCandidates } from "./lib/propose-intentional-error-candidate.ts";
import {
  intentionalErrorJsonPath,
  loadIntentionalErrorJson,
  loadIntentionalErrors,
  writeIntentionalErrorJson,
} from "./lib/intentional-errors.ts";
import { intentionalErrorsJsonlPathForEditionDir } from "./lib/intentional-error-repeat.ts";
import { NARRATIVE_PLACEHOLDER, plantIntentionalError } from "./lib/plant-intentional-error.ts";
import type { IntentionalErrorCandidate } from "./lib/propose-intentional-error-candidate.ts";

const REQUIRED = ["description", "location", "category", "correct_value", "reveal"] as const;

function isFilled(record: Record<string, unknown> | null): boolean {
  if (!record) return false;
  if (record.no_error === true) return true;
  return REQUIRED.every((k) => {
    const v = record[k];
    return typeof v === "string" && v.trim().length > 0 && !/^\{PREENCHER/i.test(v.trim());
  });
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const values = parseArgs(argv);
  const editionDirArg = values["edition-dir"]?.replace(/[\\/]+$/, "");
  if (!editionDirArg) {
    console.error("Uso: npx tsx scripts/plant-intentional-error.ts --edition-dir data/editions/AAMMDD/");
    return 2;
  }
  const editionDir = resolve(editionDirArg);
  const mdPath = join(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) {
    console.error(`plant-intentional-error: ${mdPath} não existe`);
    return 2;
  }
  const jsonPath = intentionalErrorJsonPath(editionDir);
  const existing = loadIntentionalErrorJson(jsonPath) as Record<string, unknown> | null;
  if (isFilled(existing)) {
    console.log(JSON.stringify({ action: "already_filled", json: jsonPath }));
    return 0;
  }

  const md = readFileSync(mdPath, "utf8");
  if (!md.includes(NARRATIVE_PLACEHOLDER)) {
    // Sem a linha "Nessa edição, {PREENCHER_…}." não há onde declarar o erro:
    // plantar só o valor deixaria JSON e texto sem narrativa — não grava nada.
    console.log(JSON.stringify({ action: "no_placeholder" }));
    console.error(`plant-intentional-error: ${NARRATIVE_PLACEHOLDER} ausente em ${mdPath} — rode render-erro-intencional.ts antes.`);
    return 1;
  }
  const jsonlPath = values["jsonl"] ?? intentionalErrorsJsonlPathForEditionDir(editionDir);
  const edition = values["edition"] ?? basename(editionDir);
  // Tenta os candidatos em ordem de preferência: o 1º pode não ser plantável
  // (menção só em URL / fora da seção pelo rastreio de linha) — #9255 review.
  let candidate: IntentionalErrorCandidate | null = null;
  let planted: ReturnType<typeof plantIntentionalError> = null;
  const tried: string[] = [];
  for (const c of listIntentionalErrorCandidates(md, {
    history: jsonlPath ? loadIntentionalErrors(jsonlPath) : [],
    edition,
  })) {
    tried.push(c.location);
    planted = plantIntentionalError(md, c);
    if (planted) {
      candidate = c;
      break;
    }
  }
  if (!candidate || !planted) {
    console.log(JSON.stringify({ action: "no_candidate", tried }));
    console.error(
      "plant-intentional-error: nenhuma menção plantável do catálogo #5742 em seção secundária — " +
        "monte o erro à mão (orchestrator-stage-2.md §Filtro de segurança) e preencha o JSON + a linha 'Nessa edição, …'.",
    );
    return 1;
  }

  writeFileSync(mdPath, planted.md, "utf8");
  writeIntentionalErrorJson(jsonPath, { ...(existing ?? {}), ...candidate });
  console.log(JSON.stringify({ action: "planted", section: planted.section, candidate }, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}

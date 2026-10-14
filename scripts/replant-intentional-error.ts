#!/usr/bin/env tsx
/**
 * scripts/replant-intentional-error.ts (#10176, #10213)
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
 * valida `intentional-error-present-in-final` e `intentional-error-not-recent-repeat`
 * → grava MD + JSON + JSONL num lote verificado (`writeFilesVerified`, #9173).
 *
 * Garantias (#10213):
 *   - A validação roda sobre uma CÓPIA em diretório temporário do SO (fora de
 *     `data/`), nunca sobre os arquivos reais: `--dry-run` não toca em nada e
 *     um processo morto no meio não deixa estado intermediário pro OneDrive
 *     sincronizar.
 *   - Antes de gravar, relê `02-reviewed.md`; se mudou desde a leitura (save do
 *     editor pelo Studio na janela), aborta sem gravar (#495/#7401).
 *   - O JSONL é reescrito a partir do TEXTO CRU — só as linhas desta edição são
 *     trocadas; linhas corrompidas/sem `edition` são preservadas. JSONL que
 *     existe mas não pode ser lido aborta (nunca reescreve a partir de `[]`).
 *   - Se o `wrong_value` do erro ANTIGO ainda aparece no MD (item só movido),
 *     recusa: replantar deixaria a edição com dois erros e só um declarado.
 *
 * Uso: npx tsx scripts/replant-intentional-error.ts --edition-dir data/editions/AAMMDD/ [--jsonl path] [--dry-run]
 * Stdout: JSON `{ action: "replanted"|"no_candidate"|"invalid"|"old_error_still_present"|"md_changed"|..., ... }`.
 * Exit: 0 = replantado (ou dry-run ok); 1 = sem candidato / validação falhou / recusa; 2 = uso inválido.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { listIntentionalErrorCandidates } from "./lib/propose-intentional-error-candidate.ts";
import {
  frontmatterToEntry,
  intentionalErrorJsonPath,
  loadIntentionalErrorJson,
  readIntentionalErrorsJsonlStrict,
  replaceEditionInJsonlRaw,
} from "./lib/intentional-errors.ts";
import { intentionalErrorsJsonlPathForEditionDir } from "./lib/intentional-error-repeat.ts";
import { buildCurrentNarrative, plantIntentionalError } from "./lib/plant-intentional-error.ts";
import { checkIntentionalErrorNotRecentRepeat } from "./lib/intentional-error-repeat.ts";
import { checkIntentionalErrorPresentInFinal } from "./lib/invariant-checks/stage-4.ts";
import { writeFilesVerified, type VerifiedWrite } from "./lib/write-files-verified.ts";
import type { IntentionalError, IntentionalErrorJson } from "./lib/intentional-errors.ts";

/** Linha da declaração corrente ("Nessa edição, …" — frase única até o 1º ponto final da linha). */
const CURRENT_NARRATIVE_LINE_RE = /^Nessa edição,.*$/m;

function jsonRecordBody(record: IntentionalErrorJson): string {
  // Mesmo formato de `writeIntentionalErrorJson`.
  return JSON.stringify(record, null, 2) + "\n";
}

/**
 * (#10213) Valida o candidato numa cópia descartável em `os.tmpdir()` (fora de
 * `data/`), preservando o basename AAMMDD que o check de repetição exige.
 */
function validateInScratch(
  edition: string,
  newMd: string,
  record: IntentionalErrorJson,
  history: IntentionalError[],
): string[] {
  const root = mkdtempSync(join(tmpdir(), "replant-validate-"));
  try {
    const dir = join(root, edition);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), newMd, "utf8");
    writeFileSync(intentionalErrorJsonPath(dir), jsonRecordBody(record), "utf8");
    return [
      ...checkIntentionalErrorPresentInFinal(dir),
      ...checkIntentionalErrorNotRecentRepeat(dir, { history }),
    ]
      .filter((v) => v.severity === "error")
      .map((v) => v.message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

  // (#10213) Leitura estrita: JSONL existente mas ilegível aborta em vez de virar `[]`
  // (histórico vazio desligaria o filtro de repetição e a reescrita apagaria o arquivo).
  let jsonlRaw: string | null = null;
  let history: IntentionalError[] = [];
  if (jsonlPath) {
    try {
      const read = readIntentionalErrorsJsonlStrict(jsonlPath);
      jsonlRaw = read.raw;
      history = read.entries;
      if (read.unparsedLines > 0) {
        console.error(
          `replant-intentional-error: ${read.unparsedLines} linha(s) de ${jsonlPath} não parseiam — ` +
            "ficam de fora do filtro de repetição, mas são preservadas na reescrita.",
        );
      }
    } catch (err) {
      console.log(JSON.stringify({ action: "jsonl_unreadable", jsonl: jsonlPath }));
      console.error(
        `replant-intentional-error: ${jsonlPath} existe mas não pôde ser lido (${(err as Error).message}) — ` +
          "abortando sem gravar nada (reescrever a partir de leitura vazia apagaria o histórico do concurso).",
      );
      return 1;
    }
  }

  const md = readFileSync(mdPath, "utf8");
  if (!CURRENT_NARRATIVE_LINE_RE.test(md)) {
    console.log(JSON.stringify({ action: "no_narrative_line" }));
    console.error(`replant-intentional-error: linha "Nessa edição, …" ausente em ${mdPath} — rode render-erro-intencional.ts antes.`);
    return 1;
  }

  // (#10213) Erro velho ainda no texto (item só movido, não removido) → replantar
  // deixaria a edição com dois erros e só o novo declarado.
  const prevRecord = loadIntentionalErrorJson(jsonPath);
  const oldWrong = (prevRecord?.wrong_value ?? "").trim();
  if (prevRecord?.no_error !== true && oldWrong && !/^\{PREENCHER/i.test(oldWrong) && md.includes(oldWrong)) {
    console.log(JSON.stringify({ action: "old_error_still_present", wrong_value: oldWrong }));
    console.error(
      `replant-intentional-error: o erro antigo ("${oldWrong}") ainda aparece em 02-reviewed.md — ` +
        "o item provavelmente só foi movido e não precisa de replantio. Se for mesmo replantar, corrija o erro antigo no texto antes.",
    );
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
    const violations = validateInScratch(edition, newMd, record, history);
    if (violations.length > 0) {
      invalid.push(...violations);
      continue;
    }
    if (dryRun) {
      console.log(JSON.stringify({ action: "replanted", dry_run: true, validated: true, section: planted.section, candidate: c }, null, 2));
      return 0;
    }

    // (#10213) Save do editor na janela entre a leitura e a escrita → não sobrescrever.
    if (readFileSync(mdPath, "utf8") !== md) {
      console.log(JSON.stringify({ action: "md_changed" }));
      console.error("replant-intentional-error: 02-reviewed.md mudou durante a execução (save do editor?) — nada gravado; rode de novo.");
      return 1;
    }

    const writes: VerifiedWrite[] = [
      { path: mdPath, content: newMd },
      { path: jsonPath, content: jsonRecordBody(record) },
    ];
    if (jsonlPath) {
      // Substitui TODA entry desta edição (qualquer `source`), preservando as demais linhas verbatim.
      writes.push({ path: jsonlPath, content: replaceEditionInJsonlRaw(jsonlRaw, edition, frontmatterToEntry(record, edition)) });
    } else {
      console.error("replant-intentional-error: JSONL não resolvido — data/intentional-errors.jsonl NÃO sincronizado.");
    }
    for (const w of writes) mkdirSync(dirname(w.path), { recursive: true });
    writeFilesVerified(writes, "replant-intentional-error");
    console.log(JSON.stringify({ action: "replanted", dry_run: false, jsonl_synced: !!jsonlPath, section: planted.section, candidate: c }, null, 2));
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

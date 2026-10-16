#!/usr/bin/env tsx
/**
 * scripts/propose-intentional-error-candidate.ts (#8592)
 *
 * CLI do gerador determinístico de candidato de erro intencional
 * (`scripts/lib/propose-intentional-error-candidate.ts`). Lê `02-reviewed.md`
 * de uma edição e imprime um candidato pronto pra aceite em 1 clique — ou
 * `candidate: null` quando nenhuma seção secundária menciona uma entidade do
 * catálogo #5742.
 *
 * **Nunca escreve nada em disco.** Só leitura + stdout. Quem decide gravar
 * `_internal/intentional-error.json` (após aceite do editor no gate do
 * Stage 4) é o orchestrator, no chat — este script só monta a proposta.
 *
 * Uso:
 *   npx tsx scripts/propose-intentional-error-candidate.ts --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/propose-intentional-error-candidate.ts --md data/editions/AAMMDD/02-reviewed.md
 *
 * (#9101) Filtro de repetição: lê `data/intentional-errors.jsonl` (override
 * `--jsonl <path>`; ausente = sem filtro; existente mas ilegível = exit 1, #10292) e descarta grafia já usada
 * / entidade usada nos últimos `--window-days` (default 30) antes de `--edition`
 * (default: basename de `--edition-dir`).
 *
 * (#10244) `--list-recent` lista os erros da janela (`{ recent: [...] }`) e
 * `--check-wrong "<grafia>"` devolve `{ repeats: [...] }` — pro Stage 4 consultar
 * ANTES de propor na mão quando `candidate: null`. Não exigem `02-reviewed.md`.
 * (#10269) Esses dois modos leem o JSONL em modo ESTRITO: arquivo existente mas
 * ilegível (ou sem nenhuma linha parseável) sai com exit 1 em vez de responder
 * `{repeats: []}` — que seria lido como "sem repetição". Arquivo ausente = vazio.
 *
 * Stdout: JSON `{ candidate: IntentionalErrorCandidate | null }`.
 * Exit codes: 0 = leu com sucesso (candidato encontrado ou não — ambos são
 * saídas válidas, "sem candidato" não é erro); 1 = histórico ilegível, em
 * qualquer modo (#10269 consultas, #10292 caminho principal); 2 = uso inválido ou arquivo
 * `02-reviewed.md` inexistente.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import { proposeIntentionalErrorCandidate } from "./lib/propose-intentional-error-candidate.ts";
import {
  readIntentionalErrorsHistoryStrict,
  type IntentionalError,
} from "./lib/intentional-errors.ts";
import { intentionalErrorsJsonlPathForEditionDir, listRecentErrors, findRecentRepeats } from "./lib/intentional-error-repeat.ts";

/**
 * (#10269, #10292) Lê o histórico em modo ESTRITO. Devolve `null` (o caller sai
 * com exit 1; a mensagem já foi pro stderr) quando o JSONL existe mas é ilegível
 * (lock do OneDrive, permissão) ou tem linhas e nenhuma parseia — nesses casos
 * `[]` seria lido como "sem repetição na janela" e o Stage 4 proporia um erro
 * repetido. Arquivo ausente, ou `path` nulo (edição fora de `.../editions/`, ex.
 * fixture), = histórico vazio (legítimo em clone novo).
 */
function readHistoryStrict(path: string | null): IntentionalError[] | null {
  // #10344: lógica compartilhada com o planter do Stage 2 e o invariante de repetição.
  const read = readIntentionalErrorsHistoryStrict(path);
  if (!read.ok) {
    console.error(`propose-intentional-error-candidate: ${read.reason}`);
    return null;
  }
  if (read.warning) console.error(`propose-intentional-error-candidate: ${read.warning}`);
  return read.entries;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const values = parseArgs(argv);
  const listRecent = argv.includes("--list-recent");
  const checkWrong = values["check-wrong"];
  if (listRecent || checkWrong) {
    const dir = values["edition-dir"]?.replace(/[\\/]+$/, "");
    const jsonl =
      values["jsonl"] ??
      (dir ? intentionalErrorsJsonlPathForEditionDir(resolve(dir)) : join("data", "intentional-errors.jsonl"));
    const ed = values["edition"] ?? (dir ? basename(resolve(dir)) : "");
    if (!/^\d{6}$/.test(ed)) {
      console.error("propose-intentional-error-candidate: --list-recent/--check-wrong exigem --edition AAMMDD ou --edition-dir");
      return 2;
    }
    const wd = values["window-days"] ? Number(values["window-days"]) : undefined;
    const opts = { windowDays: wd !== undefined && Number.isFinite(wd) && wd >= 1 ? wd : undefined };
    const history = readHistoryStrict(jsonl);
    if (history === null) return 1;
    const out = checkWrong
      ? { repeats: findRecentRepeats({ wrong_value: checkWrong }, history, ed, opts) }
      : { recent: listRecentErrors(history, ed, opts) };
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }
  const mdPath = values["md"] ?? (values["edition-dir"] ? join(values["edition-dir"], "02-reviewed.md") : undefined);

  if (!mdPath) {
    console.error(
      "Uso: npx tsx scripts/propose-intentional-error-candidate.ts --edition-dir data/editions/AAMMDD/ | --md <path>",
    );
    return 2;
  }
  if (!existsSync(mdPath)) {
    console.error(`propose-intentional-error-candidate: ${mdPath} não existe`);
    return 2;
  }

  const md = readFileSync(mdPath, "utf8");
  // #9101 — arquivo ausente = lista vazia = sem filtro; ilegível = exit 1 (#10292).
  const editionDirArg = values["edition-dir"]?.replace(/[\\/]+$/, "");
  // --edition-dir fora de `.../editions/` (fixture) → sem histórico, nunca o `data/` do cwd.
  const jsonlPath =
    values["jsonl"] ??
    (editionDirArg ? intentionalErrorsJsonlPathForEditionDir(resolve(editionDirArg)) : join("data", "intentional-errors.jsonl"));
  const edition = values["edition"] ?? (editionDirArg ? basename(resolve(editionDirArg)) : "");
  if (!/^\d{6}$/.test(edition)) {
    console.error(
      `propose-intentional-error-candidate: edição "${edition}" não é AAMMDD — filtro de janela (#9101) desligado; só grafias já usadas são descartadas. Passe --edition AAMMDD.`,
    );
  }
  const windowDays = values["window-days"] ? Number(values["window-days"]) : undefined;
  // #10292: mesma leitura ESTRITA dos modos de consulta (#10269). O `candidate`
  // não-nulo é apresentado pelo Stage 4 como "já filtrado contra repetição" —
  // histórico ilegível virando `[]` faria o filtro (#9101) passar em branco.
  const history = readHistoryStrict(jsonlPath);
  if (history === null) return 1;
  const candidate = proposeIntentionalErrorCandidate(md, {
    history,
    edition,
    windowDays: windowDays !== undefined && Number.isFinite(windowDays) && windowDays >= 1 ? windowDays : undefined,
  });
  console.log(JSON.stringify({ candidate }, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}

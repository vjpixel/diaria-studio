#!/usr/bin/env node
/**
 * diaria-subscribers-ingest-contest.ts (#7209 residual — sessão develop)
 *
 * Wiring de arquivo/CLI que faltava pro miolo puro de
 * `scripts/lib/contest-poll-ingest.ts` (PR #7364): lê a resposta CONFIRMADA
 * ao concurso "ache o erro, ganhe um número" e grava no store unificado
 * (`diaria-subscribers-db.ts`) como evento `contest_reply`. Mesmo padrão de
 * `diaria-subscribers-build-db.ts`/`diaria-subscribers-ingest-kit.ts`: I/O
 * fino aqui, lógica pura em `scripts/lib/`.
 *
 * ## Fonte VIVA — `data/raffle-numbers.json`
 *
 * Correção de premissa sobre a issue original (ver docstring de
 * `contest-poll-ingest.ts` — "mecanismo LEGADO, removido em #1778"):
 * `data/contest-entries.jsonl` não é mais escrito por nenhum script deste
 * checkout. A fonte viva pós-#2724 é `data/raffle-numbers.json`
 * (`scripts/lib/raffle-numbers.ts`), escrita pelo playbook §0-replies do
 * Stage 0 (`.claude/agents/orchestrator-stage-0-preflight.md`) toda vez que
 * um leitor acerta o erro intencional. Cada `RaffleEntry` = 1 pessoa + 1
 * edição confirmadas — mapeado 1:1 pra `ContestEntryRecord` via
 * `mapRaffleEntryToContestEntry`.
 *
 * ## Fonte histórica opcional — `data/contest-entries.jsonl`
 *
 * Se o arquivo ainda existir em disco (histórico gitignored, decisão de
 * arquivar/apagar ficou com o editor no #1778 — nunca confirmado se foi
 * apagado), este CLI também o lê como backfill de uma-vez. Ausente (caso
 * comum hoje) → simplesmente pulado, sem erro.
 *
 * Idempotente nas duas fontes — `recordEvent` já é `INSERT OR IGNORE` por
 * chave natural (e-mail + edição), então rodar este CLI repetidamente (ex:
 * a cada Stage 0) nunca duplica evento.
 *
 * Uso:
 *   npx tsx scripts/diaria-subscribers-ingest-contest.ts [--db <p>] [--raffle <p>] [--legacy-jsonl <p>]
 *
 * Stdout: JSON summary. Exit 1 se `data/` (junction OneDrive) não existir —
 * mesmo guard de `diaria-subscribers-build-db.ts`.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getArg, isMainModule } from "./lib/cli-args.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb, getStoreCounts } from "./lib/diaria-subscribers-db.ts";
import {
  parseContestEntriesJsonl,
  ingestContestReplies,
  mapRaffleEntryToContestEntry,
  isWellFormedRaffleEntryForContestMap,
  type ContestReplyIngestResult,
} from "./lib/contest-poll-ingest.ts";
import { loadRaffleRegistry } from "./lib/raffle-numbers.ts";

/** `data/raffle-numbers.json` — fonte VIVA (ver docstring do módulo). */
export const DEFAULT_RAFFLE_PATH = resolve(dirname(DEFAULT_DB_PATH), "..", "raffle-numbers.json");

/** `data/contest-entries.jsonl` — fonte histórica opcional (ver docstring). */
export const DEFAULT_LEGACY_JSONL_PATH = resolve(dirname(DEFAULT_DB_PATH), "..", "contest-entries.jsonl");

function mergeResults(a: ContestReplyIngestResult, b: ContestReplyIngestResult): ContestReplyIngestResult {
  return {
    newEvents: a.newEvents + b.newEvents,
    alreadyKnown: a.alreadyKnown + b.alreadyKnown,
    subscribersTouched: a.subscribersTouched + b.subscribersTouched,
    skippedNoEmail: a.skippedNoEmail + b.skippedNoEmail,
  };
}

const ZERO_RESULT: ContestReplyIngestResult = {
  newEvents: 0,
  alreadyKnown: 0,
  subscribersTouched: 0,
  skippedNoEmail: 0,
};

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const rafflePath = getArg(argv, "raffle") || DEFAULT_RAFFLE_PATH;
  const legacyJsonlPath = getArg(argv, "legacy-jsonl") || DEFAULT_LEGACY_JSONL_PATH;

  const dbDir = dirname(dbPath);
  const dataRoot = dirname(dbDir); // data/
  if (!existsSync(dataRoot)) {
    console.error(`❌ data/ não existe: ${dataRoot} (ver CLAUDE.md setup, passo 2b)`);
    process.exitCode = 1;
    return;
  }
  if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

  const db = openDiariaSubscribersDb(dbPath);
  try {
    const now = new Date().toISOString();

    // -------------------------------------------------------------------------
    // Fonte VIVA: data/raffle-numbers.json
    // -------------------------------------------------------------------------
    let raffleEntriesRead = 0;
    let raffleEntriesMalformed = 0;
    let raffleResult = ZERO_RESULT;
    if (existsSync(rafflePath)) {
      // Guard (#7419 fleet review, achado 1): `loadRaffleRegistry` engole
      // QUALQUER falha de JSON.parse e retorna [] — indistinguível de
      // "arquivo existe, genuinamente vazio". `data/` é um junction OneDrive
      // com histórico documentado de conflito de sync (ver
      // onedrive-conflict-backup-durante-edit.md); um JSON corrompido nesse
      // arquivo faria este CLI reportar silenciosamente "0 entradas, 0
      // eventos novos" com exit 0 — perda de dado silenciosa, exatamente a
      // classe de falha que os guards #573/#738 deste repo existem pra
      // prevenir. Lê e valida o parse AQUI, antes de chamar
      // `loadRaffleRegistry`, pra poder distinguir "vazio" de "corrompido".
      const rawRaffle = readFileSync(rafflePath, "utf8");
      if (rawRaffle.trim() !== "") {
        try {
          JSON.parse(rawRaffle);
        } catch (err) {
          console.error(
            `❌ ${rafflePath} existe mas não é JSON válido (${(err as Error).message}) — abortando em vez de ` +
              `tratar como "0 entradas" (conflito de sync do OneDrive é a causa mais provável; ver ` +
              `docs/claude-md-historical-incidents.md ou o registro em memory/onedrive-conflict-backup-durante-edit.md).`,
          );
          process.exitCode = 1;
          return;
        }
      }

      const raffleEntries = loadRaffleRegistry(rafflePath);
      raffleEntriesRead = raffleEntries.length;
      // Guard (#7419 self-review): raffle-numbers.json corrompido à mão fora do
      // caminho normal (allocateRaffleNumber, sempre completo) poderia faltar
      // edition/issued_at — filtrar ANTES do mapeamento em vez de deixar
      // recordEvent lançar contra a coluna ts NOT NULL a meio do loop.
      const wellFormed = raffleEntries.filter(isWellFormedRaffleEntryForContestMap);
      raffleEntriesMalformed = raffleEntries.length - wellFormed.length;
      const mapped = wellFormed.map(mapRaffleEntryToContestEntry);
      raffleResult = ingestContestReplies(db, mapped, now);
      console.error(
        `📇 ${raffleEntriesRead} entrada(s) em ${rafflePath} — ${raffleResult.newEvents} evento(s) novo(s), ` +
          `${raffleResult.alreadyKnown} já conhecido(s)` +
          (raffleEntriesMalformed > 0 ? `, ${raffleEntriesMalformed} malformada(s) ignorada(s)` : "") +
          ".",
      );
    } else {
      console.error(`ℹ️  ${rafflePath} não existe ainda — nenhum acerto de sorteio registrado até agora.`);
    }

    // -------------------------------------------------------------------------
    // Fonte histórica opcional: data/contest-entries.jsonl (legado, #1778)
    // -------------------------------------------------------------------------
    let legacyEntriesRead = 0;
    let legacyEntriesMalformed = 0;
    let legacyResult = ZERO_RESULT;
    const legacyPresent = existsSync(legacyJsonlPath);
    if (legacyPresent) {
      const raw = readFileSync(legacyJsonlPath, "utf8");
      const legacyEntries = parseContestEntriesJsonl(raw);
      legacyEntriesRead = legacyEntries.length;
      // Simetria com `raffle_entries_malformed` acima (#7419 fleet review,
      // achado 3): `parseContestEntriesJsonl` também descarta linha
      // malformada silenciosamente — sem contagem visível isso ficava
      // invisível pro summary. Não é um erro (mesma tolerância documentada
      // na docstring do módulo), só observabilidade.
      const nonEmptyLines = raw.split("\n").filter((line) => line.trim() !== "").length;
      legacyEntriesMalformed = Math.max(0, nonEmptyLines - legacyEntriesRead);
      legacyResult = ingestContestReplies(db, legacyEntries, now);
      console.error(
        `📇 ${legacyEntriesRead} entrada(s) em ${legacyJsonlPath} (legado) — ${legacyResult.newEvents} evento(s) novo(s), ` +
          `${legacyResult.alreadyKnown} já conhecido(s)` +
          (legacyEntriesMalformed > 0 ? `, ${legacyEntriesMalformed} malformada(s) ignorada(s)` : "") +
          ".",
      );
    }
    // Ausência do legado NÃO é logada — é o caminho comum pós-#1778 (arquivo
    // pode nunca ter existido nesta máquina), não uma condição a sinalizar.

    const combined = mergeResults(raffleResult, legacyResult);
    const counts = getStoreCounts(db);

    console.log(
      JSON.stringify(
        {
          db: dbPath,
          raffle_source: rafflePath,
          raffle_entries_read: raffleEntriesRead,
          raffle_entries_malformed: raffleEntriesMalformed,
          legacy_source: legacyPresent ? legacyJsonlPath : null,
          legacy_entries_read: legacyEntriesRead,
          legacy_entries_malformed: legacyEntriesMalformed,
          events_new: combined.newEvents,
          events_already_known: combined.alreadyKnown,
          subscribers_touched: combined.subscribersTouched,
          skipped_no_email: combined.skippedNoEmail,
          store_counts: counts,
        },
        null,
        2,
      ),
    );
  } finally {
    // Achado 2 (#7419 fleet review): sem try/finally, uma exceção no meio
    // do corpo (readFileSync/ingestContestReplies/etc) deixava o handle
    // SQLite/WAL aberto e o summary JSON nunca saía — `db.close()` agora
    // roda sempre, sucesso ou erro (inclusive no early-return do guard de
    // JSON corrompido acima).
    db.close();
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

#!/usr/bin/env tsx
/**
 * check-raffle-month.ts (#11896)
 *
 * Preflight do Stage 0: confere `platform.config.json` → `raffle.sorteio_do_mes`
 * contra a data da edição e avisa ANTES de o Stage 3
 * (`inject-champions-callout.ts`, #4583) parar na 1ª edição do mês. Lógica
 * pura em `scripts/lib/raffle-month-preflight.ts`; o gate "1ª edição do mês"
 * reusa `isFirstEditionOfMonth`/`readPublishedDates` de
 * `fetch-leaderboard-top1.ts` (mesma fonte que o inject usa).
 *
 * Nunca bloqueia: sai 0 com o veredito em JSON no stdout; quem decide o que
 * fazer é `scripts/stage-0-run.ts` (passo 0p): `upcoming-month-stale` vira
 * nota + warn no run-log, `current-month-stale` vira `pendingHumanDecision`
 * pedindo o dia do sorteio ao editor.
 *
 * Uso:
 *   npx tsx scripts/check-raffle-month.ts --edition AAMMDD \
 *     [--platform-config platform.config.json] \
 *     [--past-editions data/past-editions-raw.json] [--lead-days 5]
 *
 * Exit codes:
 *   0  veredito emitido (inclusive avisos)
 *   2  argumento inválido
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { isFirstEditionOfMonth, readPublishedDates } from "./fetch-leaderboard-top1.ts";
import {
  assessRaffleMonth,
  describeRaffleMonthVerdict,
  DEFAULT_RAFFLE_LEAD_DAYS,
  type RaffleMonthInput,
} from "./lib/raffle-month-preflight.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readRaffle(path: string): RaffleMonthInput["raffle"] {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { raffle?: RaffleMonthInput["raffle"] };
    return parsed?.raffle ?? null;
  } catch {
    return null;
  }
}

function main(): void {
  const { values } = parseArgs(process.argv.slice(2));
  const edition = values.edition ?? "";
  if (!/^\d{6}$/.test(edition)) {
    console.error("Uso: check-raffle-month.ts --edition AAMMDD [--platform-config path] [--past-editions path] [--lead-days N]");
    process.exit(2);
  }
  const leadRaw = values["lead-days"];
  const leadDays = leadRaw === undefined ? DEFAULT_RAFFLE_LEAD_DAYS : Number(leadRaw);
  if (!Number.isInteger(leadDays) || leadDays < 0) {
    console.error(`[check-raffle-month] --lead-days inválido: ${leadRaw}`);
    process.exit(2);
  }

  const raffle = readRaffle(resolve(ROOT, values["platform-config"] ?? "platform.config.json"));
  const publishedAt = readPublishedDates(resolve(ROOT, values["past-editions"] ?? "data/past-editions-raw.json"));
  const verdict = assessRaffleMonth({
    edition,
    raffle,
    isFirstOfMonth: isFirstEditionOfMonth(edition, publishedAt),
    leadDays,
  });
  const message = describeRaffleMonthVerdict(verdict);
  if (message) console.error(`[check-raffle-month] ${message}`);
  console.log(JSON.stringify({ ...verdict, message }));
}

if (isMainModule(import.meta.url)) {
  main();
}

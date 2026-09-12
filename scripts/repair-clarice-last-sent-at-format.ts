#!/usr/bin/env node
/**
 * scripts/repair-clarice-last-sent-at-format.ts (#8033)
 *
 * Corrige, no store local (`clarice_users.last_sent_at`), linhas gravadas no
 * formato ambíguo `DD-MM-AAAA HH:MM:SS` (dia-mês-ano) em vez do ISO-like
 * `AAAA-MM-DD[ HH:MM:SS]` que o resto do banco usa — bug de ingestão já
 * corrigido em `collectDeliveredStats` (`clarice-sync-brevo.ts`, #8033: um
 * guard de formato passa a rejeitar esse tipo de string ANTES de chamar
 * `Date.parse`, que interpretava `"03-09-2026"` como 9 de MARÇO — MM-DD
 * americano — em vez de 3 de setembro). Este script é só o REPARO dos
 * registros que já entraram corrompidos antes do fix de código existir.
 *
 * Detecção: `last_sent_at` que não começa com `AAAA-` (4 dígitos + hífen) —
 * mesmo padrão usado na investigação ao vivo que achou o bug (4 contatos no
 * ciclo 2608-09). Reparo: reinterpreta a string como `DD-MM-AAAA HH:MM:SS`
 * (a única leitura consistente com o formato que a Brevo de fato exporta,
 * ver `ISO_LIKE_DATE_RE`/`test/clarice-engagement-cohorts-v2.test.ts`) e
 * regrava em ISO UTC — sem deslocar fuso horário (o valor já era lido como
 * "naive", tratado como UTC pelo resto do pipeline; este reparo preserva
 * esse mesmo tratamento, só troca dia↔mês).
 *
 * Uso:
 *   npx tsx scripts/repair-clarice-last-sent-at-format.ts [--db <path>] [--apply]
 *   (default: dry-run — lista o que seria corrigido, não escreve)
 *
 * Stdout: JSON com achados (email, valor antigo, valor novo) e resumo.
 */
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { ISO_LIKE_DATE_RE } from "./lib/iso-like-date.ts";

/** `DD-MM-AAAA HH:MM:SS` → ISO UTC (`AAAA-MM-DDTHH:MM:SS.000Z`), ou `null`
 *  se `raw` não bate exatamente com esse formato OU se o dia/mês resultante
 *  não é uma data de calendário real (ex: 30 de fevereiro) — round-trip via
 *  `Date.UTC` em vez de só checar `1<=dia<=31`/`1<=mês<=12` isoladamente,
 *  que aceitaria uma combinação impossível (#8043 review). Pura — testável
 *  isolada. */
export function repairAmbiguousDmyDate(raw: string): string | null {
  const m = raw.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss] = m;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const hour = Number(hh);
  const minute = Number(min);
  const second = Number(ss);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(ms);
  const calendarValid =
    roundTrip.getUTCFullYear() === year &&
    roundTrip.getUTCMonth() === month - 1 &&
    roundTrip.getUTCDate() === day &&
    roundTrip.getUTCHours() === hour &&
    roundTrip.getUTCMinutes() === minute &&
    roundTrip.getUTCSeconds() === second;
  if (!calendarValid) return null;
  return roundTrip.toISOString();
}

export interface RepairFinding {
  email: string;
  before: string;
  after: string;
}

export interface RepairScanResult {
  /** Reparos aplicáveis — `DD-MM-AAAA HH:MM:SS` válido, convertido pra ISO. */
  repairs: RepairFinding[];
  /** #8043 review: linhas fora do padrão ISO-like MAS que também não batem
   *  com o formato ambíguo DD-MM esperado (separador diferente, dia/mês não
   *  zero-padded, timestamp truncado, data de calendário impossível, etc.)
   *  — sinalizadas separadamente pra nunca ficarem invisíveis: `found` no
   *  stdout do script cobria só `repairs.length`, então um operador via
   *  "found: 4" sem saber que existiam MAIS linhas corrompidas que o script
   *  não sabe corrigir. */
  unrepairable: Array<{ email: string; value: string }>;
}

/** Pura: varre as linhas dadas e separa reparos aplicáveis de linhas
 *  corrompidas que este script não sabe corrigir (não toca o DB). */
export function findLastSentAtRepairs(
  rows: Array<{ email: string; last_sent_at: string | null }>,
): RepairScanResult {
  const repairs: RepairFinding[] = [];
  const unrepairable: Array<{ email: string; value: string }> = [];
  for (const r of rows) {
    if (!r.last_sent_at || ISO_LIKE_DATE_RE.test(r.last_sent_at)) continue;
    const fixed = repairAmbiguousDmyDate(r.last_sent_at);
    if (fixed) repairs.push({ email: r.email, before: r.last_sent_at, after: fixed });
    else unrepairable.push({ email: r.email, value: r.last_sent_at });
  }
  return { repairs, unrepairable };
}

async function main(argv: string[] = process.argv.slice(2)) {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const apply = hasFlag(argv, "apply");
  const db = openClariceDb(dbPath);
  try {
    const rows = db.prepare(
      "SELECT email, last_sent_at FROM clarice_users WHERE last_sent_at IS NOT NULL",
    ).all() as Array<{ email: string; last_sent_at: string | null }>;

    const { repairs, unrepairable } = findLastSentAtRepairs(rows);
    console.log(JSON.stringify({ found: repairs.length, unrepairableCount: unrepairable.length, apply, repairs, unrepairable }, null, 2));

    if (unrepairable.length > 0) {
      console.error(
        `[repair-clarice-last-sent-at-format] ⚠️  ${unrepairable.length} linha(s) fora do padrão ISO que este script NÃO sabe corrigir (formato diferente do ambíguo DD-MM esperado) — ver campo "unrepairable" no JSON acima, inspecionar manualmente.`,
      );
    }
    if (apply && repairs.length > 0) {
      const upd = db.prepare("UPDATE clarice_users SET last_sent_at = ? WHERE email = ?");
      for (const f of repairs) upd.run(f.after, f.email);
      console.error(`[repair-clarice-last-sent-at-format] ${repairs.length} linha(s) corrigida(s).`);
    } else if (!apply && repairs.length > 0) {
      console.error("[repair-clarice-last-sent-at-format] --dry-run: nada escrito. Rode com --apply pra corrigir.");
    } else if (unrepairable.length === 0) {
      console.error("[repair-clarice-last-sent-at-format] nenhuma linha fora do formato ISO encontrada.");
    }
  } finally {
    db.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

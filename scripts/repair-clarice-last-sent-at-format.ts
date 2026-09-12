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

/** Regex do formato ISO-like esperado — mesmo padrão de `ISO_LIKE_DATE_RE`
 *  em `clarice-sync-brevo.ts` (não importado direto pra manter este script
 *  sem dependência do módulo de sync — só duplicando um literal simples). */
const ISO_LIKE_RE = /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}:\d{2})?/;

/** `DD-MM-AAAA HH:MM:SS` → ISO UTC (`AAAA-MM-DDTHH:MM:SS.000Z`), ou `null`
 *  se `raw` não bate exatamente com esse formato. Pura — testável isolada. */
export function repairAmbiguousDmyDate(raw: string): string | null {
  const m = raw.match(/^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss] = m;
  const day = Number(dd);
  const month = Number(mm);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}.000Z`;
}

export interface RepairFinding {
  email: string;
  before: string;
  after: string;
}

/** Pura: varre as linhas dadas e devolve os reparos aplicáveis (não toca o DB). */
export function findLastSentAtRepairs(
  rows: Array<{ email: string; last_sent_at: string | null }>,
): RepairFinding[] {
  const out: RepairFinding[] = [];
  for (const r of rows) {
    if (!r.last_sent_at || ISO_LIKE_RE.test(r.last_sent_at)) continue;
    const fixed = repairAmbiguousDmyDate(r.last_sent_at);
    if (fixed) out.push({ email: r.email, before: r.last_sent_at, after: fixed });
  }
  return out;
}

async function main(argv: string[] = process.argv.slice(2)) {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const apply = hasFlag(argv, "apply");
  const db = openClariceDb(dbPath);
  try {
    const rows = db.prepare(
      "SELECT email, last_sent_at FROM clarice_users WHERE last_sent_at IS NOT NULL",
    ).all() as Array<{ email: string; last_sent_at: string | null }>;

    const findings = findLastSentAtRepairs(rows);
    console.log(JSON.stringify({ found: findings.length, apply, findings }, null, 2));

    if (apply && findings.length > 0) {
      const upd = db.prepare("UPDATE clarice_users SET last_sent_at = ? WHERE email = ?");
      for (const f of findings) upd.run(f.after, f.email);
      console.error(`[repair-clarice-last-sent-at-format] ${findings.length} linha(s) corrigida(s).`);
    } else if (!apply && findings.length > 0) {
      console.error("[repair-clarice-last-sent-at-format] --dry-run: nada escrito. Rode com --apply pra corrigir.");
    } else {
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

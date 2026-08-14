#!/usr/bin/env node
/**
 * check-corrupted-names.ts (#5214 item 1)
 *
 * Audita o store `clarice_users` INTEIRO por contatos com `name` corrompido
 * (U+FFFD — replacement character, sinal de encoding upstream corrompido —
 * achado ao vivo em #5184 item 3: 22 contatos, provável CSV do Stripe lido
 * como UTF-8 quando a fonte real era Latin-1/Windows-1252). Visibilidade
 * GERAL fora do fluxo de montagem de onda — `scripts/clarice-build-segment.ts`
 * (`checkCorruptedNames`) já avisa por onda específica, na hora do envio;
 * este script responde "quantos ainda estão corrompidos hoje, no store
 * inteiro", no mesmo espírito ad-hoc de `/diaria-source-health`. Reusa a
 * MESMA detecção (`hasCorruptedName`, lib/clarice-name.ts) — fonte única,
 * pra as duas checagens nunca divergirem silenciosamente.
 *
 * NÃO corrige nada (#5214 item 2 é ação manual do editor — contatar cada
 * pessoa ou consultar `stripe_ids` de cada contato pra recuperar a grafia
 * correta e fazer um UPDATE pontual no store). Só reporta.
 *
 * Uso:
 *   npx tsx scripts/check-corrupted-names.ts [--db PATH] [--emails]
 *
 *   --db PATH   path alternativo do store SQLite (default: DEFAULT_DB_PATH).
 *   --emails    inclui a lista de e-mails afetados no JSON — PII, omitida
 *               por padrão; passe só quando for de fato reconciliar (#5214
 *               item 2), não pra visibilidade rotineira.
 *
 * Stdout: JSON { total: number, count: number, emails?: string[] }.
 * Exit code: sempre 0 (relatório, não guard — nunca bloqueia nada).
 */

import { existsSync } from "node:fs";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { openClariceDb, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { hasCorruptedName } from "./lib/clarice-name.ts";

export interface CorruptedNameAuditRow {
  email: string;
  name: string | null;
}

export interface CorruptedNameAuditResult {
  total: number;
  count: number;
  /** Só presente quando `includeEmails` foi pedido. */
  emails?: string[];
}

/** Pura/testável — separada da leitura do store pra não precisar de fixture SQLite no teste unitário. */
export function auditCorruptedNames(
  rows: CorruptedNameAuditRow[],
  includeEmails: boolean,
): CorruptedNameAuditResult {
  const affected = rows.filter((r) => hasCorruptedName(r.name));
  return {
    total: rows.length,
    count: affected.length,
    ...(includeEmails ? { emails: affected.map((r) => r.email) } : {}),
  };
}

function main(): void {
  const argv = process.argv.slice(2);
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const includeEmails = hasFlag(argv, "emails");

  if (dbPath !== ":memory:" && !existsSync(dbPath)) {
    console.error(`[check-corrupted-names] store não encontrado em ${dbPath}. Use --db para apontar outro path.`);
    process.exit(1);
  }

  const db = openClariceDb(dbPath);
  let result: CorruptedNameAuditResult;
  try {
    const rows = db.prepare("SELECT email, name FROM clarice_users").all() as unknown as CorruptedNameAuditRow[];
    result = auditCorruptedNames(rows, includeEmails);
  } finally {
    db.close();
  }

  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}

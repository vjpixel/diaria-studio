#!/usr/bin/env node
/**
 * clarice-optin.ts — gere a flag manual `priority_optin` (+40) do store (#2647).
 *
 * Quem pede pra entrar na lista de prioridade recebe +40 em `priority_points`
 * (ver `computePriorityPoints`). É input MANUAL do editor — não há sinal na base
 * que o derive. A flag vive na tabela `priority_optin` (email + added_at),
 * separada de `clarice_users` pra sobreviver a rebuilds do store: o builder a lê
 * via join e nunca a apaga.
 *
 * Aditivo, não corte duro: um optin que ignora 4 emails decai pra 0
 * (40 − 10×4) — comportamento confirmado pelo editor.
 *
 * Uso:
 *   npx tsx scripts/clarice-optin.ts add <email> [email2 …]
 *   npx tsx scripts/clarice-optin.ts remove <email> [email2 …]
 *   npx tsx scripts/clarice-optin.ts list
 *   (opcional em qualquer subcomando: --db <path>)
 *
 * add/remove recomputam `priority_points` na hora pras linhas já existentes no
 * store; emails ainda não ingeridos passam a contar no próximo build.
 */

import { openClariceDb, recomputeDerived, DEFAULT_DB_PATH } from "./lib/clarice-db.ts";
import { getArg, parseArgs } from "./lib/cli-args.ts";

function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const [cmd, ...args] = parseArgs(argv).positional;

  if (!cmd || !["add", "remove", "list"].includes(cmd)) {
    console.error(
      "uso: clarice-optin.ts <add|remove|list> [emails…] [--db <path>]",
    );
    process.exit(1);
  }

  const db = openClariceDb(dbPath);

  if (cmd === "list") {
    const rows = db
      .prepare(
        "SELECT email, added_at FROM priority_optin ORDER BY added_at DESC",
      )
      .all() as Array<{ email: string; added_at: string }>;
    if (rows.length === 0) {
      console.error("(nenhum priority_optin cadastrado)");
    } else {
      for (const r of rows) {
        console.log(`${r.email}\t${r.added_at}`);
      }
      console.error(`\n${rows.length} email(s) com priority_optin.`);
    }
    db.close();
    return;
  }

  const emails = args.map(normalizeEmail).filter(Boolean);
  if (emails.length === 0) {
    console.error(`❌ ${cmd}: informe ao menos 1 email.`);
    db.close();
    process.exit(1);
  }

  if (cmd === "add") {
    const addedAt = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT INTO priority_optin (email, added_at) VALUES (?, ?)
       ON CONFLICT(email) DO NOTHING`,
    );
    let added = 0;
    for (const email of emails) {
      const r = stmt.run(email, addedAt);
      if (r.changes > 0) added++;
    }
    const recomputed = recomputeDerived(db);
    console.error(
      `✅ +${added} priority_optin (${emails.length - added} já existiam) · ` +
        `${recomputed} linhas recomputadas.`,
    );
  } else {
    const stmt = db.prepare("DELETE FROM priority_optin WHERE email = ?");
    let removed = 0;
    for (const email of emails) {
      const r = stmt.run(email);
      if (r.changes > 0) removed++;
    }
    const recomputed = recomputeDerived(db);
    console.error(
      `🗑️  -${removed} priority_optin (${emails.length - removed} não estavam) · ` +
        `${recomputed} linhas recomputadas.`,
    );
  }

  db.close();
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}

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

import type { DatabaseSync } from "node:sqlite";
import {
  openClariceDb,
  recomputeDerived,
  findContactByEmail,
  DEFAULT_DB_PATH,
} from "./lib/clarice-db.ts";
import { getArg, parseArgs } from "./lib/cli-args.ts";

function normalizeEmail(e: string): string {
  return e.trim().toLowerCase();
}

/**
 * Resolve o email informado (`add` OU `remove`, #2921 — aplicado nos dois
 * desde então; originalmente só `add`, #2861) contra o store ANTES de gravar.
 *
 * Incidente real (260702): 13 opt-ins prioritários, 4 responderam da variante
 * SEM pontos do Gmail (`filosofodaniel@gmail.com`) mas o Stripe/store tem a
 * forma COM pontos (`filosofo.daniel@gmail.com`) — o Gmail trata como a mesma
 * caixa, o join exato do `recomputeDerived` não. O boost +40 ficou órfão na
 * tabela `priority_optin` (um deles era assinante ativo T01).
 *
 * #2921: o mesmo problema existia no `remove` — um `add` que resolveu pro
 * canônico grava a forma COM pontos em `priority_optin`; um `remove` que NÃO
 * resolvesse tentaria `DELETE ... WHERE email = '<variante sem pontos>'`,
 * casaria 0 linhas, e o boost +40 ficaria ativo indevidamente (falha
 * silenciosa — a CLI reporta "não estava" como se o email nunca tivesse sido
 * adicionado). Aplicar a MESMA resolução no remove garante que a chave
 * deletada seja a mesma que o add gravou.
 *
 * A normalização fica SÓ aqui (ponto de entrada do optin) — as chaves do
 * store permanecem o email REAL do Stripe (necessário pro match com Brevo);
 * `findContactByEmail` (#2863) nunca reescreve o store, só informa a
 * resolução pro chamador decidir o que gravar/remover:
 *   - match único (exato OU gmail-normalized) → usa o email CANÔNICO do
 *     store (o que já está lá), com notice mostrando a resolução;
 *   - ambíguo (2+ candidatos) OU sem match nenhum → usa o email INFORMADO
 *     literalmente, com warning (nunca inventa uma resolução incerta).
 */
export function resolveOptinEmail(
  db: DatabaseSync,
  input: string,
): { email: string; notice?: string; warning?: string } {
  const match = findContactByEmail(db, input);

  if (match.matchType === "exact") {
    return { email: input };
  }

  if (match.matchType === "gmail-normalized" && match.row) {
    const canonical = String(match.row.email);
    return {
      email: canonical,
      notice: `↳ ${input} → resolvido para ${canonical} (match Gmail normalizado, #2861)`,
    };
  }

  if (match.candidates.length > 1) {
    const list = match.candidates.map((c) => c.email).join(", ");
    return {
      email: input,
      warning:
        `⚠️  ${input}: match AMBÍGUO no store (${match.candidates.length} candidatos — ${list}) — ` +
        `gravando o email informado literalmente, sem resolver.`,
    };
  }

  return {
    email: input,
    warning:
      `⚠️  ${input}: não encontrado no store (nem por normalização Gmail) — ` +
      `gravando o email informado literalmente. Antes de assumir que não é ` +
      `cliente, confira também os CSVs crus em data/clarice-subscribers/ (#2863).`,
  };
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
    for (const inputEmail of emails) {
      // #2861/#2863: resolve pro email canônico do store (normalização Gmail)
      // ANTES de gravar — nunca deixa uma variante sem-pontos ficar órfã na
      // tabela priority_optin enquanto o store guarda a forma com pontos.
      const resolved = resolveOptinEmail(db, inputEmail);
      if (resolved.notice) console.error(resolved.notice);
      if (resolved.warning) console.error(resolved.warning);
      const r = stmt.run(resolved.email, addedAt);
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
    for (const inputEmail of emails) {
      // #2921: mesma resolução do add (#2861) — sem isso, remove de uma
      // variante Gmail (ex: `user+tag@gmail.com` vs a forma canônica gravada
      // pelo add) casa 0 linhas e o boost +40 permanece órfão em silêncio.
      const resolved = resolveOptinEmail(db, inputEmail);
      if (resolved.notice) console.error(resolved.notice);
      if (resolved.warning) console.error(resolved.warning);
      const r = stmt.run(resolved.email);
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

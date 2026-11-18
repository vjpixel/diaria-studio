#!/usr/bin/env node
/**
 * clarice-forget.ts (#13573) — registra um pedido de EXCLUSÃO DE DADOS (LGPD)
 * de quem recebe a Clarice News e minimiza na hora, no store e na Brevo.
 * Substitui o script ad hoc de 18/11/2026 (#13534).
 *
 *   npx tsx scripts/clarice-forget.ts add --email E [--source S] [--note N]
 *       [--requested-at ISO] [--no-brevo] [--db P] [--ledger P]
 *   npx tsx scripts/clarice-forget.ts list [--db P]
 *
 * `add`:
 *   1. grava o pedido na tabela `forget_requests` do store E no ledger
 *      `data/clarice-subscribers/forget-requests.jsonl` (sobrevive a store
 *      recriado do zero);
 *   2. minimiza o store: fica só o e-mail com as flags de supressão
 *      (`unsubscribed`, `email_blacklisted`, bounce/complaint) — nome, ids do
 *      Stripe, cohort, MV e engajamento saem, e o opt-in também;
 *   3. recomputa os derivados;
 *   4. minimiza o contato na Brevo da Clarice SEM apagá-lo (apagar tiraria a
 *      blacklist): blacklist, sai de todas as listas, atributos de texto
 *      zerados. `--no-brevo` pula esta etapa (ex.: Brevo já tratada à mão).
 *
 * O rebuild (`clarice-build-db.ts`) e o sync da Brevo respeitam a lista daí em
 * diante — o pedido não se desfaz no próximo rebuild.
 *
 * Idempotente: repetir o `add` mantém a data original do pedido e só refaz a
 * minimização. Requer BREVO_CLARICE_API_KEY só sem `--no-brevo`.
 * Stdout: JSON resumo. Stderr: progresso.
 */

import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getArg, hasFlag, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  DEFAULT_DB_PATH,
  describeStoreFile,
  listForgetRequests,
  openClariceDb,
  recomputeDerived,
} from "./lib/clarice-db.ts";
import {
  DEFAULT_FORGET_LEDGER_PATH,
  forgetInStore,
  makeBrevoMinimizer,
  type BrevoMinimizeResult,
} from "./lib/clarice-forget.ts";
import { resolveOptinEmail } from "./clarice-optin.ts";

export interface ForgetCliDeps {
  /** Injetável (teste). Sem ele, monta o cliente real a partir de BREVO_CLARICE_API_KEY. */
  brevoMinimize?: (email: string) => Promise<BrevoMinimizeResult>;
  openDb?: (path: string) => DatabaseSync;
}

export async function main(argv: string[] = process.argv.slice(2), deps: ForgetCliDeps = {}): Promise<number> {
  const [cmd] = parseArgs(argv).positional;
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const openDb = deps.openDb ?? openClariceDb;

  if (cmd === "list") {
    if (!existsSync(dbPath)) {
      console.error(`❌ store não encontrado: ${dbPath}`);
      return 1;
    }
    const db = openDb(dbPath);
    try {
      console.log(JSON.stringify(listForgetRequests(db), null, 2));
    } finally {
      db.close();
    }
    return 0;
  }

  if (cmd !== "add") {
    console.error("uso: clarice-forget.ts <add|list> --email E [--source S] [--note N] [--requested-at ISO] [--no-brevo] [--db P] [--ledger P]");
    return 1;
  }

  const email = getArg(argv, "email").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error("❌ add exige --email com um endereço válido. Nada gravado.");
    return 1;
  }
  const requestedAt = getArg(argv, "requested-at") || new Date().toISOString();
  if (Number.isNaN(new Date(requestedAt).getTime())) {
    console.error(`❌ --requested-at inválido: ${requestedAt}. Nada gravado.`);
    return 1;
  }
  const source = getArg(argv, "source") || "clarice-forget.ts";
  const note = getArg(argv, "note") || null;
  // Default: o ledger mora ao lado do store (= DEFAULT_FORGET_LEDGER_PATH com o store padrão).
  const ledgerPath = getArg(argv, "ledger") || resolve(dirname(dbPath), basename(DEFAULT_FORGET_LEDGER_PATH));
  const noBrevo = hasFlag(argv, "no-brevo");

  let brevoMinimize = deps.brevoMinimize;
  if (!noBrevo && !brevoMinimize) {
    loadProjectEnv();
    const apiKey = process.env.BREVO_CLARICE_API_KEY;
    if (!apiKey) {
      console.error("❌ BREVO_CLARICE_API_KEY ausente no env (use --no-brevo para tratar só o store). Nada gravado.");
      return 1;
    }
    brevoMinimize = await makeBrevoMinimizer(apiKey);
  }

  if (!existsSync(dbPath)) {
    console.error(`❌ store não encontrado: ${dbPath}. Nada gravado.`);
    return 1;
  }
  const t0 = Date.now();
  console.error(`📂 abrindo o store em ${dbPath} (${describeStoreFile(dbPath)})…`);
  const db = openDb(dbPath);
  let target = email;
  let store;
  try {
    // Endereço que a Brevo conhece = forma canônica do store (#2861), como na triagem.
    const r = resolveOptinEmail(db, email);
    if (r.notice) console.error(r.notice);
    target = r.email;
    store = forgetInStore(db, { email, requestedAt, source, note }, ledgerPath);
    console.error(
      `🔒 store: pedido ${store.new_request ? "registrado" : "já registrado"} · ` +
        `${store.minimized} linha(s) minimizada(s) · opt-in removido: ${store.optin_removed}`,
    );
    console.error(`⚙️  recomputando derivados no store inteiro…`);
    recomputeDerived(db);
    console.error(`   store pronto em ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  } finally {
    db.close();
  }

  let brevo: BrevoMinimizeResult | { status: "skipped" } = { status: "skipped" };
  if (!noBrevo && brevoMinimize) {
    console.error(`🌐 Brevo: minimizando ${target}…`);
    try {
      brevo = await brevoMinimize(target);
    } catch (e) {
      console.error(`❌ Brevo: ${target} falhou — ${(e as Error).message}. O store já está minimizado; repita o add para retentar.`);
      console.log(JSON.stringify({ email, brevo_target: target, store, brevo: { status: "error", error: (e as Error).message } }, null, 2));
      return 1;
    }
    if (brevo.status === "not_found") {
      console.error(`🔎 Brevo: ${target} não existe na Brevo — nada a minimizar lá; confira à mão o endereço que recebe a newsletter.`);
    } else if (brevo.status === "ok") {
      console.error(
        `🚫 Brevo: ${target} blacklisted, fora de ${brevo.lists_unlinked.length} lista(s), ` +
          `atributos zerados: ${brevo.attributes_cleared.join(", ") || "(nenhum)"}`,
      );
      if (brevo.attributes_kept.length > 0) {
        console.error(`⚠️  Brevo: atributos não-texto mantidos (revise à mão): ${brevo.attributes_kept.join(", ")}`);
      }
    }
  }

  console.log(JSON.stringify({ email, brevo_target: target, store, brevo }, null, 2));
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`❌ ${(err as Error).message}`);
      process.exit(1);
    },
  );
}

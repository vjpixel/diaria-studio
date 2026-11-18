#!/usr/bin/env node
/**
 * clarice-forget.ts (#13573) — registra um pedido de EXCLUSÃO DE DADOS (LGPD)
 * de quem recebe a Clarice News e minimiza na hora, no store e na Brevo.
 * Substitui o script ad hoc de 18/11/2026 (#13534).
 *
 *   npx tsx scripts/clarice-forget.ts add --email E [--source S] [--note N]
 *       [--requested-at ISO] [--no-brevo] [--db P] [--ledger P]
 *   npx tsx scripts/clarice-forget.ts list [--db P]
 *   npx tsx scripts/clarice-forget.ts sync-ledger [--db P] [--ledger P]
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
 *      Cada variante do mesmo Gmail que o store tem vira um contato minimizado.
 *
 * `sync-ledger`: acrescenta ao ledger os pedidos da tabela que faltam nele
 * (o rebuild aborta enquanto o ledger não cobre a tabela). Rodar só depois de
 * conferir que o Drive terminou de sincronizar o ledger.
 *
 * Ledger: `DEFAULT_FORGET_LEDGER_PATH` (o mesmo que a triagem e o rebuild
 * leem), salvo `--ledger` explícito.
 *
 * O rebuild (`clarice-build-db.ts`) e o sync da Brevo respeitam a lista daí em
 * diante — o pedido não se desfaz no próximo rebuild.
 *
 * Idempotente: repetir o `add` mantém a data original do pedido e só refaz a
 * minimização. Requer BREVO_CLARICE_API_KEY só sem `--no-brevo`.
 * Stdout: JSON resumo. Stderr: progresso.
 */

import { existsSync } from "node:fs";
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
  forgetBrevoTargets,
  forgetInStore,
  makeBrevoMinimizer,
  minimizeBrevoTargets,
  syncLedgerFromStore,
  type BrevoForgetOutcome,
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

  const ledgerPath = getArg(argv, "ledger") || DEFAULT_FORGET_LEDGER_PATH;

  if (cmd === "sync-ledger") {
    if (!existsSync(dbPath)) {
      console.error(`❌ store não encontrado: ${dbPath}`);
      return 1;
    }
    const db = openDb(dbPath);
    try {
      const added = syncLedgerFromStore(db, ledgerPath);
      console.error(`📝 ledger ${ledgerPath}: ${added.length} pedido(s) acrescentado(s) a partir do store`);
      console.log(JSON.stringify({ ledger: ledgerPath, added }, null, 2));
    } finally {
      db.close();
    }
    return 0;
  }

  if (cmd !== "add") {
    console.error("uso: clarice-forget.ts <add|list|sync-ledger> --email E [--source S] [--note N] [--requested-at ISO] [--no-brevo] [--db P] [--ledger P]");
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
  let targets: string[] = [email];
  let store;
  try {
    // Endereço que a Brevo conhece = forma canônica do store (#2861), como na triagem.
    const r = resolveOptinEmail(db, email);
    if (r.notice) console.error(r.notice);
    store = forgetInStore(db, { email, requestedAt, source, note }, ledgerPath);
    // Todas as variantes do mesmo Gmail que o store minimizou (review da PR #13583).
    targets = forgetBrevoTargets(db, r.email);
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

  let brevo: BrevoForgetOutcome | { status: "skipped" } = { status: "skipped" };
  if (!noBrevo && brevoMinimize) {
    console.error(`🌐 Brevo: minimizando ${targets.join(", ")}…`);
    try {
      brevo = await minimizeBrevoTargets(brevoMinimize, targets);
    } catch (e) {
      console.error(`❌ Brevo: falhou — ${(e as Error).message}. O store já está minimizado; repita o add para retentar.`);
      console.log(JSON.stringify({ email, brevo_targets: targets, store, brevo: { status: "error", error: (e as Error).message } }, null, 2));
      return 1;
    }
    for (const [target, res] of Object.entries(brevo.results)) logBrevoResult(target, res);
  }

  console.log(JSON.stringify({ email, brevo_targets: targets, store, brevo }, null, 2));
  return 0;
}

function logBrevoResult(target: string, res: BrevoMinimizeResult): void {
  if (res.status === "not_found") {
    console.error(`🔎 Brevo: ${target} não existe na Brevo — nada a minimizar lá; confira à mão o endereço que recebe a newsletter.`);
    return;
  }
  console.error(
    `🚫 Brevo: ${target} blacklisted, fora de ${res.lists_unlinked.length} lista(s), ` +
      `atributos zerados: ${res.attributes_cleared.join(", ") || "(nenhum)"}`,
  );
  if (res.attributes_failed && res.attributes_failed.length > 0) {
    console.error(
      `⚠️  Brevo: ${target} — a Brevo recusou zerar ${res.attributes_failed.join(", ")} (${res.attributes_error}); ` +
        `blacklist e listas já valeram, limpe esses atributos à mão.`,
    );
  }
  if (res.attributes_kept.length > 0) {
    console.error(`⚠️  Brevo: ${target} — atributos não-texto mantidos (revise à mão): ${res.attributes_kept.join(", ")}`);
  }
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

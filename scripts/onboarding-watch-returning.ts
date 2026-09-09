/**
 * scripts/onboarding-watch-returning.ts (#7660)
 *
 * Watcher de RECADASTRO. Roda de hora em hora; quando alguém da watchlist
 * reaparece no Kit, semeia a entrada dele no store de onboarding com o
 * e-mail 1 JÁ MARCADO como enviado — o que faz a rodada diária das 09:05
 * pular a pessoa em vez de mandar "Você está dentro" pra quem lê há meses.
 *
 * Ver `scripts/lib/onboarding-returning-watch.ts` para o porquê e para a
 * lógica de decisão (pura, testada à parte). Este arquivo é só o I/O.
 *
 * ## Uso
 *
 *   npx tsx scripts/onboarding-watch-returning.ts --add fulano@x.com --reason "#7660"
 *   npx tsx scripts/onboarding-watch-returning.ts            # dry-run
 *   npx tsx scripts/onboarding-watch-returning.ts --send     # grava
 *
 * ## Fresta conhecida
 *
 * A task roda no minuto :00 de cada hora e a rodada de onboarding às 09:05.
 * Quem se cadastrar entre 09:00 e 09:05 é detectado pela rodada antes do
 * watcher agir, e o e-mail 1 sai. São 5 minutos por dia; fechar isso exigiria
 * acoplar este check ao próprio `onboarding-welcome-run.ts`, o que não se
 * justifica pelo tamanho da lista. Documentado em vez de escondido.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { getKitSubscriberByEmail } from "./lib/kit-subscribers.ts";
import { readStore, writeStore, type OnboardingEntry } from "./lib/onboarding-store.ts";
import {
  decideWatchEntry,
  pendingWatchEntries,
  emptyWatchlist,
  addToWatchlist,
  markWatchResolved,
  renderWatchDecision,
  type ReturningWatchlist,
} from "./lib/onboarding-returning-watch.ts";

// `fileURLToPath`, nunca `new URL(...).pathname` — no Windows o pathname vem
// como `/C:/...` e vira caminho inválido (mesmo defeito que quebra
// `test/poll-subscribe-welcome-sequence-6508.test.ts` só nesta plataforma).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WATCHLIST = "data/onboarding/returning-watchlist.json";

interface Args {
  send: boolean;
  add?: string;
  reason?: string;
  watchlistPath?: string;
  storePath?: string;
  /** Override de teste — raiz de onde `.env` é carregado. Mesmo contrato do
   *  `--env-root` de `onboarding-welcome-run.ts` (#5966): sem isto, rodar de
   *  um worktree (que não tem `.env`) falha por credencial ausente. */
  envRoot?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { send: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--send") a.send = true;
    else if (v === "--add") a.add = argv[++i];
    else if (v === "--reason") a.reason = argv[++i];
    else if (v === "--watchlist") a.watchlistPath = argv[++i];
    else if (v === "--store") a.storePath = argv[++i];
    else if (v === "--env-root") a.envRoot = argv[++i];
    else {
      process.stderr.write(`[watch-returning] flag desconhecida: ${v}\n`);
      process.exit(2);
    }
  }
  return a;
}

function readWatchlist(path: string): ReturningWatchlist {
  if (!existsSync(path)) return emptyWatchlist();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ReturningWatchlist;
  } catch {
    process.stderr.write(`[watch-returning] watchlist corrompida em ${path} — tratando como vazia\n`);
    return emptyWatchlist();
  }
}

function writeWatchlist(list: ReturningWatchlist, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(list, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  loadProjectEnv(args.envRoot);

  const watchlistPath = args.watchlistPath ?? resolve(ROOT, DEFAULT_WATCHLIST);
  const storePath = args.storePath ?? resolve(ROOT, "data/onboarding/store.json");
  let list = readWatchlist(watchlistPath);

  // --- modo gestão: só adiciona alguém à observação e sai ---
  if (args.add) {
    if (!args.reason) {
      process.stderr.write(`[watch-returning] --add exige --reason (vira \`seeded_by\` na entrada).\n`);
      process.exit(2);
    }
    const r = addToWatchlist(list, args.add, args.reason, new Date().toISOString());
    if (!r.added) {
      console.log(`[watch-returning] ${args.add} já estava em observação — nada a fazer.`);
      return;
    }
    if (args.send) {
      writeWatchlist(r.list, watchlistPath);
      console.log(`[watch-returning] ${args.add} adicionado à observação (origem ${args.reason}).`);
    } else {
      console.log(`[watch-returning] dry-run: ${args.add} SERIA adicionado (origem ${args.reason}). Use --send.`);
    }
    return;
  }

  const pendentes = pendingWatchEntries(list);
  if (pendentes.length === 0) {
    console.log("[watch-returning] ninguém em observação — nada a fazer.");
    return;
  }

  const kitResult = resolveKitConfig();
  if (!kitResult.ok) {
    process.stderr.write(`[watch-returning] ${kitResult.reason}\n`);
    process.exit(2);
  }
  const kitCfg = kitResult.config;

  const { store } = readStore(storePath);
  const emailsNoStore = new Set(Object.values(store.entries).map((e) => e.email.toLowerCase()));
  const idsNoStore = new Set(Object.keys(store.entries));

  console.log(`[watch-returning] ${pendentes.length} em observação${args.send ? "" : " (dry-run)"}:`);
  let mudouStore = false;
  let mudouLista = false;
  const nowIso = new Date().toISOString();

  for (const entry of pendentes) {
    // Falha de rede não pode derrubar o watcher inteiro nem, pior, fazer uma
    // pessoa parecer "ainda não recadastrada" — a diferença entre as duas é
    // justamente o que decide se o e-mail 1 sai. Erro é reportado alto e a
    // pessoa continua na fila para a próxima hora.
    let kit;
    try {
      kit = await getKitSubscriberByEmail(entry.email, kitCfg);
    } catch (err) {
      process.stderr.write(
        `[watch-returning] ERRO consultando ${entry.email}: ${err instanceof Error ? err.message : String(err)} — segue em observação\n`,
      );
      continue;
    }

    const d = decideWatchEntry(
      entry,
      kit ? { id: kit.id, email_address: kit.email_address, state: kit.state, created_at: kit.created_at } : null,
      emailsNoStore.has(entry.email.toLowerCase()),
      kit ? idsNoStore.has(String(kit.id)) : false,
    );
    console.log(renderWatchDecision(d));

    if (d.kind === "ja-no-store") {
      list = markWatchResolved(list, d.email, nowIso, null);
      mudouLista = true;
      continue;
    }
    if (d.kind !== "semear") continue;

    const nova: OnboardingEntry = {
      subscription_id: String(d.kitId),
      email: d.email,
      status_detectado: "active",
      created_at: Math.floor(Date.parse(d.seedEmail1SentAt) / 1000),
      detected_at: nowIso,
      email1_sent_at: d.seedEmail1SentAt,
      email1_brevo_id: null,
      email2_sent_at: null,
      email2_brevo_id: null,
      email3_state: "pending",
      email3_campaign_id: null,
      email3_decided_at: null,
      seeded_by: d.reason,
    };
    store.entries[String(d.kitId)] = nova;
    emailsNoStore.add(d.email.toLowerCase());
    idsNoStore.add(String(d.kitId));
    list = markWatchResolved(list, d.email, nowIso, d.kitId);
    mudouStore = true;
    mudouLista = true;
  }

  if (!args.send) {
    console.log("[watch-returning] dry-run — nada escrito. Use --send.");
    return;
  }
  if (mudouStore) writeStore(store, storePath);
  if (mudouLista) writeWatchlist(list, watchlistPath);
  if (!mudouStore && !mudouLista) console.log("[watch-returning] nenhuma mudança.");
}

main().catch((err) => {
  process.stderr.write(`[watch-returning] falhou: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

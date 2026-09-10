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
 *   npx tsx scripts/onboarding-watch-returning.ts --add {email} --reason "#7660"
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

/**
 * Arquivo AUSENTE é "ninguém em observação" — estado legítimo, exit 0.
 *
 * Arquivo PRESENTE mas ilegível é outra coisa: significa que existia uma
 * lista e não sabemos mais quem estava nela. Tratar isso como lista vazia
 * faria a task sair verde tendo perdido a observação inteira — a mesma
 * classe de silêncio do #7599, em que o onboarding rodava, detectava 0 e
 * saía exit 0 por semanas sem ninguém receber nada. Aqui aborta com exit 2,
 * que é o que o alarme de units falhas do `300` enxerga (achado do review
 * da PR #7698).
 */
function readWatchlist(path: string): ReturningWatchlist {
  if (!existsSync(path)) return emptyWatchlist();
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ReturningWatchlist;
  } catch (err) {
    process.stderr.write(
      `[watch-returning] watchlist ILEGÍVEL em ${path}: ${err instanceof Error ? err.message : String(err)}\n` +
        `[watch-returning] abortando — tratar como lista vazia esconderia quem estava sendo observado.\n`,
    );
    process.exit(2);
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

  // `corrupted` NÃO pode ser descartado (achado P0 do review da PR #7698).
  // `readStore` devolve `emptyStore()` quando o JSON não parseia — e este
  // script GRAVA o store. Seguir com um store "vazio" e depois escrever
  // apagaria o histórico de onboarding de TODO MUNDO (quem aguarda o e-mail
  // 2 em D+3, quem aguarda a decisão do e-mail 3) num único `writeStore`,
  // sem erro visível. O cenário é concreto neste projeto: junction `data/`
  // do OneDrive momentaneamente caída no `300` — foi exatamente por isso
  // que a task-irmã `Diaria-Onboarding-Welcome-Run` ganhou
  // `guard.requiredFile` no #5956.
  const { store, corrupted } = readStore(storePath);
  if (corrupted) {
    process.stderr.write(
      `[watch-returning] store ILEGÍVEL em ${storePath} — abortando SEM escrever.\n` +
        `[watch-returning] prosseguir apagaria o histórico de onboarding de todos os assinantes rastreados.\n`,
    );
    process.exit(2);
  }
  const emailsNoStore = new Set(Object.values(store.entries).map((e) => e.email.toLowerCase()));
  const idsNoStore = new Set(Object.keys(store.entries));

  console.log(`[watch-returning] ${pendentes.length} em observação${args.send ? "" : " (dry-run)"}:`);
  let mudouStore = false;
  let mudouLista = false;
  /** #7698: quantas consultas ao Kit falharam. Sem isto, um apagão do Kit
   *  fazia a task sair 0 — indistinguível de "consultei todo mundo e ninguém
   *  recadastrou". O alarme de units falhas do `300` só enxerga exit ≠ 0,
   *  e é justamente durante o apagão que a rodada das 09:05 pode detectar o
   *  recadastro primeiro e mandar o e-mail indevido. */
  let falhasDeConsulta = 0;
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
      falhasDeConsulta++;
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
    if (d.kind === "data-invalida") {
      // Não sai da observação: a data pode vir boa na próxima hora, e semear
      // com `NaN` congelaria a pessoa antes dos e-mails 2 e 3 sem sinal.
      process.exitCode = 1;
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

  if (falhasDeConsulta > 0) {
    process.exitCode = 1;
    process.stderr.write(
      `[watch-returning] ${falhasDeConsulta} de ${pendentes.length} consulta(s) ao Kit falharam — ` +
        `saindo com erro pra não passar por "rodei e ninguém recadastrou".\n`,
    );
  }

  if (!args.send) {
    console.log("[watch-returning] dry-run — nada escrito. Use --send.");
    return;
  }
  if (mudouStore) {
    // Relê o store IMEDIATAMENTE antes de gravar e reaplica só as entradas
    // que este watcher criou.
    //
    // Motivo (achado do review da PR #7698): até agora
    // `onboarding-welcome-run.ts` era o único escritor de
    // `data/onboarding/store.json`. Esta task é o segundo, e `readStore` →
    // modificar → `writeStore` não tem exclusão mútua entre processos. O
    // agendamento nominal não colide (:00 de cada hora vs. 09:05), mas uma
    // rodada atrasada por retry de rede pode se sobrepor — e aí quem grava
    // por último apaga as entradas que o outro acabou de criar. Reler e
    // reaplicar reduz a janela ao intervalo entre estas duas linhas, em vez
    // do run inteiro. Não é lock: é minimizar o que se perde.
    const { store: atual, corrupted: corrompeuAgora } = readStore(storePath);
    if (corrompeuAgora) {
      // Ficou ilegível ENTRE o início do run e agora. Mesmo raciocínio do
      // guard lá em cima: escrever por cima destruiria o resto do store.
      process.stderr.write(
        `[watch-returning] store ficou ILEGÍVEL durante o run — abortando SEM escrever; a watchlist não avança.\n`,
      );
      process.exit(2);
    }
    for (const [chave, entrada] of Object.entries(store.entries)) {
      if (entrada.seeded_by != null && atual.entries[chave] == null) atual.entries[chave] = entrada;
    }
    writeStore(atual, storePath);
  }
  if (mudouLista) writeWatchlist(list, watchlistPath);
  if (!mudouStore && !mudouLista) console.log("[watch-returning] nenhuma mudança.");
}

main().catch((err) => {
  process.stderr.write(`[watch-returning] falhou: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});

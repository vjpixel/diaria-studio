#!/usr/bin/env npx tsx
/**
 * render-halt-banner.ts (#737, notificação push #3564, canal e-mail #5341)
 *
 * Emite um banner vermelho de "PIPELINE PAROU" no stdout. Chamado pelo
 * orchestrator (top-level Claude Code) sempre que detectar uma parada
 * inesperada (MCP disconnect, subagent error, exception não-tratada,
 * ratelimit, loop verify→fix esgotado).
 *
 * Escopo: este script faz apenas o output. O orchestrator decide quando
 * invocá-lo seguindo as regras em CLAUDE.md (ex: "MCP indisponível =
 * fail-fast" #738) e nas specs por stage.
 *
 * Diferença vs gate banner: gate é pausa esperada (aprovação do editor),
 * halt é pausa inesperada (algo quebrou). Cor diferente, texto diferente,
 * action obrigatória pra dar caminho ao editor.
 *
 * #3564/#5341: além do stdout, dispara (fail-soft TOTAL, nunca bloqueia nem
 * atrasa o banner além do timeout de rede) uma notificação push por e-mail
 * com o mesmo texto (stage/motivo/ação) via `scripts/lib/push-notify.ts`
 * (canal Gmail, definido em #5341, decisão do editor: padronizar em e-mail
 * em vez de exigir um app de mensagens novo — o canal anterior era no-op
 * silencioso sem credenciais configuradas) — fecha o loop mobile quando o
 * editor não está olhando o terminal. Dedup entre invocações (script roda
 * como processo novo a cada chamada, sem estado em memória sobrevivendo)
 * via um registro JSON pequeno em `data/.push-halt-dedup.json` (mesma pasta
 * OneDrive-synced de `data/`, nunca no repo; renomeado do arquivo do canal
 * anterior em #5341) — chave = `stage|reason|action`
 * (o MESMO halt reportado de novo dentro da janela não reenvia). Se `data/`
 * não existir (clone fresco sem a junction, sessão cloud) ou a escrita
 * falhar, o dedup degrada pra "sempre notifica" — nunca impede o banner de
 * imprimir.
 *
 * #7215: `--no-push` suprime SÓ a notificação (o banner continua saindo no
 * stdout). Serve ao caller que já notificou o editor pelo próprio canal e,
 * ao invocar este script, geraria um SEGUNDO e-mail sobre o mesmo evento —
 * hoje só `scripts/overnight-watchdog.ts`, que manda o alerta de stall
 * (assunto "[diar.ia.br overnight] STALL detectado") e logo em seguida
 * chamava este script, que mandava outro ("[diar.ia.br] Pipeline parou").
 * Os dois e-mails descreviam o mesmo stall, com a mesma ação. O alerta do
 * watchdog é o que fica: é mais específico (kind no assunto, fonte da última
 * atividade) e é `await`-ado no processo do watchdog, enquanto o daqui
 * corria dentro de um `execFileSync` com timeout de 10s — podia ser morto no
 * meio do envio. Nenhum outro caller passa a flag: pra eles este script
 * segue sendo o ÚNICO canal de notificação de halt.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { renderHaltBanner } from "./lib/gate-banner.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  sendPushNotification,
  formatHaltNotifyMessage,
  shouldNotify,
  markNotified,
  type DedupRecord,
} from "./lib/push-notify.ts";

const RED_BG_WHITE_FG = "\x1b[41m\x1b[97m";
const RESET = "\x1b[0m";

/** Janela de dedup entre halts idênticos (mesmo stage/motivo/ação) — 15 min:
 * generoso o bastante pra cobrir um loop de retry rápido do orchestrator sem
 * silenciar um halt genuinamente novo (ex: reconectou, quebrou nod novo). */
const HALT_DEDUP_WINDOW_MS = 15 * 60_000;

export interface HaltBannerArgs {
  stage: string;
  reason: string;
  action: string;
  /** `false` quando `--no-push` foi passado — o banner sai no stdout, mas a
   * notificação por e-mail é suprimida. Existe pro caller que JÁ notificou o
   * editor por conta própria e só quer o banner (hoje: `overnight-watchdog.ts`
   * — ver #7215 e o doc-comment do módulo). Default `true`: nenhum caller
   * existente muda de comportamento. */
  push: boolean;
}

/**
 * Parseia o argv do CLI. Retorna `null` quando falta algum dos 3 argumentos
 * obrigatórios — quem imprime o usage e sai é `main()`, não esta função, pra
 * ela ser testável sem derrubar o processo de teste (mesmo cuidado que o
 * guard `isMainModule` no fim do arquivo documenta).
 */
export function parseHaltBannerArgs(argv: string[]): HaltBannerArgs | null {
  const { values, flags } = parseCliArgs(argv);
  if (!values.stage || !values.reason || !values.action) return null;
  return {
    stage: values.stage,
    reason: values.reason,
    action: values.action,
    push: !flags.has("no-push"),
  };
}

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

function haltDedupPath(rootDir: string): string {
  return resolve(rootDir, "data", ".push-halt-dedup.json");
}

/** Lê o registro de dedup do disco — fail-soft: arquivo ausente, `data/`
 * ausente (junction não criada, #2643 label `local`) ou JSON corrompido
 * todos retornam registro vazio (equivalente a "nunca notificado"), nunca
 * lançam. */
function readHaltDedupRecord(rootDir: string): DedupRecord {
  try {
    const path = haltDedupPath(rootDir);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as DedupRecord) : {};
  } catch {
    return {};
  }
}

/** Grava o registro atualizado — fail-soft: qualquer erro (disco cheio,
 * `data/` ausente, permissão) é engolido; o dedup simplesmente não persiste
 * pra próxima chamada, o que só degrada pra "notifica de novo" (nunca
 * "para de notificar pra sempre"). */
function writeHaltDedupRecord(rootDir: string, record: DedupRecord): void {
  try {
    const path = haltDedupPath(rootDir);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileAtomic(path, JSON.stringify(record, null, 2) + "\n");
  } catch {
    // fail-soft — ver doc-comment do módulo.
  }
}

export interface NotifyHaltOptions {
  rootDir?: string;
  nowMs?: number;
  /** `sendPushNotification` injetável (testes) — evita bater na rede
   * real/depender de credenciais presentes no ambiente de CI. */
  notifyFn?: (msg: {
    subject: string;
    body: string;
  }) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>;
}

/**
 * Dispara a notificação push (e-mail, #5341) do halt, com dedup por processo
 * (ver doc-comment do módulo). Sempre resolve — nunca lança, nunca faz o
 * caller esperar além do timeout de rede embutido em `sendPushNotification`
 * (`PUSH_IO_TIMEOUT_MS`, 10s).
 */
export async function notifyHaltViaPush(
  opts: { stage: string; reason: string; action: string },
  env: NotifyHaltOptions = {},
): Promise<void> {
  const rootDir = env.rootDir ?? process.cwd();
  const nowMs = env.nowMs ?? Date.now();
  const notifyFn = env.notifyFn ?? sendPushNotification;

  const key = `${opts.stage}|${opts.reason}|${opts.action}`;
  const record = readHaltDedupRecord(rootDir);
  if (!shouldNotify(record, key, nowMs, HALT_DEDUP_WINDOW_MS)) return;

  const result = await notifyFn(formatHaltNotifyMessage(opts.stage, opts.reason, opts.action));
  if (result.skipped) return; // sem credenciais — nada a persistir
  if (!result.ok) {
    process.stderr.write(`[render-halt-banner] Notificação push falhou: ${result.error}\n`);
    return; // não marca como notificado — próxima chamada tenta de novo
  }
  writeHaltDedupRecord(rootDir, markNotified(record, key, nowMs));
}

async function main(): Promise<void> {
  const opts = parseHaltBannerArgs(process.argv.slice(2));
  if (opts === null) {
    process.stderr.write(
      "Usage: render-halt-banner.ts --stage <stage> --reason <reason> --action <action> [--no-push]\n",
    );
    process.exit(2);
  }
  const banner = renderHaltBanner(opts);

  const colored = shouldUseColor() ? `${RED_BG_WHITE_FG}${banner}${RESET}` : banner;
  process.stdout.write(colored + "\n");

  // Audible bell on TTY (terminals that support it ring; others ignore).
  if (process.stdout.isTTY) {
    process.stderr.write("\x07");
  }

  if (opts.push) await notifyHaltViaPush(opts);
}

// #3564 (regressão exposta pelo teste novo): sem este guard, `main()` rodava
// incondicionalmente ao IMPORTAR o módulo (mesmo bug que #2834/#2958 já
// corrigiram em `overnight-watchdog.ts`) — qualquer teste que importasse
// `notifyHaltViaPush` daqui rodava `main()` contra o `argv` real do test
// runner (sem --stage/--reason/--action) e o `process.exit(2)` do usage
// matava o processo de teste inteiro. Antes deste arquivo ganhar exports
// testáveis (#3564), nada importava este módulo, então o bug ficou latente.
//
// O guard continua necessário depois do #7215: aquela issue só tirou o
// `exit` de DENTRO do parser (`parseHaltBannerArgs` devolve `null`, quem sai
// é `main()`). O que não pode rodar na importação é `main()` — e é ela que
// o guard protege.
if (isMainModule(import.meta.url)) {
  main();
}

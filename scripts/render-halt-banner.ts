#!/usr/bin/env npx tsx
/**
 * render-halt-banner.ts (#737, notificação Telegram #3564)
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
 * Uso:
 *   npx tsx scripts/render-halt-banner.ts \
 *     --stage "2b — Clarice review" \
 *     --reason "mcp__clarice desconectado" \
 *     --action "reconecte e responda 'retry', ou 'abort' para abortar"
 *
 * Wraps em ANSI red quando stdout é TTY e NO_COLOR não está set. Em
 * Bash tool result do Claude Code, sempre não-TTY → output limpo. Em
 * terminal interativo, fica vermelho. Sino do terminal () emitido
 * no stderr quando TTY.
 *
 * #3564: além do stdout, dispara (fail-soft TOTAL, nunca bloqueia nem atrasa
 * o banner além do timeout de rede) uma notificação Telegram com o mesmo
 * texto (stage/motivo/ação) via `scripts/lib/telegram-notify.ts` — fecha o
 * loop mobile quando o editor não está olhando o terminal. Dedup entre
 * invocações (script roda como processo novo a cada chamada, sem estado em
 * memória sobrevivendo) via um registro JSON pequeno em
 * `data/.telegram-halt-dedup.json` (mesma pasta OneDrive-synced de `data/`,
 * nunca no repo) — chave = `stage|reason|action` (o MESMO halt reportado de
 * novo dentro da janela não reenvia). Se `data/` não existir (clone fresco
 * sem a junction, sessão cloud) ou a escrita falhar, o dedup degrada pra
 * "sempre notifica" — nunca impede o banner de imprimir.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { renderHaltBanner } from "./lib/gate-banner.ts";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  sendTelegramNotification,
  formatHaltNotifyMessage,
  shouldNotify,
  markNotified,
  type DedupRecord,
} from "./lib/telegram-notify.ts";

const RED_BG_WHITE_FG = "\x1b[41m\x1b[97m";
const RESET = "\x1b[0m";

/** Janela de dedup entre halts idênticos (mesmo stage/motivo/ação) — 15 min:
 * generoso o bastante pra cobrir um loop de retry rápido do orchestrator sem
 * silenciar um halt genuinamente novo (ex: reconectou, quebrou nod novo). */
const HALT_DEDUP_WINDOW_MS = 15 * 60_000;

function parseArgs(argv: string[]): { stage: string; reason: string; action: string } {
  const { values } = parseCliArgs(argv);
  if (!values.stage || !values.reason || !values.action) {
    process.stderr.write(
      "Usage: render-halt-banner.ts --stage <stage> --reason <reason> --action <action>\n",
    );
    process.exit(2);
  }
  return { stage: values.stage, reason: values.reason, action: values.action };
}

function shouldUseColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

function haltDedupPath(rootDir: string): string {
  return resolve(rootDir, "data", ".telegram-halt-dedup.json");
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
  /** `sendTelegramNotification` injetável (testes) — evita bater na rede
   * real/depender de credenciais presentes no ambiente de CI. */
  notifyFn?: (text: string) => Promise<{ ok: boolean; skipped?: boolean; error?: string }>;
}

/**
 * Dispara a notificação Telegram do halt (#3564), com dedup por processo
 * (ver doc-comment do módulo). Sempre resolve — nunca lança, nunca faz o
 * caller esperar além do timeout de rede embutido em `sendTelegramNotification`
 * (`TELEGRAM_IO_TIMEOUT_MS`, 10s).
 */
export async function notifyHaltViaTelegram(
  opts: { stage: string; reason: string; action: string },
  env: NotifyHaltOptions = {},
): Promise<void> {
  const rootDir = env.rootDir ?? process.cwd();
  const nowMs = env.nowMs ?? Date.now();
  const notifyFn = env.notifyFn ?? sendTelegramNotification;

  const key = `${opts.stage}|${opts.reason}|${opts.action}`;
  const record = readHaltDedupRecord(rootDir);
  if (!shouldNotify(record, key, nowMs, HALT_DEDUP_WINDOW_MS)) return;

  const result = await notifyFn(formatHaltNotifyMessage(opts.stage, opts.reason, opts.action));
  if (result.skipped) return; // sem credenciais — nada a persistir
  if (!result.ok) {
    process.stderr.write(`[render-halt-banner] Telegram alert falhou: ${result.error}\n`);
    return; // não marca como notificado — próxima chamada tenta de novo
  }
  writeHaltDedupRecord(rootDir, markNotified(record, key, nowMs));
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const banner = renderHaltBanner(opts);

  const colored = shouldUseColor() ? `${RED_BG_WHITE_FG}${banner}${RESET}` : banner;
  process.stdout.write(colored + "\n");

  // Audible bell on TTY (terminals that support it ring; others ignore).
  if (process.stdout.isTTY) {
    process.stderr.write("\x07");
  }

  await notifyHaltViaTelegram(opts);
}

// #3564 (regressão exposta pelo teste novo): sem este guard, `main()` rodava
// incondicionalmente ao IMPORTAR o módulo (mesmo bug que #2834/#2958 já
// corrigiram em `overnight-watchdog.ts`) — qualquer teste que importasse
// `notifyHaltViaTelegram` daqui disparava `parseArgs` contra o `argv` real
// do test runner (sem --stage/--reason/--action) e o `process.exit(2)`
// matava o processo de teste inteiro. Antes deste arquivo ganhar exports
// testáveis (#3564), nada importava este módulo, então o bug ficou latente.
if (isMainModule(import.meta.url)) {
  main();
}

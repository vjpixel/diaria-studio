/**
 * scripts/lib/continuo-ratelimit-notes.ts (#10074)
 *
 * Fila de avisos de pausa/retomada do contínuo por `403 Key limit exceeded`.
 *
 * `hermes/scripts/pause-cron-on-ratelimit.py` imprime mensagens pensadas pro
 * chat ("⏸️ Diária Contínuo pausado ... retomada após 14/10 00:05 UTC",
 * "▶️ Diária Contínuo retomado"). Desde o #10070, quem age primeiro é o timer
 * horário (`scripts/run-continuo-ratelimit-watchdog.ts`), cuja saída só ia
 * pro log da task e pro `run-log.jsonl` em nível `info` (que nenhum alarme
 * lê). Quando o watch diário do Hermes rodava o mesmo Python, o job já
 * estava pausado e o Python ficava em silêncio — o editor nunca sabia que o
 * contínuo tinha parado nem quando voltava.
 *
 * Mecanismo: o wrapper horário ENFILEIRA cada aviso informativo neste
 * arquivo (local da máquina, ao lado do marcador `.paused-by-watchdog`); o
 * watch diário (`hermes/scripts/watch-continuo-health.sh`) DRENA a fila e
 * entrega os avisos no stdout, que o Hermes manda no Telegram (job
 * `no_agent`). É o mesmo canal pra onde as mensagens do Python foram
 * escritas originalmente.
 *
 * Fail-soft: enfileirar ou drenar nunca lança — erro vira string no
 * resultado, o chamador decide o que logar.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export const RATELIMIT_NOTES_FILENAME = ".ratelimit-watchdog-notes.jsonl";

/** `{home}/.hermes/cron/.ratelimit-watchdog-notes.jsonl` — mesmo diretório do
 * marcador `.paused-by-watchdog` do Python. */
export function ratelimitNotesPath(home: string): string {
  return join(home, ".hermes", "cron", RATELIMIT_NOTES_FILENAME);
}

export interface RatelimitNote {
  /** ISO de quando o aviso foi enfileirado. */
  at: string;
  message: string;
}

/** Acrescenta um aviso à fila. Devolve `null` em sucesso ou a mensagem de erro. */
export function appendRatelimitNote(path: string, message: string, now: Date = new Date()): string | null {
  const text = message.trim();
  if (!text) return null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const note: RatelimitNote = { at: now.toISOString(), message: text };
    appendFileSync(path, `${JSON.stringify(note)}\n`, "utf8");
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Linhas da fila → avisos. Linha que não é JSON válido entra crua (nunca
 * some um aviso por formato). */
export function parseRatelimitNotes(raw: string): RatelimitNote[] {
  const notes: RatelimitNote[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Partial<RatelimitNote>;
      if (obj && typeof obj.message === "string" && obj.message.trim()) {
        notes.push({ at: typeof obj.at === "string" ? obj.at : "", message: obj.message.trim() });
        continue;
      }
    } catch {
      // cai no aviso cru abaixo
    }
    notes.push({ at: "", message: t });
  }
  return notes;
}

export interface DrainResult {
  notes: RatelimitNote[];
  error?: string;
}

/**
 * Lê e esvazia a fila. Renomeia antes de ler, pra um aviso que o timer
 * enfileire durante a drenagem cair num arquivo novo (entregue na próxima
 * drenagem) em vez de ser apagado sem ter sido lido.
 */
export function drainRatelimitNotes(path: string): DrainResult {
  if (!existsSync(path)) return { notes: [] };
  const draining = `${path}.draining.${process.pid}`;
  try {
    renameSync(path, draining);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { notes: [] };
    return { notes: [], error: (e as Error).message };
  }
  try {
    const notes = parseRatelimitNotes(readFileSync(draining, "utf8"));
    unlinkSync(draining);
    return { notes };
  } catch (e) {
    return { notes: [], error: (e as Error).message };
  }
}

/** Uma linha por aviso, com o horário UTC em que foi enfileirado. */
export function formatRatelimitNotes(notes: RatelimitNote[]): string {
  return notes
    .map((n) => {
      const d = n.at ? new Date(n.at) : null;
      const when =
        d && !Number.isNaN(d.getTime())
          ? `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`
          : "horário desconhecido";
      return `[contínuo · ${when}] ${n.message.replace(/\s*\r?\n\s*/g, " ")}`;
    })
    .join("\n");
}

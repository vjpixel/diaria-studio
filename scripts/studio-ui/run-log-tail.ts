/**
 * run-log-tail.ts (#3555)
 *
 * Leitura + watch incremental de `data/run-log.jsonl` (path resolvido via
 * `scripts/lib/run-log.ts` — mesmo helper usado por `logEvent`, respeita
 * `platform.config.json > logging.path`). Alimenta `GET /api/events` (SSE):
 * tail inicial no connect + push de linhas novas conforme são appendadas.
 *
 * Duas camadas de detecção de mudança, deliberadamente redundantes:
 *   1. `fs.watch` no diretório-pai — reação quase instantânea na maioria dos
 *      setups.
 *   2. Polling de baixa frequência (default 1s, ajustável) — rede de
 *      segurança. `data/` é uma directory junction pro OneDrive (ver
 *      CLAUDE.md § Setup) e o comportamento de `fs.watch` sobre junctions /
 *      pastas sincronizadas varia por SO e client de sync; nunca confiar
 *      só nele pra um requisito de latência (#3555 aceite: "<2s").
 *
 * Tudo aqui é testável sem subir um servidor HTTP: `readNewRunLogEvents` é
 * uma função pura de leitura por offset; `watchRunLogAppends` aceita
 * `pollIntervalMs` injetável pra testes rápidos.
 */

import {
  existsSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, basename } from "node:path";

/** Parseia um chunk de texto JSONL em objetos, ignorando linhas em branco e malformadas. */
function parseJsonlChunk(chunk: string): unknown[] {
  return chunk
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((e) => e !== null);
}

/** Lê as últimas `n` linhas válidas de um JSONL (usado no tail inicial do SSE). */
export function tailJsonl(logPath: string, n: number): unknown[] {
  if (!existsSync(logPath)) return [];
  let content: string;
  try {
    content = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tail = lines.slice(-n);
  return parseJsonlChunk(tail.join("\n"));
}

export interface ReadResult {
  events: unknown[];
  newSize: number;
}

/**
 * Lê o que foi appendado a `logPath` desde `lastSize` bytes. Se o arquivo
 * encolheu (rotação/truncamento externo), reinicia do byte 0 — nunca lança
 * por causa disso, apenas relê o que existe.
 */
export function readNewRunLogEvents(logPath: string, lastSize: number): ReadResult {
  if (!existsSync(logPath)) return { events: [], newSize: 0 };
  let size: number;
  try {
    size = statSync(logPath).size;
  } catch {
    return { events: [], newSize: lastSize };
  }
  const effectiveLastSize = size < lastSize ? 0 : lastSize;
  if (size === effectiveLastSize) return { events: [], newSize: size };

  const len = size - effectiveLastSize;
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch {
    return { events: [], newSize: effectiveLastSize };
  }
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, effectiveLastSize);
    return { events: parseJsonlChunk(buf.toString("utf8")), newSize: size };
  } finally {
    closeSync(fd);
  }
}

export interface RunLogWatchHandle {
  close: () => void;
}

/**
 * Observa `logPath` e chama `onEvents` com o array de eventos novos sempre
 * que o arquivo cresce. `startSize` permite ao caller decidir se quer
 * incluir eventos já existentes no primeiro disparo (passe `0`) ou só
 * eventos futuros (passe o tamanho atual, o default).
 */
export function watchRunLogAppends(
  logPath: string,
  onEvents: (events: unknown[]) => void,
  opts: { pollIntervalMs?: number; startSize?: number } = {},
): RunLogWatchHandle {
  let lastSize = opts.startSize ?? (existsSync(logPath) ? statSync(logPath).size : 0);

  const poll = () => {
    const { events, newSize } = readNewRunLogEvents(logPath, lastSize);
    lastSize = newSize;
    if (events.length > 0) onEvents(events);
  };

  let watcher: FSWatcher | null = null;
  try {
    const dir = dirname(logPath);
    const target = basename(logPath);
    if (existsSync(dir)) {
      watcher = watch(dir, (_eventType, filename) => {
        if (filename && filename !== target) return;
        poll();
      });
      watcher.on("error", () => {
        // fs.watch pode falhar mid-stream (ex: dir removido) — o polling
        // de baixa frequência abaixo continua cobrindo.
      });
    }
  } catch {
    watcher = null;
  }

  const interval = setInterval(poll, opts.pollIntervalMs ?? 1000);

  return {
    close: () => {
      clearInterval(interval);
      try {
        watcher?.close();
      } catch {
        // no-op
      }
    },
  };
}

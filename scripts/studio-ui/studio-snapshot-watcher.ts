/**
 * studio-snapshot-watcher.ts (#3565)
 *
 * Dispara `pushStudioSnapshot` (de `scripts/studio-snapshot-push.ts`)
 * periodicamente a partir do studio-server — o mecanismo que mantém o
 * espelho read-only no worker `diaria-dashboard` (`GET /studio`, chave KV
 * `studio:snapshot`) atualizado enquanto o Studio local está rodando.
 *
 * Design deliberadamente simples (timer periódico, não `fs.watch`): o estado
 * relevante do snapshot mistura fontes em disco (edições, plan.json
 * overnight/develop) com estado EM MEMÓRIA (gates `AskUserQuestion`
 * pendentes do chat, `studio-chat.ts`) — não há um único diretório pra
 * observar. Um push a cada `intervalMs` (default 5min) + 1 push imediato ao
 * iniciar cobre o objetivo ("dados de HH:MM" no Worker) sem a complexidade
 * de múltiplos `fs.watch` + debounce (`plan-watch.ts`/`run-log-tail.ts`
 * usam essa estratégia porque alimentam SSE ao vivo; aqui o consumidor é um
 * KV externo, refrescado por push, não uma UI que precisa reagir em <1s).
 *
 * Fail-soft TOTAL (invariante, não best-effort — ver `studio-snapshot-push.ts`):
 * uma falha de rede/Cloudflare NUNCA pode derrubar o Studio local. Todo erro
 * — inclusive um lançado inesperadamente por `pushFn` (defensivo: a própria
 * `pushStudioSnapshot` já não lança, mas um `pushFn` injetado em teste
 * poderia) — é capturado e só reportado via `onPush`, nunca propagado.
 */

import { pushStudioSnapshot, type PushStudioSnapshotResult } from "../studio-snapshot-push.ts";

export interface StudioSnapshotWatchHandle {
  close: () => void;
}

export interface StudioSnapshotWatchOptions {
  /** Intervalo entre pushes (ms). Default 5min. */
  intervalMs?: number;
  /** `pushStudioSnapshot` injetável — testes mockam sem tocar disco/rede. */
  pushFn?: (rootDir: string) => Promise<PushStudioSnapshotResult>;
  /** Callback opcional pra observar o resultado de cada tentativa (log,
   * asserts de teste). Nunca lançar aqui — não há guard adicional em volta
   * da chamada a `onPush`. */
  onPush?: (result: PushStudioSnapshotResult | { pushed: false; error: string }) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Inicia o push periódico do snapshot pro KV. Dispara 1x imediatamente (não
 * espera o 1º intervalo) e depois a cada `intervalMs`. `close()` para o
 * timer — idempotente, seguro chamar mais de uma vez.
 */
export function watchAndPushStudioSnapshot(
  rootDir: string,
  opts: StudioSnapshotWatchOptions = {},
): StudioSnapshotWatchHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const pushFn = opts.pushFn ?? ((root: string) => pushStudioSnapshot(root));
  let closed = false;

  const tick = async (): Promise<void> => {
    if (closed) return;
    try {
      const result = await pushFn(rootDir);
      if (!closed) opts.onPush?.(result);
    } catch (err) {
      // Fail-soft total (ver header): mesmo um pushFn injetado que lance é
      // contido aqui — nunca propaga pro caller (que rodaria dentro do
      // studio-server, servindo requests do editor).
      if (!closed) {
        opts.onPush?.({ pushed: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, intervalMs);
  void tick();

  return {
    close: () => {
      closed = true;
      clearInterval(interval);
    },
  };
}

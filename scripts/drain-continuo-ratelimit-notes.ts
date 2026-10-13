/**
 * scripts/drain-continuo-ratelimit-notes.ts (#10074)
 *
 * Drena a fila de avisos de pausa/retomada do contínuo por key limit
 * (`scripts/lib/continuo-ratelimit-notes.ts`) e imprime 1 linha por aviso no
 * stdout. Chamado por `hermes/scripts/watch-continuo-health.sh`, que repassa
 * as linhas pro stdout dele (entregue no Telegram pelo Hermes).
 *
 * Fila vazia/ausente → stdout vazio, exit 0. Falha ao drenar → mensagem no
 * stderr, exit 1 (o watch conta como checagem indeterminada).
 *
 * Uso: `npx tsx scripts/drain-continuo-ratelimit-notes.ts [--home DIR]`
 */

import { homedir } from "node:os";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { drainRatelimitNotes, formatRatelimitNotes, ratelimitNotesPath } from "./lib/continuo-ratelimit-notes.ts";

function main(): number {
  const args = process.argv.slice(2);
  const homeIdx = args.indexOf("--home");
  const home = homeIdx >= 0 && args[homeIdx + 1] ? args[homeIdx + 1] : homedir();
  const { notes, error } = drainRatelimitNotes(ratelimitNotesPath(home));
  if (notes.length > 0) console.log(formatRatelimitNotes(notes));
  if (error) {
    console.error(`[drain-continuo-ratelimit-notes] falha ao drenar a fila: ${error}`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("[drain-continuo-ratelimit-notes] erro fatal:", e) });
}

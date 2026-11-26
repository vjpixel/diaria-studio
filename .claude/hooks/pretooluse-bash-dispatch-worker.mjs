// Thread de um guard do despachante único de PreToolUse/Bash (#14045).
//
// Cada guard de modo `worker` roda numa Worker própria, fora do event loop
// do despachante: um guard síncrono que trava (laço, regex catastrófica) não
// segura os timers do despachante, que o encerra no teto dele com
// `terminate()` e segue com os outros. Recebe `{ url, raw }` em `workerData`
// e devolve `{ out }` (o que o CLI do guard escreveria no stdout) ou
// `{ error }`.

import { parentPort, workerData } from "node:worker_threads";

const { url, raw } = workerData;
let out = "";
try {
  const mod = await import(url);
  if (typeof mod.runHook !== "function") {
    parentPort.postMessage({ error: "não exporta runHook (contrato #14045)" });
  } else {
    await mod.runHook(raw, (s) => {
      out += String(s);
      return true;
    });
    parentPort.postMessage({ out });
  }
} catch (err) {
  parentPort.postMessage({ error: `lançou: ${err?.message ?? err}` });
}

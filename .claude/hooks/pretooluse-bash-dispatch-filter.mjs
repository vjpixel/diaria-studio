// Worker única dos filtros `appliesTo` do despachante (#14302).
//
// Importa os guards `spawn-if-applies` um por vez, na ordem recebida, e manda
// uma mensagem `{ i, applies }` ou `{ i, error }` por guard assim que ele
// decide. A ordem serial é o que deixa o despachante saber qual guard travou:
// o primeiro sem resposta. Ele termina esta Worker nesse caso e abre outra
// para os guards seguintes. Cada filtro recebe o próprio parse do payload,
// para um filtro que mexa no objeto não mudar o que os outros veem.
import { parentPort, workerData } from "node:worker_threads";

const { entries, raw } = workerData;
for (const { i, url } of entries) {
  let message;
  try {
    const mod = await import(url);
    if (typeof mod.appliesTo !== "function") throw new Error("não exporta appliesTo (contrato #14045)");
    message = { i, applies: mod.appliesTo(JSON.parse(raw || "{}")) === true };
  } catch (err) {
    message = { i, error: err?.message ?? String(err) };
  }
  parentPort.postMessage(message);
}

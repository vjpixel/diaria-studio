// log-dedup.js (#3891, item 6) — dedup de eventos de run-log por
// (timestamp+agent+message). Pure, sem DOM/fetch — testável isoladamente
// (mesmo padrão de edicao-stage-age.js/gate-chat-bridge.js).
//
// Problema: eventos de data/run-log.jsonl não têm seq/id (ver
// scripts/lib/run-log.ts > PersistedEvent). No reconnect do SSE
// (`GET /api/events`), o servidor reenvia a TAIL inteira via `log-init`
// (`tailJsonl`, server.ts > handleApiEvents) — SEMPRE, mesmo que o client já
// tivesse essas mesmas linhas de uma conexão anterior (rede oscilando, aba
// em background suspendendo o EventSource, etc.). Sem dedup, o log ao vivo
// (app.js/edicao.js) duplica linhas visíveis a cada reconnect.
//
// Dedup por chave (timestamp+agent+message) resolve sem exigir um seq/id
// novo server-side. Trade-off aceito (documentado na issue): 2 eventos
// GENUINAMENTE distintos com timestamp+agent+message idênticos (mesmo
// milissegundo) colidiriam e um seria descartado — extremamente raro na
// prática (run-log não loga em rajada sub-milissegundo hoje).

/** Chave de dedup de 1 evento de run-log. Nunca lança mesmo com evento
 * malformado (fail-soft, mesma disciplina do resto do parsing de SSE). */
export function logEventKey(event) {
  if (!event || typeof event !== "object") return String(event);
  const ts = event.timestamp ?? "";
  const agent = event.agent ?? "";
  const message = event.message ?? "";
  return `${ts}|${agent}|${message}`;
}

/**
 * Deduplicador com janela deslizante (FIFO) de `maxSize` chaves — cobre
 * folgadamente o tail reenviado no reconnect (`runLogTailSize`, tipicamente
 * bem menor que `maxSize`), sem crescer sem limite numa sessão longa. Uma
 * chave que "sai" da janela pode, em teoria, reaparecer sem ser tratada
 * como duplicata — aceitável: o objetivo é cobrir o reconnect recente, não
 * um cache perene de todo o histórico da sessão.
 */
export function createLogDeduper(maxSize = 500) {
  const seen = new Set();
  const order = [];
  return {
    /** `true` = evento NOVO (nunca visto na janela atual), quem chama deve
     * renderizar/contar; `false` = duplicata, ignorar. */
    isNew(event) {
      const key = logEventKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      order.push(key);
      if (order.length > maxSize) {
        const oldest = order.shift();
        seen.delete(oldest);
      }
      return true;
    },
    size() {
      return seen.size;
    },
  };
}

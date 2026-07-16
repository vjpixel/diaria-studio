/**
 * sse.ts (#3555) — helpers de formatação Server-Sent Events.
 *
 * Puros (sem dependência de `http.ServerResponse`) — o server.ts escreve o
 * resultado direto em `res.write(...)`. Mantidos separados pra serem
 * testáveis sem subir um socket.
 */

/** Formata um evento SSE nomeado com payload JSON. */
export function formatSseEvent(event: string, data: unknown): string {
  const payload = JSON.stringify(data);
  // SSE não permite quebras de linha cruas no campo `data:` — JSON.stringify
  // já não produz newlines reais (\n vira \\n na string), então uma linha basta.
  return `event: ${event}\ndata: ${payload}\n\n`;
}

/** Comentário SSE (linha iniciada com `:`) — usado como heartbeat, ignorado pelo EventSource do browser. */
export function formatSseComment(text: string): string {
  return `: ${text}\n\n`;
}

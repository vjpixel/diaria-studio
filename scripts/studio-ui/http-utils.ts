/**
 * http-utils.ts (#5894)
 *
 * Funções utilitárias HTTP compartilhadas entre `server.ts` e os arquivos de
 * rota em `routes/{feature}.ts`. Extraídas de `server.ts` (#5894 — refactor
 * de server.ts 2389 → ~1700 linhas movendo handleApi* pra routes/).
 *
 * Nenhuma lógica de negócio — só glue de response: serialização JSON +
 * headers de segurança, e leitura com limite de bytes do corpo da request.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { SECURITY_HEADERS } from "./static-serve.ts";

/**
 * responde JSON com Content-Type + Content-Length + X-Content-Type-Options
 * (nosniff — defesa em profundidade #3891). NÃO seta CSP: resposta JSON nunca
 * é renderizada como página.
 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "X-Content-Type-Options": SECURITY_HEADERS["X-Content-Type-Options"],
  });
  res.end(payload);
}

/**
 * lê o corpo da request como string UTF-8, rejeitando se exceder `maxBytes`.
 * Fail-closed: corpo acima do teto aborta a request (req.destroy) + rejeita
 * a Promise — o handler trata como 400.
 */
export function readRequestBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`corpo da request excede o limite de ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

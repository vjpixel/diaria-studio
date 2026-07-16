/**
 * static-serve.ts (#3555)
 *
 * Serve arquivos estáticos da SPA a partir de um diretório-raiz, com o mesmo
 * guard de path traversal de `scripts/serve-preview.ts` (#3546): qualquer
 * request que resolva pra fora de `publicDir` recebe 403 em vez do arquivo.
 * `/` mapeia pra `index.html`.
 *
 * `resolveStaticPath` é pura (sem I/O) — testável isoladamente pro guard de
 * traversal. `serveStaticFile` faz a leitura + resposta HTTP.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { ServerResponse } from "node:http";

const EXT_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

export function mimeFor(path: string): string {
  return EXT_MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve `urlPath` pra um path absoluto dentro de `publicDir`. Retorna
 * `null` quando a resolução escaparia de `publicDir` (path traversal) —
 * caller deve responder 403 nesse caso, nunca seguir a resolução.
 */
export function resolveStaticPath(publicDir: string, urlPath: string): string | null {
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const relPath = decoded === "/" || decoded === "" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = normalize(join(publicDir, relPath));
  if (resolved !== publicDir && !resolved.startsWith(publicDir + sep)) return null;
  return resolved;
}

/**
 * Serve um arquivo estático. Retorna `true` se a request foi respondida
 * (200, 403 ou o caller trata 404 externamente retornando `false`) — `false`
 * significa "arquivo não encontrado, não escrevi nada na response ainda",
 * deixando o caller decidir o fallback (ex: 404 JSON de API vs HTML).
 */
export function serveStaticFile(publicDir: string, urlPath: string, res: ServerResponse): boolean {
  const resolved = resolveStaticPath(publicDir, urlPath);
  if (!resolved) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return true;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return false;
  }
  const body = readFileSync(resolved);
  res.writeHead(200, { "Content-Type": mimeFor(resolved), "Content-Length": body.length });
  res.end(body);
  return true;
}

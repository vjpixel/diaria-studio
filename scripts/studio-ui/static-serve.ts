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
 *
 * **ETag + Cache-Control (#3891, item 5).** Cada navegação MPA (o Studio não
 * é uma SPA client-routed — cada página é um `.html` próprio, ver server.ts)
 * rebaixava chat-drawer.js/nav.js/tokens.generated.css do zero, perceptível
 * via tunnel/celular (#3560, latência maior que loopback). `Cache-Control:
 * no-cache` (o browser SEMPRE revalida antes de reusar, mas pode fazer isso
 * com um `If-None-Match` condicional em vez de baixar o corpo de novo) + um
 * `ETag` barato derivado de `mtime+size` (sem hashear o conteúdo) resolve sem
 * risco de staleness: qualquer escrita nova no arquivo muda `mtime` → ETag
 * novo → a próxima request sempre pega o conteúdo fresco, nunca serve stale.
 * Deliberadamente NÃO é `Cache-Control: immutable`/`max-age` alto — perderia
 * o requisito de "nunca staleness" por um ganho marginal (loopback/tunnel já
 * é rápido; o alvo aqui é só cortar a RE-TRANSFERÊNCIA do corpo, não a
 * revalidação em si).
 *
 * **Headers de segurança (#3891, item 10).** `X-Content-Type-Options:
 * nosniff` + uma CSP básica (`default-src 'self'`, restrito ao próprio
 * processo) em toda resposta — defesa em profundidade barata mesmo atrás do
 * Cloudflare Access/tunnel. `'unsafe-inline'` em script/style continua
 * liberado porque os HTMLs já têm `<script>window.STUDIO_PAGE=...</script>`
 * e atributos `style="display:none"` inline sem infra de nonce nesta fatia
 * — não vale reescrever isso agora só pra endurecer a CSP além do que o
 * item pedia.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

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

/** Headers de segurança aplicados a TODA resposta de `serveStaticFile` (200,
 * 304 e 403) — ver doc-comment do módulo. Exportado pra `sendJson` (server.ts)
 * reusar o mesmo `X-Content-Type-Options`, e pros testes afirmarem contra a
 * MESMA fonte (nunca um literal duplicado que pode divergir silenciosamente). */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
};

/** ETag fraco (`W/"..."`) derivado de `mtime+size` — barato (sem ler nem
 * hashear o conteúdo do arquivo) e suficiente pro caso de uso: assets locais
 * do próprio processo do studio-server, nunca conteúdo user-uploaded onde
 * colisão importaria de verdade. */
export function computeETag(mtimeMs: number, size: number): string {
  return `W/"${mtimeMs}-${size}"`;
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
 * (200, 304, 403 ou o caller trata 404 externamente retornando `false`) —
 * `false` significa "arquivo não encontrado, não escrevi nada na response
 * ainda", deixando o caller decidir o fallback (ex: 404 JSON de API vs HTML).
 *
 * `req` é opcional (retrocompatível com callers que não têm o
 * `IncomingMessage` à mão) — sem ele, a resposta 200 ainda carrega
 * `ETag`/`Cache-Control`, só nunca resolve pra 304 (não há `If-None-Match`
 * pra comparar).
 */
export function serveStaticFile(
  publicDir: string,
  urlPath: string,
  res: ServerResponse,
  req?: IncomingMessage,
): boolean {
  const resolved = resolveStaticPath(publicDir, urlPath);
  if (!resolved) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
    res.end("Forbidden");
    return true;
  }
  if (!existsSync(resolved)) return false;
  const stat = statSync(resolved);
  if (!stat.isFile()) return false;

  const etag = computeETag(stat.mtimeMs, stat.size);
  const ifNoneMatch = req?.headers["if-none-match"];
  if (ifNoneMatch === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
    res.end();
    return true;
  }

  const body = readFileSync(resolved);
  res.writeHead(200, {
    "Content-Type": mimeFor(resolved),
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    ETag: etag,
    ...SECURITY_HEADERS,
  });
  res.end(body);
  return true;
}

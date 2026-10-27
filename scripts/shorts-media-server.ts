/**
 * shorts-media-server.ts (#11265)
 *
 * Servidor HTTP mínimo, SOMENTE LEITURA, que expõe o vertical do dia pela
 * internet atrás do Cloudflare Tunnel do 300 (`media.diar.ia.br` →
 * `http://127.0.0.1:4175`). É de onde a Graph API (Reels agendado na fila do
 * Worker), a Buffer (X) e a Threads API baixam o `video_url` no horário do
 * disparo. Quem coloca o arquivo na pasta é o `publish-shorts.ts --publish`
 * (backend `tunnel`, scripts/lib/diaria/shorts-public-video.ts).
 *
 * Superfície, de propósito estreita (decisão do editor, briefing 261027d):
 *   - só GET/HEAD; qualquer outro método → 405;
 *   - só o caminho `/diaria-comentada-{AAMMDD}-short.mp4` (regex exata, sem
 *     subpasta, sem `..`, sem encode) → nada de path traversal nem listagem;
 *     `/healthz` → 200 "ok" (sonda do planejamento); o resto → 404;
 *   - arquivo precisa ser regular e não-symlink (`lstat`);
 *   - bind só em 127.0.0.1 — a única entrada externa é o túnel;
 *   - `Range: bytes=` de intervalo único (a Graph e players baixam em partes);
 *   - `Cache-Control: no-store`: a borda nunca entrega um vertical velho se o
 *     mesmo dia for re-renderizado (custo: cada download sai do 300).
 *
 * Uso: npx tsx scripts/shorts-media-server.ts --dir ~/diaria-media/shorts [--port 4175]
 * Unit: scripts/studio/setup-shorts-media-service-linux.sh. Runbook: docs/shorts-media-tunnel.md.
 */

import { createReadStream, lstatSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isMainModule } from "./lib/cli-args.ts";
import { SHORT_VIDEO_NAME_RE } from "./lib/diaria/shorts-public-video.ts";

export const DEFAULT_MEDIA_PORT = 4175;

export type MediaFileInfo = { kind: "file"; size: number } | { kind: "missing" } | { kind: "not_regular" };

export type MediaResponse =
  | { status: 200; headers: Record<string, string>; body: "ok" }
  | { status: 200 | 206; headers: Record<string, string>; file: { name: string; start: number; end: number } | null }
  | { status: 404 | 405 | 416; headers: Record<string, string>; body: string };

const BASE_HEADERS = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };

/**
 * Pure: decide a resposta. `stat` só é chamado depois que o nome passou na
 * regex — nada fora do padrão chega a tocar o disco.
 */
export function resolveMediaRequest(
  method: string,
  rawUrl: string,
  range: string | undefined,
  stat: (name: string) => MediaFileInfo,
): MediaResponse {
  if (method !== "GET" && method !== "HEAD") {
    return { status: 405, headers: { ...BASE_HEADERS, Allow: "GET, HEAD", "Content-Type": "text/plain" }, body: "method not allowed" };
  }
  const path = rawUrl.split("?")[0];
  if (path === "/healthz") return { status: 200, headers: { ...BASE_HEADERS, "Content-Type": "text/plain" }, body: "ok" };
  const notFound = { status: 404 as const, headers: { ...BASE_HEADERS, "Content-Type": "text/plain" }, body: "not found" };
  if (!path.startsWith("/")) return notFound;
  const name = path.slice(1);
  if (!SHORT_VIDEO_NAME_RE.test(name)) return notFound;
  const info = stat(name);
  if (info.kind !== "file") return notFound;
  const size = info.size;
  const headers: Record<string, string> = { ...BASE_HEADERS, "Content-Type": "video/mp4", "Accept-Ranges": "bytes" };
  const wantsBody = method === "GET";
  if (range !== undefined) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start: number;
    let end: number;
    if (!m || (m[1] === "" && m[2] === "")) {
      return { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}`, "Content-Type": "text/plain" }, body: "range not satisfiable" };
    }
    if (m[1] === "") {
      // sufixo: últimos N bytes
      const n = Number(m[2]);
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (size === 0 || start >= size || start > end) {
      return { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}`, "Content-Type": "text/plain" }, body: "range not satisfiable" };
    }
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    headers["Content-Length"] = String(end - start + 1);
    return { status: 206, headers, file: wantsBody ? { name, start, end } : null };
  }
  headers["Content-Length"] = String(size);
  return { status: 200, headers, file: wantsBody && size > 0 ? { name, start: 0, end: size - 1 } : null };
}

/** `lstat` que recusa symlink e não-regular (nunca segue link pra fora da pasta). */
export function statMediaFile(dir: string, name: string): MediaFileInfo {
  try {
    const st = lstatSync(join(dir, name));
    if (!st.isFile()) return { kind: "not_regular" };
    return { kind: "file", size: st.size };
  } catch {
    return { kind: "missing" };
  }
}

export function handleMediaRequest(dir: string, req: IncomingMessage, res: ServerResponse): void {
  const r = resolveMediaRequest(req.method ?? "GET", req.url ?? "/", req.headers.range, (n) => statMediaFile(dir, n));
  res.writeHead(r.status, r.headers);
  if ("body" in r) {
    res.end(req.method === "HEAD" ? undefined : r.body);
    return;
  }
  if (!r.file) {
    res.end();
    return;
  }
  const stream = createReadStream(join(dir, r.file.name), { start: r.file.start, end: r.file.end });
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const { values } = parseArgs({ args: argv, options: { dir: { type: "string" }, port: { type: "string" } } });
  const dirRaw = values.dir ?? process.env.SHORTS_MEDIA_DIR;
  if (!dirRaw) {
    console.error("shorts-media-server: passe --dir (ou SHORTS_MEDIA_DIR) com a pasta dos verticais (#11265)");
    process.exit(2);
  }
  const dir = expandHome(dirRaw);
  const port = Number(values.port ?? DEFAULT_MEDIA_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`shorts-media-server: porta inválida ${values.port}`);
    process.exit(2);
  }
  const server = createServer((req, res) => handleMediaRequest(dir, req, res));
  server.listen(port, "127.0.0.1", () => {
    console.error(`shorts-media-server: servindo ${dir} em http://127.0.0.1:${port} (só leitura, só diaria-comentada-AAMMDD-short.mp4)`);
  });
}

if (isMainModule(import.meta.url)) main();

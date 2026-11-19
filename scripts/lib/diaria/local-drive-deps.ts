/**
 * local-drive-deps.ts (#13712) — `FetchDriveVideoDeps` lido do DISCO em vez da
 * Drive API, para o dia em que o export fica fora do Drive (`C:/diaria-video-local`,
 * mesma raiz do `--drive-root`/`DIARIA_VIDEO_DRIVE_ROOT` da montagem, #13308).
 *
 * A raiz tem o mesmo desenho da pasta de vídeo do Drive: `{raiz}/{AAMMDD}/Final/`
 * (e `Editados/`). O id de um item é `local:` + o caminho relativo à raiz com `/`
 * (a raiz é `local:`). Só leitura: a promoção (POST) responde 405 e vira o aviso
 * de sempre do `promoteToFinal`.
 */

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import type { FetchDriveVideoDeps } from "../../fetch-drive-video.ts";

export const LOCAL_ID_PREFIX = "local:";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export interface VideoDims {
  width?: number;
  height?: number;
  durationMillis?: string;
}

/** ffprobe fail-soft: sem ffprobe/saída ilegível → `{}` (a seleção cai em `orientation-unknown`). */
export function probeVideoDims(path: string): VideoDims {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", path],
    { encoding: "utf8", timeout: 60_000 },
  );
  if (r.error || r.status !== 0) return {};
  try {
    const j = JSON.parse(r.stdout) as { streams?: { width?: number; height?: number }[]; format?: { duration?: string } };
    const s = j.streams?.[0];
    const d = Number(j.format?.duration);
    return {
      ...(s?.width ? { width: s.width } : {}),
      ...(s?.height ? { height: s.height } : {}),
      ...(Number.isFinite(d) && d > 0 ? { durationMillis: String(Math.round(d * 1000)) } : {}),
    };
  } catch {
    return {};
  }
}

export function localIdToPath(root: string, id: string): string {
  if (!id.startsWith(LOCAL_ID_PREFIX)) throw new Error(`id local inválido: ${id}`);
  const rel = id.slice(LOCAL_ID_PREFIX.length);
  const abs = resolve(root, rel);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) throw new Error(`id fora da raiz local: ${id}`);
  return abs;
}

function describe(root: string, abs: string, probe: (p: string) => VideoDims) {
  const st = statSync(abs);
  const rel = resolve(abs).slice(resolve(root).length).split(sep).filter(Boolean).join("/");
  const isDir = st.isDirectory();
  const isMp4 = !isDir && /\.mp4$/i.test(abs);
  const dims = isMp4 ? probe(abs) : {};
  return {
    id: `${LOCAL_ID_PREFIX}${rel}`,
    name: basename(abs),
    mimeType: isDir ? FOLDER_MIME : isMp4 ? "video/mp4" : /\.(jpe?g)$/i.test(abs) ? "image/jpeg" : /\.png$/i.test(abs) ? "image/png" : "application/octet-stream",
    createdTime: st.birthtime.toISOString(),
    modifiedTime: st.mtime.toISOString(),
    ...(isDir ? {} : { size: String(st.size) }),
    ...(isMp4 && Object.keys(dims).length > 0 ? { videoMediaMetadata: dims } : {}),
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function makeLocalDriveDeps(root: string, probe: (p: string) => VideoDims = probeVideoDims): FetchDriveVideoDeps {
  return {
    async driveFetch(url, init) {
      if (init?.method === "POST") return json({ error: "Drive local é só leitura (#13712)" }, 405);
      const u = new URL(url);
      const m = /\/files(?:\/([^/]+))?$/.exec(u.pathname);
      if (!m) return json({ error: `rota não suportada: ${u.pathname}` }, 404);
      try {
        if (m[1]) {
          const abs = localIdToPath(root, decodeURIComponent(m[1]));
          if (!existsSync(abs)) return json({ error: "não encontrado" }, 404);
          if (u.searchParams.get("alt") === "media") {
            const st = statSync(abs);
            return new Response(Readable.toWeb(createReadStream(abs)) as unknown as ReadableStream, {
              status: 200,
              headers: { "content-type": /\.mp4$/i.test(abs) ? "video/mp4" : "application/octet-stream", "content-length": String(st.size) },
            });
          }
          return json(describe(root, abs, probe));
        }
        const parent = /'([^']*)' in parents/.exec(u.searchParams.get("q") ?? "")?.[1];
        if (parent === undefined) return json({ error: "consulta sem pasta-pai" }, 400);
        const dir = localIdToPath(root, parent.replace(/\\'/g, "'"));
        if (!existsSync(dir)) return json({ files: [] });
        return json({ files: readdirSync(dir).map((n) => describe(root, join(dir, n), probe)) });
      } catch (e) {
        return json({ error: (e as Error).message }, 400);
      }
    },
  };
}

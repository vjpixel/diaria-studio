#!/usr/bin/env node
/**
 * scripts/link-video-d1.ts (#10772)
 *
 * Link do vídeo do dia (YouTube) no post do D1: LinkedIn página (1º
 * comentário), X @diariabr (1º link do texto curto), Threads diar.ia.br
 * (texto curto) e Facebook diar.ia.br (linha no post) — decisão do editor de
 * 22/10/2026 no #10772.
 *
 * Uso:
 *   npx tsx scripts/link-video-d1.ts AAMMDD --video-url URL [--save]
 *     [--edition-dir DIR] [--now ISO]
 *
 * O que faz:
 *   - valida e normaliza a URL (`https://youtu.be/{id}`);
 *   - `--save` grava `_internal/05-video-url.txt`. Com o arquivo presente
 *     ANTES do Stage 5, `prep-twitter-posts.ts`, `publish-threads.ts` e
 *     `publish-facebook.ts` já põem o link no texto do D1 (X e Threads só se
 *     couber no limite do canal);
 *   - imprime, por destino, o plano para os posts do D1 que JÁ foram
 *     agendados/publicados (`_internal/06-social-published.json`): editar o
 *     post agendado ou comentar/responder depois do disparo.
 *
 * Nunca publica, edita nem comenta nada: a execução do plano (editar o
 * payload na fila do Worker / Buffer, comentar como organização no LinkedIn,
 * comentar no Facebook, responder no Threads e no X) segue pendente no #10772.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import {
  D1_VIDEO_URL_FILE,
  normalizeYouTubeVideoUrl,
  planD1VideoLink,
  type D1PostEntryLike,
} from "./lib/diaria/d1-video-link.ts";

function readPublishedEntries(dir: string): { entries: D1PostEntryLike[]; source: string | null } {
  for (const p of [join(dir, "_internal", "06-social-published.json"), join(dir, "06-social-published.json")]) {
    if (!existsSync(p)) continue;
    const parsed = JSON.parse(readFileSync(p, "utf8")) as { posts?: unknown };
    if (!Array.isArray(parsed.posts)) throw new Error(`${p}: campo "posts" ausente ou não é lista`);
    return { entries: parsed.posts as D1PostEntryLike[], source: p };
  }
  return { entries: [], source: null };
}

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const aammdd = positional[0];
  const rawUrl = values["video-url"];
  if (!aammdd || !/^\d{6}$/.test(aammdd) || !rawUrl) {
    console.error("uso: link-video-d1.ts AAMMDD --video-url URL [--save] [--edition-dir DIR] [--now ISO]");
    return 2;
  }
  const videoUrl = normalizeYouTubeVideoUrl(rawUrl);
  const now = values["now"] ? new Date(values["now"]) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now inválido: ${JSON.stringify(values["now"])}`);

  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  if (!existsSync(dir)) {
    console.error(`link-video-d1: ${dir} não existe`);
    return 1;
  }

  const urlFile = join(dir, D1_VIDEO_URL_FILE);
  if (flags.has("save")) {
    mkdirSync(dirname(urlFile), { recursive: true });
    writeFileSync(urlFile, `${videoUrl}\n`, "utf8");
    console.error(`[ok] ${urlFile} gravado — o Stage 5 põe o link no D1 de X, Threads e Facebook`);
  }

  const { entries, source } = readPublishedEntries(dir);
  const steps = planD1VideoLink({ videoUrl, entries, now });
  console.log(
    JSON.stringify(
      {
        dry_run: true,
        edition: aammdd,
        video_url: videoUrl,
        video_url_file: flags.has("save") ? urlFile : existsSync(urlFile) ? urlFile : null,
        social_published: source,
        steps,
      },
      null,
      2,
    ),
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("link-video-d1:", e instanceof Error ? e.message : e) });
}

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
 *   npx tsx scripts/link-video-d1.ts AAMMDD [--video-url URL] [--save]
 *     [--assume-public] [--edition-dir DIR] [--now ISO]
 *
 * O que faz:
 *   - valida e normaliza a URL (`https://youtu.be/{id}`). Sem `--video-url`,
 *     usa a `url` do registro do upload (`_internal/05-youtube-published.json`,
 *     `publish-youtube.ts --upload`);
 *   - recusa (exit 1, nada gravado) vídeo que o leitor não abre (#10858): se o
 *     registro do upload é deste vídeo e o estado relido é privado sem
 *     agendamento, indeterminado, ou agendado para depois do post do D1. O
 *     estado do registro é o da releitura no upload — se o editor publicou à
 *     mão no Studio depois, `--assume-public` libera;
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
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import {
  D1_VIDEO_URL_FILE,
  normalizeYouTubeVideoUrl,
  planD1VideoLink,
  type D1PostEntryLike,
} from "./lib/diaria/d1-video-link.ts";
import { d1SocialSlotAt, gateVideoLink, readYouTubeRecordSummary } from "./lib/diaria/youtube-video-link-gate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadSocialConfig(): Record<string, unknown> | null {
  const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")) as {
    publishing?: { social?: Record<string, unknown> };
  };
  return cfg.publishing?.social ?? null;
}

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
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error(
      "uso: link-video-d1.ts AAMMDD [--video-url URL] [--save] [--assume-public] [--edition-dir DIR] [--now ISO]",
    );
    return 2;
  }
  const now = values["now"] ? new Date(values["now"]) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`--now inválido: ${JSON.stringify(values["now"])}`);

  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  if (!existsSync(dir)) {
    console.error(`link-video-d1: ${dir} não existe`);
    return 1;
  }

  // #10858: o registro do upload diz se o vídeo abre para o leitor.
  const record = readYouTubeRecordSummary(dir);
  const rawUrl = values["video-url"] ?? record?.url ?? null;
  if (!rawUrl) {
    console.error(
      `link-video-d1: sem --video-url e sem url no registro do upload (${record?.path ?? "_internal/05-youtube-published.json ausente"})`,
    );
    return 2;
  }
  const videoUrl = normalizeYouTubeVideoUrl(rawUrl);
  const gate = gateVideoLink({ videoUrl, record, d1SlotAt: d1SocialSlotAt(aammdd, loadSocialConfig()) });
  if (!gate.ok) {
    if (!flags.has("assume-public")) {
      console.error(
        `link-video-d1: recusado — ${gate.reason}. Nada gravado. Publique (ou agende antes do post do D1) no YouTube Studio ` +
          "e rode de novo com --assume-public (#10858).",
      );
      return 1;
    }
    console.error(`[aviso] --assume-public: ${gate.reason} — seguindo porque o editor confirmou o vídeo público no Studio`);
  } else if (!gate.record_matched) {
    console.error(`[aviso] ${gate.reason}`);
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
        video_link_gate: gate,
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

#!/usr/bin/env node
/**
 * scripts/short-vertical-cover.ts (#13708) — o Passo B3a do `/diaria-publica`
 * (capa vertical do YouTube Shorts pelo Studio web, #12254) com estado no
 * registro, dono automático e fechamento por comando.
 *
 * Uso:
 *   npx tsx scripts/short-vertical-cover.ts status AAMMDD [--edition-dir DIR]
 *   npx tsx scripts/short-vertical-cover.ts defer AAMMDD [--at ISO] [--task NOME] [--reason TEXTO] [--edition-dir DIR]
 *   npx tsx scripts/short-vertical-cover.ts confirm AAMMDD --id VIDEO_ID [--studio-persisted] [--feed-check SAIDA.json] [--edition-dir DIR]
 *
 * - `status`: JSON com o estado (`not-applicable`, `done`, `pending`). Exit 0
 *   = `done` ou `not-applicable`; 1 = `pending` (com ou sem dono); 2 = uso
 *   errado ou registro ilegível.
 * - `defer`: sem Chrome na sessão, registra o dono do passo em
 *   `_internal/06-short-vertical-cover-owner.json` (`agent-scheduled-task`,
 *   no formato dos donos do #11550) e imprime o `command`/`at` da task
 *   one-shot que a skill cria. Só com o passo `pending`.
 * - `confirm`: depois de aplicar a capa no Studio web e conferir após reload
 *   (`--studio-persisted`) e/ou com a saída do `check-short-feed-cover.ts`
 *   gravada em arquivo (`--feed-check`, só o `sardefault.jpg` do mesmo Short,
 *   veredito `capa` quando sozinho), troca só `cover.vertical_feed` da entrada
 *   `youtube_shorts` para `"studio_web"` (e grava `cover.feed_check`), sob o
 *   lock do registro. O `--id` precisa ser o do Short registrado.
 *
 * Não chama YouTube, Studio nem Chrome: só lê/grava arquivos da edição.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { updateShortEntry } from "./lib/diaria/shorts-published-store.ts";
import {
  SHORT_VERTICAL_COVER_DESTINATION,
  buildShortVerticalCoverOwner,
  confirmedVerticalCover,
  describeShortVerticalCoverStep,
  parseFeedCheck,
  readShortVerticalCoverStep,
  writeShortVerticalCoverOwner,
  youtubeVideoIdOf,
  type ShortVerticalCoverStep,
} from "./lib/diaria/short-vertical-cover-step.ts";

const USAGE =
  "uso: short-vertical-cover.ts status AAMMDD [--edition-dir DIR]\n" +
  "     short-vertical-cover.ts defer AAMMDD [--at ISO] [--task NOME] [--reason TEXTO] [--edition-dir DIR]\n" +
  "     short-vertical-cover.ts confirm AAMMDD --id VIDEO_ID [--studio-persisted] [--feed-check SAIDA.json] [--edition-dir DIR]";

export interface ShortVerticalCoverDeps {
  log: (l: string) => void;
  err: (l: string) => void;
  now: () => Date;
}

const defaultDeps: ShortVerticalCoverDeps = { log: (l) => console.log(l), err: (l) => console.error(l), now: () => new Date() };

export async function main(argv: string[] = process.argv.slice(2), deps: ShortVerticalCoverDeps = defaultDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values, flags, positional } = parseArgs(rest);
  const aammdd = positional[0];
  if (!cmd || !["status", "defer", "confirm"].includes(cmd) || !aammdd || !/^\d{6}$/.test(aammdd)) {
    deps.err(USAGE);
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  if (!existsSync(dir)) {
    deps.err(`short-vertical-cover: ${dir} não existe`);
    return 2;
  }
  let step: ShortVerticalCoverStep;
  try {
    step = readShortVerticalCoverStep(dir, aammdd);
  } catch (e) {
    deps.err(`short-vertical-cover: ${(e as Error).message}`);
    return 2;
  }

  if (cmd === "status") {
    const d = describeShortVerticalCoverStep(aammdd, step);
    if (d.problem) deps.err(`[pendente] ${d.problem}`);
    if (d.note) deps.err(`[ok] ${d.note}`);
    deps.log(JSON.stringify(step, null, 2));
    return step.state === "pending" ? 1 : 0;
  }

  if (cmd === "defer") {
    if (step.state !== "pending") {
      deps.err(`short-vertical-cover: nada a delegar (passo ${step.state})`);
      deps.log(JSON.stringify(step, null, 2));
      return 1;
    }
    try {
      const owner = buildShortVerticalCoverOwner({
        aammdd,
        videoId: step.video_id,
        now: deps.now(),
        at: values["at"],
        task: values["task"],
        reason: values["reason"],
      });
      const path = writeShortVerticalCoverOwner(dir, owner);
      deps.err(`[ok] dono do Passo B3a registrado em ${path}: criar a task one-shot para ${owner.at} com o comando ${owner.command}`);
      deps.log(JSON.stringify({ ok: true, owner }, null, 2));
      return 0;
    } catch (e) {
      deps.err(`short-vertical-cover: ${(e as Error).message}`);
      return 1;
    }
  }

  // confirm
  const id = values["id"]?.trim();
  if (!id) {
    deps.err("short-vertical-cover confirm: --id VIDEO_ID obrigatório");
    deps.err(USAGE);
    return 2;
  }
  if (step.state === "not-applicable") {
    deps.err(`short-vertical-cover: ${step.reason}: nada a confirmar`);
    return 1;
  }
  if (step.video_id !== id) {
    deps.err(`short-vertical-cover: --id ${id} não é o Short registrado (${step.video_id ?? "sem id"})`);
    return 1;
  }
  const feedPath = values["feed-check"];
  try {
    const feedCheck = feedPath ? parseFeedCheck(readFileSync(resolve(feedPath), "utf8"), id, deps.now()) : null;
    const studioPersisted = flags.has("studio-persisted");
    const updated = updateShortEntry(dir, aammdd, "main", SHORT_VERTICAL_COVER_DESTINATION, (entry) => {
      if (youtubeVideoIdOf(entry) !== id) throw new Error(`a entrada ${SHORT_VERTICAL_COVER_DESTINATION} do registro principal é de outro vídeo`);
      return { ...entry, cover: confirmedVerticalCover(entry.cover, { studioPersisted, feedCheck }) };
    });
    deps.err(
      `[ok] capa vertical do Short ${id}: studio_web` +
        (studioPersisted ? " (persistiu após reload no Studio)" : "") +
        (feedCheck ? `; feed: ${feedCheck.verdict}${feedCheck.distance !== undefined ? `, distância ${feedCheck.distance.toFixed(3)}` : ""}` : "; verificação do feed não registrada"),
    );
    deps.log(JSON.stringify({ ok: true, entry: updated }, null, 2));
    return 0;
  } catch (e) {
    deps.err(`short-vertical-cover: ${(e as Error).message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error("short-vertical-cover:", e instanceof Error ? e.message : e);
      process.exit(2);
    },
  );
}

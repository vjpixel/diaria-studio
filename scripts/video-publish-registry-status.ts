#!/usr/bin/env node
/**
 * scripts/video-publish-registry-status.ts (#11741)
 *
 * Relê os registros de publicação dos vídeos da edição — o horizontal
 * (`_internal/05-youtube-published.json`, de `publish-youtube.ts --upload`) e
 * o vertical (`_internal/06-shorts-published*.json`, de `publish-shorts.ts
 * --publish`, todos os escritores unidos) — e diz o que foi registrado desde
 * um instante. Só leitura: não chama API, não grava nada.
 *
 * Uso:
 *   npx tsx scripts/video-publish-registry-status.ts AAMMDD [--since ISO] [--edition-dir DIR]
 *
 * Para que serve: a `/diaria-publica-video` roda isto depois de QUALQUER
 * interrupção ou rejeição de uma chamada de publisher, antes de seguir
 * (decisão do editor, #11741). Em 261030 duas chamadas rejeitadas no app
 * parecem ter publicado mesmo assim — hipótese: a interrupção não mata o
 * processo já em execução (camada de harness, ver
 * `scripts/lib/diaria/publish-confirm.ts`). Com `--since` = o instante da
 * chamada interrompida, `registered_since` lista o que o processo
 * sobrevivente gravou. Um destino nessa lista saiu (ou pode ter saído, no
 * caso de `in_progress`/`upload_indeterminado`/`send_unknown`): relatar ao
 * editor, nunca publicar de novo.
 *
 * Saída: JSON no stdout. Exit 0 = registros lidos; exit 1 = algum registro
 * ilegível (não dá para saber o que saiu: conferir as contas antes de
 * qualquer nova chamada); exit 2 = uso.
 */
import { join, resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import type { ShortsPublishedFile } from "./lib/diaria/short-video.ts";
import { readPublishedRecord, type PublishedRecordRead } from "./publish-youtube.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./lib/diaria/youtube-upload.ts";

export type RegistryRead<T> = { ok: true; value: T } | { ok: false; error: string };

export interface VideoRegistryStatusInput {
  aammdd: string;
  since: string | null;
  youtube: RegistryRead<PublishedRecordRead>;
  shorts: RegistryRead<ShortsPublishedFile>;
}

export interface YouTubeStatusLine {
  kind: "none" | "done" | "pending" | "unreadable";
  videoId?: string;
  url?: string;
  state?: string;
  status?: string;
  at?: string;
  error?: string;
  since_match?: boolean;
}

export interface ShortsStatusLine {
  destination: string;
  status: string;
  url?: string;
  at: string;
  since_match?: boolean;
}

export interface VideoRegistryStatus {
  aammdd: string;
  since: string | null;
  youtube: YouTubeStatusLine;
  shorts: { kind: "ok"; entries: ShortsStatusLine[] } | { kind: "unreadable"; error: string };
  /** Só com `since`: destinos com registro em `at >= since` (`youtube` para o horizontal). */
  registered_since: string[] | null;
  verdict: "unreadable" | "registered-since" | "nothing-since" | "no-cutoff";
  message: string;
}

function sinceMatch(at: string | undefined, sinceMs: number | null): boolean | undefined {
  if (sinceMs === null) return undefined;
  const t = at ? Date.parse(at) : NaN;
  // Registro sem data legível conta como "pode ter saído depois": nunca esconde.
  return Number.isNaN(t) ? true : t >= sinceMs;
}

/** Pure: resumo dos dois registros, com o corte `since` quando houver. */
export function summarizeVideoRegistries(input: VideoRegistryStatusInput): VideoRegistryStatus {
  const sinceMs = input.since === null ? null : Date.parse(input.since);
  if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error(`--since inválido: ${input.since}`);

  let youtube: YouTubeStatusLine;
  if (!input.youtube.ok) youtube = { kind: "unreadable", error: input.youtube.error };
  else if (input.youtube.value.kind === "none") youtube = { kind: "none" };
  else if (input.youtube.value.kind === "done") {
    const r = input.youtube.value.record;
    youtube = { kind: "done", videoId: r.videoId, url: r.url, state: r.state, at: r.uploadedAt, since_match: sinceMatch(r.uploadedAt, sinceMs) };
  } else {
    const s = input.youtube.value.sentinel;
    youtube = { kind: "pending", status: s.status, at: s.at, since_match: sinceMatch(s.at, sinceMs) };
  }
  if (youtube.since_match === undefined) delete youtube.since_match;

  const shorts: VideoRegistryStatus["shorts"] = input.shorts.ok
    ? {
        kind: "ok",
        entries: input.shorts.value.entries.map((e) => {
          const line: ShortsStatusLine = { destination: e.destination, status: e.status, ...(e.url ? { url: e.url } : {}), at: e.at };
          const m = sinceMatch(e.at, sinceMs);
          return m === undefined ? line : { ...line, since_match: m };
        }),
      }
    : { kind: "unreadable", error: input.shorts.error };

  const unreadable = youtube.kind === "unreadable" || shorts.kind === "unreadable";
  let registered: string[] | null = null;
  if (sinceMs !== null) {
    registered = [
      ...(youtube.since_match ? ["youtube"] : []),
      ...(shorts.kind === "ok" ? shorts.entries.filter((e) => e.since_match).map((e) => e.destination) : []),
    ];
  }

  let verdict: VideoRegistryStatus["verdict"];
  let message: string;
  if (unreadable) {
    verdict = "unreadable";
    message =
      "registro ilegível: não dá para saber o que saiu — conferir o canal/as contas antes de qualquer nova chamada de publisher (#11741)";
  } else if (registered === null) {
    verdict = "no-cutoff";
    message = "sem --since: estado atual dos registros, sem corte de tempo";
  } else if (registered.length > 0) {
    verdict = "registered-since";
    message =
      `registrado desde ${input.since}: ${registered.join(", ")} — o processo da chamada interrompida pode ter seguido vivo e publicado. ` +
      "Relatar ao editor como saído (estado normalizado, #573) e nunca publicar esses destinos de novo (#11741)";
  } else {
    verdict = "nothing-since";
    message = `nada registrado desde ${input.since}. A interrupção conta como "não": nova chamada só com novo "pode publicar" do editor (#11741)`;
  }
  return { aammdd: input.aammdd, since: input.since, youtube, shorts, registered_since: registered, verdict, message };
}

function readSafely<T>(read: () => T): RegistryRead<T> {
  try {
    return { ok: true, value: read() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const USAGE = "uso: video-publish-registry-status.ts AAMMDD [--since ISO] [--edition-dir DIR]";

export function main(argv: string[] = process.argv.slice(2)): number {
  const { values, positional } = parseArgs(argv);
  const aammdd = values["edition"] ?? positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error(USAGE);
    return 2;
  }
  const since = values["since"] ?? null;
  if (since !== null && Number.isNaN(Date.parse(since))) {
    console.error(`video-publish-registry-status: --since inválido: ${since}`);
    console.error(USAGE);
    return 2;
  }
  const dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  const status = summarizeVideoRegistries({
    aammdd,
    since,
    youtube: readSafely(() => readPublishedRecord(join(dir, YOUTUBE_PUBLISHED_FILE), aammdd)),
    shorts: readSafely(() => readShortsRegistry(dir, aammdd)),
  });
  console.log(JSON.stringify(status, null, 2));
  console.error(`[${status.verdict}] ${status.message}`);
  return status.verdict === "unreadable" ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}

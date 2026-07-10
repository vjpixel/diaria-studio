/**
 * resolve-video-youtube.ts (#3202)
 *
 * Pós-processa o bucket `video` de `tmp-categorized.json`: qualquer item cuja
 * URL não seja `youtube.com/watch` ou `youtu.be` é resolvido contra resultados
 * de busca scoped a `site:youtube.com` (já coletados pelo orchestrator via
 * `discovery-searcher`/WebSearch — ver passo 1m-quinquies de
 * `.claude/agents/orchestrator-stage-1-research.md`). Match confiável
 * substitui a URL; sem match, o item é marcado `video_url_unverified: true`
 * pra o orchestrator flagar no gate humano.
 *
 * Regra editorial #3202: itens de VÍDEOS usam SEMPRE link do YouTube. Nunca
 * fabricar/adivinhar a URL — só resultado real de busca (`video-youtube-
 * resolve.ts` é puro, este script só faz I/O).
 *
 * Uso:
 *   npx tsx scripts/resolve-video-youtube.ts \
 *     --categorized data/editions/{AAMMDD}/_internal/tmp-categorized.json \
 *     [--search-results data/editions/{AAMMDD}/_internal/tmp-video-search-results.json] \
 *     [--out <path>]
 *
 * `--search-results` é o JSON `{ [urlOriginal]: [{ url, title, source_name }, ...] }`
 * emitido pelo orchestrator ao consolidar as respostas de `discovery-searcher`
 * pra cada item de vídeo não-YouTube. Se omitido (ou URL ausente do mapa),
 * o item é tratado como "sem candidatos" — cai direto em `flagged`.
 *
 * In-place é seguro (--out omitido grava sobre --categorized).
 *
 * Output (stdout): { resolved: [...], flagged: [...], alreadyYoutube: N }
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { parseArgsSimple } from "./lib/cli-args.ts";
import {
  resolveVideoBucket,
  type VideoArticleLike,
  type VideoSearchCandidate,
} from "./lib/video-youtube-resolve.ts";

interface Categorized {
  lancamento?: VideoArticleLike[];
  radar?: VideoArticleLike[];
  use_melhor?: VideoArticleLike[];
  video?: VideoArticleLike[];
  [key: string]: unknown;
}

export function resolveVideoYoutube(
  input: Categorized,
  searchResultsByUrl: Record<string, VideoSearchCandidate[]>,
): { output: Categorized; resolved: number; flagged: number; alreadyYoutube: number } {
  if (!Array.isArray(input.video) || input.video.length === 0) {
    return { output: input, resolved: 0, flagged: 0, alreadyYoutube: 0 };
  }
  const result = resolveVideoBucket(input.video, searchResultsByUrl);
  return {
    output: { ...input, video: result.articles },
    resolved: result.resolved.length,
    flagged: result.flagged.length,
    alreadyYoutube: result.alreadyYoutube,
  };
}

function parseCliArgs(argv: string[]) {
  const args = parseArgsSimple(argv);
  const categorizedPath = args.categorized ?? "";
  if (!categorizedPath) {
    console.error(
      "Uso: resolve-video-youtube.ts --categorized <categorized.json> [--search-results <search-results.json>] [--out <out.json>]",
    );
    process.exit(1);
  }
  return {
    categorizedPath,
    searchResultsPath: args["search-results"] ?? "",
    outPath: args.out || categorizedPath,
  };
}

function main() {
  const { categorizedPath, searchResultsPath, outPath } = parseCliArgs(process.argv.slice(2));

  const input: Categorized = JSON.parse(readFileSync(categorizedPath, "utf8"));

  let searchResultsByUrl: Record<string, VideoSearchCandidate[]> = {};
  if (searchResultsPath) {
    if (!existsSync(searchResultsPath)) {
      console.error(
        `[resolve-video-youtube] AVISO: --search-results não encontrado (${searchResultsPath}) — tratando todos os itens não-YouTube como sem candidatos.`,
      );
    } else {
      searchResultsByUrl = JSON.parse(readFileSync(searchResultsPath, "utf8"));
    }
  }

  const { output, resolved, flagged, alreadyYoutube } = resolveVideoYoutube(
    input,
    searchResultsByUrl,
  );

  writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

  console.error(
    `[resolve-video-youtube] video bucket: ${alreadyYoutube} já YouTube, ${resolved} resolvido(s), ${flagged} flagado(s) (sem match confiável).`,
  );
  if (flagged > 0) {
    for (const a of output.video ?? []) {
      if (a.video_url_unverified) {
        console.error(`  ⚠️  ${a.title ?? a.url}: ${a.video_url_search_reason}`);
      }
    }
  }

  process.stdout.write(JSON.stringify({ resolved, flagged, alreadyYoutube }) + "\n");
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const _importMeta = import.meta.url;
if (
  _importMeta === `file://${_argv1}` ||
  _importMeta === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}

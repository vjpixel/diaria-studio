/**
 * check-short-feed-cover.ts (#12100) — a capa do Short aparece no feed de Shorts?
 *
 * O `thumbnails.set` só troca a miniatura 16:9; a aba Shorts do canal mostra
 * `i.ytimg.com/vi/{id}/sardefault.jpg` quando o Short tem miniatura vertical
 * própria e o frame automático quando não tem (#12251 — até lá este script
 * media o `oar2.jpg`, que é frame automático sempre, e errava em 6 de 10
 * Shorts). Este script baixa o `sardefault.jpg` (imagem pública, sem
 * credencial, só leitura) e compara com a capa local por hash perceptual
 * (`scripts/lib/diaria/short-feed-cover-check.ts`): 200 não basta, o
 * `sardefault` pode trazer um frame.
 *
 * Uso:
 *   npx tsx scripts/check-short-feed-cover.ts --id VIDEO_ID --cover 04-youtube-short-capa.jpg
 *   npx tsx scripts/check-short-feed-cover.ts --feed-image sardefault.jpg --cover capa.jpg   (offline)
 *
 * Saída: JSON no stdout (`verdict`, `distance`, `threshold`, `feed_url`).
 * Exit 0 = o feed mostra a capa; 1 = mostra outro frame, ou `sem-capa-vertical`
 * (404 no `sardefault`: o passo manual não foi feito, ou não pegou); 2 = uso
 * errado ou falha ao ler/baixar.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { youtubeShortFeedThumbUrl } from "./lib/diaria/short-cover.ts";
import { assessFeedCover } from "./lib/diaria/short-feed-cover-check.ts";

const USAGE =
  "uso: check-short-feed-cover.ts --id VIDEO_ID --cover JPG\n" +
  "     check-short-feed-cover.ts --feed-image JPG --cover JPG";

/** Id de vídeo do YouTube: 11 caracteres de [A-Za-z0-9_-]. */
export const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Baixa o `sardefault.jpg` do Short. `null` = HTTP 404, o Short não tem
 * miniatura vertical própria (#12251) — o corpo que vem com o 404 (no teste
 * de 04/11, ~1 KB gravado pelo curl) nunca entra na comparação como se fosse
 * a imagem do feed. Outro erro HTTP ou resposta que não é imagem lança.
 */
export async function fetchFeedImage(videoId: string, fetchImpl: typeof fetch = fetch): Promise<Buffer | null> {
  const url = youtubeShortFeedThumbUrl(videoId);
  // UA de navegador: sem ele a CDN às vezes responde com outra coisa.
  const res = await fetchImpl(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
  // Saída sem ler o corpo cancela o stream (#9991): senão o socket segura o processo.
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`GET ${url}: HTTP ${res.status}`);
  }
  const type = res.headers.get("content-type") ?? "";
  if (type && !type.startsWith("image/")) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`GET ${url}: content-type ${type}, esperado imagem`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main(): Promise<number> {
  const { values } = parseArgs(process.argv.slice(2));
  const coverPath = values["cover"];
  const id = values["id"]?.trim();
  const feedPath = values["feed-image"];
  if (!coverPath || (!id && !feedPath) || (id && feedPath)) {
    console.error(USAGE);
    return 2;
  }
  if (id && !YOUTUBE_VIDEO_ID_RE.test(id)) {
    console.error(`check-short-feed-cover: --id ${JSON.stringify(id)} não parece id de vídeo do YouTube (11 caracteres)`);
    return 2;
  }
  for (const p of [coverPath, feedPath].filter((x): x is string => !!x)) {
    if (!existsSync(resolve(p))) {
      console.error(`check-short-feed-cover: ${resolve(p)} não existe`);
      return 2;
    }
  }
  const feed = id ? await fetchFeedImage(id) : readFileSync(resolve(feedPath!));
  if (feed === null) {
    const feedUrl = youtubeShortFeedThumbUrl(id!);
    console.log(JSON.stringify({ verdict: "sem-capa-vertical", feed_url: feedUrl, http_status: 404 }, null, 2));
    console.error(
      `[aviso] ${feedUrl} deu 404: o Short não tem miniatura vertical própria e a aba Shorts mostra o frame automático ` +
        "(ou o vídeo não existe/é privado): no app do YouTube, Editar → Miniatura → enviar a capa",
    );
    return 1;
  }
  const r = await assessFeedCover(feed, readFileSync(resolve(coverPath)));
  console.log(JSON.stringify({ ...r, ...(id ? { feed_url: youtubeShortFeedThumbUrl(id) } : { feed_image: resolve(feedPath!) }) }, null, 2));
  if (r.verdict === "capa") return 0;
  console.error(
    `[aviso] o feed de Shorts mostra outro frame (distância ${r.distance.toFixed(3)} > ${r.threshold}): no app do YouTube, Editar → Miniatura → enviar a capa`,
  );
  return 1;
}

if (isMainModule(import.meta.url)) {
  // Falha de leitura/download é 2: nunca vira o 1 de "o feed mostra outro frame".
  runCli(main, { errorCode: 2, onError: (e) => console.error("check-short-feed-cover:", e instanceof Error ? e.message : e) });
}

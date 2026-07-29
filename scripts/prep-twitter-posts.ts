/**
 * prep-twitter-posts.ts (#3994, substitui publish-twitter.ts/twitter-oauth1.ts;
 * #4103 — dueAt via schedule compartilhado, mode customScheduled;
 * #4285/#4264 adendo do editor — gate de char limit pondera URL como 23 chars)
 *
 * Publicação no X mudou de "API direta da X" (OAuth 1.0a, pay-per-usage desde
 * que o free tier acabou — ~$0.20/post com link) para "via Buffer" (MCP
 * `claude_ai_Buffer`, plano Free, $0 — Buffer absorve o custo do lado dela).
 * A API da Buffer só é alcançável de dentro de uma sessão de agente (MCP), não
 * de um script Node puro rodado via Bash — por isso a publicação em si não é
 * mais um script: o orchestrator (Stage 5, `orchestrator-stage-5.md`) chama
 * `mcp__claude_ai_Buffer__create_post` diretamente, um destaque por vez.
 *
 * Este script faz só a parte determinística de antes (extração de texto +
 * gate de config + skip-existing) e devolve ao orchestrator, em JSON, a lista
 * exata de destaques que precisam ser postados. Depois de cada `create_post`,
 * o orchestrator chama `append-twitter-published.ts` pra gravar o resultado.
 *
 * Fonte do texto (#3992): SÓ a seção `# Curto` de 03-social.md (texto único
 * compartilhado com Threads, ≤280 chars, escrito por `social-curto`).
 * **Sem fallback** — ausência da seção/destaque é tratada como "sem conteúdo
 * pronto pro X nesta edição", nunca improvisando texto (decisão da issue #3994).
 *
 * **CTA aponta pra edição, não pra home (#4285/#4264 adendo do editor):**
 * `social-curto.md` escreve o placeholder literal `{edition_url}` no CTA
 * (mesmo padrão do `## post_pixel`) em vez de `"Mais em diar.ia.br"`
 * hardcoded. `resolve-edition-url.ts` já substitui `{edition_url}` no
 * `03-social.md` inteiro (incluindo `# Curto`) ANTES deste script rodar
 * (5c-2 roda antes de 5c-3b) — este script sempre lê o texto já com a URL
 * real. Ver `computeTwitterWeightedLength` abaixo pro porquê o gate de
 * limite não usa `text.length` cru contra essa URL.
 *
 * **Imagem (#4264):** cada post ganha `imageUrl`/`altText` resolvidos de
 * `06-public-images.json` (gerado por `upload-images-public.ts` no 5c-pre),
 * MESMO critério de precedência já usado por `publish-instagram.ts`
 * (~L488): `images.d{N}_4x5.url` (card com título, preferencial) com
 * fallback pra `images.d{N}.url` (1:1, sempre presente). **Sem fallback
 * silencioso pro destaque inteiro** — se o cache não existe ou não tem a
 * entry, o post continua saindo (só texto, `imageUrl: null`) e o motivo vai
 * pra `skipped_image` (visível no resumo da edição) — X sem imagem é pior
 * que X nenhum, então isso nunca vira um `skipped` de verdade.
 *
 * **dueAt (#4103):** cada post ganha um `dueAt` calculado por
 * `computeScheduledAt` de `compute-social-schedule.ts` — o MESMO helper usado
 * por `publish-facebook.ts`/`publish-linkedin.ts`/`publish-instagram.ts`/
 * `publish-threads.ts` (fallback_schedule/timezone de `platform.config.json`).
 * Antes do #4103, o dispatch usava `mode: "addToQueue"` (fila própria da
 * Buffer) — os slots do canal na Buffer não têm relação com os horários
 * editoriais dos demais canais, e dessincronizavam (ex: X saindo às 08:55
 * enquanto Facebook/LinkedIn/Instagram/Threads saíam às 10:00, caso real
 * 260727). O orchestrator agora usa esse `dueAt` com `mode: "customScheduled"`
 * — um só dono do cronograma editorial (o `fallback_schedule` compartilhado).
 *
 * Uso:
 *   npx tsx scripts/prep-twitter-posts.ts \
 *     --edition-dir data/editions/260624/ \
 *     [--skip-existing]     # pula destaques já em 06-social-published.json (default: true)
 *     [--no-skip-existing]  # força re-inclusão
 *
 * Output (stdout, JSON): { enabled, published_path, posts: [{destaque, text, dueAt, imageUrl, altText}], skipped: [...], skipped_image: [...] }
 * `posts` é a lista que o orchestrator deve efetivamente postar via Buffer MCP
 * (`mode: "customScheduled"`, `dueAt` = `post.dueAt`; quando `imageUrl` não é
 * `null`, passar `assets: [{ image: { url: imageUrl, metadata: { altText } } }]`).
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readSocialPublished } from "./lib/social-published-store.ts";
import { parseDestaqueHeaders } from "./lint-social-md.ts";
import { extractSection } from "./lib/extract-section.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { computeScheduledAt } from "./compute-social-schedule.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Limite de caracteres por tweet. */
export const TWITTER_CHAR_LIMIT = 280;

/**
 * Peso que o X (t.co) atribui a QUALQUER URL dentro de um post, independente
 * do comprimento literal — desde #3994. `text.length` cru superestima o custo
 * de uma URL longa (#4285/#4264 adendo do editor): `{edition_url}` resolve
 * pra `https://diar.ia.br/p/{slug}`, tipicamente 40-80 chars literais, mas o
 * X sempre conta 23 na hora de aplicar o limite de 280. Sem essa correção,
 * um slug longo derrubava o post pro `skipped` sem que ele de fato
 * estourasse no X.
 */
export const TWITTER_URL_WEIGHT = 23;

/** Reconhece URLs http(s) dentro do texto do post, pra fins de contagem ponderada. */
const URL_RE = /https?:\/\/\S+/g;

/**
 * Calcula o comprimento "ponderado" de um post do X, contando cada URL como
 * `TWITTER_URL_WEIGHT` chars (t.co) em vez do comprimento literal — o mesmo
 * critério que o X usa de verdade pra aplicar o limite de 280 (#4285/#4264
 * adendo do editor, #3994). Texto sem nenhuma URL: idêntico a `text.length`.
 */
export function computeTwitterWeightedLength(text: string): number {
  let delta = 0;
  for (const match of text.matchAll(URL_RE)) {
    delta += TWITTER_URL_WEIGHT - match[0].length;
  }
  return text.length + delta;
}

/**
 * Extrai a lista de destaques da seção `# Curto` do 03-social.md.
 * Sem fallback (#3994): se a seção não existe, retorna `[]`.
 */
export function extractDestaquesFromCurto(socialMd: string): string[] {
  const section = extractSection(socialMd, "Curto");
  if (section === null) return [];
  return parseDestaqueHeaders(section);
}

/**
 * Extrai o texto do post `# Curto` para um destaque específico.
 * Retorna `null` se a seção `# Curto` ou o destaque dentro dela não existir
 * — nunca lança nem cai pra outra seção (#3994: sem fallback).
 */
export function extractCurtoText(socialMd: string, destaque: string): string | null {
  const normalized = socialMd.replace(/\r\n/g, "\n");
  const section = extractSection(normalized, "Curto");
  if (section === null) return null;

  const dRe = new RegExp(
    `(?:^|\\n)## ${destaque}\\n([\\s\\S]*?)(?=\\n## d\\d+\\b|\\n# |$)`,
    "i",
  );
  const dMatch = section.match(dRe);
  if (!dMatch) return null;
  return dMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim();
}

export interface PrepResult {
  enabled: boolean;
  published_path: string | null;
  posts: Array<{
    destaque: string;
    text: string;
    dueAt: string;
    imageUrl: string | null;
    altText: string | null;
  }>;
  skipped: Array<{ destaque: string; reason: string }>;
  /** #4264: destaques com post normal mas sem imagem resolvida — motivo aqui, nunca em `skipped`. */
  skipped_image: Array<{ destaque: string; reason: string }>;
}

/**
 * Resolve a URL pública + alt text de um destaque a partir de
 * `06-public-images.json` (#4264). MESMO critério de precedência de
 * `publish-instagram.ts` (~L488): card 4:5 (com título) > 1:1 (sempre
 * presente, sem título). Retorna `{ imageUrl: null, reason }` quando o
 * cache não existe ou não tem entry pro destaque — nunca lança.
 */
export function resolveTwitterImage(
  editionDir: string,
  destaque: string,
  editionDate: string,
): { imageUrl: string | null; altText: string | null; reason: string | null } {
  const publicImagesPath = resolve(editionDir, "06-public-images.json");
  if (!existsSync(publicImagesPath)) {
    return {
      imageUrl: null,
      altText: null,
      reason: "06-public-images.json ausente — rode upload-images-public.ts",
    };
  }

  let images: Record<string, { url?: string }> | undefined;
  try {
    const parsed = JSON.parse(readFileSync(publicImagesPath, "utf8")) as {
      images?: Record<string, { url?: string }>;
    };
    images = parsed.images;
  } catch (e: any) {
    return {
      imageUrl: null,
      altText: null,
      reason: `06-public-images.json inválido — ${e.message}`,
    };
  }

  const imageUrl = images?.[`${destaque}_4x5`]?.url ?? images?.[destaque]?.url ?? null;
  if (!imageUrl) {
    return {
      imageUrl: null,
      altText: null,
      reason: `public URL para ${destaque} ausente em 06-public-images.json`,
    };
  }

  const altText = `Imagem do destaque ${destaque.toUpperCase()} da edição Diar.ia de ${editionDate}`;
  return { imageUrl, altText, reason: null };
}

/**
 * Deriva `editionDate` (AAMMDD) a partir do último segmento de `editionDir` —
 * mesmo padrão usado por `publish-facebook.ts`/`publish-linkedin.ts` (#270).
 */
function deriveEditionDate(editionDir: string): string {
  return editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
}

export function prepTwitterPosts(
  editionDir: string,
  opts: { skipExisting?: boolean; editionDate?: string; now?: number } = {},
): PrepResult {
  const skipExisting = opts.skipExisting ?? true;
  const editionDate = opts.editionDate ?? deriveEditionDate(editionDir);
  const gateConfig = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const twitterGateConfig = gateConfig?.publishing?.social?.twitter;
  if (twitterGateConfig?.enabled === false) {
    return { enabled: false, published_path: null, posts: [], skipped: [], skipped_image: [] };
  }

  const socialMdPath = resolve(editionDir, "03-social.md");
  if (!existsSync(socialMdPath)) {
    throw new Error("03-social.md não encontrado. Rode Stage 2 primeiro.");
  }
  const socialMd = readFileSync(socialMdPath, "utf8");

  const internalPath = resolve(editionDir, "_internal", "06-social-published.json");
  const rootPath = resolve(editionDir, "06-social-published.json");
  let publishedPath: string;
  if (existsSync(internalPath)) {
    publishedPath = internalPath;
  } else if (existsSync(rootPath)) {
    publishedPath = rootPath;
  } else {
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    publishedPath = internalPath;
  }

  const destaques = extractDestaquesFromCurto(socialMd);
  const posts: PrepResult["posts"] = [];
  const skipped: PrepResult["skipped"] = [];
  const skippedImage: PrepResult["skipped_image"] = [];

  if (destaques.length === 0) {
    return { enabled: true, published_path: publishedPath, posts, skipped, skipped_image: skippedImage };
  }

  const published = readSocialPublished(publishedPath);

  for (const d of destaques) {
    if (skipExisting) {
      const existing = published.posts.find(
        (p) =>
          p.platform === "twitter" &&
          p.destaque === d &&
          (p.status === "draft" || p.status === "scheduled" || p.status === "published"),
      );
      if (existing) {
        skipped.push({ destaque: d, reason: `already ${existing.status}` });
        continue;
      }
    }

    const text = extractCurtoText(socialMd, d);
    if (!text) {
      skipped.push({ destaque: d, reason: "destaque ausente na seção '# Curto'" });
      continue;
    }

    // #4285/#4264 adendo do editor: conta URL como TWITTER_URL_WEIGHT (peso
    // real do X via t.co), não o comprimento literal — {edition_url} resolvido
    // pode ter 40-80 chars literais sem de fato estourar o limite no X.
    const weightedLength = computeTwitterWeightedLength(text);
    if (weightedLength > TWITTER_CHAR_LIMIT) {
      skipped.push({
        destaque: d,
        reason: `texto com ${weightedLength} chars (peso X, URL=${TWITTER_URL_WEIGHT}; ${text.length} chars literais) excede ${TWITTER_CHAR_LIMIT} — sem truncagem silenciosa`,
      });
      continue;
    }

    // #4103: dueAt calculado pelo MESMO helper compartilhado com
    // Facebook/LinkedIn/Instagram/Threads — nunca uma fila própria da Buffer.
    const dueAt = computeScheduledAt({
      config: gateConfig,
      editionDate,
      destaque: d as "d1" | "d2" | "d3",
      platform: "twitter",
      now: opts.now,
    });

    const { imageUrl, altText, reason: imageReason } = resolveTwitterImage(editionDir, d, editionDate);
    if (imageReason) {
      skippedImage.push({ destaque: d, reason: imageReason });
    }

    posts.push({ destaque: d, text, dueAt, imageUrl, altText });
  }

  return { enabled: true, published_path: publishedPath, posts, skipped, skipped_image: skippedImage };
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) {
    console.error("ERRO: --edition-dir é obrigatório.");
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const noSkipExisting = process.argv.includes("--no-skip-existing");

  try {
    const result = prepTwitterPosts(editionDir, { skipExisting: !noSkipExisting });
    console.log(JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.error(`ERROR: ${e.message}`);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

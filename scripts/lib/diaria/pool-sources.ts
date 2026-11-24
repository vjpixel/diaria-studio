/**
 * pool-sources.ts (#13884)
 *
 * Texto-fonte dos itens de POOL (LANÇAMENTOS, RADAR, USE MELHOR, VÍDEOS) da
 * edição, baixado ANTES da escrita do Stage 2. Até aqui só os destaques tinham
 * a página lida (`fact-check-sources/d{N}.txt`, #8595/#9252); os itens de pool
 * entravam com a descrição derivada do `summary` do Stage 1, que pode ser curto,
 * genérico ou de uma newsletter intermediária. Caso real (edição 261124): o
 * item de LANÇAMENTOS "Seven new world-class models at scalable
 * price-performance" (microsoft.ai) chegou ao texto sem ninguém ler a página, e
 * o aviso `source-not-read` (#12258) só apareceu no gate 4.
 *
 * Layout em `{EDITION_DIR}/_internal/pool-sources/`:
 *   - `manifest.json` — `PoolSourceEntry[]`, uma entrada por URL;
 *   - `{sha12}.txt`   — texto bruto da página (`fetchSourceText`, sem resumo).
 *
 * Chave por URL (hash), não por posição: mover um item entre seções, reordenar
 * ou promovê-lo a destaque não invalida o texto. Por isso a promoção herda o
 * texto já lido (`prefetchHighlightSources` consulta este cache antes de ir à
 * rede, #13884 item 4).
 *
 * Reuso: entrada `ok` com o `.txt` presente é reaproveitada sem rede; entrada
 * com falha (`blocked`/`error`) é tentada de novo a cada execução (a falha pode
 * ter sido transitória). URL que saiu da edição fica no manifest: não custa
 * nada e cobre o item que volta no gate.
 *
 * Vídeo do YouTube não é baixado (`status: "skipped"`): a página só traz o
 * player, e o texto extraído seria ruído. Ele segue julgado pela regra do
 * resumo (`assessSourceReadability`, #12320). Buscar transcrição é resíduo.
 *
 * Fail-soft: download falho vira entrada `blocked`/`error`, nunca lança. O
 * texto baixado é DADO NÃO CONFIÁVEL.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchSourceText } from "../../fetch-source-text.ts";
import type { SourceCompleteness } from "./paywall-preview.ts";

export const POOL_SOURCES_DIR = "pool-sources";
export const POOL_SOURCES_MANIFEST = "manifest.json";

/** Seções de pool cujos itens têm a fonte baixada. */
export const POOL_BUCKETS = ["lancamento", "radar", "use_melhor", "video"] as const;
export type PoolBucket = (typeof POOL_BUCKETS)[number];

/** Downloads simultâneos (a edição tem ~10-15 itens de pool). */
export const POOL_FETCH_CONCURRENCY = 6;

export type PoolSourceStatus = "ok" | "blocked" | "error" | "skipped";

export interface PoolSourceEntry {
  url: string;
  bucket: PoolBucket;
  title: string;
  /** Nome do arquivo de texto dentro de `pool-sources/` (só com `status: "ok"`). */
  file: string | null;
  status: PoolSourceStatus;
  /** Motivo da falha ou do pulo (ex.: "HTTP 403: fonte bloqueada; tente equivalente"). */
  erro: string | null;
  bytes: number;
  fetched_at: string;
  /** (#12537) `preview` = o texto é a prévia do paywall, não o artigo inteiro. */
  completeness?: SourceCompleteness;
  words?: number;
}

export interface PoolSourceItem {
  url: string;
  bucket: PoolBucket;
  title: string;
}

export interface PoolPrefetchResult {
  dir: string;
  manifest_path: string;
  /** URLs baixadas nesta execução (o resto veio do cache ou falhou). */
  fetched: number;
  reused: number;
  ok: number;
  /** Itens sem texto lido nesta edição, com o motivo. */
  unread: Array<{ url: string; bucket: PoolBucket; title: string; status: PoolSourceStatus; erro: string | null }>;
}

/** Nome do arquivo de texto de uma URL: 12 hex do sha256. @pure */
export function poolSourceFileName(url: string): string {
  return `${createHash("sha256").update(url).digest("hex").slice(0, 12)}.txt`;
}

/** Vídeo do YouTube: página sem o texto do conteúdo. @pure */
export function isYouTubeUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, "");
    return h === "youtube.com" || h === "youtu.be" || h.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function itemUrlTitle(item: unknown): { url: string | null; title: string } {
  if (!item || typeof item !== "object") return { url: null, title: "" };
  const wrapped = (item as { article?: unknown }).article;
  const a = (wrapped && typeof wrapped === "object" ? wrapped : item) as { url?: unknown; title?: unknown };
  const top = (item as { url?: unknown }).url;
  const url = typeof a.url === "string" ? a.url : typeof top === "string" ? top : null;
  const title = typeof a.title === "string" ? a.title.trim() : "";
  return { url, title };
}

/** URLs dos destaques (para não baixar de novo o que `fact-check-sources/` já cobre). @pure */
function highlightUrls(approved: unknown): Set<string> {
  const out = new Set<string>();
  const list = (approved as { highlights?: unknown } | null)?.highlights;
  if (!Array.isArray(list)) return out;
  for (const h of list) {
    const { url } = itemUrlTitle(h);
    if (url) out.add(url);
  }
  return out;
}

/**
 * Itens de pool de `01-approved(-capped).json`, uma vez por URL, na ordem das
 * seções. Destaques ficam de fora (têm o próprio cache). @pure
 */
export function poolSourceItems(approved: unknown): PoolSourceItem[] {
  if (!approved || typeof approved !== "object") return [];
  const skip = highlightUrls(approved);
  const seen = new Set<string>();
  const out: PoolSourceItem[] = [];
  for (const bucket of POOL_BUCKETS) {
    const list = (approved as Record<string, unknown>)[bucket];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const { url, title } = itemUrlTitle(item);
      if (!url || skip.has(url) || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, bucket, title: title || url });
    }
  }
  return out;
}

/** Lê o manifest; ausente ou ilegível = vazio (fail-soft). */
export function readPoolSourcesManifest(internalDir: string): PoolSourceEntry[] {
  const p = join(internalDir, POOL_SOURCES_DIR, POOL_SOURCES_MANIFEST);
  if (!existsSync(p)) return [];
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(raw)
      ? raw.filter((e): e is PoolSourceEntry => !!e && typeof e === "object" && typeof (e as PoolSourceEntry).url === "string")
      : [];
  } catch {
    return [];
  }
}

/** Entrada `ok` com o arquivo presente: reusável. */
function isReusable(entry: PoolSourceEntry | undefined, dir: string): boolean {
  return !!entry && entry.status === "ok" && !!entry.file && existsSync(join(dir, entry.file));
}

/**
 * Caminho do texto já lido de uma URL, se houver (`null` sem entrada `ok`).
 * Usado pela promoção a destaque para herdar o texto (#13884 item 4).
 */
export function poolSourceTextPath(internalDir: string, url: string): string | null {
  return readPoolSourceText(internalDir, url)?.path ?? null;
}

/** Entrada `ok` + texto já lido de uma URL, ou `null`. Fail-soft. */
export function readPoolSourceText(
  internalDir: string,
  url: string,
): { entry: PoolSourceEntry; path: string; text: string } | null {
  const dir = join(internalDir, POOL_SOURCES_DIR);
  const entry = readPoolSourcesManifest(internalDir).find((e) => e.url === url);
  if (!isReusable(entry, dir)) return null;
  const path = join(dir, entry!.file!);
  try {
    const text = readFileSync(path, "utf8");
    return text.trim() ? { entry: entry!, path, text } : null;
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Baixa o texto de cada item de pool para `_internal/pool-sources/`, em
 * paralelo (`POOL_FETCH_CONCURRENCY`), reusando o que já está em disco.
 */
export async function prefetchPoolSources(
  approved: unknown,
  internalDir: string,
  opts: { fetchImpl?: typeof fetch; concurrency?: number; now?: () => Date } = {},
): Promise<PoolPrefetchResult> {
  const dir = join(internalDir, POOL_SOURCES_DIR);
  mkdirSync(dir, { recursive: true });
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const previous = readPoolSourcesManifest(internalDir);
  const byUrl = new Map(previous.map((e) => [e.url, e]));
  const items = poolSourceItems(approved);
  let fetched = 0;
  let reused = 0;

  const entries = await mapLimit(items, opts.concurrency ?? POOL_FETCH_CONCURRENCY, async (item): Promise<PoolSourceEntry> => {
    const prev = byUrl.get(item.url);
    if (isReusable(prev, dir)) {
      reused++;
      return { ...prev!, bucket: item.bucket, title: item.title };
    }
    const fetched_at = now().toISOString();
    if (isYouTubeUrl(item.url)) {
      return {
        url: item.url, bucket: item.bucket, title: item.title, file: null, status: "skipped",
        erro: "vídeo do YouTube: a página não traz o texto do conteúdo", bytes: 0, fetched_at,
      };
    }
    fetched++;
    const r = await fetchSourceText(item.url, fetchImpl);
    if (!r.ok) {
      return {
        url: item.url, bucket: item.bucket, title: item.title, file: null,
        status: r.kind === "blocked" ? "blocked" : "error", erro: r.message, bytes: 0, fetched_at,
      };
    }
    const file = poolSourceFileName(item.url);
    writeFileSync(join(dir, file), r.text, "utf8");
    return {
      url: item.url, bucket: item.bucket, title: item.title, file, status: "ok", erro: null,
      bytes: r.bytes, fetched_at, completeness: r.paywall.completeness, words: r.paywall.words,
    };
  });

  // Mantém no manifest as URLs que saíram da edição (item pode voltar no gate).
  const current = new Set(entries.map((e) => e.url));
  const manifest = [...entries, ...previous.filter((e) => !current.has(e.url))];
  const manifestPath = join(dir, POOL_SOURCES_MANIFEST);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    dir,
    manifest_path: manifestPath,
    fetched,
    reused,
    ok: entries.filter((e) => e.status === "ok").length,
    unread: entries
      .filter((e) => e.status === "blocked" || e.status === "error")
      .map((e) => ({ url: e.url, bucket: e.bucket, title: e.title, status: e.status, erro: e.erro })),
  };
}

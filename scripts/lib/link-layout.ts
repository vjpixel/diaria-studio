/**
 * link-layout.ts (#4841)
 *
 * Instrumentação de posição/proveniência de link — grava, no momento do
 * render, a posição exata de cada link editorial da edição, em vez de
 * reconstruí-la depois por heurística sobre o HTML publicado (mecanismo
 * existente, `resolveNewsletterSection` em `lib/link-ctr-categorize.ts`, que
 * quebrou quando a sequência de kickers mudou em 260625 — #3476 — e chegou a
 * produzir um "D1 vale 11× D3" falso, medido na auditoria de 260810).
 *
 * Posição é o maior efeito medido sobre clique (rank 1 rende 5,4× o rank
 * 16+) e a pior instrumentada. O render JÁ SABE a resposta — este módulo só
 * grava o que `NewsletterContent` (a mesma estrutura que `renderHTML()`
 * consome, nunca a string HTML já renderizada) já contém.
 *
 * Dois artefatos, por design SEPARADOS (join por `url`, não fundidos num
 * único arquivo):
 *
 *   - `link-layout.json`  — POSIÇÃO (bloco + ordinal local + ordinal
 *     global). Serve o desenho de #4846 (randomizar D3 vs 1º slot do Radar
 *     exige posição final auditável).
 *   - `published-links.json` — PROVENIÊNCIA (scored vs writer_inserted),
 *     cruzando os URLs do render contra `01-approved.json` (o pool que
 *     passou pelo scorer do Stage 1). Serve #4848 (43 links/janela nunca
 *     passaram pelo scorer e rendem 2,1× mais — mas comparar a média bruta
 *     confunde posição com origem; separar os dois arquivos e joinar por
 *     `url` é o que permite controlar por posição antes de atribuir o
 *     efeito à origem).
 *
 * Ambos calculados a partir da MESMA `NewsletterContent` já parseada — nunca
 * fazem I/O de rede nem reparsam HTML.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewsletterContent } from "./newsletter-parse.ts";
import { findMarkdownLinks } from "./newsletter-render-html.ts";
import { SECTIONS } from "./section-naming.ts";
import type { CategorizedJson, Highlight } from "./types/categorized-json.ts";

/** Taxonomia de bloco — mesmo vocabulário de `SectionBucket`
 * (section-naming.ts) + "destaque" (que não é uma seção secundária). */
export type Bloco = "destaque" | "radar" | "use_melhor" | "lancamento" | "video";

export interface LinkLayoutEntry {
  url: string;
  bloco: Bloco;
  /** Posição 1-based dentro do próprio bloco (ex: 2º link do RADAR). */
  ordinal_no_bloco: number;
  /** Posição 1-based entre TODOS os links editoriais capturados, na ordem em
   * que aparecem no e-mail renderizado (destaques primeiro — D1→D3 na ordem
   * de `content.destaques` — depois seções secundárias na ordem de
   * `content.sections`, a mesma ordem em que `renderHTML()` as itera). */
  ordinal_global: number;
}

export type LinkOrigin = "scored" | "writer_inserted";

export interface PublishedLink {
  url: string;
  bloco: Bloco;
  origin: LinkOrigin;
}

/**
 * Mapa `Section.name` (já normalizado por `parseSections`) → bloco. Reusa o
 * registry único `SECTIONS` de section-naming.ts (#1737) em vez de
 * redeclarar padrões locais que poderiam divergir do parser real — a mesma
 * disciplina que motivou aquele registry (drift entre 3 arquivos que
 * duplicavam nome→bucket).
 */
function sectionNameToBloco(name: string): Bloco | null {
  const bare = name.trim().toUpperCase();
  for (const section of SECTIONS) {
    if (new RegExp(`^(?:${section.pattern})$`, "u").test(bare)) {
      return section.bucket;
    }
  }
  return null;
}

/** Links markdown `[label](url)` embutidos num texto livre (corpo/why/
 * descrição de item) — writer insere esses contextualmente ("segundo a
 * Reuters"), nunca passam pelo scorer (#4848). */
function collectLinksFromText(text: string | undefined | null): string[] {
  if (!text) return [];
  return findMarkdownLinks(text)
    .map((l) => l.url)
    .filter((url): url is string => Boolean(url));
}

/**
 * Deriva o link-layout inteiro de uma `NewsletterContent` já parseada.
 * Ordem de captura espelha a ordem de emissão de `renderHTML()`: por
 * destaque, título(url)→corpo→"por que importa"→aprofunde; por seção
 * secundária, item a item (título(url) + links dentro da descrição).
 */
export function buildLinkLayout(content: NewsletterContent): LinkLayoutEntry[] {
  const entries: LinkLayoutEntry[] = [];
  const perBloco = new Map<Bloco, number>();
  let global = 0;

  const push = (url: string | undefined | null, bloco: Bloco): void => {
    if (!url) return;
    global += 1;
    const local = (perBloco.get(bloco) ?? 0) + 1;
    perBloco.set(bloco, local);
    entries.push({ url, bloco, ordinal_no_bloco: local, ordinal_global: global });
  };

  for (const destaque of content.destaques) {
    push(destaque.url, "destaque");
    for (const url of collectLinksFromText(destaque.body)) push(url, "destaque");
    for (const url of collectLinksFromText(destaque.why)) push(url, "destaque");
    for (const item of destaque.aprofunde ?? []) push(item.url, "destaque");
  }

  for (const section of content.sections) {
    const bloco = sectionNameToBloco(section.name);
    if (!bloco) continue;
    for (const item of section.items) {
      push(item.url, bloco);
      for (const url of collectLinksFromText(item.description)) push(url, bloco);
    }
  }

  return entries;
}

/**
 * URLs de `01-approved.json`/`01-categorized.json` — tudo que passou pelo
 * funil pesquisa → dedup → categorize → score, independente de ter virado
 * destaque ou ficado no pool secundário (highlights, runners_up e os 4
 * buckets). Um URL fora deste set foi inserido pelo writer no Stage 2, sem
 * nunca ter sido visto pelo scorer.
 */
export function collectScoredUrls(approved: CategorizedJson): Set<string> {
  const urls = new Set<string>();
  const addHighlight = (h: Highlight | undefined): void => {
    if (!h) return;
    const url = h.article?.url ?? h.url;
    if (url) urls.add(url);
  };
  for (const h of approved.highlights ?? []) addHighlight(h);
  for (const h of approved.runners_up ?? []) addHighlight(h);
  for (const bucket of ["lancamento", "radar", "use_melhor", "video"] as const) {
    for (const article of approved[bucket] ?? []) {
      if (article?.url) urls.add(article.url);
    }
  }
  return urls;
}

/**
 * Leitura fail-soft de `_internal/01-approved.json` (fallback:
 * `01-categorized.json`, caso o CLI rode fora do fluxo normal — Stage 4
 * roda sempre pós-gate, quando `01-approved.json` já existe). Nunca lança —
 * arquivo ausente/inválido retorna Set vazio (todo link fica marcado
 * `writer_inserted` até o approved existir de verdade). Instrumentação não
 * pode bloquear o render (mesma disciplina fail-soft de `render-warnings`).
 */
export function readScoredUrls(editionDir: string): Set<string> {
  for (const name of ["01-approved.json", "01-categorized.json"]) {
    const path = join(editionDir, "_internal", name);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as CategorizedJson;
      return collectScoredUrls(parsed);
    } catch {
      // fail-soft — tenta o próximo nome candidato
    }
  }
  return new Set<string>();
}

/**
 * Lista final DEDUPLICADA (por `url`, mantém a 1ª ocorrência) de links que
 * foram ao e-mail, cada um marcado com a origem. `scoredUrls` vazio (ex:
 * `01-approved.json` não encontrado) marca tudo como `writer_inserted` —
 * usar sempre `readScoredUrls()` (fail-soft) em vez de omitir o argumento,
 * pra não inflar a contagem de "writer_inserted" silenciosamente.
 */
export function buildPublishedLinks(
  layout: LinkLayoutEntry[],
  scoredUrls: Set<string>,
): PublishedLink[] {
  const seen = new Map<string, PublishedLink>();
  for (const entry of layout) {
    if (seen.has(entry.url)) continue;
    seen.set(entry.url, {
      url: entry.url,
      bloco: entry.bloco,
      origin: scoredUrls.has(entry.url) ? "scored" : "writer_inserted",
    });
  }
  return [...seen.values()];
}

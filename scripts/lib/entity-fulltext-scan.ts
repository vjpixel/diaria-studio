/**
 * entity-fulltext-scan.ts (#12958) — scanner de TEXTO COMPLETO das edições
 * para o alarme de defasagem das páginas de entidade.
 *
 * O alarme original (`findStaleEntityMentions`, `entity-staleness-check.ts`)
 * casa `ENTITY_KEYWORD_PATTERNS` só no título e subtítulo do cache. Para as
 * entidades brasileiras do #8350 isso via 10 das 33 menções publicadas: elas
 * aparecem sobretudo no corpo e no Radar. Uma edição nova que citasse o TSE no
 * corpo não disparava nada e a página ficava defasada sem sinal, o modo de
 * falha que o #5125 existe para evitar.
 *
 * Este módulo lê o HTML das edições no site (`workers/site/public/p/{slug}/
 * index.html`, commitado a cada publicação, sem depender do link `data/`),
 * descarta o que inflou as contagens brutas no #8350 e devolve as edições que
 * citam a entidade no texto e ainda não estão no `mentions` dela:
 *
 *   - `<head>`, `<script>`, `<style>` e `<nav>` (a navegação
 *     "Anterior/Próxima" leva o título da edição vizinha);
 *   - os blocos "Mais sobre {tema}:" (pílulas de link para hubs e edições
 *     antigas, com o título de outra edição);
 *   - parágrafos do concurso de erros (errata e "erro intencional"), que
 *     repetem o trecho de outra edição.
 *
 * Vale só para os slugs de `ENTITY_FULLTEXT_SCAN_SINCE` (`patterns.ts`) e só
 * para edições daquela data em diante: o histórico anterior já foi lido à mão
 * na contagem do #8350, e varrê-lo de novo transformaria cada acerto
 * descartado ali num alarme falso permanente.
 *
 * Puro: recebe o HTML já lido. A leitura do diretório fica em
 * `loadSiteEditions` (I/O isolado, fail-soft).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { stripAccents } from "../generate-hub-sources.ts";
import type { StaleEntityEdition } from "./entity-staleness-check.ts";

export interface SiteEdition {
  editionSlug: string;
  /** `YYYY-MM-DD` de `article:published_time`; `null` se a página não tiver. */
  date: string | null;
  title?: string;
  html: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Parágrafo do concurso de erros (texto já sem acento): errata, "erro intencional", "ache o erro". */
const ERRATA_PARAGRAPH_RE =
  /\berrata\b|erro intencional|ache o erro|o erro de ontem|erro em cada edicao|na ultima edicao,? (no texto|escrevi|chamei|o erro)/i;

/**
 * Texto do corpo da edição, sem acento e com espaços colapsados, já sem os
 * trechos que não são cobertura da própria edição (ver docstring do módulo).
 * @pure
 */
export function extractEditionBodyText(html: string): string {
  let s = html;
  s = s.replace(/<head\b[\s\S]*?<\/head>/gi, " ");
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<nav\b[\s\S]*?<\/nav>/gi, " ");
  // "Mais sobre X:" + a tabela de pílulas logo a seguir (sem tabela aninhada).
  s = s.replace(/<p\b[^>]*>\s*Mais sobre\b[\s\S]*?<\/p>\s*<table\b[\s\S]*?<\/table>/gi, " ");
  // Parágrafos do concurso de erros. Só `<p>`: um `<td>` pode conter a seção
  // inteira, e apagá-lo por causa de uma frase levaria o resto junto.
  s = s.replace(/<p\b[^>]*>(?:(?!<\/?p\b)[\s\S])*?<\/p>/gi, (block) => {
    const text = decodeEntities(block.replace(/<[^>]+>/g, " "));
    return ERRATA_PARAGRAPH_RE.test(stripAccents(text)) ? " " : block;
  });
  const text = decodeEntities(s.replace(/<[^>]+>/g, " "));
  return stripAccents(text).replace(/\s+/g, " ").trim();
}

/** `YYYY-MM-DD` de `<meta property="article:published_time">`, ou `null`. @pure */
export function extractPublishedDate(html: string): string | null {
  const m = html.match(/<meta\s+property="article:published_time"\s+content="(\d{4}-\d{2}-\d{2})/i);
  return m ? m[1] : null;
}

/** Conteúdo de `<title>`, decodificado. @pure */
export function extractTitle(html: string): string | undefined {
  const m = html.match(/<title>([^<]*)<\/title>/i);
  const t = m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
  return t || undefined;
}

/**
 * Edições que citam a entidade no texto completo, a partir de `since[slug]`,
 * fora do `mentions` publicado e de `excluded[slug]`. Edição sem data fica de
 * fora (não dá para saber se é anterior ao corte) e vira aviso.
 * @pure
 */
export function findFullTextStaleMentions(
  editions: readonly SiteEdition[],
  patterns: Readonly<Record<string, RegExp>>,
  since: Readonly<Record<string, string>>,
  mentionEditionSlugsBySlug: Readonly<Record<string, ReadonlySet<string>>>,
  excluded: Readonly<Record<string, readonly string[]>> = {},
): { stale: StaleEntityEdition[]; warnings: string[] } {
  const stale: StaleEntityEdition[] = [];
  const warnings: string[] = [];
  const slugs = Object.keys(since).filter((s) => patterns[s] && mentionEditionSlugsBySlug[s]);
  if (slugs.length === 0) return { stale, warnings };
  const undated = editions.filter((e) => !e.date).map((e) => e.editionSlug);
  if (undated.length > 0) {
    warnings.push(`texto completo: ${undated.length} edição(ões) sem article:published_time ignorada(s): ${undated.slice(0, 5).join(", ")}`);
  }
  for (const ed of editions) {
    if (!ed.date) continue;
    const relevant = slugs.filter((slug) => ed.date! >= since[slug]);
    if (relevant.length === 0) continue;
    const text = extractEditionBodyText(ed.html);
    for (const slug of relevant) {
      if (mentionEditionSlugsBySlug[slug].has(ed.editionSlug)) continue;
      if ((excluded[slug] ?? []).includes(ed.editionSlug)) continue;
      const re = new RegExp(patterns[slug].source, patterns[slug].flags.replace("g", ""));
      const m = re.exec(text);
      if (!m) continue;
      const start = Math.max(0, m.index - 60);
      stale.push({
        entitySlug: slug,
        date: ed.date,
        editionSlug: ed.editionSlug,
        ...(ed.title ? { editionTitle: ed.title } : {}),
        matchedHeadlines: [`…${text.slice(start, m.index + m[0].length + 60).trim()}… (texto completo)`],
      });
    }
  }
  stale.sort((a, b) => a.date.localeCompare(b.date) || a.entitySlug.localeCompare(b.entitySlug));
  return { stale, warnings };
}

/**
 * Quantas menções já publicadas de cada slug o scanner vê no texto completo
 * (para o log de cobertura do `regenerate-entity-pages.ts`). Sem corte de data:
 * mede a leitura, não o alarme. Slug sem `mentions` fica de fora.
 * @pure
 */
export function computeFullTextCoverage(
  editions: readonly SiteEdition[],
  patterns: Readonly<Record<string, RegExp>>,
  slugs: readonly string[],
  mentionEditionSlugsBySlug: Readonly<Record<string, ReadonlySet<string>>>,
): Record<string, number> {
  const bySlug = new Map(editions.map((e) => [e.editionSlug, e]));
  const textCache = new Map<string, string>();
  const textOf = (e: SiteEdition) => {
    let t = textCache.get(e.editionSlug);
    if (t === undefined) {
      t = extractEditionBodyText(e.html);
      textCache.set(e.editionSlug, t);
    }
    return t;
  };
  const out: Record<string, number> = {};
  for (const slug of slugs) {
    const known = mentionEditionSlugsBySlug[slug];
    const pattern = patterns[slug];
    if (!known || !pattern) continue;
    const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
    let n = 0;
    for (const s of known) {
      const ed = bySlug.get(s);
      if (ed && re.test(textOf(ed))) n++;
    }
    out[slug] = n;
  }
  return out;
}

/**
 * Lê as edições do site (`{dir}/{slug}/index.html`). Diretório ausente = `[]`;
 * arquivo ilegível vira aviso e fica de fora.
 */
export function loadSiteEditions(dir: string, warn: (m: string) => void = console.warn): SiteEdition[] {
  if (!existsSync(dir)) return [];
  const out: SiteEdition[] = [];
  for (const slug of readdirSync(dir).sort()) {
    const path = join(dir, slug, "index.html");
    if (!existsSync(path)) continue;
    try {
      const html = readFileSync(path, "utf8");
      out.push({ editionSlug: slug, date: extractPublishedDate(html), title: extractTitle(html), html });
    } catch (e) {
      warn(`texto completo: ${path} ilegível (${(e as Error).message}) — ignorado`);
    }
  }
  return out;
}

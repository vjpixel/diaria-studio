/**
 * artigo-especial-meta.ts (#5979)
 *
 * Extrator puro de metadados de um artigo especial já deployado em
 * `workers/artigos/public/{ano}/{slug}/index.html`. Usado pelo Passo 0 da
 * skill `/diaria-artigo-especial` — a fonte do artigo é o Worker JÁ
 * publicado (deploy é pré-requisito manual, fora do escopo desta skill),
 * então este módulo só LÊ o HTML estático, nunca gera/edita artigo.
 *
 * ## Convenção assumida (estável, `workers/artigos/README.md`)
 *
 * Cada artigo é um documento HTML autocontido com:
 *   - `<title>` / `<meta property="og:title">` — título.
 *   - `<meta name="description">` / `<meta property="og:description">` —
 *     resumo de 1 frase.
 *   - `<meta property="og:url">` — URL canônica.
 *   - `<meta property="og:image">` — capa (`.../capa.jpg`).
 *   - JSON-LD `Article` (`<script type="application/ld+json">`) —
 *     `datePublished`/`dateModified`.
 *   - `<h1>` seguido, no `.manuscript`, por um `<p class="lede">` (parágrafo
 *     de abertura sempre presente) e, opcionalmente, um ou mais `<p>` sem
 *     classe ENTRE o lede e o primeiro `<h3 class="sect">`. `leadParagraphs`
 *     SEMPRE pula TODOS esses parágrafos intermediários (não só o 1º — achado
 *     #5988/pr-test-analyzer #6000: o corte é por posição, `afterLede.slice(
 *     firstSectIdx)` descarta o bloco inteiro antes do 1º `h3.sect`, qualquer
 *     que seja a quantidade), qualquer que seja o conteúdo — é um recorte
 *     estrutural (posição), não semântico
 *     (não lê o texto pra decidir se é "nota de apresentação" ou conteúdo
 *     real). **Correção 23/08/2026 (achado do review do #5979, PR #6000):**
 *     a versão anterior deste comentário afirmava que só
 *     `engenharia-de-ilusao` tinha esse parágrafo intermediário
 *     ("nota de apresentação", ex: de onde veio o tema) e que `o-agente`
 *     não tinha — **falso**, confirmado relendo o HTML publicado: os 2
 *     artigos têm a mesma estrutura (`lede` → 1 `<p>` sem classe → 1º
 *     `h3.sect`), só que o parágrafo intermediário de `o-agente` é uma
 *     frase de referência a cobertura anterior (`"A diar.ia.br já havia
 *     coberto esse mesmo modelo..."`), não uma nota sobre a origem do tema —
 *     ambos são descartados igual, pela mesma regra estrutural, sem
 *     distinção de conteúdo. **Trade-off aceito, não bug**: como não há
 *     sinal estrutural confiável pra separar "framing sobre o artigo" de
 *     "1ª frase de conteúdo real", o extrator sempre descarta o parágrafo
 *     nessa posição — o preço é perder ocasionalmente uma frase de
 *     conteúdo legítima (caso `o-agente`) em troca de nunca vazar
 *     comentário editorial fora de contexto (caso `engenharia-de-ilusao`,
 *     que motivou a regra, issue #5979 original). Se isso incomodar na
 *     prática, a correção exigiria julgamento semântico (LLM), não regex.
 *
 * ## Regex, não parser HTML
 *
 * O repo não tem dependência de parser HTML (cheerio/jsdom) — mesmo padrão
 * de `scripts/lib/newsletter-parse.ts` (regex sobre um formato próprio e
 * previsível). Os artigos são conteúdo AUTORAL do próprio projeto (não HTML
 * arbitrário de terceiros), então a superfície de casos é pequena e estável;
 * introduzir uma dependência nova só para isto não se justifica.
 */

import { readFileSync } from "node:fs";
import { isMainModule } from "./cli-args.ts";

export interface ArtigoEspecialMeta {
  title: string;
  description: string;
  url: string;
  image: string | null;
  datePublished: string | null;
  dateModified: string | null;
  /** Texto do `<h1>` — normalmente igual a `title`, mas lido separadamente
   *  (o `<title>` da aba pode ter sufixo/prefixo que o `<h1>` não tem). */
  h1: string;
  /**
   * Parágrafos de abertura reaproveitáveis como teaser (apoia.se, Passo 1 da
   * skill) — `[lede, ...próximos parágrafos de conteúdo real]`, cap em
   * `maxParagraphs` (default 3). A "nota de apresentação" (ver acima) nunca
   * entra aqui.
   */
  leadParagraphs: string[];
}

/** Decodifica as entidades HTML mais comuns em texto autoral em português. */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)));
}

/** Remove tags aninhadas (`<a>`, `<strong>`, `<span>`, etc.) preservando o texto. */
function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

function matchAttr(html: string, tagRe: RegExp): string | null {
  const m = html.match(tagRe);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

/** Pura: parseia o HTML já lido em memória. Exportada separada de
 *  `readArtigoMeta` pra permitir teste sem tocar filesystem. */
export function parseArtigoMetaHtml(html: string, maxParagraphs = 3): ArtigoEspecialMeta {
  const title =
    matchAttr(html, /<title>([\s\S]*?)<\/title>/i) ??
    matchAttr(html, /<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    "";
  const description =
    matchAttr(html, /<meta\s+name="description"\s+content="([^"]*)"/i) ??
    matchAttr(html, /<meta\s+property="og:description"\s+content="([^"]*)"/i) ??
    "";
  const url = matchAttr(html, /<meta\s+property="og:url"\s+content="([^"]*)"/i) ?? "";
  const image = matchAttr(html, /<meta\s+property="og:image"\s+content="([^"]*)"/i);

  let datePublished: string | null = null;
  let dateModified: string | null = null;
  const ldJsonMatch = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (ldJsonMatch) {
    try {
      const parsed = JSON.parse(ldJsonMatch[1]) as {
        "@graph"?: Array<{ datePublished?: string; dateModified?: string }>;
        datePublished?: string;
        dateModified?: string;
      };
      const node = parsed["@graph"]?.[0] ?? parsed;
      datePublished = node.datePublished ?? null;
      dateModified = node.dateModified ?? null;
    } catch (e) {
      // JSON-LD malformado — segue sem datas (resto do extrator não depende
      // disso), mas isso é sempre um bug de autoria (o JSON-LD é conteúdo
      // nosso, não de terceiro) — avisar em vez de engolir em silêncio
      // (#5979 review, achado do silent-failure-hunter).
      process.stderr.write(
        `[artigo-especial-meta] AVISO: JSON-LD malformado — datePublished/dateModified saem null (${(e as Error).message}).\n`,
      );
    }
  }

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1 = h1Match ? stripTags(h1Match[1]) : "";

  const leadParagraphs = extractLeadParagraphs(html, maxParagraphs);

  return { title, description, url, image, datePublished, dateModified, h1, leadParagraphs };
}

/**
 * Extrai `[lede, ...conteúdo real]`, ignorando a nota de apresentação —
 * ver docstring do módulo pra regra estrutural completa. Exportada
 * separadamente pra testar a regra sem montar o objeto inteiro.
 */
export function extractLeadParagraphs(html: string, maxParagraphs = 3): string[] {
  const manuscriptMatch = html.match(/<div class="manuscript">([\s\S]*?)(?:<div class="manuscript-|$)/i);
  const region = manuscriptMatch ? manuscriptMatch[1] : html;

  const ledeMatch = region.match(/<p class="lede">([\s\S]*?)<\/p>/i);
  if (!ledeMatch) return [];
  const lede = stripTags(ledeMatch[1]);
  if (!lede) return [];

  const leadParagraphs = [lede];
  if (leadParagraphs.length >= maxParagraphs) return leadParagraphs;

  // Região após o lede até o fim do manuscript.
  const afterLedeIdx = region.indexOf(ledeMatch[0]) + ledeMatch[0].length;
  const afterLede = region.slice(afterLedeIdx);

  // 1º h3.sect marca o início do conteúdo real (se existir). Qualquer <p>
  // ANTES dele (sem classe "lede", já consumida) é nota de apresentação —
  // descartada por completo, não só o 1º.
  const firstSectIdx = afterLede.search(/<h3\s+class="sect"/i);
  const contentRegion = firstSectIdx >= 0 ? afterLede.slice(firstSectIdx) : afterLede;

  const pRe = /<p(?:\s+class="([^"]*)")?[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(contentRegion)) && leadParagraphs.length < maxParagraphs) {
    const cls = m[1] ?? "";
    if (cls === "lede") continue; // não deveria repetir, mas defensivo.
    const text = stripTags(m[2]);
    if (text) leadParagraphs.push(text);
  }

  return leadParagraphs;
}

export class ArtigoEspecialMetaError extends Error {}

/**
 * Valida que a extração produziu o mínimo utilizável. `title`/`url` vazios
 * nunca são "o artigo legitimamente não tem título" — são sinal de que o
 * template do artigo mudou (tag renomeada/removida) e o extrator não
 * encontrou nada pra casar. Sem esse guard, `""` se propagava em silêncio
 * até virar um erro confuso 2-3 passos depois (URL vazia no `HEAD`/`GET` de
 * liveness do Passo 0, ou título vazio no prompt do subagente de texto do
 * Passo 1) — achado do silent-failure-hunter no review do #5979 (PR #6000).
 * `description`/`image`/datas seguem opcionais de propósito (podem estar
 * genuinamente ausentes sem indicar falha de extração).
 */
export function assertArtigoEspecialMeta(meta: ArtigoEspecialMeta, path: string): void {
  const missing: string[] = [];
  if (!meta.title) missing.push("<title>/og:title");
  if (!meta.url) missing.push("og:url");
  if (missing.length > 0) {
    throw new ArtigoEspecialMetaError(
      `${path}: extração de metadados falhou (${missing.join(", ")} ausente) — ` +
        "o template do artigo pode ter mudado (ver workers/artigos/README.md pro shape esperado).",
    );
  }
}

/** Lê, parseia e valida (`assertArtigoEspecialMeta`) o arquivo do artigo
 *  publicado. Lança se o arquivo não existir, ou se a extração não produziu
 *  title/url (caller — Passo 0 da skill — decide a mensagem de erro
 *  acionável a partir da exceção). */
export function readArtigoMeta(path: string, maxParagraphs = 3): ArtigoEspecialMeta {
  const html = readFileSync(path, "utf8");
  const meta = parseArtigoMetaHtml(html, maxParagraphs);
  assertArtigoEspecialMeta(meta, path);
  return meta;
}

// ── CLI (debug/inspeção manual) ─────────────────────────────────────────

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) {
    console.error("Uso: npx tsx scripts/lib/artigo-especial-meta.ts <path-para-index.html>");
    process.exit(2);
  }
  const meta = readArtigoMeta(path);
  console.log(JSON.stringify(meta, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

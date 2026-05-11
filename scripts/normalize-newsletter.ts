/**
 * normalize-newsletter.ts (#157)
 *
 * Pós-processador defensivo do output do writer (Stage 2). Corrige
 * formato quando o LLM concatena elementos numa linha única que o
 * template exige separados.
 *
 * Bugs cobertos:
 *
 * 1. Cabeçalho de destaque + 3 títulos colados:
 *    "DESTAQUE 1 | GEOPOLÍTICA Brasil... EUA... Pacotes..."
 *    →
 *    "DESTAQUE 1 | GEOPOLÍTICA\nBrasil...\nEUA...\nPacotes..."
 *
 * 2. Item de seção (LANÇAMENTOS/PESQUISAS/OUTRAS NOTÍCIAS) com
 *    título + descrição + URL na mesma linha:
 *    "Título qualquer Descrição em 1 frase. [https://x](https://x)"
 *    →
 *    "Título qualquer\nDescrição em 1 frase.\nhttps://x"
 *
 * Heurística conservadora — só reformata quando o pattern é claro;
 * caso ambíguo, deixa como está e sinaliza warning.
 *
 * Uso:
 *   npx tsx scripts/normalize-newsletter.ts \
 *     --in <md-path> \
 *     --out <md-path>
 *
 * Output JSON em stderr: { highlight_headers_split, section_items_split, warnings[] }.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isInlineLinkLine } from "./lib/inline-link.ts"; // #599
import { readEiaAnswer } from "./lib/eia-answer.ts"; // #927

export interface NormalizeReport {
  highlight_headers_split: number;
  section_items_split: number;
  emdashes_removed: number;
  warnings: string[];
}

const TITLE_MAX_CHARS = 52;
const TITLE_TOLERANCE = 60; // pequena folga; títulos válidos podem chegar a ~52

/**
 * Quebra "DESTAQUE N | CATEGORIA <título1> <título2> <título3>" em 4 linhas
 * separadas. Retorna a linha original se não detectar concatenação.
 *
 * Heurística: se a linha começa com "DESTAQUE N | CAT " e tem texto extra,
 * tenta dividir esse extra em 3 títulos por largura/pontuação.
 */
export function splitConcatenatedHighlightHeader(
  line: string,
): { lines: string[]; split: boolean } {
  const m = line.match(/^(DESTAQUE\s+\d+\s*\|\s*[A-ZÁ-Ú0-9 ]+?)\s+(.+)$/);
  if (!m) return { lines: [line], split: false };
  const header = m[1].trim();
  const rest = m[2].trim();
  if (!rest) return { lines: [line], split: false };

  // Tentar dividir o rest em 3 títulos. Estratégia: greedy split por largura.
  // Cada título deve ter palavras inteiras + ≤ TITLE_TOLERANCE chars.
  const words = rest.split(/\s+/);
  const titles: string[] = [];
  let current: string[] = [];
  for (const w of words) {
    const candidate = [...current, w].join(" ");
    if (
      candidate.length > TITLE_TOLERANCE &&
      current.length > 0 &&
      titles.length < 2
    ) {
      titles.push(current.join(" "));
      current = [w];
    } else {
      current.push(w);
    }
  }
  if (current.length > 0) titles.push(current.join(" "));

  // Só aceita split se chegou a exatamente 3 títulos plausíveis.
  if (titles.length !== 3) return { lines: [line], split: false };
  if (titles.some((t) => t.length === 0)) return { lines: [line], split: false };

  return { lines: [header, ...titles], split: true };
}

/**
 * Quebra item de seção concatenado.
 *
 * Layout esperado pós-#172: cada item é `Título / URL / Descrição` em
 * 3 linhas. Aqui tratamos a forma colapsada (LLM colocou tudo numa
 * linha só) e devolvemos as 3 linhas na ordem nova.
 *
 * Casos:
 *  - "Título com pontuação. URL Descrição." → [título, URL, descrição]
 *  - "Título sem ponto URL Descrição." → [título_textBefore, URL] (warning)
 *  - "Título URL" (sem descrição depois) → [textBefore, URL]
 *
 * Compat: também aceitamos a forma legacy `Título Descrição URL` quando
 * a URL está no fim — extraímos URL e re-emitimos na ordem nova.
 *
 * Heurística:
 *  1. Achar a URL na linha (qualquer posição).
 *  2. Se há texto depois da URL → forma nova colapsada: textBefore +
 *     URL + textAfter; usa textAfter como descrição (já é uma frase).
 *     textBefore é o título.
 *  3. Se NÃO há texto depois → forma legacy (URL no fim). Aplica a
 *     heurística antiga: separa textBefore por último "." em
 *     título + descrição e re-emite na ordem nova.
 */
export function splitConcatenatedSectionItem(
  line: string,
): { lines: string[]; split: boolean; warning?: string } {
  // #909 — guard: linha que é APENAS um inline link bem-formado (sem texto
  // antes nem depois do `)`) não deve ser tocada. Sem este guard, o
  // bareUrlRe abaixo casa a URL dentro de `(...)`, produz textBefore/After
  // estranhos e re-emite linhas corrompidas.
  if (isInlineLinkLine(line)) {
    return { lines: [line], split: false };
  }

  // M2: detecta múltiplas URLs na linha. Caso ambíguo — recusa split
  // pra não chutar a fronteira errada e silenciosamente corromper o
  // conteúdo. Conta tanto bare URLs quanto markdown links.
  const bareUrlGlobalRe = /https?:\/\/[^\s\)\]]+/g;
  const bareUrlMatches = [...line.matchAll(bareUrlGlobalRe)];
  const mdLinkGlobalRe = /\[([^\]]+)\]\(\1\)/g;
  const mdLinkMatches = [...line.matchAll(mdLinkGlobalRe)];
  // Conta URLs distintas (2 matches dentro de 1 markdown link representam
  // uma URL canônica só — bare match casa a parte do `[url]` E `(url)`).
  const distinctUrls = new Set<string>();
  for (const m of bareUrlMatches) {
    distinctUrls.add(m[0].replace(/[).,;]+$/, ""));
  }
  for (const m of mdLinkMatches) {
    distinctUrls.add(m[1].trim());
  }
  if (distinctUrls.size >= 2) {
    return {
      lines: [line],
      split: false,
      warning: `linha tem ${distinctUrls.size} URLs distintas — split ambíguo, não toquei: "${line.slice(0, 80)}..."`,
    };
  }

  // Caso A1 (#909): markdown link `[Título](URL)` proper (title text
  // diferente da URL) seguido de descrição na mesma linha. Forma comum
  // do bug: writer emite `**[Título](URL)**` + texto descritivo colado.
  // Trata isso como caso prioritário — devolve `[Título](URL)` + descrição
  // em 2 linhas (sem extrair URL bare). Aceita `**`/spaces wrappers.
  const inlineLinkWithTextRe =
    /^(\s*\*{0,2}\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)\*{0,2})\s+(.+\S)\s*$/;
  const inlineLinkWithText = line.match(inlineLinkWithTextRe);
  if (inlineLinkWithText) {
    const linkPart = inlineLinkWithText[1].trim();
    const description = inlineLinkWithText[4].trim();
    // Sanity: descrição deve ter conteúdo real (≥3 chars) — evita pegar
    // pontuação isolada como `**[X](Y)** .`
    if (description.length >= 3) {
      return { lines: [linkPart, description], split: true };
    }
  }

  // Caso A2: markdown link [url](url) em qualquer posição (legacy — title
  // == url, bare URL render como link clicável)
  const mdLinkRe = /\[([^\]]+)\]\(\1\)/;
  const mdLinkMatch = line.match(mdLinkRe);
  // Caso B: bare URL em qualquer posição
  const bareUrlRe = /https?:\/\/[^\s\)\]]+/;
  const bareUrlMatch = line.match(bareUrlRe);

  let url: string;
  let urlStart: number;
  let urlEnd: number;

  if (mdLinkMatch && mdLinkMatch.index !== undefined) {
    url = mdLinkMatch[1].trim();
    urlStart = mdLinkMatch.index;
    urlEnd = urlStart + mdLinkMatch[0].length;
  } else if (bareUrlMatch && bareUrlMatch.index !== undefined) {
    url = bareUrlMatch[0].trim().replace(/[).,;]+$/, "");
    urlStart = bareUrlMatch.index;
    urlEnd = urlStart + bareUrlMatch[0].length;
  } else {
    return { lines: [line], split: false };
  }

  const textBefore = line.slice(0, urlStart).trim();
  const textAfter = line.slice(urlEnd).trim();

  if (!textBefore && !textAfter) {
    // Linha só com URL, sem concat. Não tocar.
    return { lines: [line], split: false };
  }

  if (!textBefore) {
    // URL no início + texto depois — não dá pra inferir título com confiança.
    return { lines: [line], split: false };
  }

  // Forma nova colapsada: título + URL + descrição (textAfter presente).
  if (textAfter) {
    if (textBefore.length < 5 || textBefore.length > 120) {
      return {
        lines: [textBefore, url, textAfter],
        split: true,
        warning: `split heurístico produziu título com ${textBefore.length} chars, fora da faixa esperada`,
      };
    }
    return { lines: [textBefore, url, textAfter], split: true };
  }

  // Forma legacy: URL no fim. Tentar separar título/descrição no textBefore.
  const lastPeriodIdx = textBefore.lastIndexOf(". ");
  if (lastPeriodIdx === -1) {
    return {
      lines: [textBefore, url],
      split: true,
      warning: `não consegui separar título de descrição (sem ponto): "${line.slice(0, 80)}..."`,
    };
  }

  const title = textBefore.slice(0, lastPeriodIdx + 1).trim();
  const description = textBefore.slice(lastPeriodIdx + 1).trim();

  if (title.length < 5 || title.length > 120) {
    return {
      lines: [textBefore, url],
      split: true,
      warning: `split heurístico produziu título estranho (${title.length} chars), preservei texto+url separados`,
    };
  }

  // Re-emite na ordem nova: título / URL / descrição.
  return { lines: [title, url, description], split: true };
}

const SECTION_HEADERS = [
  "LANÇAMENTOS",
  "LANCAMENTOS",
  "PESQUISAS",
  "OUTRAS NOTÍCIAS",
  "OUTRAS NOTICIAS",
  "NOTÍCIAS",
  "NOTICIAS",
];

function isSectionHeader(line: string): boolean {
  // Aceita plain ou **negrito** (#590) — writer pós-#590 emite headers com bold
  const trimmed = line.trim().replace(/^\*\*|\*\*$/g, "").trim();
  return SECTION_HEADERS.some((h) => trimmed === h);
}

function isHighlightHeader(line: string): boolean {
  // Aceita plain ou **negrito** (#590)
  return /^(?:\*\*)?DESTAQUE\s+\d+\s*\|/.test(line.trim());
}

function looksLikeUrl(line: string): boolean {
  return /https?:\/\//.test(line);
}

/**
 * Adiciona trailing spaces (`  `) para forçar quebra de linha no Drive/Google
 * Docs (#382). Sem eles, linhas consecutivas colapsam em parágrafo único.
 *
 * Linhas afetadas:
 * - Opções de título nos blocos DESTAQUE (antes da URL)
 * - Linha de título de cada item nas seções secundárias
 * - Linha de URL de cada item nas seções secundárias
 *
 * Não afetadas: URL do destaque, corpo/descrição, cabeçalhos, separadores `---`.
 * Idempotente: aplica trimEnd() antes de adicionar `  `.
 *
 * #691: caller pode passar `warnings` array opcional pra coletar warnings
 * estruturais (ex: destaque sem URL — todas as linhas até `---` viram
 * "título" e ganham trailing spaces, quebrando o corpo).
 */
export function addTrailingSpaces(text: string, warnings?: string[]): string {
  const lines = text.split("\n");
  const out: string[] = [];

  let ctx: "highlight" | "section" | null = null;
  let highlightUrlSeen = false;
  let highlightHeader: string | null = null;
  // #599: rastreia se já apareceu ao menos 1 inline link no bloco de destaque
  // atual. Quando true e chega linha não-inline-link não-blank, transiciona
  // pra body (não mais título). Não usa lookup no array (frágil ante blanks).
  let highlightInlineLinkSeen = false;
  let sectionExpectTitle = false;
  let sectionExpectUrl = false;

  // #691: estrito — linha INTEIRA é uma URL (nada de texto adicional). Match
  // bare `https://...` OU markdown `[https://...](https://...)`. Antes era
  // `/^\s*\[?https?:\/\//` (qualquer prefixo) e linhas tipo
  // "https://foo.com diz que X" eram tratadas como URL line.
  const isUrl = (s: string) => /^\s*(?:\[https?:\/\/\S+\]\(https?:\/\/\S+\)|https?:\/\/\S+)\s*$/.test(s);

  const emitHighlightUrlMissingWarning = () => {
    if (warnings && ctx === "highlight" && !highlightUrlSeen && highlightHeader) {
      warnings.push(
        `destaque "${highlightHeader}" terminou sem URL — trailing spaces aplicados ` +
          `em todas as linhas; corpo pode renderizar com line-breaks indesejados`,
      );
    }
  };

  for (const raw of lines) {
    const t = raw.trimEnd();

    // Reset em separadores
    if (t === "---") {
      emitHighlightUrlMissingWarning();
      ctx = null; highlightUrlSeen = false; highlightHeader = null;
      highlightInlineLinkSeen = false;
      sectionExpectTitle = false; sectionExpectUrl = false;
      out.push(t); continue;
    }

    // Header de destaque
    if (isHighlightHeader(t)) {
      emitHighlightUrlMissingWarning();
      ctx = "highlight"; highlightUrlSeen = false; highlightHeader = t;
      highlightInlineLinkSeen = false;
      out.push(t); continue;
    }

    // Header de seção secundária
    if (isSectionHeader(t)) {
      emitHighlightUrlMissingWarning();
      ctx = "section"; sectionExpectTitle = true; sectionExpectUrl = false;
      highlightHeader = null; highlightInlineLinkSeen = false;
      out.push(t); continue;
    }

    // Linha em branco — dentro de seção, próximo item começa
    if (t === "") {
      if (ctx === "section") { sectionExpectTitle = true; sectionExpectUrl = false; }
      out.push(t); continue;
    }

    // Bloco DESTAQUE: títulos antes da URL recebem trailing spaces
    if (ctx === "highlight" && !highlightUrlSeen) {
      if (isUrl(t)) {
        highlightUrlSeen = true;
        out.push(t); // URL do destaque: sem trailing space
      } else if (isInlineLinkLine(t)) {
        // #599 — formato inline `[título](URL)`. Trailing spaces pra separação
        // visual no Drive preview. Flipa highlightInlineLinkSeen pra que
        // qualquer linha não-link que venha depois (mesmo após blank) seja
        // reconhecida como body.
        highlightInlineLinkSeen = true;
        out.push(t + "  ");
      } else {
        // Linha não-blank, não-URL, não-inline-link dentro de bloco DESTAQUE.
        // Se já vimos um inline link → body começou; transição. Caso contrário,
        // trata como opção de título legacy (formato antigo sem inline link).
        if (highlightInlineLinkSeen) {
          highlightUrlSeen = true;
          out.push(t); // body — sem trailing
          continue;
        }
        out.push(t + "  "); // opção de título legacy (sem inline link)
      }
      continue;
    }

    // Seção secundária: título + URL recebem trailing spaces
    if (ctx === "section") {
      if (sectionExpectTitle && !isUrl(t)) {
        out.push(t + "  ");
        sectionExpectTitle = false; sectionExpectUrl = true;
        continue;
      }
      if (sectionExpectUrl && isUrl(t)) {
        out.push(t + "  ");
        sectionExpectUrl = false;
        continue;
      }
      // Edge case: esperava URL mas veio outra coisa → reset expectativa
      if (sectionExpectUrl) sectionExpectUrl = false;
    }

    out.push(t);
  }

  // EOF — destaque sem URL no fim do arquivo também emite warning
  emitHighlightUrlMissingWarning();

  return out.join("\n");
}

/**
 * Remove travessões (—) restantes após humanizador, substituindo por vírgula.
 * Rede de segurança pós-humanizador — apanha os que escaparam da revisão contextual.
 * Preserva meia-risca (–) em intervalos numéricos (U+2013 ≠ U+2014).
 */
export function removeEmdashes(text: string): { text: string; count: number } {
  let count = 0;
  // #1098: travessão após pontuação final ("Foo. — Bar") → "Foo. Bar"
  // Antes: " — " virava ", " cegamente, gerando ". , " (ponto + vírgula).
  // Caso observado em 260512 (crédito do É IA?: "Paquistão. — [autor]").
  let result = text.replace(/([.!?:;]) — /g, (_m, punct) => {
    count++;
    return punct + " ";
  });
  // " — " (espaço + travessão + espaço) sem pontuação final precedente → ", "
  result = result.replace(/ — /g, () => { count++; return ", "; });
  // Travessão sem espaços adjacentes (raro) → ", " para manter legibilidade
  result = result.replace(/—/g, () => { count++; return ", "; });
  return { text: result, count };
}

/**
 * Pre-fix: detecta markdown link com URL quebrada em múltiplas linhas
 * (`[Título](\n  url\n  )`) e colapsa pra forma canônica `[Título](url)`
 * em uma única linha. Sintoma observado em 260507 (#909) — writer LLM
 * quebrou dentro do parens em vez de depois do link.
 *
 * Reescreve o markdown global (não trata linha-por-linha) porque o bug
 * é multi-linha. Idempotente — não toca em links bem-formados.
 *
 * Retorna objeto `{ text, fixed_count }` pra report.
 */
export function fixBrokenInlineLinks(
  text: string,
): { text: string; fixed_count: number } {
  let count = 0;
  // Match `[Título](\n*\s*url\s*\n*)` em múltiplas linhas. `[\s\S]` evita
  // dot-all flag mismatch entre engines. Conservador: requer URL imediatamente
  // após `(` (com possível whitespace+newline) e `)` no fim com possível
  // whitespace.
  const re =
    /\[([^\]\n]+)\]\(\s*\n\s*(https?:\/\/[^\s)]+)\s*\n\s*\)/g;
  const out = text.replace(re, (_match, title, url) => {
    count++;
    return `[${title.trim()}](${url.trim()})`;
  });
  return { text: out, fixed_count: count };
}

export function normalizeNewsletter(text: string): {
  text: string;
  report: NormalizeReport;
} {
  // Pre-fix multi-line broken inline links (#909)
  const { text: prefixed, fixed_count: brokenLinks } = fixBrokenInlineLinks(text);
  const lines = prefixed.split("\n");
  const out: string[] = [];
  const report: NormalizeReport = {
    highlight_headers_split: 0,
    section_items_split: 0,
    emdashes_removed: 0,
    warnings: [],
  };
  if (brokenLinks > 0) {
    report.warnings.push(
      `${brokenLinks} markdown link(s) com URL quebrada em múltiplas linhas — colapsado pra [título](url) único`,
    );
  }

  // Track section context — quando estamos dentro de LANÇAMENTOS/PESQUISAS/etc,
  // tentar split de items concatenados. Em DESTAQUE bodies, NÃO mexer (o LLM
  // pode ter URL no meio do parágrafo legitimamente — fora de escopo).
  let inSection: "highlight" | "section" | null = null;

  for (const raw of lines) {
    const line = raw;

    if (isHighlightHeader(line)) {
      const r = splitConcatenatedHighlightHeader(line);
      if (r.split) {
        report.highlight_headers_split++;
        out.push(...r.lines);
      } else {
        out.push(line);
      }
      inSection = "highlight";
      continue;
    }

    if (isSectionHeader(line)) {
      inSection = "section";
      out.push(line);
      continue;
    }

    if (line.trim() === "---") {
      // Reset section tracking em separadores (evita inferência cross-section).
      out.push(line);
      continue;
    }

    if (inSection === "section" && looksLikeUrl(line) && line.trim().length > 0) {
      // Detecta item concat: linha que tem texto + URL juntos
      const hasTextBeforeUrl = !/^\s*(\[?https?:\/\/|https?:\/\/)/.test(line);
      if (hasTextBeforeUrl) {
        const r = splitConcatenatedSectionItem(line);
        if (r.split) {
          report.section_items_split++;
          if (r.warning) report.warnings.push(r.warning);
          out.push(...r.lines);
        } else {
          out.push(line);
        }
        continue;
      }
    }

    out.push(line);
  }

  const withTrailingSpaces = addTrailingSpaces(out.join("\n"), report.warnings);
  const { text: normalized, count: emdashes } = removeEmdashes(withTrailingSpaces);
  report.emdashes_removed = emdashes;
  if (emdashes > 0) {
    report.warnings.push(`${emdashes} travessão(ões) substituído(s) por vírgula — humanizador deve ter corrigido antes`);
  }
  return { text: normalized, report };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

/**
 * Extrai `eia_answer` do frontmatter YAML de um arquivo markdown (#744).
 * Retorna a string YAML bruta do bloco (sem as delimitações `---`) ou null
 * se não houver frontmatter ou se `eia_answer` não estiver presente.
 *
 * Suporta tanto forma escalar ("eia_answer: ia") quanto mapeamento multi-linha
 * ("eia_answer:\n  A: real\n  B: ia"). Devolve o bloco YAML completo do
 * frontmatter (entre os `---`) para ser re-emitido como-está no cabeçalho do
 * output, preservando a estrutura exata que o eia-composer gravou.
 */
export function extractEiaFrontmatter(eiaPath: string): string | null {
  if (!existsSync(eiaPath)) return null;
  const content = readFileSync(eiaPath, "utf8");
  // Frontmatter: bloco entre o primeiro `---` e o segundo `---`
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const block = fm[1];
  if (!/eia_answer/i.test(block)) return null;
  return block;
}

/**
 * #927: Resolve o bloco YAML `eia_answer:` para propagar pra `02-reviewed.md`.
 * Tenta na ordem:
 *   1. Sidecar JSON `_internal/01-eia-answer.json` (canonical, pós-#927).
 *   2. Frontmatter de `01-eia.md` (legacy / backward compat).
 *
 * Sidecar tem precedência porque sobrevive Drive round-trip; frontmatter
 * pode ter sido strippado se 01-eia.md já passou pelo Drive.
 */
export function resolveEiaFrontmatterBlock(editionDir: string): string | null {
  const answer = readEiaAnswer(editionDir);
  if (answer) {
    return `eia_answer:\n  A: ${answer.A}\n  B: ${answer.B}`;
  }
  const eiaPath = resolve(editionDir, "01-eia.md");
  return extractEiaFrontmatter(eiaPath);
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  if (!args.in || !args.out) {
    console.error("Uso: normalize-newsletter.ts --in <md-path> --out <md-path>");
    process.exit(1);
  }
  const inPath = resolve(ROOT, args.in);
  const outPath = resolve(ROOT, args.out);
  const text = readFileSync(inPath, "utf8");
  const result = normalizeNewsletter(text);

  // #1069: NÃO injetar `eia_answer:` frontmatter no output. Antes (#744/#927):
  // o frontmatter era prepended pra propagar gabarito; mas o sidecar
  // `_internal/01-eia-answer.json` (#927) já é canonical e sobrevive Drive
  // round-trip. Quando 02-reviewed.md é colado manualmente no Beehiiv (#1083),
  // qualquer frontmatter YAML residual aparece como texto literal no email.
  // Remover a injeção evita o bug visual + simplifica fluxo.
  const outputText = result.text;

  writeFileSync(outPath, outputText, "utf8");
  console.error(JSON.stringify(result.report, null, 2));
}

// Note (#1069): a injeção de frontmatter `eia_answer:` em `02-reviewed.md`
// foi REMOVIDA. Sidecar `_internal/01-eia-answer.json` (#927) é canonical,
// sobrevive Drive round-trip, e é precedence em `readEiaAnswer`. Lint
// (`checkEiaAnswer` em `scripts/lint-newsletter-md.ts`) aceita sidecar como
// source-of-truth. Frontmatter em `02-reviewed.md` aparecia como texto
// literal no paste manual no Beehiiv — bug visual eliminado.
// `extractEiaFrontmatter` e `resolveEiaFrontmatterBlock` permanecem exportados
// pra backward-compat (leitura de edições antigas), mas não são mais usados
// em runtime aqui.

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}

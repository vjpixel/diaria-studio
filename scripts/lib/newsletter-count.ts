/**
 * newsletter-count.ts (#1455)
 *
 * Single source of truth pra contagem de items selecionados num
 * `02-reviewed.md` final. Producer (`sync-coverage-line.ts`) e consumer
 * (`lint-newsletter-md.ts --check intro-count`) usam essa função pra evitar
 * divergência — caso 260522 onde producer setou "12" e consumer reclamou
 * "intro afirma 12 mas contagem real é 3" porque o lint usava regex que não
 * casava emoji prefix nem singular nas seções secundárias.
 *
 * Counted as visible items:
 *   - DESTAQUE N blocks (com ou sem emoji+pipe) — 1 URL por bloco
 *   - LANÇAMENTO(S) section items (singular ou plural, com ou sem emoji prefix)
 *   - PESQUISA(S) section items
 *   - OUTRA(S) NOTÍCIA(S) section items
 *
 * Skipped:
 *   - Bloco É IA?, SORTEIO, PARA ENCERRAR, ERRO INTENCIONAL, TÍTULO/SUBTÍTULO
 *   - Affiliate/footer URLs (diaria.beehiiv.com, wisprflow, clarice.ai,
 *     beehiiv.com?via, linkedin/facebook/wikipedia/creativecommons)
 */

export interface SelectedCounts {
  destaques: number;
  lancamentos: number;
  pesquisas: number;
  noticias: number;
  total: number;
}

const FOOTER_DOMAINS = [
  "diaria.beehiiv.com",
  "wisprflow.ai",
  "clarice.ai",
  "beehiiv.com?via",
  "linkedin.com/company",
  "facebook.com/diar.ia",
  "pt.wikipedia.org",
  "commons.wikimedia.org",
  "creativecommons.org",
];

const SKIP_HEADER_NAMES = [
  "SORTEIO",
  "PARA ENCERRAR",
  "ERRO INTENCIONAL",
  "É IA?",
  "ASSINE",
  "TÍTULO",
  "SUBTÍTULO",
];

// Regex pra reconhecer header de seção secundária. Aceita:
//   **LANÇAMENTOS** / **LANÇAMENTO** (plural/singular)
//   **🚀 LANÇAMENTOS** / **🚀 LANÇAMENTO** (com emoji prefix)
//   **OUTRAS NOTÍCIAS** / **OUTRA NOTÍCIA**
//   **📰 OUTRAS NOTÍCIAS**
//   E DESTAQUE N | ...
//
// Restrição: prefixo entre `**` e nome da seção é `[^\n\[]*?` (sem `[`)
// pra evitar matchar `**[Título A](url)**` onde "Título" bateria com TÍTULO.
const SECTION_HEADER_LOOKAHEAD =
  /(?=^\*\*[^\n\[]*?(?:LAN[ÇC]AMENTOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?|OUTRA\s+NOT[ÍI]CIA|SORTEIO|PARA ENCERRAR|ERRO INTENCIONAL|ASSINE|T[ÍI]TULO|SUBT[ÍI]TULO|DESTAQUE\s+\d)[^\n]*\*\*\s*$)|(?=^##\s+É\s+IA\?)/im;

/**
 * Pure: parsea o MD e retorna a contagem por bucket + total visível.
 *
 * O total é a soma de URLs únicas (cada URL conta 1×) nos blocos editoriais
 * relevantes. Usado por sync-coverage-line (escreve Z na intro) e
 * lint-newsletter-md (valida intro vs contagem).
 */
export function countSelectedItems(md: string): SelectedCounts {
  const rawSections = md.split(/^---\s*$/m);
  const allBlocks: string[] = [];
  for (const sec of rawSections) {
    allBlocks.push(...sec.split(SECTION_HEADER_LOOKAHEAD));
  }

  const buckets: SelectedCounts = {
    destaques: 0,
    lancamentos: 0,
    pesquisas: 0,
    noticias: 0,
    total: 0,
  };

  const linkRe = /\[(?:\*\*)?([^\]]+?)(?:\*\*)?\]\((https?:\/\/[^)]+)\)/g;

  for (const section of allBlocks) {
    // Skip blocos editoriais fixos
    const isSkip = SKIP_HEADER_NAMES.some((h) => section.includes(h));
    if (isSkip) continue;

    // Identifica o bucket pela header. Default = noticias se nenhum match.
    let bucket: "destaques" | "lancamentos" | "pesquisas" | "noticias" | null = null;
    if (/DESTAQUE\s+\d/i.test(section)) bucket = "destaques";
    else if (/\bLAN[ÇC]AMENTOS?\b/i.test(section)) bucket = "lancamentos";
    else if (/\bPESQUISAS?\b/i.test(section)) bucket = "pesquisas";
    else if (/OUTRAS?\s+NOT[ÍI]CIAS?\b|OUTRA\s+NOT[ÍI]CIA/i.test(section)) bucket = "noticias";

    if (!bucket) continue;

    const urls = new Set<string>();
    let m: RegExpExecArray | null;
    linkRe.lastIndex = 0;
    while ((m = linkRe.exec(section)) !== null) {
      const url = m[2];
      const isFooter = FOOTER_DOMAINS.some((d) => url.includes(d));
      if (isFooter) continue;
      urls.add(url);
    }
    // Para destaques, o bloco tem 1 URL (o título); contamos 1 por bloco
    // DESTAQUE. Para seções secundárias, cada item = 1 URL.
    if (bucket === "destaques") {
      // Pode haver múltiplos DESTAQUE em um único allBlocks slice se o split
      // não particionou completamente. Conta 1 por marcador encontrado.
      const destaqueCount = (section.match(/DESTAQUE\s+\d/gi) || []).length;
      buckets.destaques += destaqueCount;
      buckets.total += destaqueCount;
    } else {
      buckets[bucket] += urls.size;
      buckets.total += urls.size;
    }
  }

  return buckets;
}

/**
 * Pure: extrai o número declarado na frase "Selecionamos os X mais relevantes"
 * do intro. Aceita variações de verbo pós-humanizer/Clarice.
 *
 * Retorna `null` se a frase não bater no padrão (caller decide se trata
 * ausência como ok ou erro).
 */
export function extractIntroClaimedCount(md: string): number | null {
  const normalized = md.replace(/\r\n/g, "\n");
  const introMatch = normalized.match(
    /(?:Selecionamos|Escolhemos|Reunimos|Destacamos|Separamos|Trouxemos)\s+os?\s+(\d+)/i,
  );
  if (!introMatch) return null;
  return parseInt(introMatch[1], 10);
}

export interface IntroCountResult {
  ok: boolean;
  claimed?: number;
  actual?: number;
}

/**
 * Pure: valida que intro count bate com a contagem real.
 *
 * Retorna `{ok: true}` quando o intro não declara contagem (forma alternativa
 * ou ausência) — não bloqueia. Quando declara, compara com `countSelectedItems`.
 */
export function lintIntroCount(md: string): IntroCountResult {
  const claimed = extractIntroClaimedCount(md);
  if (claimed === null) return { ok: true };
  const counts = countSelectedItems(md);
  return {
    ok: claimed === counts.total,
    claimed,
    actual: counts.total,
  };
}

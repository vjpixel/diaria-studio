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
 *   - OUTRA(S) NOTÍCIA(S) / OUTRO(S) LINK(S) section items
 *   - USE MELHOR section items (#1568 — bucket `tutorial`)
 *   - VÍDEOS section items (bucket `video`)
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
  tutoriais: number;
  videos: number;
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
  /(?=^\*\*[^\n\[]*?(?:LAN[ÇC]AMENTOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?|OUTRA\s+NOT[ÍI]CIA|OUTROS?\s+LINKS?|USE\s+MELHOR|V[ÍI]DEOS?|SORTEIO|PARA ENCERRAR|ERRO INTENCIONAL|ASSINE|T[ÍI]TULO|SUBT[ÍI]TULO|DESTAQUE\s+\d)[^\n]*\*\*\s*$)|(?=^##\s+É\s+IA\?)/imu;

/**
 * Pure: parsea o MD e retorna a contagem por bucket + total visível.
 *
 * O total é a soma de URLs únicas (cada URL conta 1×) nos blocos editoriais
 * relevantes. Usado por sync-coverage-line (escreve Z na intro) e
 * lint-newsletter-md (valida intro vs contagem).
 */
// Regex pra detectar header de section como linha standalone. Mais restrito
// que `section.includes(name)` — só casa quando o nome aparece numa linha que
// é APENAS o header (com bold opcional + emoji prefix opcional).
const SECTION_HEADER_LINE_RE =
  /^\s*(?:\*\*)?(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][️‍\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}]*\s+)?(LAN[ÇC]AMENTOS?|PESQUISAS?|OUTRAS?\s+NOT[ÍI]CIAS?|OUTRA\s+NOT[ÍI]CIA|OUTROS?\s+LINKS?|USE\s+MELHOR|V[ÍI]DEOS?|SORTEIO|PARA ENCERRAR|ERRO INTENCIONAL|ASSINE|T[ÍI]TULO|SUBT[ÍI]TULO|É\s+IA\?)\s*(?:\*\*)?\s*$/imu;
// Production format: `**DESTAQUE 1 | 🚀 LANÇAMENTO**`. Pipe é canonical mas
// tolerante a `**DESTAQUE 1**` standalone (fixtures de teste).
const DESTAQUE_HEADER_LINE_RE = /^\s*(?:\*\*)?DESTAQUE\s+\d+(?:\s*\||\s*(?:\*\*)?\s*$)/im;
const EIA_HEADER_LINE_RE = /^\s*(?:##\s+)?É\s+IA\?\s*$/im;

/**
 * Strip YAML frontmatter (entre primeiro par de `---` no topo). #1455 bug
 * caught by review: frontmatter intentional_error.location continha
 * \"DESTAQUE 3\" e era contado como destaque, inflando total.
 */
function stripFrontmatter(md: string): string {
  // Strip APENAS se entre `---` aparecer YAML key:value (heurística: ao
  // menos uma linha do tipo `chave:`/`chave: valor`). Sem isso, divisões
  // de seção (como `---` antes de DESTAQUE) seriam confundidas com FM.
  const m = md.match(/^\s*---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return md;
  const block = m[1];
  // Pelo menos 1 linha YAML-like (key: ou key: value, indentada ou não)
  if (!/^\s*[A-Za-z_][\w-]*\s*:/m.test(block)) return md;
  return md.slice(m[0].length);
}

export function countSelectedItems(md: string): SelectedCounts {
  // #1455 fix (review): strip frontmatter primeiro — sem isso, intentional_error
  // com \"DESTAQUE N\" polui contagem.
  const body = stripFrontmatter(md);
  const rawSections = body.split(/^---\s*$/m);
  const allBlocks: string[] = [];
  for (const sec of rawSections) {
    allBlocks.push(...sec.split(SECTION_HEADER_LOOKAHEAD));
  }

  const buckets: SelectedCounts = {
    destaques: 0,
    lancamentos: 0,
    pesquisas: 0,
    noticias: 0,
    tutoriais: 0,
    videos: 0,
    total: 0,
  };

  const linkRe = /\[(?:\*\*)?([^\]]+?)(?:\*\*)?\]\((https?:\/\/[^)]+)\)/g;

  for (const section of allBlocks) {
    // Skip blocos editoriais fixos — match em LINHA inteira, não substring.
    // Fix #1455 (review): `section.includes(name)` casava body text com
    // o nome (ex: artigo titulado \"PARA ENCERRAR o ano...\"), zerando seções
    // legítimas silenciosamente.
    const hasSkipHeader = SECTION_HEADER_LINE_RE.test(section) &&
      SKIP_HEADER_NAMES.some((h) => {
        // Constrói regex per-skip-name pra match em linha
        const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(
          `^\\s*(?:\\*\\*)?(?:[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]\\s+)?${escaped}\\s*(?:\\*\\*)?\\s*$`,
          "imu",
        );
        return re.test(section);
      });
    if (hasSkipHeader || EIA_HEADER_LINE_RE.test(section)) continue;

    // Identifica o bucket pela header em LINHA (não substring).
    // Fix #1455: antes `section.includes("DESTAQUE")` casava texto de body
    // (artigo que mencionasse \"DESTAQUE\" em descrição) e inflava destaques.
    let bucket:
      | "destaques"
      | "lancamentos"
      | "pesquisas"
      | "noticias"
      | "tutoriais"
      | "videos"
      | null = null;
    if (DESTAQUE_HEADER_LINE_RE.test(section)) bucket = "destaques";
    else if (/^\s*(?:\*\*)?(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][️‍\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}]*\s+)?LAN[ÇC]AMENTOS?\s*(?:\*\*)?\s*$/imu.test(section)) bucket = "lancamentos";
    else if (/^\s*(?:\*\*)?(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][️‍\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}]*\s+)?PESQUISAS?\s*(?:\*\*)?\s*$/imu.test(section)) bucket = "pesquisas";
    else if (/^\s*(?:\*\*)?(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][️‍\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}]*\s+)?(?:OUTRAS?\s+NOT[ÍI]CIAS?|OUTRA\s+NOT[ÍI]CIA|OUTROS?\s+LINKS?)\s*(?:\*\*)?\s*$/imu.test(section)) bucket = "noticias";
    else if (/^\s*(?:\*\*)?(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][️‍\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}]*\s+)?USE\s+MELHOR\s*(?:\*\*)?\s*$/imu.test(section)) bucket = "tutoriais";
    else if (/^\s*(?:\*\*)?(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][️‍\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}]*\s+)?V[ÍI]DEOS?\s*(?:\*\*)?\s*$/imu.test(section)) bucket = "videos";

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
    // Para destaques, cada bloco = 1 destaque com 1 URL (o título).
    // Match em LINHA pra contar só headers reais, não menções no body.
    if (bucket === "destaques") {
      const destaqueHeaders = section.match(/^\s*(?:\*\*)?DESTAQUE\s+\d+(?:\s*\||\s*(?:\*\*)?\s*$)/gim);
      const destaqueCount = destaqueHeaders ? destaqueHeaders.length : 0;
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

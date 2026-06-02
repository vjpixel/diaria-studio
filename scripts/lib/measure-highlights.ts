/**
 * measure-highlights.ts (#739)
 *
 * Mede o tamanho dos destaques d1/d2/d3 em uma newsletter já reviewed
 * (`02-reviewed.md`). Usado pelo orchestrator no gate Stage 2 pra mostrar
 * ao editor o balanceamento entre destaques antes da aprovação:
 *
 *   d1: 856 chars (157 palavras)
 *   d2: 920 chars (172 palavras)
 *   d3: 743 chars (138 palavras)
 *
 * Para social isso já existe (`<!-- char_count: 858 -->` em FB); newsletter
 * não tinha equivalente. Editor revisando no Drive (mobile) tinha que
 * inferir balanceamento visualmente.
 *
 * Pura — sem I/O, testável com fixtures inline.
 */

/**
 * Tamanho de um destaque individual.
 */
export interface HighlightSize {
  /** Número do destaque (1, 2, 3). */
  number: number;
  /** Categoria do destaque (PESQUISA, LANÇAMENTO, etc). */
  category: string;
  /** Char count excluindo URLs. */
  chars: number;
  /** Word count excluindo URLs. */
  words: number;
}

/**
 * Faixa saudável de tamanho por destaque (chars). Fora dessa faixa,
 * `flagOutOfRange` emite warning. Valores baseados em observação
 * editorial (#739):
 * - <600: falta substância, leitor se sente roubado
 * - >1500: newsletter fica densa, CTR cai
 */
export const HEALTHY_RANGE_MIN = 600;
export const HEALTHY_RANGE_MAX = 1500;

export interface MeasureResult {
  /** Tamanhos individuais dos destaques encontrados (até 3). */
  highlights: HighlightSize[];
  /** Soma de chars de todos os destaques. */
  total_chars: number;
  /** Soma de palavras de todos os destaques. */
  total_words: number;
  /** Lista de avisos quando algum destaque sai da faixa saudável. */
  warnings: string[];
}

/**
 * Regex pra detectar URL inline ou em linha própria. Não tenta cobrir
 * 100% do RFC 3986 — mira o que o writer.md emite (HTTP/HTTPS, sem
 * query string complexa).
 */
const URL_RE = /https?:\/\/[^\s)]+/g;

/**
 * #1709: linha que é APENAS uma opção de título (inline link `**[texto](url)**`,
 * bold opcional). O writer emite 3 opções por destaque; o title-picker (#159)
 * poda pra 1 pós-gate. Usado por `stripTitleOptions`.
 */
const TITLE_OPTION_LINE_RE = /^\s*\*{0,2}\s*\[[^\]]+\]\([^)]*\)\*{0,2}\s*$/;

/**
 * #1709: remove TODAS as opções de título iniciais do bloco do destaque,
 * deixando só o CORPO. Decisão editorial (2026-06-02): medir o corpo separado
 * do título — o corpo tem os limites originais (D1 1000-1200, D2/D3 900-1000,
 * #914/#964) e o título é validado à parte por `--check title-length` (≤52, #701).
 *
 * Antes, `parseHighlights` media body + as 3 opções de título, divergindo do
 * que o writer escreve (corpo) e do publicado (corpo + 1 título). Medir o corpo
 * sozinho casa com o alvo do writer → alvo estável, sem o churn de trim/expand.
 *
 * Estratégia: descarta as linhas inline-link consecutivas no INÍCIO do bloco
 * (após o header `DESTAQUE N |`); para no 1º parágrafo de corpo. Linhas em
 * branco iniciais preservadas. Não toca links inline DENTRO do corpo.
 */
export function stripTitleOptions(body: string): string {
  const lines = body.split("\n");
  const out: string[] = [];
  let pastTitleBlock = false;
  for (const line of lines) {
    if (!pastTitleBlock) {
      if (line.trim() === "") {
        out.push(line);
        continue;
      }
      if (TITLE_OPTION_LINE_RE.test(line)) continue; // descarta a opção de título
      // 1ª linha não-branco e não-título = início do corpo
      pastTitleBlock = true;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Identifica blocos de destaque na markdown e mede cada um.
 *
 * Estrutura esperada (de `context/templates/newsletter.md`):
 *
 *   DESTAQUE N | CATEGORIA
 *   <título>
 *   <lead, parágrafos, "Por que isso importa">
 *   <URL>
 *
 *   ---
 *
 * Strategy: split markdown by `\n---\n` (separador inter-bloco), pra
 * cada chunk verifica se começa com `DESTAQUE N | CATEGORIA`. Mais
 * confiável que regex única com lookahead — o lookahead com flag `m`
 * tem ambiguidade entre EOI e EOL que causou bug em desenvolvimento.
 *
 * URLs são removidas antes de medir; whitespace colapsado.
 */
export function parseHighlights(reviewedMd: string): MeasureResult {
  if (typeof reviewedMd !== "string" || reviewedMd.length === 0) {
    return {
      highlights: [],
      total_chars: 0,
      total_words: 0,
      warnings: [],
    };
  }

  const highlights: HighlightSize[] = [];

  // Header regex pra detectar início de destaque dentro de cada chunk.
  // Suporta plain ou **negrito** (#590). `\*\*` opcional no início e fim
  // do título da seção (fim antes da newline).
  const headerRe = /^(?:\*\*)?DESTAQUE\s+(\d+)\s*\|\s*(.+?)(?:\*\*)?\n([\s\S]*)$/;

  // Split by `\n---\n` (separator entre seções). Cada chunk pode ser
  // um destaque, ou outras seções (LANÇAMENTOS, PESQUISAS, etc).
  const chunks = reviewedMd.split(/\n---\n/);
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    const m = headerRe.exec(trimmed);
    if (!m) continue;

    const number = parseInt(m[1], 10);
    const category = m[2].trim();
    // #1709: mede o CORPO sozinho (sem as opções de título — validadas à parte
    // por title-length ≤52). Casa com o que o writer escreve → alvo estável.
    const body = stripTitleOptions(m[3]);

    // Remove URLs antes de medir
    const bodyNoUrls = body.replace(URL_RE, "");
    // Collapse whitespace pra count consistent
    const normalized = bodyNoUrls.replace(/\s+/g, " ").trim();

    const chars = normalized.length;
    // Word count: split em whitespace, filter strings vazias
    const words = normalized.split(/\s+/).filter((w) => w.length > 0).length;

    highlights.push({ number, category, chars, words });
  }

  highlights.sort((a, b) => a.number - b.number);

  const total_chars = highlights.reduce((acc, h) => acc + h.chars, 0);
  const total_words = highlights.reduce((acc, h) => acc + h.words, 0);
  const warnings = flagOutOfRange(highlights);

  return { highlights, total_chars, total_words, warnings };
}

/**
 * Emite warnings quando algum destaque está fora da faixa saudável.
 * Pure — usado tanto pelo CLI quanto por consumers que querem só os warnings.
 */
export function flagOutOfRange(highlights: HighlightSize[]): string[] {
  const warnings: string[] = [];
  for (const h of highlights) {
    if (h.chars < HEALTHY_RANGE_MIN) {
      warnings.push(
        `d${h.number}: ${h.chars} chars — abaixo da faixa saudável (${HEALTHY_RANGE_MIN}-${HEALTHY_RANGE_MAX}). Pode faltar substância.`,
      );
    } else if (h.chars > HEALTHY_RANGE_MAX) {
      warnings.push(
        `d${h.number}: ${h.chars} chars — acima da faixa saudável (${HEALTHY_RANGE_MIN}-${HEALTHY_RANGE_MAX}). Newsletter pode ficar densa, CTR cai.`,
      );
    }
  }
  return warnings;
}

/**
 * Formata o resultado pro stderr / gate output do orchestrator. Output
 * legível em monoespaço, com warnings quando aplicável.
 */
export function formatMeasureResult(result: MeasureResult): string {
  const lines: string[] = [];
  lines.push("Tamanhos dos destaques (corpo, excluindo URLs):");
  for (const h of result.highlights) {
    lines.push(`  d${h.number}: ${h.chars} chars (${h.words} palavras) — ${h.category}`);
  }
  lines.push(`  total: ${result.total_chars} chars (${result.total_words} palavras)`);
  if (result.warnings.length > 0) {
    lines.push("");
    lines.push("⚠️ Avisos:");
    for (const w of result.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  return lines.join("\n");
}

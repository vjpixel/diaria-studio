/**
 * lint-image-prompt.ts (#810)
 *
 * Defesa em profundidade da regra editorial sobre prompts de imagem
 * (`context/editorial-rules.md`):
 *
 *   "Prompt de imagem: Van Gogh impasto, 2:1, SEM resolução em pixels,
 *    SEM Noite Estrelada."
 *
 * `scripts/image-generate.ts` já tem NEGATIVE_PROMPT cobrindo
 * "Starry Night" + "pixel art" no negativo, mas Gemini tende a respeitar
 * positivos mesmo com negativo conflitante. Pré-flight lint pega
 * violações antes de gastar API call.
 *
 * Pure helpers — exported pra testar sem CLI overhead.
 */

/**
 * Categoria da violação encontrada. Usado no exit message + log pra
 * dar contexto ao editor sobre qual parte da regra editorial bateu.
 */
export type ForbiddenCategory =
  | "starry_night_pt"
  | "starry_night_en"
  | "pixel_resolution"
  | "pixel_count"
  | "dpi";

/**
 * Categoria de WARNING — palavras-gatilho que tendem a fazer Gemini renderizar
 * texto na cena (livro aberto, placa, tela com código, petição, documento).
 * Não bloqueiam geração (exit 0), mas avisam no stderr pra editor considerar
 * reframe pra reduzir risco de letras distorcidas. #1241.
 */
export type TriggerCategory = "text_trigger_words";

export interface ForbiddenIssue {
  category: ForbiddenCategory;
  /** Trecho exato que casou — usado no warn message. */
  match: string;
  /** Posição (índice) no input pra contexto opcional. */
  index: number;
}

export interface TriggerIssue {
  category: TriggerCategory;
  match: string;
  index: number;
}

/**
 * Lista de patterns proibidos em qualquer prompt de imagem da Diar.ia.
 * Ordem estável pra output determinístico nos testes.
 *
 * Patterns são intencionalmente generosos — preferimos false-positive
 * (editor reescreve) sobre false-negative (gasta API + viola regra).
 */
export const FORBIDDEN_PATTERNS: ReadonlyArray<{
  category: ForbiddenCategory;
  pattern: RegExp;
}> = [
  { category: "starry_night_pt", pattern: /noite\s+estrelada/gi },
  { category: "starry_night_en", pattern: /starry\s+night/gi },
  // Resolução tipo "1024x1024", "800 x 600", "1920X1080" — duas dim com x/X.
  { category: "pixel_resolution", pattern: /\b\d{3,4}\s*[xX]\s*\d{3,4}\b/g },
  // "1024 pixels", "500px", "X pixel" — qualquer referência a pixel count.
  { category: "pixel_count", pattern: /\b\d+\s*(?:pixels?|px)\b/gi },
  // DPI mentions — "300 dpi", "150DPI".
  { category: "dpi", pattern: /\b\d+\s*dpi\b/gi },
];

/**
 * Palavras-gatilho que tendem a fazer Gemini renderizar texto na cena.
 * Caso real edição 260514 D1: prompt mencionava "petição com texto" → Gemini
 * desenhou letras distorcidas na petição. #1241.
 *
 * Não bloqueia — só avisa. Editor decide se reframe (substituir "petição"
 * por "documento abstrato", "tela com código" por "monitor com formas
 * geométricas", etc).
 */
export const TEXT_TRIGGER_PATTERNS: ReadonlyArray<{
  category: TriggerCategory;
  pattern: RegExp;
}> = [
  // PT-BR
  { category: "text_trigger_words", pattern: /\bpeti[çc][ãa]o\b/gi },
  { category: "text_trigger_words", pattern: /\blivro\s+aberto\b/gi },
  { category: "text_trigger_words", pattern: /\bplaca\b/gi },
  { category: "text_trigger_words", pattern: /\bjornal\b/gi },
  { category: "text_trigger_words", pattern: /\bdocumento\b/gi },
  { category: "text_trigger_words", pattern: /\bc[oó]digo\b/gi },
  { category: "text_trigger_words", pattern: /\btela\s+(?:de|com)\s+/gi },
  { category: "text_trigger_words", pattern: /\bcarta\b/gi },
  { category: "text_trigger_words", pattern: /\bcartaz\b/gi },
  // EN
  { category: "text_trigger_words", pattern: /\bopen\s+book\b/gi },
  { category: "text_trigger_words", pattern: /\bnewspaper\b/gi },
  { category: "text_trigger_words", pattern: /\bsign\s+(?:that|with|saying)/gi },
];

/**
 * Detecta TODAS as violações da regra editorial num prompt de imagem.
 * Retorna array vazio quando o prompt está limpo.
 *
 * Múltiplas ocorrências do mesmo pattern são detectadas separadamente
 * (ex: "Noite Estrelada... Noite Estrelada" → 2 issues), pra editor
 * conseguir localizar e remover cada uma.
 */
export function findForbiddenPhrases(prompt: string): ForbiddenIssue[] {
  if (typeof prompt !== "string" || prompt.length === 0) return [];

  const issues: ForbiddenIssue[] = [];
  for (const { category, pattern } of FORBIDDEN_PATTERNS) {
    // Reset regex state porque RegExp com /g é stateful.
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(prompt)) !== null) {
      issues.push({
        category,
        match: match[0],
        index: match.index,
      });
      // Avoid infinite loop on zero-width matches (defensive)
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  // Ordena por posição pra output legível (contexto progride no prompt)
  issues.sort((a, b) => a.index - b.index);
  return issues;
}

/**
 * Formata as violações pra mensagem human-readable no stderr / warn.
 * Inclui contexto (~30 chars antes/depois) pra editor localizar a posição.
 */
export function formatIssues(prompt: string, issues: ForbiddenIssue[]): string {
  if (issues.length === 0) return "";
  const lines: string[] = [];
  lines.push(`[lint-image-prompt] ${issues.length} violação(ões) encontrada(s):`);
  for (const issue of issues) {
    const start = Math.max(0, issue.index - 25);
    const end = Math.min(prompt.length, issue.index + issue.match.length + 25);
    const context = prompt.slice(start, end).replace(/\s+/g, " ").trim();
    lines.push(`  - [${issue.category}] match=${JSON.stringify(issue.match)} contexto: "…${context}…"`);
  }
  return lines.join("\n");
}

/**
 * Categorias agrupadas por regra editorial — usado pra explicação no
 * stderr quando há violação. Mapping fixo, atualizar quando regras mudarem.
 */
export const CATEGORY_RULES: Record<ForbiddenCategory, string> = {
  starry_night_pt: "Regra editorial proíbe referências a Noite Estrelada (style copy).",
  starry_night_en: "Regra editorial proíbe referências a The Starry Night (style copy).",
  pixel_resolution:
    "Regra editorial proíbe especificar resolução em pixels (ex: 1024x1024) — Gemini decide aspect ratio via parâmetro.",
  pixel_count:
    "Regra editorial proíbe especificar contagem de pixels — Gemini decide tamanho.",
  dpi: "Regra editorial proíbe especificar DPI — irrelevante pro pipeline editorial.",
};

export const TRIGGER_RULES: Record<TriggerCategory, string> = {
  text_trigger_words:
    "Palavra(s) que tendem a induzir Gemini a renderizar texto/letras na cena (#1241). Considere reframe: substituir por elemento abstrato equivalente (ex: 'petição' → 'documento estilizado', 'tela de código' → 'monitor com formas geométricas').",
};

/**
 * Detecta palavras-gatilho de texto (#1241). Não bloqueia — só avisa.
 */
export function findTextTriggers(prompt: string): TriggerIssue[] {
  if (typeof prompt !== "string" || prompt.length === 0) return [];
  const issues: TriggerIssue[] = [];
  for (const { category, pattern } of TEXT_TRIGGER_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(prompt)) !== null) {
      issues.push({ category, match: match[0], index: match.index });
      if (match.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }
  issues.sort((a, b) => a.index - b.index);
  return issues;
}

export function formatTriggerWarnings(prompt: string, issues: TriggerIssue[]): string {
  if (issues.length === 0) return "";
  const lines: string[] = [];
  lines.push(`[lint-image-prompt] ${issues.length} aviso(s) de gatilho de texto (#1241):`);
  for (const issue of issues) {
    const start = Math.max(0, issue.index - 25);
    const end = Math.min(prompt.length, issue.index + issue.match.length + 25);
    const context = prompt.slice(start, end).replace(/\s+/g, " ").trim();
    lines.push(`  - [${issue.category}] match=${JSON.stringify(issue.match)} contexto: "…${context}…"`);
  }
  return lines.join("\n");
}

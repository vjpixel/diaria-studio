/**
 * annual-parse.ts (#7569)
 *
 * `draft.md` da edição anual → estrutura. Puro, sem I/O.
 *
 * O draft é dividido por LABELS de seção — linhas isoladas em `**negrito**`
 * (`**INTRO**`, `**TEMA 1 | ENERGIA**`, `**PREVISÕES**`). É o mesmo contrato
 * do digest mensal, e pela mesma razão: sem esse sinal, o render não tem como
 * separar as seções e o e-mail inteiro sai como um bloco de prosa, sem imagem
 * e sem estrutura (#2794, causa raiz do ciclo 2606-07 no mensal).
 *
 * A diferença estrutural em relação ao mensal é o **N variável**: a anual tem
 * de 3 a 7 temas, decididos pelo analista. Nada aqui pode assumir 3.
 */

/** Um tema da retrospectiva. */
export interface AnnualTheme {
  /** 1-based, na ordem do draft. */
  index: number;
  /** O nome depois do `|` no label (`**TEMA 2 | ENERGIA**` → "ENERGIA"). */
  name: string;
  /** Primeira linha do bloco — o título narrativo. */
  title: string;
  /** Parágrafos do corpo, na ordem (sem o título, sem o fio condutor). */
  paragraphs: string[];
  /** Texto após "O fio condutor:", se houver. */
  fioCondutor: string;
}

export interface AnnualDraft {
  /** Opções de assunto, na ordem de preferência do writer. */
  subjects: string[];
  preview: string;
  intro: string;
  /** Presente só na rodada de aniversário. */
  anniversary?: string;
  themes: AnnualTheme[];
  whatChanged: string;
  predictions: string;
  closing: string;
  /** Labels encontrados no draft, na ordem — usado pelo lint. */
  labels: string[];
  warnings: string[];
}

/** Label de seção: linha isolada toda em negrito. */
const LABEL_RE = /^\*\*(.+?)\*\*$/;
const THEME_LABEL_RE = /^TEMA\s+(\d+)\s*(?:\|\s*(.*))?$/i;
const FIO_RE = /^O fio condutor:\s*$/i;
/** Seções que não podem existir numa edição anual (decisão do editor). */
export const FORBIDDEN_LABELS = ["USE MELHOR", "RADAR", "É IA?", "E IA?", "É AI?", "E AI?"];

/** Quebra o draft em blocos `{label, lines}` na ordem de leitura. */
export function splitByLabels(md: string): { label: string; lines: string[] }[] {
  const out: { label: string; lines: string[] }[] = [];
  let current: { label: string; lines: string[] } | null = null;

  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(LABEL_RE);
    // Um label é uma linha isolada em negrito e SEM outro conteúdo. Uma frase
    // que começa com negrito (`**Previsão 1** — texto`) não é label: o
    // `LABEL_RE` já exige que o negrito cubra a linha inteira.
    if (m && !m[1].includes("**")) {
      current = { label: m[1].trim(), lines: [] };
      out.push(current);
      continue;
    }
    if (current) current.lines.push(raw);
  }
  return out;
}

/** Junta linhas num texto, colapsando linhas em branco repetidas. */
function joinBlock(lines: readonly string[]): string {
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Separa parágrafos (blocos separados por linha em branco). */
function paragraphsOf(lines: readonly string[]): string[] {
  return joinBlock(lines)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function parseTheme(index: number, name: string, lines: readonly string[]): AnnualTheme {
  const fioIdx = lines.findIndex((l) => FIO_RE.test(l.trim()));
  const bodyLines = fioIdx === -1 ? lines : lines.slice(0, fioIdx);
  const fio = fioIdx === -1 ? "" : joinBlock(lines.slice(fioIdx + 1));

  const paras = paragraphsOf(bodyLines);
  const title = paras.length > 0 ? paras[0] : "";
  return { index, name, title, paragraphs: paras.slice(1), fioCondutor: fio };
}

/**
 * Parseia o `draft.md` inteiro. Nunca lança: seção ausente vira string vazia
 * e um aviso — quem decide o que é fatal é o lint, que tem o contexto do tipo
 * de rodada (o bloco de aniversário é obrigatório em agosto e proibido em
 * janeiro, e este parser não sabe qual das duas está rodando).
 */
export function parseAnnualDraft(md: string): AnnualDraft {
  const blocks = splitByLabels(md);
  const warnings: string[] = [];
  const labels = blocks.map((b) => b.label);

  const draft: AnnualDraft = {
    subjects: [],
    preview: "",
    intro: "",
    themes: [],
    whatChanged: "",
    predictions: "",
    closing: "",
    labels,
    warnings,
  };

  for (const block of blocks) {
    const label = block.label.toUpperCase();
    const themeMatch = block.label.match(THEME_LABEL_RE);

    if (themeMatch) {
      const idx = Number(themeMatch[1]);
      draft.themes.push(parseTheme(idx, (themeMatch[2] ?? "").trim(), block.lines));
      continue;
    }
    if (label.startsWith("ASSUNTO")) {
      draft.subjects = block.lines
        .map((l) => l.trim().match(/^\d+\.\s*(.+)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => m[1].trim());
      continue;
    }
    if (label === "PREVIEW") {
      draft.preview = joinBlock(block.lines);
      continue;
    }
    if (label === "INTRO") {
      draft.intro = joinBlock(block.lines);
      continue;
    }
    if (label === "ANIVERSÁRIO" || label === "ANIVERSARIO") {
      draft.anniversary = joinBlock(block.lines);
      continue;
    }
    if (label.startsWith("O QUE MUDOU")) {
      draft.whatChanged = joinBlock(block.lines);
      continue;
    }
    if (label.startsWith("PREVIS")) {
      draft.predictions = joinBlock(block.lines);
      continue;
    }
    if (label.startsWith("PARA ENCERRAR")) {
      draft.closing = joinBlock(block.lines);
      continue;
    }
    warnings.push(`label não reconhecido: "${block.label}"`);
  }

  draft.themes.sort((a, b) => a.index - b.index);

  if (draft.themes.length === 0) warnings.push("nenhum tema encontrado — o draft tem labels em negrito?");
  if (draft.subjects.length === 0) warnings.push("bloco ASSUNTO sem opções numeradas");

  return draft;
}

/**
 * Conta caracteres de um bloco de markdown, descontando as URLs dos links
 * ancorados — `[âncora](url)` conta só a âncora, porque a URL não é texto
 * que o leitor lê. Usado por qualquer bloco de prosa livre do draft (temas,
 * "O que mudou", "Previsões") para que o lint meça o que o leitor vê, não o
 * tamanho do markdown cru.
 */
export function textCharCount(text: string): number {
  return text.replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1").length;
}

/** Conta caracteres de um tema, descontando as URLs dos links ancorados. */
export function themeCharCount(theme: AnnualTheme): number {
  return textCharCount([theme.title, ...theme.paragraphs, theme.fioCondutor].join("\n"));
}

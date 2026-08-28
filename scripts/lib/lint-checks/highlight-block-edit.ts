/**
 * lint-checks/highlight-block-edit.ts (#6447 Fatia 2 — editor estruturado por destaque)
 *
 * Parser/serializer PUROS pro bloco `DESTAQUE N | CATEGORIA` de
 * `02-reviewed.md`, usados pelo painel "Editor por destaque" do Studio
 * (`scripts/studio-ui/public/rv-highlights.js`) — a contraparte estruturada
 * do textarea de Markdown cru que o painel já oferece (achados 1+2 do #6447).
 *
 * Reusa os parsers/regexes já existentes em vez de re-derivar (mesmo
 * princípio documentado em `studio-review.ts`):
 *   - `HIGHLIGHT_HEADER_RE`/`SECTION_BREAK_LINE_RE`/`WHY_MATTERS_LINE_RE`
 *     (highlight-parsing.ts).
 *   - `walkDestaqueTitles` (destaque-title-walk.ts) — coleta das opções de
 *     título, mesmo parser usado por `countTitlesPerHighlight`.
 *   - `looksLikeTitleOption` (title-heuristic.ts) — heurística título vs body.
 *   - `parseInlineLink` (inline-link.ts) — separa texto/URL do link markdown.
 *   - `APROFUNDE_HEADER_RE`/`HUB_LINK_HEADER_RE` (extract-destaques.ts) —
 *     únicos regexes reusados de fora de `lint-checks/`, pra não duplicar a
 *     definição do header dos blocos opcionais "Aprofunde:"/"Saiba mais:".
 *
 * ## Design: bloco "trailing" opaco, não parseado estruturalmente
 *
 * Tudo que vem DEPOIS dos parágrafos de "Por que isso importa:" (o bloco
 * opcional "Aprofunde:" + o também opcional "Saiba mais:" de hub temático,
 * #3920/#4907) é capturado como um único bloco de texto OPACO
 * (`trailingRaw`) — verbatim, sem parse estrutural. Dois motivos:
 *   1. O escopo desta fatia (achados 1+2 da issue) não pede edição desses
 *      blocos — `HighlightEdit` (a interface de escrita) não tem campo pra
 *      eles, então eles nunca são tocados por `applyHighlightEdit`.
 *   2. Precisão de round-trip: como não editamos esse trecho, preservá-lo
 *      verbatim garante byte-identidade sem precisar reconstruir o formato
 *      exato de cada item (`* [Título](URL) - Fonte`, etc).
 *
 * ## Design: edição cirúrgica (só o bloco `DESTAQUE N` tocado)
 *
 * `applyHighlightEdit` reconstrói SOMENTE a região de linhas entre o header
 * `DESTAQUE N | ...` e o próximo `---` (ou fim do arquivo) — todo o resto do
 * documento (outros destaques, seções LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS,
 * cabeçalho de cobertura) é preservado por fatiamento de array, nunca
 * reconstruído. Mesmo princípio do #495 (edições cirúrgicas em arquivo que o
 * editor pode ter tocado) aplicado dentro do próprio Studio — o editor pode
 * estar no meio de editar outro destaque/aba ao mesmo tempo.
 */

import {
  HIGHLIGHT_HEADER_RE,
  SECTION_BREAK_LINE_RE,
  WHY_MATTERS_LINE_RE,
} from "./highlight-parsing.ts";
import { walkDestaqueTitles } from "./destaque-title-walk.ts";
import { looksLikeTitleOption } from "../title-heuristic.ts";
import { parseInlineLink } from "../inline-link.ts";
import { APROFUNDE_HEADER_RE, HUB_LINK_HEADER_RE } from "../../extract-destaques.ts";

// ── Tipos ────────────────────────────────────────────────────────────────

export interface HighlightTitleOption {
  /** Texto do título (sem URL, sem wrap de negrito). */
  text: string;
  /** Número de linha no markdown original (1-based) — útil pro caller
   * mapear de volta pra posição no editor de texto cru, se precisar. */
  line: number;
}

export interface HighlightBlock {
  n: number;
  /** Categoria completa do header (com emoji), ex: "🚀 LANÇAMENTO". */
  category: string;
  /** 1-3 opções de título pré-gate, ou 1 só pós-gate (poda já feita). */
  titleOptions: HighlightTitleOption[];
  /** URL canônica — extraída do link markdown da PRIMEIRA opção de título que
   * tiver link inline (o parser não verifica as demais opções — assume-se,
   * sem confirmar, que todas apontam pra mesma URL — variantes do mesmo
   * artigo, convenção do template). Vazio se NENHUMA opção tiver link inline
   * (formato legado sem URL embedada). */
  url: string;
  /** Parágrafos do corpo (entre o bloco de títulos e "Por que isso importa:"). */
  body: string[];
  /** Texto de "Por que isso importa:" — parágrafos unidos por linha em
   * branco dupla (`\n\n`) quando há mais de 1. */
  whyMatters: string;
  /** Texto OPACO de tudo que vem depois dos parágrafos do why (bloco
   * "Aprofunde:"/"Saiba mais:", se presentes) — verbatim, sem parse
   * estrutural (ver nota de design no topo do arquivo). `""` se ausente. */
  trailingRaw: string;
}

export interface ParseHighlightBlocksResult {
  ok: boolean;
  blocks: HighlightBlock[];
  error?: string;
}

export interface HighlightEdit {
  /** Título final escolhido (por índice OU texto substituído — o caller já
   * resolveu isso pra um texto final antes de chamar `applyHighlightEdit`). */
  title: string;
  url: string;
  body: string[];
  whyMatters: string;
}

export interface ApplyHighlightEditResult {
  ok: boolean;
  md?: string;
  error?: string;
}

// ── Parse ────────────────────────────────────────────────────────────────

/** Normaliza CRLF→LF antes do split. Diferente de `countTitlesPerHighlight`
 * (#5084, mesma normalização mas por outro motivo): aqui todo match de
 * `HIGHLIGHT_HEADER_RE`/`WHY_MATTERS_LINE_RE`/etc já roda sobre `.trim()`
 * (que por si só já remove um `\r` residual), então a normalização NÃO é
 * necessária pros matches em si. É necessária porque `trailingRaw`
 * (`parseBlockContent` abaixo) reconstrói linhas RAW, sem trim, via
 * `lines.slice(...).join("\n")` — sem normalizar antes, um `\r` residual de
 * arquivo fonte CRLF ficaria embutido no meio desse bloco opaco, quebrando a
 * promessa de "verbatim" (ver nota de design no topo do arquivo). */
function normalizeLines(md: string): string[] {
  return md.replace(/\r\n/g, "\n").split("\n");
}

/** Fim do bloco (exclusivo) — índice da linha `---` seguinte, ou
 * `lines.length` se o destaque for o último conteúdo do arquivo. */
function findBlockEnd(lines: string[], headerIdx: number): number {
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (SECTION_BREAK_LINE_RE.test(lines[i].trim())) return i;
  }
  return lines.length;
}

/** Agrupa linhas não-vazias consecutivas em parágrafos — cada "run" entre
 * linhas em branco vira 1 parágrafo (linhas internas do run unidas por
 * espaço; na prática cada parágrafo do template é 1 linha só). */
function extractParagraphs(lines: string[], start: number, end: number): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  for (let i = start; i < end; i++) {
    const t = lines[i].trim();
    if (t === "") {
      if (current.length > 0) {
        paragraphs.push(current.join(" "));
        current = [];
      }
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) paragraphs.push(current.join(" "));
  return paragraphs;
}

/** Reconstrói uma lista de parágrafos em linhas com blank-line entre cada
 * par — inverso de `extractParagraphs` (#245: linha em branco entre todo
 * elemento). */
function joinParagraphs(paragraphs: string[]): string[] {
  const out: string[] = [];
  paragraphs.forEach((p, i) => {
    if (i > 0) out.push("");
    out.push(p);
  });
  return out;
}

/** Parse do CONTEÚDO de um bloco já delimitado (`[headerIdx, blockEnd)`) —
 * miolo compartilhado por `parseHighlightBlocks` (leitura) e
 * `applyHighlightEdit` (precisa do título/trailing ORIGINAIS antes de
 * reescrever). */
function parseBlockContent(
  lines: string[],
  headerIdx: number,
  blockEnd: number,
  n: number,
  category: string,
): HighlightBlock {
  const { titles: titleLines, nextIndex } = walkDestaqueTitles(
    lines,
    headerIdx + 1,
    category,
    looksLikeTitleOption,
  );

  const titleOptions: HighlightTitleOption[] = [];
  let url = "";
  for (const t of titleLines) {
    titleOptions.push({ text: t.title, line: t.line });
    if (!url) {
      const inline = parseInlineLink(lines[t.line - 1].trim());
      if (inline) url = inline.url;
    }
  }

  let whyIdx = -1;
  for (let k = nextIndex; k < blockEnd; k++) {
    if (WHY_MATTERS_LINE_RE.test(lines[k].trim())) {
      whyIdx = k;
      break;
    }
  }

  const bodyEnd = whyIdx !== -1 ? whyIdx : blockEnd;
  const body = extractParagraphs(lines, nextIndex, bodyEnd);

  let whyMatters = "";
  let trailingRaw = "";
  if (whyIdx !== -1) {
    let trailStart = blockEnd;
    for (let k = whyIdx + 1; k < blockEnd; k++) {
      const t = lines[k].trim();
      if (APROFUNDE_HEADER_RE.test(t) || HUB_LINK_HEADER_RE.test(t)) {
        trailStart = k;
        break;
      }
    }
    whyMatters = extractParagraphs(lines, whyIdx + 1, trailStart).join("\n\n");
    trailingRaw = lines.slice(trailStart, blockEnd).join("\n");
  }

  return { n, category, titleOptions, url, body, whyMatters, trailingRaw };
}

/** Extrai todos os blocos `DESTAQUE N | CATEGORIA` de `02-reviewed.md`,
 * ordenados por `n`. Nunca lança — arquivo sem nenhum destaque retorna
 * `{ ok: true, blocks: [] }` (caller decide se isso é erro no contexto dele). */
export function parseHighlightBlocks(md: string): ParseHighlightBlocksResult {
  const lines = normalizeLines(md);
  const blocks: HighlightBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(HIGHLIGHT_HEADER_RE);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const category = m[2].trim();
    const blockEnd = findBlockEnd(lines, i);
    blocks.push(parseBlockContent(lines, i, blockEnd, n, category));
  }
  blocks.sort((a, b) => a.n - b.n);
  return { ok: true, blocks };
}

// ── Serialize ────────────────────────────────────────────────────────────

// Mesmos 3 formatos de linha de título inline-link que
// `extract-destaques.ts::rebuildInlineLinkTitleLine` reconhece — reimplementado
// aqui (não importado) porque esta versão também substitui a URL, o que a
// função de lá não suporta (#3806 só troca o TEXTO do título, preservando a
// URL original). Mesma limitação herdada de lá: `\S+` não faz scan de
// parênteses balanceados (URLs com `(`/`)` literais podem não casar) —
// aceito, é o mesmo comportamento já em produção pro spike de título único.
const OUTER_BOLD_LINK_RE = /^\*\*\[(.+)\]\((https?:\/\/\S+)\)\*\*$/;
const INNER_BOLD_LINK_RE = /^\[\*\*(.+)\*\*\]\((https?:\/\/\S+)\)$/;
const PLAIN_LINK_RE = /^\[(.+)\]\((https?:\/\/\S+)\)$/;

type TitleLineFormat = "outer-bold" | "inner-bold" | "plain";

/** Detecta a convenção de negrito (#590/#1051) da linha de título ORIGINAL,
 * pra preservar o mesmo formato ao reconstruir com o título final. Sem linha
 * original pra referência (bloco sem nenhuma opção — malformado), assume o
 * formato canônico do template (`**[Título](URL)**`, outer-bold). */
function determineTitleLineFormat(originalLine: string | undefined): TitleLineFormat {
  if (originalLine === undefined) return "outer-bold";
  const t = originalLine.trim();
  if (OUTER_BOLD_LINK_RE.test(t)) return "outer-bold";
  if (INNER_BOLD_LINK_RE.test(t)) return "inner-bold";
  if (PLAIN_LINK_RE.test(t)) return "plain";
  return "outer-bold";
}

function buildTitleLine(format: TitleLineFormat, title: string, url: string): string {
  if (format === "inner-bold") return `[**${title}**](${url})`;
  if (format === "plain") return `[${title}](${url})`;
  return `**[${title}](${url})**`;
}

/**
 * Aplica uma edição estruturada no bloco `DESTAQUE {destaqueNum}` de `md`,
 * devolvendo o markdown COMPLETO com apenas aquele bloco alterado — todo o
 * resto (outros destaques, seções secundárias, cabeçalho) preservado byte a
 * byte (ver nota de design no topo do arquivo).
 *
 * Nunca lança. Falha (`ok: false`) quando: o destaque não existe no arquivo,
 * ou algum campo obrigatório da edição chega vazio (título/URL/corpo/why).
 */
export function applyHighlightEdit(
  md: string,
  destaqueNum: number,
  edit: HighlightEdit,
): ApplyHighlightEditResult {
  const eol = /\r\n/.test(md) ? "\r\n" : "\n";
  const lines = normalizeLines(md);

  const headerIdx = lines.findIndex((l) => {
    const m = l.trim().match(HIGHLIGHT_HEADER_RE);
    return m !== null && parseInt(m[1], 10) === destaqueNum;
  });
  if (headerIdx === -1) return { ok: false, error: `DESTAQUE ${destaqueNum} não encontrado no arquivo` };

  const headerMatch = lines[headerIdx].trim().match(HIGHLIGHT_HEADER_RE)!;
  const category = headerMatch[2].trim();
  const blockEnd = findBlockEnd(lines, headerIdx);
  const original = parseBlockContent(lines, headerIdx, blockEnd, destaqueNum, category);

  const trimmedTitle = edit.title.trim().replace(/\s+/g, " ");
  if (!trimmedTitle) return { ok: false, error: "título não pode ser vazio" };
  const trimmedUrl = edit.url.trim();
  if (!trimmedUrl) return { ok: false, error: "URL não pode ser vazia" };
  // #6493 review (type-design-analyzer, P2): validar o esquema, não só
  // não-vazio — todo consumidor de leitura desta MESMA URL (`parseInlineLink`,
  // os regexes de título abaixo, `parseHighlightBlocks`) assume `https?://`;
  // uma URL sem esquema salva aqui produziria uma linha de título que o
  // PRÓXIMO parse não reconhece como link (title-options viraria [], url
  // viraria "" na leitura seguinte) — um round-trip quebrado detectável só
  // depois do save, silenciosamente.
  if (!/^https?:\/\//i.test(trimmedUrl)) {
    return { ok: false, error: "URL precisa começar com http:// ou https://" };
  }

  const bodyParagraphs = edit.body.map((p) => p.trim()).filter((p) => p.length > 0);
  if (bodyParagraphs.length === 0) return { ok: false, error: "corpo não pode ficar vazio" };

  const whyParagraphs = edit.whyMatters
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (whyParagraphs.length === 0) return { ok: false, error: "'Por que isso importa' não pode ficar vazio" };

  const originalTitleLine =
    original.titleOptions.length > 0 ? lines[original.titleOptions[0].line - 1] : undefined;
  const format = determineTitleLineFormat(originalTitleLine);
  const titleLine = buildTitleLine(format, trimmedTitle, trimmedUrl);

  const newBlockLines: string[] = [
    lines[headerIdx],
    "",
    titleLine,
    "",
    ...joinParagraphs(bodyParagraphs),
    "",
    "Por que isso importa:",
    "",
    ...joinParagraphs(whyParagraphs),
  ];
  // #3920/#4907: bloco opaco "Aprofunde:"/"Saiba mais:" nunca é tocado por
  // esta edição — reinserido verbatim (com o mesmo separador de linha em
  // branco que o template exige entre elementos) quando presente no
  // original; sem ele, apenas a blank line final antes do próximo `---`
  // (mesma convenção de um destaque sem Aprofunde no template).
  if (original.trailingRaw) {
    newBlockLines.push("", ...original.trailingRaw.split("\n"));
  } else {
    newBlockLines.push("");
  }

  const resultLines = [...lines.slice(0, headerIdx), ...newBlockLines, ...lines.slice(blockEnd)];
  return { ok: true, md: resultLines.join(eol) };
}

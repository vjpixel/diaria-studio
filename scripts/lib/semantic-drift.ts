/**
 * semantic-drift.ts (#603, #630)
 *
 * Detecta divergência semântica entre o email renderizado (Beehiiv) e o
 * source MD (`02-reviewed.md`). Foco em **fatos quantificáveis** que mudaram:
 * números, datas, versões.
 *
 * Não cobre prosa livre — comparação direta de texto seria frágil (Beehiiv
 * normaliza aspas, hífens, line wrapping). Em vez disso, extrai entidades
 * por destaque dos dois lados e compara sets.
 *
 * Pega:
 * - Editor edita o draft no Beehiiv pós-paste e introduz erro factual
 * - Render Beehiiv corrompe número/data
 * - Substituição automática (autocorreção) muda fato
 *
 * Não pega:
 * - Reescrita de prosa que não muda número/data
 * - Mudanças sutis em adjetivos
 *
 * Limitação reconhecida: 1 destaque pode ter 5-15 números mencionados;
 * número novo (não no source) pode ser legítimo (editor adicionou contexto).
 * Por isso classificação inicial é `warning`, não blocker — caller (CLI)
 * promove a blocker apenas quando há entry intencional no mesmo destaque
 * ausente.
 */

import { destaqueHeaderAt } from "./version-consistency.ts";

export interface DriftDetection {
  destaque: string;
  /** Tipo da entidade que divergiu. */
  kind: "number" | "date";
  /** Valor que aparece só num lado. */
  value: string;
  /** Lado em que foi detectado: "email" ou "source". */
  side: "email" | "source";
  /** Snippet de contexto (até 80 chars). */
  snippet: string;
}

// Sem `\b` no final — `%`, `x`, `×` são non-word chars e quebrariam boundary
// quando o número está seguido de espaço. Boundary inicial protege contra
// match mid-word.
const NUMBER_PATTERN = /\b\d+(?:[.,]\d+)?(?:%|x|×)?/g;
// Datas em formatos comuns:
//   2026-05-06, 06/05/2026, 06.05.2026 (numéricas)
//   "5 de maio", "5 de maio de 2026" (PT-BR escrito)
const ISO_DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/g;
const SLASH_DATE_PATTERN = /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
const PT_DATE_PATTERN = /\b\d{1,2}\s+de\s+(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+\d{4})?\b/gi;

/**
 * Pure: divide texto em mapa `destaque → array de linhas`. Linhas em
 * destaque vazio (intro, lançamentos, pesquisas) ficam sob a chave "".
 */
export function splitByDestaque(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = "";
  for (const line of text.split("\n")) {
    current = destaqueHeaderAt(line, current);
    const arr = out.get(current) ?? [];
    arr.push(line);
    out.set(current, arr);
  }
  return out;
}

/**
 * Pure: extrai todas as entidades quantificáveis de um texto, agrupadas por
 * tipo. Cada entidade tem o valor canônico (sem espaços extra) e snippet.
 */
export interface ExtractedEntity {
  value: string;
  /** Snippet de contexto. */
  snippet: string;
}

export function extractEntities(text: string): {
  numbers: ExtractedEntity[];
  dates: ExtractedEntity[];
} {
  const numbers: ExtractedEntity[] = [];
  const dates: ExtractedEntity[] = [];

  // Números
  NUMBER_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_PATTERN.exec(text)) !== null) {
    const start = Math.max(0, m.index - 30);
    const end = Math.min(text.length, m.index + m[0].length + 30);
    numbers.push({ value: m[0], snippet: text.slice(start, end).replace(/\s+/g, " ") });
  }

  // Datas — múltiplos formatos
  for (const pattern of [ISO_DATE_PATTERN, SLASH_DATE_PATTERN, PT_DATE_PATTERN]) {
    pattern.lastIndex = 0;
    let dm: RegExpExecArray | null;
    while ((dm = pattern.exec(text)) !== null) {
      const start = Math.max(0, dm.index - 30);
      const end = Math.min(text.length, dm.index + dm[0].length + 30);
      const normalized = dm[0].toLowerCase().replace(/\s+/g, " ").trim();
      dates.push({ value: normalized, snippet: text.slice(start, end).replace(/\s+/g, " ") });
    }
  }

  // Remove números que são parte de datas (e.g., "06" de "06/05/2026" não conta separadamente)
  const dateValuePieces = new Set<string>();
  for (const d of dates) {
    for (const piece of d.value.split(/[\s/.\-]+/)) {
      if (/^\d+$/.test(piece)) dateValuePieces.add(piece);
    }
  }
  const numbersFiltered = numbers.filter((n) => !dateValuePieces.has(n.value.replace(/[%x×,.]/g, "")));

  return { numbers: numbersFiltered, dates };
}

/**
 * Pure: detecta divergência entre email e source MD. Compara entidades por
 * destaque — entidades que aparecem só num lado viram DriftDetection.
 *
 * Comparação é set-based: se o email tem "10%" e source tem "10%", match.
 * Se email tem "12%" e source tem "10%", `12%` vira detection lado=email,
 * `10%` vira detection lado=source.
 *
 * Destaques sem match no outro side (ex: source tem D1 mas email só tem D2)
 * são ignorados — verify-render resolve isso em outro lugar.
 */
export function detectDrift(emailText: string, sourceMd: string): DriftDetection[] {
  const emailByDestaque = splitByDestaque(emailText);
  const sourceByDestaque = splitByDestaque(sourceMd);

  const detections: DriftDetection[] = [];

  // Itera só nos destaques que existem em ambos os lados, ignorando seção vazia
  // (intro/lançamentos/etc — variabilidade alta, ratio FP elevado).
  const allDestaques = new Set<string>();
  for (const k of emailByDestaque.keys()) if (k) allDestaques.add(k);
  for (const k of sourceByDestaque.keys()) if (k) allDestaques.add(k);

  for (const destaque of allDestaques) {
    const emailLines = emailByDestaque.get(destaque) ?? [];
    const sourceLines = sourceByDestaque.get(destaque) ?? [];
    if (emailLines.length === 0 || sourceLines.length === 0) continue;

    const emailEntities = extractEntities(emailLines.join("\n"));
    const sourceEntities = extractEntities(sourceLines.join("\n"));

    detections.push(
      ...diffEntities(destaque, emailEntities.numbers, sourceEntities.numbers, "number"),
    );
    detections.push(
      ...diffEntities(destaque, emailEntities.dates, sourceEntities.dates, "date"),
    );
  }

  return detections;
}

function diffEntities(
  destaque: string,
  emailEntities: ExtractedEntity[],
  sourceEntities: ExtractedEntity[],
  kind: "number" | "date",
): DriftDetection[] {
  const sourceValues = new Set(sourceEntities.map((e) => normalizeValue(e.value)));
  const emailValues = new Set(emailEntities.map((e) => normalizeValue(e.value)));

  const detections: DriftDetection[] = [];

  // Email-side: entidades no email não presentes no source
  for (const e of emailEntities) {
    if (!sourceValues.has(normalizeValue(e.value))) {
      detections.push({ destaque, kind, value: e.value, side: "email", snippet: e.snippet });
    }
  }
  // Source-side: entidades no source não presentes no email (raro mas pode
  // indicar render Beehiiv que sumiu com algo)
  for (const e of sourceEntities) {
    if (!emailValues.has(normalizeValue(e.value))) {
      detections.push({ destaque, kind, value: e.value, side: "source", snippet: e.snippet });
    }
  }

  return detections;
}

/** Normaliza valor pra comparação (vírgula decimal → ponto, lowercase). */
function normalizeValue(v: string): string {
  return v.toLowerCase().replace(",", ".").trim();
}

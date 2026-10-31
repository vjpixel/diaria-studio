/**
 * scripts/lib/diaria/video-montage-docs.ts (#11361) — o Markdown dos dois Docs
 * da `/diaria-video-montagem`: a decupagem (gate 1) e o roteiro final (gate 2),
 * no formato que o editor aprovou nos Docs feitos à mão na 261027.
 *
 * Decupagem: uma tabela por bloco do roteiro (`Tempo | Fala | Sugestão |
 * Decisão`), curada — só as tomadas da fala; os bastidores e falsos começos
 * ficam agrupados em linhas "cortar (bastidor)" —, sugestão com motivo, texto
 * limpo (vocabulário aplicado), coluna Decisão em branco para o editor, e
 * "Montagem sugerida" por versão com os timecodes do bruto.
 *
 * A classificação (qual segmento é de qual bloco, qual tomada usar e por quê)
 * é julgamento: quem a faz é a skill, lendo a transcrição, e grava o
 * `decupagem-plan.json`. Este módulo valida o plano e monta o Markdown; os
 * tempos saem sempre do transcript, nunca do plano.
 *
 * Roteiro final: uma tabela por versão (`Bloco | Fala | Bruto`), a duração no
 * título da seção, texto integral de cada bloco com o timecode do bruto, um
 * parágrafo inicial dizendo o que muda entre as versões, e as tomadas que
 * ficam para quem finaliza escolher como linhas "opção A/B" no bloco.
 */

import {
  BLOCK_KEYS,
  alignTokens,
  clipSecondsOfBlock,
  clockTime,
  decideTakes,
  defaultSequences,
  isBlockKey,
  itemInTarget,
  tokenize,
  tokensMatch,
  validateVocabRules,
  type BlockKey,
  type ResolvedItem,
  type Segment,
  type SequencePlan,
  type SequenceSpec,
  type SequenceTarget,
  type VocabRule,
} from "./video-montage.ts";
import { voiceHint, type VoiceMark } from "./video-voice.ts";

// ── Rótulos ───────────────────────────────────────────────────────────────

/** Nome de cada bloco nos Docs. */
export const BLOCK_LABELS: Readonly<Record<BlockKey, string>> = {
  titulo: "Título",
  abertura: "Abertura",
  resumo: "Resumo",
  resumo_curto: "Resumo curto",
  comentario: "Comentário",
  cta_yt: "CTA YouTube",
  cta_vertical: "CTA vertical",
  cta_ig: "CTA Instagram",
  cta_out: "CTA outras redes",
  fecho: "Encerramento",
};

const TARGET_LABELS: Readonly<Record<SequenceTarget, string>> = {
  youtube: "Horizontal YouTube",
  instagram: "Vertical Instagram",
  "outras-redes": "Vertical",
};

/** "Horizontal YouTube 1920x1080" etc. */
export function versionLabel(spec: SequenceSpec): string {
  return `${TARGET_LABELS[spec.target]} ${spec.width}x${spec.height}`;
}

/** Célula de tabela Markdown: sem `|` cru nem quebra de linha. */
export const mdCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const span = (start: number, end: number) => `${clockTime(start)}–${clockTime(end)}`;

/** Vocabulário aplicado a um texto de exibição (regra a regra, como nas legendas; aqui o número de palavras pode mudar). */
export function applyVocabularyToText(text: string, rules: VocabRule[], target?: SequenceTarget): string {
  let out = text;
  for (const r of rules) {
    if (r.targets && (!target || !r.targets.includes(target))) continue;
    out = out.replace(new RegExp(r.pattern, r.flags ?? "g"), r.replacement);
  }
  return out;
}

// ── Plano da decupagem (`decupagem-plan.json`) ────────────────────────────

export type DecupagemSuggestion = "usar" | "cortar" | "alternativa";
const SUGGESTIONS: readonly DecupagemSuggestion[] = ["usar", "cortar", "alternativa"];

export interface DecupagemRow {
  /** Segmentos do transcript (numeração 1-based da listagem), consecutivos ou não; juntos formam a fala da linha. */
  segments: number[];
  suggestion: DecupagemSuggestion;
  /** O motivo ("2ª tomada", "título antigo", "tropeço no meio"). Obrigatório em cortar/alternativa. */
  reason?: string;
  /** Texto limpo da fala, quando o do Whisper não serve ("PNI" → "PIB"). Sem ele, o do transcript com o vocabulário. */
  text?: string;
}

export interface DecupagemBlock {
  key: BlockKey;
  rows: DecupagemRow[];
}

export interface DecupagemPlan {
  edition: string;
  /** Na ordem em que aparecem no Doc (a 261027: abertura, título, resumo, comentário, CTAs, encerramento). */
  blocks: DecupagemBlock[];
  /** Termos só desta edição, somados aos de `context/video-montagem/vocabulario.json`. */
  vocabulary?: VocabRule[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Valida o plano contra o transcript, juntando todos os erros: bloco conhecido
 * e não repetido, segmento existente e em uma linha só, sugestão conhecida,
 * motivo em cortar/alternativa. Chaves que começam com `_` (as notas do molde)
 * são ignoradas.
 */
export function parseDecupagemPlan(raw: unknown, segmentCount: number): { ok: true; plan: DecupagemPlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["decupagem-plan.json precisa ser um objeto"] };
  if (typeof raw.edition !== "string" || !/^\d{6}$/.test(raw.edition)) errors.push("edition precisa ser AAMMDD");
  const seenSeg = new Map<number, string>();
  const seenKey = new Set<string>();
  let used = 0;
  if (!Array.isArray(raw.blocks)) errors.push("blocks precisa ser uma lista de { key, rows }");
  else {
    raw.blocks.forEach((b, i) => {
      const where = `blocks[${i}]`;
      if (!isObj(b)) return void errors.push(`${where}: precisa ser objeto`);
      if (typeof b.key !== "string" || !isBlockKey(b.key)) return void errors.push(`${where}: key "${String(b.key)}" desconhecida (válidas: ${BLOCK_KEYS.join(", ")})`);
      if (seenKey.has(b.key)) errors.push(`${where}: bloco ${b.key} repetido`);
      seenKey.add(b.key);
      if (!Array.isArray(b.rows)) return void errors.push(`${where} (${b.key}): rows precisa ser lista`);
      b.rows.forEach((r, j) => {
        const label = `${b.key}.rows[${j}]`;
        if (!isObj(r)) return void errors.push(`${label}: precisa ser objeto`);
        if (!Array.isArray(r.segments) || r.segments.length === 0) errors.push(`${label}: segments precisa listar ao menos 1 segmento`);
        else {
          for (const s of r.segments) {
            if (!Number.isInteger(s) || (s as number) < 1 || (s as number) > segmentCount) {
              errors.push(`${label}: segmento ${String(s)} fora de 1..${segmentCount}`);
              continue;
            }
            const prev = seenSeg.get(s as number);
            if (prev) errors.push(`${label}: segmento ${s} já está em ${prev}`);
            else seenSeg.set(s as number, label);
            used++;
          }
        }
        if (typeof r.suggestion !== "string" || !SUGGESTIONS.includes(r.suggestion as DecupagemSuggestion)) {
          errors.push(`${label}: suggestion precisa ser ${SUGGESTIONS.join(", ")}`);
        } else if (r.suggestion !== "usar" && (typeof r.reason !== "string" || !r.reason.trim())) {
          errors.push(`${label}: ${r.suggestion} precisa de reason (o motivo vai na coluna Sugestão)`);
        }
        if (r.reason !== undefined && typeof r.reason !== "string") errors.push(`${label}: reason precisa ser string`);
        if (r.text !== undefined && (typeof r.text !== "string" || !r.text.trim())) errors.push(`${label}: text, se presente, não pode ser vazio`);
      });
    });
  }
  if (Array.isArray(raw.blocks) && used === 0 && errors.length === 0) errors.push("nenhum segmento classificado: o plano precisa de ao menos uma linha");
  errors.push(...validateVocabRules(raw.vocabulary, "vocabulary"));
  if (errors.length) return { ok: false, errors };
  return { ok: true, plan: raw as unknown as DecupagemPlan };
}

/** Lista numerada dos segmentos (1-based), com a decisão por critério de cada tomada (#11364): o insumo da classificação. */
export function segmentListing(segments: Segment[], voices?: Array<VoiceMark | null>): string {
  return segmentLines(segments, voices).join("\n") + "\n";
}

/**
 * Uma linha por segmento: tempo, fala, a decisão da tomada (#11364) e, numa
 * gravação com duas vozes (#11507), a voz provável pela F0 ("voz: entrevistadora,
 * 214 Hz: cortar (fala da entrevistadora)", "voz: ouvir" na faixa ambígua).
 */
function segmentLines(segments: Segment[], voices?: Array<VoiceMark | null>): string[] {
  const hint = takeHints(segments);
  return segments.map((s, i) => {
    const notes = [hint[i], voiceHint(voices?.[i] ?? null)].filter(Boolean);
    return `${i + 1}. [${span(s.start, s.end)}] ${s.text.trim()}${notes.length ? `  (${notes.join("; ")})` : ""}`;
  });
}

/**
 * Por segmento, a decisão de `decideTakes` (#11364): "tomada k de n: usar
 * (aprovada pela direção: …)", "tomada k de n: cortar (a 3ª tomada é a última
 * completa)", "direção: cortar (bastidor …)". "conferir" quando nenhum
 * critério decide (a direção recusou todas): retranscrever antes de declarar
 * dúvida.
 */
function takeHints(segments: Segment[]): string[] {
  const out = segments.map(() => "");
  const { bySegment } = decideTakes(segments);
  for (const d of bySegment.values()) {
    if (d.criterion === "bastidor") out[d.segment] = `direção: cortar (${d.reason})`;
    else {
      const head = d.group.length > 1 ? `tomada ${d.group.indexOf(d.segment) + 1} de ${d.group.length}: ` : "";
      const verdict = d.criterion === "sem-criterio" ? `conferir, nenhum critério decide (${d.reason}); retranscrever o trecho` : `${d.suggestion} (${d.reason})`;
      out[d.segment] = head + verdict;
    }
  }
  return out;
}

/** Ordinal da tomada do segmento no grupo de repetições ("2ª tomada"), ou null se a frase saiu uma vez só. */
function takeOrdinal(segments: Segment[], index0: number): string | null {
  const d = decideTakes(segments).bySegment.get(index0);
  if (!d || d.group.length < 2) return null;
  return `${d.group.indexOf(index0) + 1}ª tomada`;
}

/** Fração das palavras da tomada mais longa que a outra precisa casar para ser a mesma fala (1 erro do Whisper em 10). */
export const DUPLICATE_MIN_SIMILARITY = 0.9;

/**
 * Confere o plano contra os critérios de decisão (#11364), juntando tudo:
 * - erro: duas tomadas da mesma frase como "usar" (uma tomada por frase; o
 *   XML sai com UMA montagem, não com as opções em sequência);
 * - erro: "alternativa" numa frase que a direção já decidiu (aprovou uma tomada);
 * - aviso: "usar" numa tomada diferente da que a direção aprovou;
 * - aviso: comentário da direção dentro de uma linha "usar"/"alternativa" (é bastidor).
 * Segmentos são os 1-based do plano.
 */
export function checkDecupagemCriteria(plan: DecupagemPlan, segments: Segment[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { bySegment, cues } = decideTakes(segments);
  const cueSegs = new Set(cues.map((c) => c.segment));
  const toks = segments.map((s) => tokenize(s.text));
  // A mesma fala dita de novo, não só o mesmo começo: o falso começo (a mais
  // curta é prefixo inteiro da outra) ou a frase inteira igual em ao menos
  // DUPLICATE_MIN_SIMILARITY das palavras da MAIS LONGA. "O Google lançou o
  // Gemini." × "O Google lançou o Veo." (4 de 5) são frases distintas.
  const duplicate = (a: number, b: number) => {
    const [x, y] = toks[a].length <= toks[b].length ? [toks[a], toks[b]] : [toks[b], toks[a]];
    if (x.length === 0) return false;
    const prefix = x.length < y.length && x.every((t, k) => tokensMatch(t, y[k]));
    return prefix || alignTokens(x, y).length >= DUPLICATE_MIN_SIMILARITY * y.length;
  };
  const usedTakes = new Map<string, Array<{ seg: number; label: string }>>();
  for (const b of plan.blocks) {
    b.rows.forEach((r, j) => {
      const label = `${b.key}.rows[${j}]`;
      for (const s1 of r.segments) {
        const s = s1 - 1;
        if (cueSegs.has(s) && r.suggestion !== "cortar") {
          warnings.push(`${label}: segmento ${s1} é comentário da direção ("${segments[s].text.trim()}"): bastidor, deixar fora do plano`);
        }
        const d = bySegment.get(s);
        if (!d || d.group.length === 0) continue;
        const approvedSeg = d.criterion === "direcao" ? d.group.find((x) => bySegment.get(x)?.suggestion === "usar") : undefined;
        if (r.suggestion === "alternativa" && approvedSeg !== undefined) {
          errors.push(`${label}: "alternativa" no segmento ${s1}, mas a direção aprovou o segmento ${approvedSeg + 1}: usar esse e cortar os outros`);
        }
        if (r.suggestion === "usar") {
          if (approvedSeg !== undefined && approvedSeg !== s) {
            warnings.push(`${label}: "usar" no segmento ${s1}, mas a direção aprovou o segmento ${approvedSeg + 1} (contrariar a direção pede motivo no reason)`);
          }
          const key = d.group.join(",");
          const list = usedTakes.get(key) ?? [];
          list.push({ seg: s, label });
          usedTakes.set(key, list);
        }
      }
    });
  }
  for (const list of usedTakes.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let k = i + 1; k < list.length; k++) {
        const a = list[i];
        const c = list[k];
        if (!duplicate(a.seg, c.seg)) continue;
        errors.push(
          `segmentos ${a.seg + 1} (${a.label}) e ${c.seg + 1} (${c.label}) são tomadas da mesma frase, as duas "usar": decidir uma (a outra "cortar", ou "alternativa" só se nenhum critério decide)`,
        );
      }
    }
  }
  return { errors, warnings };
}

/** Molde do plano: todos os blocos vazios e a listagem dos segmentos como nota (`_segmentos`), para a skill classificar. */
export function decupagemPlanTemplate(edition: string, segments: Segment[], voices?: Array<VoiceMark | null>): Record<string, unknown> {
  return {
    _como: "Cada linha: { segments: [n, ...], suggestion: usar|cortar|alternativa, reason?, text? }. Segmento fora de toda linha vira 'cortar (bastidor)'. text = fala limpa quando o Whisper errou.",
    _criterio:
      "Uma tomada por frase, decidida nesta ordem: (1) a aprovada pela direção; (2) a que emenda com a frase seguinte do roteiro; (3) a última completa. As outras 'cortar' com o motivo. 'alternativa' só quando nenhum critério decide, depois de retranscrever o trecho (retranscribe --from --to), com a justificativa.",
    _segmentos: segmentLines(segments, voices),
    edition,
    blocks: BLOCK_KEYS.filter((key) => key !== "cta_ig" && key !== "cta_out").map((key) => ({ key, rows: [] })),
    vocabulary: [],
  };
}

export interface DecupagemTableRow {
  start: number;
  end: number;
  fala: string;
  sugestao: string;
  /** Linha de bastidor (segmentos fora de toda linha do plano). */
  bastidor: boolean;
  /** A sugestão crua (bastidor = cortar). */
  suggestion: DecupagemSuggestion;
  segments: number[];
}

export interface DecupagemDoc {
  blocks: Array<{ key: BlockKey; rows: DecupagemTableRow[] }>;
}

const BASTIDOR_SNIPPET = 70;

/**
 * Monta as linhas de cada bloco: as do plano (texto limpo, sugestão com
 * motivo; "usar" sem motivo ganha o da tomada, "2ª tomada", quando a frase saiu
 * mais de uma vez) e os bastidores. Cada sequência contígua de segmentos fora
 * do plano vira UMA linha "cortar (bastidor)" no bloco da fala seguinte (o
 * falso começo vem antes da tomada boa); depois da última fala, no bloco da
 * anterior. Dentro do bloco, as linhas ficam em ordem de tempo.
 */
export function buildDecupagemDoc(plan: DecupagemPlan, segments: Segment[], rules: VocabRule[] = []): DecupagemDoc {
  const allRules = [...rules, ...(plan.vocabulary ?? [])];
  const owner = new Map<number, BlockKey>();
  const out = plan.blocks.map((b) => ({ key: b.key, rows: [] as DecupagemTableRow[] }));
  const byKey = new Map(out.map((b) => [b.key, b]));
  for (const b of plan.blocks) {
    for (const r of b.rows) {
      const segs = [...r.segments].sort((x, y) => x - y);
      for (const s of segs) owner.set(s, b.key);
      const ss = segs.map((s) => segments[s - 1]);
      const raw = r.text ?? ss.map((s) => s.text.trim()).join(" ");
      let reason = r.reason?.trim();
      if (!reason && r.suggestion === "usar" && segs.length === 1) reason = takeOrdinal(segments, segs[0] - 1) ?? undefined;
      byKey.get(b.key)!.rows.push({
        start: Math.min(...ss.map((s) => s.start)),
        end: Math.max(...ss.map((s) => s.end)),
        fala: applyVocabularyToText(raw, allRules),
        sugestao: reason ? `${r.suggestion} (${reason})` : r.suggestion,
        bastidor: false,
        suggestion: r.suggestion,
        segments: segs,
      });
    }
  }
  // Bastidores: sequências contíguas de segmentos sem dono.
  const owned = [...owner.keys()].sort((a, b) => a - b);
  let i = 1;
  while (i <= segments.length) {
    if (owner.has(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 <= segments.length && !owner.has(j + 1)) j++;
    const next = owned.find((n) => n > j);
    const prev = [...owned].reverse().find((n) => n < i);
    const key = owner.get((next ?? prev)!)!;
    const run = segments.slice(i - 1, j);
    const joined = run.map((s) => s.text.trim()).join(" ");
    const snippet = joined.length > BASTIDOR_SNIPPET ? `${joined.slice(0, BASTIDOR_SNIPPET).trimEnd()}…` : joined;
    const n = j - i + 1;
    byKey.get(key)!.rows.push({
      start: run[0].start,
      end: run[run.length - 1].end,
      fala: `${snippet}${n > 1 ? ` (${n} trechos)` : ""}`,
      sugestao: "cortar (bastidor)",
      bastidor: true,
      suggestion: "cortar",
      segments: Array.from({ length: n }, (_, k) => i + k),
    });
    i = j + 1;
  }
  for (const b of out) b.rows.sort((x, y) => x.start - y.start || x.end - y.end);
  return { blocks: out };
}

/**
 * O Doc da decupagem ("Transcrição vídeo {AAMMDD} (decupagem)"): uma tabela
 * por bloco, Decisão em branco, e no fim a "Montagem sugerida" de cada versão
 * (as linhas "usar" na ordem da sequência, com os timecodes do bruto).
 */
export function decupagemMarkdown(edition: string, doc: DecupagemDoc, sequences: SequenceSpec[] = defaultSequences()): string {
  const lines = [
    `# Transcrição vídeo ${edition} (decupagem)`,
    "",
    "Uma tabela por bloco do roteiro, com os tempos do bruto. A sugestão traz o motivo; bastidores e falsos começos estão agrupados em \"cortar (bastidor)\". A coluna Decisão fica para o editor: usar, cortar, ou outro bloco.",
    "",
  ];
  for (const b of doc.blocks) {
    if (b.rows.length === 0) continue;
    lines.push(`## ${BLOCK_LABELS[b.key]}`, "", "| Tempo | Fala | Sugestão | Decisão |", "|---|---|---|---|");
    for (const r of b.rows) lines.push(`| ${span(r.start, r.end)} | ${mdCell(r.fala)} | ${mdCell(r.sugestao)} |  |`);
    lines.push("");
  }
  lines.push("## Montagem sugerida", "", "Só as linhas com sugestão \"usar\", na ordem de cada versão. A duração soma os trechos do bruto, antes de tirar os silêncios.", "");
  const byKey = new Map(doc.blocks.map((b) => [b.key, b]));
  const totals = new Map(suggestedDurations(doc, sequences).map((d) => [d.spec.name, d]));
  for (const spec of sequences) {
    const rowsFor = (k: BlockKey) => (byKey.get(k)?.rows ?? []).filter((r) => !r.bastidor && r.suggestion === "usar");
    const d = totals.get(spec.name)!;
    lines.push(`### ${versionLabel(spec)}: ${spec.name} (~${clockTime(d.totalS)})`, "");
    if (d.overS > 0) {
      lines.push(
        `**Passa de ${SHORTS_MAX_S / 60}:00 (Shorts) em ~${d.overS.toFixed(1)} s**, estimativa antes de tirar os silêncios: a decupagem propõe o corte (trecho e tempos), não o repassa.`,
        "",
      );
    }
    lines.push("| Bloco | Trechos do bruto |", "|---|---|");
    for (const k of spec.order) {
      const rows = rowsFor(k);
      lines.push(`| ${BLOCK_LABELS[k]} | ${rows.length ? rows.map((r) => span(r.start, r.end)).join(", ") : "(nenhuma tomada com \"usar\")"} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Teto das verticais: o Shorts aceita até 3:00 (#11364). */
export const SHORTS_MAX_S = 180;

/** Quanto a versão passa do teto do Shorts: 0 no horizontal e dentro do teto. */
export function shortsOverS(spec: Pick<SequenceSpec, "target">, totalS: number): number {
  return spec.target === "youtube" ? 0 : Math.max(0, totalS - SHORTS_MAX_S);
}

/**
 * O aviso da sequência montada que passa do teto do Shorts (#11377), ou null.
 * Mesmo texto no `[aviso]` do build e no roteiro (Gate 2). Aqui a duração é a
 * da montagem (silêncios já fora), não a estimativa da decupagem.
 */
export function shortsWarning(plan: Pick<SequencePlan, "spec" | "durationFrames">, fps: number): string | null {
  const totalS = plan.durationFrames / fps;
  const over = shortsOverS(plan.spec, totalS);
  if (over <= 0) return null;
  return `${plan.spec.name}: ${clockTime(totalS)} (${totalS.toFixed(1)} s), ${over.toFixed(1)} s acima do teto do Shorts (${SHORTS_MAX_S} s); cortar só na vertical com "skip"/"targets" no item do blocks.json`;
}

/**
 * Duração de cada versão na montagem sugerida (soma dos trechos "usar" do
 * bruto, antes de tirar os silêncios: estimativa por cima) e quanto a vertical
 * passa do teto do Shorts (`overS`, 0 no horizontal e dentro do teto).
 */
export function suggestedDurations(doc: DecupagemDoc, sequences: SequenceSpec[] = defaultSequences()): Array<{ spec: SequenceSpec; totalS: number; overS: number }> {
  const byKey = new Map(doc.blocks.map((b) => [b.key, b]));
  return sequences.map((spec) => {
    const totalS = spec.order
      .flatMap((k) => (byKey.get(k)?.rows ?? []).filter((r) => !r.bastidor && r.suggestion === "usar"))
      .reduce((acc, r) => acc + (r.end - r.start), 0);
    return { spec, totalS, overS: shortsOverS(spec, totalS) };
  });
}

/**
 * Molde do `blocks.json` a partir da decupagem: cada fala "usar" vira um
 * INTERVALO explícito no bruto (os tempos dos segmentos da linha) com o texto
 * limpo. Frase solta não serviria: o `roteiro` casaria a ÚLTIMA tomada
 * completa, que pode ser justo a cortada ou a alternativa da mesma frase.
 */
export function blocksFromDecupagem(doc: DecupagemDoc): Record<BlockKey, Array<{ start: number; end: number; text: string }>> {
  const out = Object.fromEntries(BLOCK_KEYS.map((k) => [k, [] as Array<{ start: number; end: number; text: string }>])) as Record<
    BlockKey,
    Array<{ start: number; end: number; text: string }>
  >;
  for (const b of doc.blocks) for (const r of b.rows) if (!r.bastidor && r.suggestion === "usar") out[b.key].push({ start: r.start, end: r.end, text: r.fala });
  return out;
}

/** As linhas "alternativa" da decupagem, por bloco: viram as opções B, C… do roteiro final. */
export function alternativesFromDecupagem(doc: DecupagemDoc): Partial<Record<BlockKey, Array<{ start: number; end: number; text: string }>>> {
  const out: Partial<Record<BlockKey, Array<{ start: number; end: number; text: string }>>> = {};
  for (const b of doc.blocks) {
    const alts = b.rows.filter((r) => r.suggestion === "alternativa");
    if (alts.length) out[b.key] = alts.map((r) => ({ start: r.start, end: r.end, text: r.fala }));
  }
  return out;
}

// ── Roteiro final (gate 2) ────────────────────────────────────────────────

/** O parágrafo inicial: o que é comum às versões e o que só uma (ou algumas) leva. */
export function versionsDiffParagraph(specs: SequenceSpec[]): string {
  if (specs.length < 2) return "";
  const common = BLOCK_KEYS.filter((k) => specs.every((s) => s.order.includes(k)));
  const parts = [`Comum às ${specs.length} versões: ${common.length ? common.map((k) => BLOCK_LABELS[k]).join(", ") : "nenhum bloco"}.`];
  for (const s of specs) {
    const own = s.order.filter((k) => !common.includes(k));
    if (own.length) parts.push(`${TARGET_LABELS[s.target]} leva ainda ${own.map((k) => BLOCK_LABELS[k]).join(", ")}.`);
  }
  return parts.join(" ");
}

const LETTERS = "ABCDEFGH";

/**
 * O Doc do roteiro final ("Roteiro final {AAMMDD} (2 versões)"): uma tabela
 * por versão (`Bloco | Fala | Bruto`), duração da versão no título, texto
 * integral de cada item com o timecode do bruto e a tomada. Bloco com tomadas
 * alternativas (as "alternativa" da decupagem) mostra a escolhida como
 * "opção A" e as outras como linhas extras "opção B", "opção C". Cada versão
 * leva só os itens que entram nela (`targets`/`skip`, #11377), com o escopo
 * anotado na coluna Bruto, e a vertical que passa de 3:00 ganha o `[aviso]`
 * com quanto passa (`shortsWarning`).
 */
export function roteiroMarkdown(
  edition: string,
  plans: SequencePlan[],
  resolved: Partial<Record<BlockKey, ResolvedItem[]>>,
  fps: number,
  opts: { alternatives?: Partial<Record<BlockKey, Array<{ start: number; end: number; text: string }>>> } = {},
): string {
  const lines = [`# Roteiro final ${edition} (${plans.length} versões)`, ""];
  const diff = versionsDiffParagraph(plans.map((p) => p.spec));
  if (diff) lines.push(diff, "");
  lines.push("Nenhuma versão leva \"Por que isso importa?\" (decisão do editor, 26/10/2026).", "");
  for (const p of plans) {
    lines.push(`## ${versionLabel(p.spec)}: ${p.spec.name} (${clockTime(p.durationFrames / fps)})`, "");
    const over = shortsWarning(p, fps);
    if (over) lines.push(`**[aviso] ${over}**`, "");
    lines.push("| Bloco | Fala | Bruto |", "|---|---|---|");
    // Só os itens desta versão (`targets`/`skip`, #11377).
    const forThis = (key: BlockKey) => (resolved[key] ?? []).filter((it) => itemInTarget(it, p.spec.target));
    for (const key of p.spec.order) {
      const all = resolved[key];
      const items = forThis(key);
      const label = BLOCK_LABELS[key];
      if (!all?.length) {
        lines.push(`| ${label} | (falta no blocks.json) |  |`);
        continue;
      }
      if (!items.length) {
        lines.push(`| ${label} | (nenhum item nesta versão: targets/skip) |  |`);
        continue;
      }
      // Clipe fundido de blocos diferentes (#11503) conta só o pedaço deste bloco.
      const secs = p.clips.reduce((acc, c) => acc + clipSecondsOfBlock(c, key, fps), 0);
      const alts = opts.alternatives?.[key] ?? [];
      items.forEach((it, i) => {
        const head = i === 0 ? `${label}${alts.length ? ", opção A" : ""} (${secs.toFixed(1)} s)` : "";
        const scope = it.targets ? ` (só ${it.targets.join(", ")})` : it.skip ? ` (fora de ${it.skip.join(", ")})` : "";
        const bruto = span(it.interval.start, it.interval.end) + (it.how === "take" ? ` (tomada ${it.take} de ${it.completeTakes})` : "") + scope;
        lines.push(`| ${mdCell(head)} | ${mdCell(it.text)} | ${bruto} |`);
      });
      alts.forEach((a, k) => lines.push(`| ${mdCell(`${label}, opção ${LETTERS[k + 1] ?? k + 2}`)} | ${mdCell(a.text)} | ${span(a.start, a.end)} |`));
    }
    // A fala ouvida que difere do texto pedido aparece no Gate 2 (#11362).
    const differs = p.spec.order.flatMap((key) =>
      (resolved[key] ?? []).flatMap((it, i) =>
        it.heard === undefined || !itemInTarget(it, p.spec.target) ? [] : [`- **fala difere** ${BLOCK_LABELS[key]} [${i}], ouvido: "${it.heard}" (pedido: "${it.text}")`],
      ),
    );
    if (differs.length) lines.push("", ...differs);
    if (p.missingBlocks.length) lines.push("", `Faltam no blocks.json: ${p.missingBlocks.map((k) => BLOCK_LABELS[k]).join(", ")}.`);
    lines.push("");
  }
  return lines.join("\n");
}

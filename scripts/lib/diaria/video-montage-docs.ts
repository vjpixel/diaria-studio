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
  OPTIONAL_BLOCKS,
  CTA_BLOCKS,
  alignTokens,
  clipSecondsOfBlock,
  clockTime,
  decideTakes,
  defaultSequences,
  openingBlockOf,
  type OpeningBlock,
  describeCollapsedSuspect,
  isBlockKey,
  itemInTarget,
  sequenceInList,
  sequenceKey,
  speechParts,
  subRetranscribeWindow,
  tokenize,
  tokensMatch,
  validateVocabRules,
  type BlockKey,
  type Interval,
  type RepetitionCut,
  type ResolvedItem,
  type Segment,
  type SequencePlan,
  type SequenceRef,
  type SequenceSpec,
  type SequenceTarget,
  type VocabRule,
} from "./video-montage.ts";
import { voiceHint, type VoiceMark } from "./video-voice.ts";
import { CTA_CARD } from "./video-cta-card.ts";

// ── Rótulos ───────────────────────────────────────────────────────────────

/** Nome de cada bloco nos Docs. */
export const BLOCK_LABELS: Readonly<Record<BlockKey, string>> = {
  gancho: "Gancho",
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
  // #12609: o horizontal não vai só para o YouTube.
  youtube: "Horizontal",
  instagram: "Vertical Instagram",
  "outras-redes": "Vertical",
};

/**
 * Nome da versão no Doc: o do destino, ou, no corte, "Vertical {slug}" (#11900).
 * O `target` do corte só diz o formato (`instagram`/`outras-redes`, pode
 * repetir entre cortes) e o rótulo do destino ("Vertical Instagram") dizia ao
 * editor uma rede que o corte não é: ele sai em todas, como a vertical da edição.
 */
export function targetLabel(spec: Pick<SequenceSpec, "target" | "corte">): string {
  return spec.corte !== undefined ? `Vertical ${spec.corte}` : TARGET_LABELS[spec.target];
}

/** "Horizontal 1920x1080" etc. */
export function versionLabel(spec: SequenceSpec): string {
  return `${targetLabel(spec)} ${spec.width}x${spec.height}`;
}

/** Célula de tabela Markdown: sem `|` cru nem quebra de linha. */
export const mdCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const span = (start: number, end: number) => `${clockTime(start)}–${clockTime(end)}`;

/** Vocabulário aplicado a um texto de exibição (regra a regra, como nas legendas; aqui o número de palavras pode mudar). */
export function applyVocabularyToText(text: string, rules: VocabRule[], target?: SequenceTarget | SequenceRef): string {
  let out = text;
  for (const r of rules) {
    if (r.targets && (!target || !sequenceInList(r.targets, target))) continue;
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
 * Blocos que podem repetir o mesmo segmento "usar" (#11676): nenhuma sequência
 * leva dois blocos do mesmo grupo. O resumo curto das verticais é, por
 * definição, um subconjunto das falas do resumo; o CTA gravado uma vez serve a
 * mais de uma versão. Fora destes grupos (e dentro do mesmo bloco), segmento
 * repetido continua erro.
 */
export const SHARED_SEGMENT_GROUPS: ReadonlyArray<readonly BlockKey[]> = [
  ["resumo", "resumo_curto"],
  BLOCK_KEYS.filter((k) => k.startsWith("cta_")),
];

/** Os dois blocos podem ter o mesmo segmento "usar" (#11676). */
export function blocksMayShareSegment(a: BlockKey, b: BlockKey): boolean {
  return a !== b && SHARED_SEGMENT_GROUPS.some((g) => g.includes(a) && g.includes(b));
}

/**
 * Valida o plano contra o transcript, juntando todos os erros: bloco conhecido
 * e não repetido, segmento existente e em uma linha só (exceto "usar" repetido
 * entre blocos de `SHARED_SEGMENT_GROUPS`, #11676), sugestão conhecida, motivo
 * em cortar/alternativa. Chaves que começam com `_` (as notas do molde) são
 * ignoradas.
 */
export function parseDecupagemPlan(raw: unknown, segmentCount: number): { ok: true; plan: DecupagemPlan } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["decupagem-plan.json precisa ser um objeto"] };
  if (typeof raw.edition !== "string" || !/^\d{6}$/.test(raw.edition)) errors.push("edition precisa ser AAMMDD");
  const seenSeg = new Map<number, Array<{ label: string; key: BlockKey; usar: boolean }>>();
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
            const occ = seenSeg.get(s as number) ?? [];
            const here = { label, key: b.key as BlockKey, usar: r.suggestion === "usar" };
            // Repetido só vale com "usar" nas duas pontas e entre blocos de um grupo compartilhável (#11676).
            const clash = occ.find((o) => !(here.usar && o.usar && blocksMayShareSegment(o.key, here.key)));
            if (clash) errors.push(`${label}: segmento ${s} já está em ${clash.label}`);
            occ.push(here);
            seenSeg.set(s as number, occ);
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
        // O MESMO segmento em resumo e resumo_curto (ou em dois CTAs) é a mesma tomada, não duas (#11676).
        if (a.seg === c.seg || !duplicate(a.seg, c.seg)) continue;
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
    _como: "Cada linha: { segments: [n, ...], suggestion: usar|cortar|alternativa, reason?, text? }. Segmento fora de toda linha vira 'cortar (bastidor)'. text = fala limpa quando o Whisper errou. Um segmento fica numa linha só, exceto 'usar' repetido entre resumo e resumo_curto ou entre os CTAs. A frase falada que abre o vídeo vai em gancho (abre as duas versões); titulo só quando o título é lido em voz alta (#12586).",
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

/** Fim de frase: ponto, exclamação, interrogação ou reticências, com aspas de fecho opcionais. */
const SENTENCE_END = /[.!?…]["'»”)]*$/;

/**
 * Propõe o bloco `gancho` (#12093): a 1ª frase do resumo abre o horizontal,
 * antes do "Olá, eu sou o Pixel". Na 261104 o editor reordenou à mão e o
 * `srt`, alinhado ao roteiro na ordem velha, espremeu a legenda do gancho em
 * 60 ms. Sem linha `gancho` "usar" no plano, a 1ª linha "usar" do resumo (a
 * mais cedo no bruto) se divide no fim da 1ª frase, pelo tempo das palavras
 * do Whisper (o corte cai no meio da pausa entre a frase e a seguinte): o
 * gancho fica com a 1ª frase, o resumo com o resto. Resumo de uma frase só vira
 * gancho inteiro. Já existe gancho, ou não há resumo, ou a frase não se acha
 * nas palavras: o doc volta igual, com o motivo em `note`.
 */
export function proposeGancho(doc: DecupagemDoc, segments: Segment[]): { doc: DecupagemDoc; note: string | null } {
  const usar = (r: DecupagemTableRow) => !r.bastidor && r.suggestion === "usar";
  if (doc.blocks.some((b) => b.key === "gancho" && b.rows.some(usar))) return { doc, note: null };
  const resumo = doc.blocks.find((b) => b.key === "resumo");
  const first = resumo?.rows.filter(usar).sort((a, b) => a.start - b.start)[0];
  if (!resumo || !first) return { doc, note: "sem linha \"usar\" no resumo: horizontal sem gancho" };
  const words = first.segments
    .flatMap((s) => segments[s - 1]?.words ?? [])
    .filter((w) => w.text.trim() && (w.start + w.end) / 2 >= first.start - 1e-6 && (w.start + w.end) / 2 <= first.end + 1e-6)
    .sort((a, b) => a.start - b.start);
  const m = /^(.*?[.!?…]["'»”)]*)(\s+)(\S[\s\S]*)$/.exec(first.fala.trim());
  const ganchoRow = (end: number, fala: string): DecupagemTableRow => ({
    ...first,
    end,
    fala,
    sugestao: "usar (1ª frase do resumo: abre o horizontal, antes da abertura; #12093)",
  });
  let gancho: DecupagemTableRow;
  let rest: DecupagemTableRow | null;
  if (!m) {
    gancho = ganchoRow(first.end, first.fala);
    rest = null;
  } else {
    const k = words.findIndex((w, i) => i < words.length - 1 && SENTENCE_END.test(w.text.trim()));
    if (k < 0) return { doc, note: `a 1ª frase do resumo ("${m[1]}") não se acha nas palavras do Whisper: gancho não proposto, separar à mão no blocks.json` };
    const cut = Math.round(((words[k].end + words[k + 1].start) / 2) * 1000) / 1000;
    gancho = ganchoRow(cut, m[1]);
    rest = { ...first, start: cut, fala: m[3] };
  }
  const blocks = doc.blocks.map((b) =>
    b.key !== "resumo" ? b : { key: b.key, rows: b.rows.flatMap((r) => (r !== first ? [r] : rest ? [rest] : [])) },
  );
  return {
    doc: { blocks: [{ key: "gancho", rows: [gancho] }, ...blocks.filter((b) => b.key !== "gancho")] },
    note: `gancho proposto (#12093): "${gancho.fala}" (${clockTime(gancho.start)}–${clockTime(gancho.end)}), a 1ª frase do resumo; abre o horizontal antes da abertura`,
  };
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

// ── Duração-alvo da vertical (#11757, #12694) ─────────────────────────────

/**
 * Duração-alvo da vertical, em segundos de fala (#12694, decisão do editor
 * 10/11/2026 na montagem da 261111; era 85 s desde o #11757): toda vertical, a
 * da edição e os cortes/Shorts avulsos, chega à prévia com até 75 s de fala. O
 * card de CTA (~4 s) fica fora da conta: `durationFrames` do plano é só a
 * montagem. Passou do alvo, o roteiro (Gate 2) propõe o corte e a prévia fica
 * bloqueada (`verticalPreviewGate`); quem decide os cortes é o editor.
 * `verticalTargetS` no `blocks.json` pode REDUZIR o alvo da edição, nunca
 * liberar mais que isto (`effectiveVerticalTargetS`).
 */
export const VERTICAL_TARGET_S = 75;

/**
 * O alvo que vale na edição: o `verticalTargetS` do `blocks.json` limitado a
 * `VERTICAL_TARGET_S` (#12694). Um `blocks.json` antigo com 85/90 (permitido
 * pelo #11757) segue carregando; o valor só é limitado, com aviso
 * (`verticalTargetOverrideWarning`).
 */
export function effectiveVerticalTargetS(targetS?: number): number {
  return Math.min(targetS ?? VERTICAL_TARGET_S, VERTICAL_TARGET_S);
}

/** O aviso do `verticalTargetS` da edição acima do teto (#12694), ou null. */
export function verticalTargetOverrideWarning(targetS?: number): string | null {
  if (targetS === undefined || targetS <= VERTICAL_TARGET_S) return null;
  return `verticalTargetS ${targetS} no blocks.json passa do teto de ${VERTICAL_TARGET_S} s da vertical: usando ${VERTICAL_TARGET_S} s (#12694; a edição só pode reduzir o alvo)`;
}

/** Segundos de fala do item na montagem (silêncios já fora, quando informados). */
export function itemSpeechSeconds(it: Pick<ResolvedItem, "interval">, silences?: Interval[]): number {
  return silences ? speechParts(it.interval.start, it.interval.end, silences).reduce((a, p) => a + (p.end - p.start), 0) : it.interval.end - it.interval.start;
}

/**
 * O gate da prévia (#12694): vertical (da edição ou corte/Short avulso) acima
 * do alvo não ganha prévia nem review; null no horizontal e dentro do alvo.
 * A mensagem é o `[aviso]` forte que o `preview`/`review` imprimem antes de
 * sair com exit 1.
 */
export function verticalPreviewGate(plan: Pick<SequencePlan, "spec" | "durationFrames">, fps: number, targetS?: number): string | null {
  if (plan.spec.target === "youtube") return null;
  const limit = effectiveVerticalTargetS(targetS);
  const seconds = plan.durationFrames / fps;
  if (seconds <= limit + 1e-9) return null;
  return (
    `[aviso] GATE BLOQUEADO: ${plan.spec.name} tem ${sec(seconds)} de fala, ${sec(seconds - limit)} acima do alvo de ${limit} s da vertical (card de CTA fora da conta). ` +
    `Antes da prévia: rodar roteiro, mostrar ao editor o roteiro enxuto (duração de cada frase, o que sai e por quê), aplicar o corte aceito no blocks.json ("skip") e refazer build. ` +
    `A prévia só sai da versão que cabe (#12694); --over-target força, só com o editor pedindo.`
  );
}

export interface VerticalCutSuggestion {
  /** Bloco do item no `blocks.json` (#12694: o comentário primeiro, depois os outros blocos). */
  block: BlockKey;
  /** Índice do item no bloco do `blocks.json`. */
  index: number;
  text: string;
  /** Segundos do item na montagem (silêncios já fora, quando informados). */
  seconds: number;
  reason: string;
}

export interface VerticalTargetCheck {
  totalS: number;
  targetS: number;
  overS: number;
  /** Frases sugeridas, na ordem de prioridade, até cobrir `overS` (pode não cobrir: aí `coveredS < overS`). */
  cuts: VerticalCutSuggestion[];
  coveredS: number;
}

// Conselho genérico, a frase que o editor cortou na 261030 ("Não utilize IA para nada que vá influenciar…").
const GENERIC_ADVICE = /\b(nao (use|utilize|confie|deixe|faca|esqueca)|use|utilize|lembre|lembrem|lembrese|cuidado|fique atent[oa]|fiquem atent[oa]s|vale a pena|recomendo|minha dica|meu conselho|o conselho|desconfie|sempre confira|sempre verifique)\b/;
const CONTENT_MIN_LEN = 4;

/** Fração das palavras de conteúdo (4+ letras) de `toks` que aparecem em `ref`. */
function overlapRatio(toks: string[], ref: string[]): number {
  const content = toks.filter((t) => t.length >= CONTENT_MIN_LEN);
  if (content.length === 0) return 0;
  return content.filter((t) => ref.some((r) => tokensMatch(t, r))).length / content.length;
}

/** Frase do comentário que repete o resumo: 60%+ das palavras de conteúdo já ditas lá. */
export const REPEATS_SUMMARY_RATIO = 0.6;

/**
 * Blocos que o fallback do corte (#12694) nunca propõe: o fecho e os CTAs
 * falados fecham a versão, e cortá-los tira a chamada, não a gordura.
 */
const NEVER_CUT_BLOCKS: readonly BlockKey[] = ["fecho", ...CTA_BLOCKS];

/**
 * A vertical passa da duração-alvo? Se passa, quais frases cortar (#11757,
 * #12694): primeiro as do comentário que repetem o resumo ou fecham com
 * conselho genérico (as que o editor cortou na 261030), da última para a
 * primeira; depois as do fim do comentário. A 1ª frase do comentário fica (é o
 * gancho). Se o comentário não bastar (inclusive Short sem comentário), entram
 * as frases dos outros blocos, de trás para frente, preservando a 1ª fala da
 * versão (o gancho) e nunca o fecho/CTA. Só para as verticais; null no
 * horizontal e dentro do alvo (`effectiveVerticalTargetS`).
 */
export function verticalTargetCheck(
  plan: Pick<SequencePlan, "spec" | "durationFrames">,
  resolved: Partial<Record<BlockKey, ResolvedItem[]>>,
  fps: number,
  opts: { targetS?: number; silences?: Interval[] } = {},
): VerticalTargetCheck | null {
  if (plan.spec.target === "youtube") return null;
  const targetS = effectiveVerticalTargetS(opts.targetS);
  const totalS = plan.durationFrames / fps;
  const overS = totalS - targetS;
  if (overS <= 1e-9) return null;
  const inThis = (k: BlockKey) => (plan.spec.order.includes(k) ? (resolved[k] ?? []).filter((it) => itemInTarget(it, plan.spec)) : []);
  const summary = [...inThis("resumo"), ...inThis("resumo_curto"), ...(resolved.resumo ?? [])].flatMap((it) => tokenize(it.text));
  const comment = (resolved.comentario ?? []).map((it, index) => ({ it, index })).filter(({ it }) => plan.spec.order.includes("comentario") && itemInTarget(it, plan.spec));
  const secondsOf = (it: ResolvedItem) => itemSpeechSeconds(it, opts.silences);
  const candidates = comment.slice(comment.length > 1 ? 1 : 0).map(({ it, index }, k, all) => {
    const toks = tokenize(it.text);
    const reasons: string[] = [];
    if (overlapRatio(toks, summary) >= REPEATS_SUMMARY_RATIO) reasons.push("repete o resumo");
    if (GENERIC_ADVICE.test(toks.join(" "))) reasons.push(k === all.length - 1 ? "fecha com conselho genérico" : "conselho genérico");
    return { index, text: it.text, seconds: Math.round(secondsOf(it) * 10) / 10, reasons };
  });
  const ordered = [...candidates.filter((c) => c.reasons.length).reverse(), ...candidates.filter((c) => !c.reasons.length).reverse()];
  const cuts: VerticalCutSuggestion[] = [];
  let coveredS = 0;
  for (const c of ordered) {
    if (coveredS >= overS - 1e-9) break;
    cuts.push({ block: "comentario", index: c.index, text: c.text, seconds: c.seconds, reason: c.reasons.length ? c.reasons.join(", ") : "frase do fim do comentário" });
    coveredS += c.seconds;
  }
  // #12694: o comentário não bastou (ou a versão não tem comentário): as frases
  // dos outros blocos, de trás para frente, sem a 1ª fala da versão (o gancho)
  // e sem fecho/CTA.
  if (coveredS < overS - 1e-9) {
    const spoken = plan.spec.order.flatMap((block) => (resolved[block] ?? []).map((it, index) => ({ block, it, index })).filter(({ it }) => itemInTarget(it, plan.spec)));
    for (const c of spoken.slice(1).reverse()) {
      if (coveredS >= overS - 1e-9) break;
      if (NEVER_CUT_BLOCKS.includes(c.block) || c.block === "comentario") continue;
      const seconds = Math.round(secondsOf(c.it) * 10) / 10;
      cuts.push({ block: c.block, index: c.index, text: c.it.text, seconds, reason: "o comentário não bastou: frase do fim da versão (o gancho fica)" });
      coveredS += seconds;
    }
  }
  return { totalS, targetS, overS, cuts, coveredS };
}

const sec = (x: number) => `${x.toFixed(1).replace(".", ",")} s`;

/** O aviso da vertical acima do alvo, numa linha (o `[aviso]` do build e do roteiro). */
export function verticalTargetWarning(name: string, c: VerticalTargetCheck): string {
  const cover = c.cuts.length ? `; sugestão: cortar ${c.cuts.map((x) => `${BLOCK_LABELS[x.block].toLowerCase()} [${x.index}]`).join(", ")} (~${sec(c.coveredS)})` : "";
  return `${name}: ${sec(c.totalS)}, ${sec(c.overS)} acima do alvo da vertical (${c.targetS} s)${cover}; quem decide é o editor no Gate 2`;
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

/**
 * O bloco de abertura da decupagem (#12586), lido do plano como a skill o
 * escreveu, ANTES do `proposeGancho`: o gancho escrito no plano é a frase
 * falada de abertura e abre as duas versões; o gancho proposto (a 1ª frase do
 * resumo, #12093) é só do horizontal e não muda a ordem da vertical.
 */
export function decupagemOpeningBlock(planned: DecupagemDoc): OpeningBlock {
  return openingBlockOf(blocksFromDecupagem(planned));
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
    if (own.length) parts.push(`${targetLabel(s)} leva ainda ${own.map((k) => BLOCK_LABELS[k]).join(", ")}.`);
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
/**
 * A linha **repetição** do roteiro (#11958): o falso começo que as subjanelas
 * acharam e o corte proposto, já como os dois intervalos que substituem o item
 * no `blocks.json` se o editor aprovar no Gate 2 (o item segue inteiro até lá).
 */
export function repetitionLine(label: string, what: string, item: Interval, rep: RepetitionCut): string {
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const parts = [
    ...(rep.cut.start - item.start > 0.05 ? [{ start: r2(item.start), end: r2(rep.cut.start) }] : []),
    ...(item.end - rep.cut.end > 0.05 ? [{ start: r2(rep.cut.end), end: r2(item.end) }] : []),
  ];
  const json = parts.map((p) => `{"start": ${p.start}, "end": ${p.end}}`).join(", ");
  return (
    `- **repetição** ${label} (${what}): falso começo "${mdCell(rep.falseStart)}" em ${span(rep.cut.start, rep.cut.end)} (${sec(rep.audibleS)} de fala sem palavra no transcript), recomeço em "${mdCell(rep.restart)}". ` +
    `Corte proposto ${rep.cut.start.toFixed(2)}–${rep.cut.end.toFixed(2)} s; aprovado, o item vira ${json} no blocks.json (mesmo targets/skip, text de cada parte do texto aprovado)`
  );
}

export function roteiroMarkdown(
  edition: string,
  plans: SequencePlan[],
  resolved: Partial<Record<BlockKey, ResolvedItem[]>>,
  fps: number,
  opts: {
    alternatives?: Partial<Record<BlockKey, Array<{ start: number; end: number; text: string }>>>;
    /** Alvo da vertical (#11757, #12694); ausente = `VERTICAL_TARGET_S`, limitado a ele. */
    verticalTargetS?: number;
    /** Silêncios do bruto: a duração de cada frase sugerida para corte sai sem as pausas. */
    silences?: Interval[];
    /**
     * #12571: a linha de compartilhar do card de CTA de cada versão (chave =
     * `sequenceKey`); presente = a versão fecha com o card (linha no fim da
     * tabela). Ausente = sem card (`ctaCard: false` no blocks.json).
     */
    ctaCardShare?: Readonly<Record<string, string>>;
    /**
     * #12585: o título de cada vídeo (chave = `sequenceKey`), já com a
     * origem entre parênteses, numa linha logo abaixo do cabeçalho da versão.
     * Ausente = sem a linha.
     */
    videoTitles?: Readonly<Record<string, string>>;
  } = {},
): string {
  const lines = [`# Roteiro final ${edition} (${plans.length} versões)`, ""];
  // #12093: bloco opcional (o gancho) sem clipe nesta versão não entra no parágrafo.
  const hasClip = (p: SequencePlan, k: BlockKey) => p.clips.some((c) => c.block === k || c.parts?.some((x) => x.block === k));
  const diff = versionsDiffParagraph(plans.map((p) => ({ ...p.spec, order: p.spec.order.filter((k) => !OPTIONAL_BLOCKS.includes(k) || hasClip(p, k)) })));
  if (diff) lines.push(diff, "");
  lines.push("Nenhuma versão leva \"Por que isso importa?\" (decisão do editor, 26/10/2026).", "");
  for (const p of plans) {
    lines.push(`## ${versionLabel(p.spec)}: ${p.spec.name} (${clockTime(p.durationFrames / fps)})`, "");
    const videoTitle = opts.videoTitles?.[sequenceKey(p.spec)];
    if (videoTitle !== undefined) lines.push(`**Título do vídeo:** ${videoTitle}`, "");
    const over = shortsWarning(p, fps);
    if (over) lines.push(`**[aviso] ${over}**`, "");
    // Duração-alvo da vertical (#11757): aviso + as frases sugeridas, para o editor decidir aqui e não no Premiere.
    const target = verticalTargetCheck(p, resolved, fps, { targetS: opts.verticalTargetS, silences: opts.silences });
    if (target) {
      lines.push(
        `**[aviso] ${sec(target.totalS)}, ${sec(target.overS)} acima do alvo da vertical (${target.targetS} s, card de CTA fora da conta). A prévia fica bloqueada até caber (#12694).** Sugestão de corte (só nesta versão: \`"skip": ["${sequenceKey(p.spec)}"]\` no item do bloco indicado):`,
        "",
      );
      for (const c of target.cuts) lines.push(`- ${BLOCK_LABELS[c.block]} [${c.index}] (${sec(c.seconds)}, ${c.reason}): "${mdCell(c.text)}"`);
      if (target.coveredS < target.overS - 1e-9) lines.push(`- As sugestões tiram ~${sec(target.coveredS)}; ainda faltam ~${sec(target.overS - target.coveredS)}: enxugar ou regravar com o editor; a prévia segue bloqueada.`);
      // #12694: o roteiro enxuto, para o editor ver o que fica antes da prévia.
      lines.push("", "**Roteiro enxuto proposto (mostrar ao editor antes da prévia):**", "", "| Bloco | Fala mantida | Duração |", "|---|---|---|");
      for (const key of p.spec.order) {
        (resolved[key] ?? []).forEach((it, index) => {
          if (!itemInTarget(it, p.spec) || target.cuts.some((c) => c.block === key && c.index === index)) return;
          lines.push(`| ${BLOCK_LABELS[key]} [${index}] | ${mdCell(it.text)} | ${sec(itemSpeechSeconds(it, opts.silences))} |`);
        });
      }
      lines.push("", `Estimativa depois dos cortes: ~${sec(target.totalS - target.coveredS)} de fala (alvo ${target.targetS} s). Aplicado o corte, refazer o build para medir de novo.`, "");
    }
    lines.push("| Bloco | Fala | Bruto |", "|---|---|---|");
    // Só os itens desta versão (`targets`/`skip`, #11377).
    const forThis = (key: BlockKey) => (resolved[key] ?? []).filter((it) => itemInTarget(it, p.spec));
    for (const key of p.spec.order) {
      const all = resolved[key];
      const items = forThis(key);
      const label = BLOCK_LABELS[key];
      if (!all?.length) {
        // #12571: sem CTA falado, o card de CTA do fim faz o papel dele.
        const byCard = CTA_BLOCKS.includes(key) && opts.ctaCardShare?.[sequenceKey(p.spec)] !== undefined;
        lines.push(`| ${label} | ${byCard ? "(sem CTA falado: o card de CTA fecha a versão)" : "(falta no blocks.json)"} |  |`);
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
    // #12571: o card de CTA, último clipe de toda versão (sem fala).
    const share = opts.ctaCardShare?.[sequenceKey(p.spec)];
    if (share !== undefined) lines.push(`| Card de CTA (${CTA_CARD.durationS} s) | ${mdCell(`${CTA_CARD.title} ${CTA_CARD.like}. ${share}. ${CTA_CARD.follow}.`)} | card, sem fala (fade-in de ${CTA_CARD.fadeInS} s) |`);
    // A fala ouvida que difere do texto pedido aparece no Gate 2 (#11362).
    const differs = p.spec.order.flatMap((key) =>
      (resolved[key] ?? []).flatMap((it, i) =>
        it.heard === undefined || !itemInTarget(it, p.spec) ? [] : [`- **fala difere** ${BLOCK_LABELS[key]} [${i}], ouvido: "${it.heard}" (pedido: "${it.text}")`],
      ),
    );
    if (differs.length) lines.push("", ...differs);
    // Tomada colapsada (#11754): a escolhida pela retranscrição, ou o pedido de retranscrever.
    const collapsed = p.spec.order.flatMap((key) =>
      (resolved[key] ?? []).flatMap((it, i) => {
        if (!it.collapsed || !itemInTarget(it, p.spec)) return [];
        const c = it.collapsed;
        const what = describeCollapsedSuspect(c.suspects[0]);
        if (c.picked) {
          return [`- **tomada colapsada** ${BLOCK_LABELS[key]} [${i}] (${what}): a retranscrição separou ${c.picked.completeTakes} tomadas; usando a ${c.picked.takeNumber}ª (${c.picked.why}), ${span(it.interval.start, it.interval.end)}`];
        }
        // Falso começo achado nas subjanelas (#11958): corte proposto, com os dois intervalos prontos para o blocks.json.
        if (c.repetition) return [repetitionLine(`${BLOCK_LABELS[key]} [${i}]`, what, it.interval, c.repetition)];
        const w = c.suspects[0].window;
        const sw = subRetranscribeWindow(c.suspects[0]);
        const sub = `retranscrever em subjanelas (\`retranscribe ${edition} --from ${sw.start.toFixed(1)} --to ${sw.end.toFixed(1)} --sub\`) e rodar o roteiro de novo (#11958)`;
        const todo = c.unresolved
          ? `a retranscrição não separou (${c.unresolved}): ${c.subChecked ? "as subjanelas também não acharam repetição: conferir no áudio" : sub}`
          : `retranscrever ${w.start.toFixed(1)}–${w.end.toFixed(1)} s (\`retranscribe --from ${w.start.toFixed(1)} --to ${w.end.toFixed(1)}\`) e rodar o roteiro de novo`;
        return [`- **tomada colapsada?** ${BLOCK_LABELS[key]} [${i}] (${what}): ${todo}`];
      }),
    );
    if (collapsed.length) lines.push("", ...collapsed);
    if (p.missingBlocks.length) lines.push("", `Faltam no blocks.json: ${p.missingBlocks.map((k) => BLOCK_LABELS[k]).join(", ")}.`);
    lines.push("");
  }
  return lines.join("\n");
}

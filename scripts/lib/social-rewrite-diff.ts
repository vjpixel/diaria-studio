/**
 * social-rewrite-diff.ts (#9692)
 *
 * Miolo PURO da medição "o que mudou no social entre a saída do Stage 2 e o
 * texto aprovado" — consumido por `scripts/measure-social-rewrite-diff.ts`
 * (IO: escolhe os arquivos no disco, imprime a tabela).
 *
 * Por que existe: o `auto-reporter` contou 12 `social-rewrite` em 3 edições
 * (260928, 261005, 261006) e sugeriu mexer nos prompts do `social-writer`/
 * `social-curto`. Decisão do editor (05/10/2026): MEDIR antes. Gabarito =
 * o texto real (Stage 2 vs aprovado), casado por URL do destaque — nunca por
 * POSIÇÃO (`## d1`), porque o editor reordena e troca destaques no gate 4.
 *
 * Tudo aqui é HEURÍSTICA declarada, não julgamento: cada rótulo diz qual
 * sinal mecânico disparou (tamanho, primeira/última frase, presença de CTA,
 * marcadores de tom, contagem de estrutura vetada, números/nomes próprios).
 * Um rótulo é um indício pra o humano olhar, não um veredito.
 */

import { BEEHIIV_BASE_URL } from "./edition-url.ts";
import { tokenizeForJaccard, jaccardSimilarity } from "./title-similarity.ts";
import { lintAntithesisReveal, lintTrailingEditorialHook } from "./social-lint-rules.ts";
import { DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET } from "./daily-carousel-card.ts";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Uma seção `## x` dentro de um bloco `# Y` do `03-social.md`. */
export interface SocialSection {
  /** Bloco de topo, minúsculo: `social`, `curto` (ou o que vier no `# `). */
  block: string;
  /** Nome da seção: `d1`/`d2`/`d3`/`um`/`post_pixel`/…; `intro` = texto antes do 1º `##` do bloco. */
  section: string;
  /** Corpo (sem a linha de cabeçalho), já normalizado. */
  body: string;
}

const SELF_URL_RE = new RegExp(`${BEEHIIV_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[^\\s)]*`, "g");

/**
 * Normalização antes de comparar: CRLF→LF (o `03-social.md` final de 260928
 * tem quebra diferente do snapshot e TODA linha "mudava"), URL própria do
 * site → `{edition_url}` (o Stage 5 substitui o placeholder, #7974), espaço
 * no fim de linha.
 */
export function normalizeSocialMd(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(SELF_URL_RE, "{edition_url}")
    .replace(/[ \t]+$/gm, "");
}

/**
 * Quebra o arquivo em (bloco, seção). A chave inclui o BLOCO — `# Social ## d1`
 * e `# Curto ## d1` são seções distintas (o antigo `Map` por nome de seção de
 * `classifySocialDiff` fazia o Curto sobrescrever o texto longo; desde o
 * #9718 aquele classificador usa este parser).
 */
export function parseSocialSections(md: string): SocialSection[] {
  const out: SocialSection[] = [];
  let block = "intro";
  let section = "intro";
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join("\n").trim();
    if (body !== "" || section !== "intro") out.push({ block, section, body });
    buf = [];
  };
  for (const line of normalizeSocialMd(md).split("\n")) {
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    if (h1) {
      flush();
      block = h1[1].trim().toLowerCase();
      section = "intro";
    } else if (h2) {
      flush();
      section = h2[1].trim().toLowerCase().replace(/\s+/g, "_");
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

export const isDestaqueSection = (s: string): boolean => /^d\d+$/.test(s);

// ---------------------------------------------------------------------------
// Medidas de texto
// ---------------------------------------------------------------------------

const HASHTAG_LINE_RE = /^(?:#[\p{L}\p{N}_]+\s*)+$/u;

/** Parágrafos de prosa (sem linha só de hashtags, sem comentário HTML, sem `**`). */
export function proseParagraphs(body: string): string[] {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\*\*/g, "").replace(/\s+/g, " ").trim())
    .filter((p) => p !== "" && !HASHTAG_LINE_RE.test(p));
}

export function proseText(body: string): string {
  return proseParagraphs(body).join("\n\n");
}

/** Divisão em frases simples: `.`/`!`/`?` seguido de espaço + maiúscula/aspas/dígito. */
export function sentences(text: string): string[] {
  return text
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=["“(\p{Lu}\p{N}])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Similaridade de conteúdo (Jaccard sobre tokens ≥3 chars) — usada pra casar histórias e medir magnitude. */
export function textSimilarity(a: string, b: string): number {
  return jaccardSimilarity(tokenizeForJaccard(a), tokenizeForJaccard(b));
}

/** Marcadores de registro coloquial (lista curta e explícita — heurística). */
const COLLOQUIAL_RE = /(?<![\p{L}])(pra|pro|pras|pros|tá|tô|né|a gente|vc|bora|tipo assim)(?![\p{L}])/giu;
/** Marcadores de registro formal. */
const FORMAL_RE = /(?<![\p{L}])(para|portanto|contudo|todavia|a fim de|mediante|cujo|cuja|cujos|cujas|outrossim)(?![\p{L}])/giu;

export function registerScore(text: string): { colloquial: number; formal: number } {
  return {
    colloquial: (text.match(COLLOQUIAL_RE) ?? []).length,
    formal: (text.match(FORMAL_RE) ?? []).length,
  };
}

/** CTA explícito no texto (o canal injeta o CTA de canal no publish — aqui só o que está NO texto). */
const CTA_RE =
  /mais em \{edition_url\}|\{edition_url\}|link na bio|assine|inscreva|leia (?:mais|a edi[çc][aã]o)|comente|compartilhe|salve (?:este|esse) post|segue pra|siga a/i;

export function hasCta(text: string): boolean {
  return CTA_RE.test(text);
}

/**
 * Estruturas vetadas pelo editor (memória `feedback_estruturas_texto_proibidas`):
 * antítese-revelação + gancho editorial (reusa os lints do social) + pivô de
 * reação / punchline de autoridade (regex abaixo) + emoji.
 */
const VETOED_EXTRA_RE =
  /o que (?:mais )?me (?:incomoda|preocupa|pega|chamou a? ?aten[çc][aã]o|deixou pensando)|a parte que me incomoda|o ponto (?:central )?[eé]|vindo de quem|pesa diferente|muda de patamar|o peso da declara[çc][aã]o/gi;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

export function vetoedStructureCount(body: string): number {
  const text = proseText(body);
  return (
    lintAntithesisReveal(text).matches.length +
    lintTrailingEditorialHook(text).matches.length +
    (text.match(VETOED_EXTRA_RE) ?? []).length +
    (text.match(EMOJI_RE) ?? []).length
  );
}

/** Fatos "duros": números e nomes próprios fora do início de frase. Siglas genéricas (IA/AI) ignoradas. */
const PROPER_STOP = new Set(["IA", "AI", "EUA"]);
export function factTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) out.add(m[0]);
  for (const s of sentences(text)) {
    const words = s.split(/\s+/).slice(1);
    for (const w of words) {
      const clean = w.replace(/^[^\p{L}]+|[^\p{L}\p{N}-]+$/gu, "");
      if (/^\p{Lu}[\p{L}\p{N}-]*$/u.test(clean) && !PROPER_STOP.has(clean)) out.add(clean);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Casamento (baseline Stage 2 ↔ aprovado)
// ---------------------------------------------------------------------------

/** Abaixo disso, duas seções "de mesmo nome" são histórias/itens diferentes. */
export const SAME_STORY_MIN_SIMILARITY = 0.2;

export type PairKind =
  /** Mesma história/item nos dois lados (por URL ou por similaridade). */
  | "mesma-historia"
  /** Seção do aprovado sem par no Stage 2 — o editor trocou o destaque/item, o texto é novo. */
  | "historia-trocada"
  /** Seção do Stage 2 sem par no aprovado — história removida. */
  | "historia-removida";

export interface SectionPair {
  kind: PairKind;
  block: string;
  /** Nome da seção no aprovado (ou no baseline, se removida). */
  section: string;
  /** Nome da seção no baseline quando difere (reordenação). */
  baselineSection?: string;
  matchedBy?: "url" | "similaridade" | "nome";
  /** Casou por texto apesar de URL diferente dos dois lados — o editor trocou a fonte. */
  sourceChanged?: boolean;
  url?: string | null;
  before?: string;
  after?: string;
}

export type UrlMap = ReadonlyMap<string, string>;

/**
 * Com URL dos dois lados e URLs DIFERENTES, só casa por texto acima disto —
 * a URL divergente já é evidência contra "mesma história" (caso real 261006:
 * o editor trocou a FONTE do destaque dos GPTs, canaltech → help.openai, e o
 * texto ficou quase igual).
 */
export const SOURCE_SWAP_MIN_SIMILARITY = 0.4;

/**
 * Casa seções em 2 passes. Destaques (`d\d+`): (1) por URL quando os DOIS
 * mapas têm URL (snapshot do `01-approved.json` de cada lado); (2) o que
 * sobrou, pela maior similaridade de texto entre os destaques do mesmo bloco
 * ainda sem par — limiar `SAME_STORY_MIN_SIMILARITY` sem URL, ou
 * `SOURCE_SWAP_MIN_SIMILARITY` quando as URLs existem e divergem (fonte
 * trocada, `sourceChanged`). Demais seções (`um`, `post_pixel`, `intro`):
 * mesmo nome no mesmo bloco, desde que similares — abaixo do limiar é item
 * trocado. Passes separados pra uma similaridade gulosa não roubar o par que
 * a URL de outra seção casaria.
 */
export function matchSections(
  baseline: SocialSection[],
  approved: SocialSection[],
  baselineUrls?: UrlMap,
  approvedUrls?: UrlMap,
): SectionPair[] {
  const used = new Set<SocialSection>();
  const matched = new Map<SocialSection, { b: SocialSection; by: NonNullable<SectionPair["matchedBy"]>; sourceChanged?: boolean }>();
  const haveUrls = (baselineUrls?.size ?? 0) > 0 && (approvedUrls?.size ?? 0) > 0;
  const urlOf = (a: SocialSection) => (isDestaqueSection(a.section) ? (approvedUrls?.get(a.section) ?? null) : null);
  const free = (a: SocialSection, destaque: boolean) =>
    baseline.filter((b) => !used.has(b) && b.block === a.block && isDestaqueSection(b.section) === destaque);
  const take = (a: SocialSection, b: SocialSection, by: NonNullable<SectionPair["matchedBy"]>, sourceChanged?: boolean) => {
    used.add(b);
    matched.set(a, { b, by, sourceChanged });
  };

  // Passe 1: URL (destaques) e nome (demais seções).
  for (const a of approved) {
    if (isDestaqueSection(a.section)) {
      const url = urlOf(a);
      if (!haveUrls || !url) continue;
      const b = free(a, true).find((c) => baselineUrls!.get(c.section) === url);
      if (b) take(a, b, "url");
    } else {
      const b = free(a, false).find((c) => c.section === a.section);
      if (b && (b.body === a.body || textSimilarity(proseText(b.body), proseText(a.body)) >= SAME_STORY_MIN_SIMILARITY)) {
        take(a, b, "nome");
      }
    }
  }
  // Passe 2: similaridade para destaques que sobraram.
  for (const a of approved) {
    if (matched.has(a) || !isDestaqueSection(a.section)) continue;
    const url = urlOf(a);
    const urlKnown = haveUrls && !!url;
    let best = 0;
    let bestB: SocialSection | undefined;
    for (const b of free(a, true)) {
      const s = textSimilarity(proseText(b.body), proseText(a.body));
      if (s > best) {
        best = s;
        bestB = b;
      }
    }
    const min = urlKnown ? SOURCE_SWAP_MIN_SIMILARITY : SAME_STORY_MIN_SIMILARITY;
    if (bestB && best >= min) take(a, bestB, "similaridade", urlKnown ? true : undefined);
  }

  const pairs: SectionPair[] = approved.map((a): SectionPair => {
    const m = matched.get(a);
    if (!m) return { kind: "historia-trocada", block: a.block, section: a.section, url: urlOf(a), after: a.body };
    return {
      kind: "mesma-historia",
      block: a.block,
      section: a.section,
      baselineSection: m.b.section !== a.section ? m.b.section : undefined,
      matchedBy: m.by,
      sourceChanged: m.sourceChanged,
      url: urlOf(a),
      before: m.b.body,
      after: a.body,
    };
  });
  for (const b of baseline) {
    if (used.has(b)) continue;
    pairs.push({
      kind: "historia-removida",
      block: b.block,
      section: b.section,
      url: isDestaqueSection(b.section) ? (baselineUrls?.get(b.section) ?? null) : null,
      before: b.body,
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Classificação
// ---------------------------------------------------------------------------

export type ChangeLabel =
  | "identico"
  | "reordenado"
  | "fonte-trocada"
  | "encurtamento"
  | "expansao"
  | "estouro-teto-260"
  | "estouro-teto-280"
  | "hook"
  | "fechamento"
  | "frase-removida"
  | "frase-adicionada"
  | "cta"
  | "tom-coloquial"
  | "tom-formal"
  | "estrutura-vetada-removida"
  | "factual"
  | "outro";

export interface PairClassification {
  labels: ChangeLabel[];
  /** 1 − Jaccard de tokens: 0 = mesmas palavras, 1 = nada em comum. */
  changeRatio: number;
  charsBefore: number;
  charsAfter: number;
  /** Parágrafos acima do teto do carrossel (só `# Social` d1-d3). */
  overCapBefore: number;
  overCapAfter: number;
  vetoedBefore: number;
  vetoedAfter: number;
  factsAdded: string[];
  factsRemoved: string[];
}

/** Teto do `social-curto` (X/Threads), contado sobre o texto como escrito (placeholder `{edition_url}` incluso). */
export const CURTO_CHAR_CAP = 280;

/** Variação relativa de tamanho a partir da qual conta como encurtamento/expansão. */
export const LENGTH_CHANGE_THRESHOLD = 0.1;
/** Diferença líquida de marcadores (coloquial − formal) pra contar como mudança de tom. */
export const TONE_DELTA_THRESHOLD = 2;

export function classifyPair(pair: SectionPair): PairClassification {
  const before = pair.before ?? "";
  const after = pair.after ?? "";
  const pb = proseText(before);
  const pa = proseText(after);
  const carousel = pair.block === "social" && isDestaqueSection(pair.section);
  const overCap = (body: string) =>
    carousel ? proseParagraphs(body).filter((p) => p.length > DAILY_CAROUSEL_PARAGRAPH_CHAR_TARGET).length : 0;
  const fb = factTokens(pb);
  const fa = factTokens(pa);
  const out: PairClassification = {
    labels: [],
    changeRatio: before === after ? 0 : Number((1 - textSimilarity(pb, pa)).toFixed(2)),
    charsBefore: pb.length,
    charsAfter: pa.length,
    overCapBefore: overCap(before),
    overCapAfter: overCap(after),
    vetoedBefore: vetoedStructureCount(before),
    vetoedAfter: vetoedStructureCount(after),
    factsAdded: [...fa].filter((t) => !fb.has(t)),
    factsRemoved: [...fb].filter((t) => !fa.has(t)),
  };
  const labels = out.labels;
  if (pair.baselineSection) labels.push("reordenado");
  if (pair.sourceChanged) labels.push("fonte-trocada");
  if (before === after) {
    labels.push("identico");
    return out;
  }
  if (pb.length > 0 && pa.length < pb.length * (1 - LENGTH_CHANGE_THRESHOLD)) labels.push("encurtamento");
  if (pb.length > 0 && pa.length > pb.length * (1 + LENGTH_CHANGE_THRESHOLD)) labels.push("expansao");
  if (out.overCapBefore > out.overCapAfter) labels.push("estouro-teto-260");
  if (pair.block === "curto" && pb.length > CURTO_CHAR_CAP && pa.length <= CURTO_CHAR_CAP) labels.push("estouro-teto-280");
  const sb = sentences(pb);
  const sa = sentences(pa);
  if (sb.length && sa.length && norm(sb[0]) !== norm(sa[0])) labels.push("hook");
  if (sb.length > 1 && sa.length > 1 && norm(sb[sb.length - 1]) !== norm(sa[sa.length - 1])) labels.push("fechamento");
  if (sa.length < sb.length) labels.push("frase-removida");
  if (sa.length > sb.length) labels.push("frase-adicionada");
  if (hasCta(before) !== hasCta(after)) labels.push("cta");
  const rb = registerScore(pb);
  const ra = registerScore(pa);
  const toneDelta = ra.colloquial - ra.formal - (rb.colloquial - rb.formal);
  if (toneDelta >= TONE_DELTA_THRESHOLD) labels.push("tom-coloquial");
  if (toneDelta <= -TONE_DELTA_THRESHOLD) labels.push("tom-formal");
  if (out.vetoedBefore > out.vetoedAfter) labels.push("estrutura-vetada-removida");
  if (out.factsAdded.length || out.factsRemoved.length) labels.push("factual");
  const content = labels.filter((l) => l !== "reordenado" && l !== "fonte-trocada");
  if (content.length === 0) labels.push("outro");
  return out;
}

// ---------------------------------------------------------------------------
// Escolha do baseline (qual arquivo é "o texto do Stage 2")
// ---------------------------------------------------------------------------

/**
 * Arquivos intermediários do social em `_internal/`, na ordem em que a
 * pipeline os escreve. Usados só quando o snapshot `stage2-post-gate` não é
 * confiável (legado pré-#9356 ou capturado tarde).
 */
export const STAGE2_INTERMEDIATE_CANDIDATES = [
  "_internal/03-social-pre-humanizador.md",
  "_internal/03-social-post-humanizador.md",
  "_internal/03-clarice-corrected.md",
  "_internal/03-social-corrected.md",
] as const;

export interface BaselineCandidate {
  path: string;
  mtimeMs: number;
}

export type BaselineChoice =
  | { kind: "snapshot"; path: string; note: string }
  | { kind: "intermediate"; path: string; note: string }
  | { kind: "unrecoverable"; note: string };

/**
 * Decide o baseline. Pura.
 *
 * 1. snapshot `stage2-post-gate` com saúde `ok` (#9356: carimbado junto do sentinel) → ele;
 * 2. senão, o intermediário MAIS RECENTE cuja mtime ≤ `completed_at` do
 *    `.step-2-done.json` (+ folga) — heurística: escrito antes do fim do
 *    Stage 2 = saída da pipeline, antes do editor. Arquivo escrito depois é
 *    regeneração do Stage 4 e não serve;
 * 3. nada disso → irrecuperável.
 */
export function chooseBaseline(input: {
  snapshotPath: string;
  snapshotHealth: "ok" | "missing" | "late" | "legacy";
  step2CompletedAtMs: number | null;
  candidates: BaselineCandidate[];
  toleranceMs?: number;
}): BaselineChoice {
  if (input.snapshotHealth === "ok") {
    return { kind: "snapshot", path: input.snapshotPath, note: "snapshot carimbado no sentinel do Stage 2 (#9356)" };
  }
  if (input.step2CompletedAtMs !== null) {
    const limit = input.step2CompletedAtMs + (input.toleranceMs ?? 60_000);
    const eligible = input.candidates.filter((c) => c.mtimeMs <= limit).sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (eligible.length) {
      return {
        kind: "intermediate",
        path: eligible[0].path,
        note: `snapshot ${input.snapshotHealth}; aproximação pelo intermediário mais recente escrito até o fim do Stage 2 (mtime)`,
      };
    }
  }
  return {
    kind: "unrecoverable",
    note: `snapshot ${input.snapshotHealth} e nenhum intermediário do social escrito até o fim do Stage 2`,
  };
}

// ---------------------------------------------------------------------------
// Edição inteira + relatório
// ---------------------------------------------------------------------------

export interface MeasuredPair extends SectionPair {
  classification?: PairClassification;
}

export interface EditionMeasurement {
  edition: string;
  baselineSource: string;
  baselineNote?: string;
  approvedSource: string;
  /** `social-rewrite` gravados por `derive-editor-requests` (o que o auto-reporter contou). */
  loggedSocialRewrites: number;
  pairs: MeasuredPair[];
  namedSteps: NamedStep[];
}

export interface EditionInput {
  edition: string;
  baselineMd: string;
  approvedMd: string;
  baselineSource: string;
  baselineNote?: string;
  approvedSource: string;
  baselineUrls?: UrlMap;
  approvedUrls?: UrlMap;
  editorRequestsJsonl?: string;
  /** `_internal/03-social.pre-{tag}.md`, em ordem cronológica. */
  namedCheckpoints?: NamedCheckpoint[];
}

/** Conta linhas `social-rewrite` de um `editor-requests.jsonl` (linha malformada é ignorada). */
export function countLoggedSocialRewrites(jsonl: string | undefined): number {
  if (!jsonl) return 0;
  let n = 0;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      if ((JSON.parse(line) as { request_type?: string }).request_type === "social-rewrite") n++;
    } catch {
      // linha malformada — fora da contagem
    }
  }
  return n;
}

/** `{highlights:[{url|article.url}]}` → `d1/d2/d3 → url`. JSON inválido → mapa vazio. */
export function destaqueUrlMapFromApproved(json: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!json) return map;
  try {
    const parsed = JSON.parse(json) as { highlights?: Array<{ url?: string; article?: { url?: string } }> };
    (parsed.highlights ?? []).forEach((h, i) => {
      const url = h?.article?.url ?? h?.url;
      if (typeof url === "string" && url) map.set(`d${i + 1}`, url);
    });
  } catch {
    // fail-soft: sem mapa, o casamento cai pra similaridade
  }
  return map;
}

/**
 * Checkpoints nomeados que a sessão do Stage 4 grava antes de cada pedido do
 * editor (`_internal/03-social.pre-{tag}.md`, ex. `pre-factfix`, `pre-jev`,
 * `pre-kolibri` em 261005). Cada arquivo é o estado ANTES da mudança `tag`,
 * então a mudança `tag_i` = diff(checkpoint_i, checkpoint_{i+1} | aprovado).
 * Dá o MOTIVO declarado que a heurística não enxerga (ex.: o "hook" do d2 de
 * 261005 é a correção factual `factfix`). Comparação por (bloco, seção) pelo
 * NOME — num passo que reordena destaques, todas as seções reordenadas
 * aparecem como mudadas (honesto, não é casamento por URL).
 */
export interface NamedCheckpoint {
  tag: string;
  md: string;
}
export interface NamedStep {
  tag: string;
  changed: string[];
}
export function namedCheckpointSteps(checkpoints: NamedCheckpoint[], approvedMd: string): NamedStep[] {
  const key = (x: SocialSection) => `${x.block}/${x.section}`;
  const asMap = (m: string) => new Map(parseSocialSections(m).map((x) => [key(x), x.body]));
  return checkpoints.map((cp, i) => {
    const before = asMap(cp.md);
    const after = asMap(i + 1 < checkpoints.length ? checkpoints[i + 1].md : approvedMd);
    const keys = new Set([...before.keys(), ...after.keys()]);
    return { tag: cp.tag, changed: [...keys].filter((k) => before.get(k) !== after.get(k)) };
  });
}

export function measureEdition(input: EditionInput): EditionMeasurement {
  const pairs = matchSections(
    parseSocialSections(input.baselineMd),
    parseSocialSections(input.approvedMd),
    input.baselineUrls,
    input.approvedUrls,
  ).map((p): MeasuredPair => (p.kind === "mesma-historia" ? { ...p, classification: classifyPair(p) } : p));
  return {
    edition: input.edition,
    baselineSource: input.baselineSource,
    baselineNote: input.baselineNote,
    approvedSource: input.approvedSource,
    loggedSocialRewrites: countLoggedSocialRewrites(input.editorRequestsJsonl),
    pairs,
    namedSteps: input.namedCheckpoints?.length ? namedCheckpointSteps(input.namedCheckpoints, input.approvedMd) : [],
  };
}

/** Seção editada de verdade = mesma história, texto diferente (excluindo só reordenação). */
export function isRealRewrite(p: MeasuredPair): boolean {
  return p.kind === "mesma-historia" && !!p.classification && !p.classification.labels.includes("identico");
}

export interface Summary {
  logged: number;
  sections: number;
  identical: number;
  reordered: number;
  swapped: number;
  removed: number;
  rewritten: number;
  labelCounts: Record<string, number>;
}

export function summarize(ms: EditionMeasurement[]): Summary {
  const s: Summary = { logged: 0, sections: 0, identical: 0, reordered: 0, swapped: 0, removed: 0, rewritten: 0, labelCounts: {} };
  for (const m of ms) {
    s.logged += m.loggedSocialRewrites;
    for (const p of m.pairs) {
      if (p.kind === "historia-removida") {
        s.removed++;
        continue;
      }
      s.sections++;
      if (p.kind === "historia-trocada") s.swapped++;
      else if (p.classification?.labels.includes("identico")) s.identical++;
      if (p.baselineSection) s.reordered++;
      if (isRealRewrite(p)) {
        s.rewritten++;
        for (const l of p.classification!.labels) if (l !== "reordenado" && l !== "fonte-trocada") s.labelCounts[l] = (s.labelCounts[l] ?? 0) + 1;
      }
    }
  }
  return s;
}

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const clip = (s: string, n = 70) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function renderMarkdown(ms: EditionMeasurement[]): string {
  const lines: string[] = [];
  for (const m of ms) {
    lines.push(`### ${m.edition}`);
    lines.push("");
    lines.push(`- baseline (Stage 2): \`${m.baselineSource}\`${m.baselineNote ? ` — ${m.baselineNote}` : ""}`);
    lines.push(`- aprovado: \`${m.approvedSource}\``);
    lines.push(`- \`social-rewrite\` no editor-requests.jsonl: ${m.loggedSocialRewrites}`);
    lines.push("");
    lines.push("| bloco | seção | casamento | resultado | rótulos (heurística) | Δ palavras | chars | 1ª frase aprovada |");
    lines.push("|---|---|---|---|---|---|---|---|");
    for (const p of m.pairs) {
      const sec = p.baselineSection ? `${p.baselineSection}→${p.section}` : p.section;
      const c = p.classification;
      const result =
        p.kind !== "mesma-historia" ? p.kind : c!.labels.includes("identico") ? "idêntico" : "editado";
      const labels = c ? c.labels.filter((l) => l !== "identico").join(", ") : "";
      const facts = c && (c.factsAdded.length || c.factsRemoved.length)
        ? ` (+${c.factsAdded.join("/") || "∅"} −${c.factsRemoved.join("/") || "∅"})`
        : "";
      const chars = c ? `${c.charsBefore}→${c.charsAfter}` : "";
      const first = sentences(proseText(p.after ?? p.before ?? ""))[0] ?? "";
      lines.push(
        `| ${p.block} | ${sec} | ${p.matchedBy ?? "—"} | ${result} | ${cell(labels + facts)} | ${c ? c.changeRatio : "—"} | ${chars} | ${cell(clip(first))} |`,
      );
    }
    lines.push("");
    if (m.namedSteps.length) {
      lines.push("Checkpoints nomeados do Stage 4 (`_internal/03-social.pre-{tag}.md`) — motivo declarado de cada passo:");
      lines.push("");
      for (const st of m.namedSteps) lines.push(`- \`${st.tag}\`: ${st.changed.join(", ") || "(nenhuma seção mudou)"}`);
      lines.push("");
    }
  }
  const s = summarize(ms);
  lines.push("### Agregado");
  lines.push("");
  lines.push(`- \`social-rewrite\` registrados (o que o auto-reporter contou): **${s.logged}**`);
  lines.push(
    `- seções no aprovado: ${s.sections} — idênticas ao Stage 2: ${s.identical}; história/item trocado (texto novo, não reescrita): ${s.swapped}; editadas de fato: **${s.rewritten}**; reordenadas: ${s.reordered}; removidas do Stage 2: ${s.removed}`,
  );
  const ranked = Object.entries(s.labelCounts).sort((a, b) => b[1] - a[1]);
  lines.push(`- rótulos nas editadas: ${ranked.map(([l, n]) => `${l} ${n}`).join(" · ") || "—"}`);
  lines.push("");
  return lines.join("\n");
}

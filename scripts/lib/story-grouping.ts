/**
 * lib/story-grouping.ts (#9360, padrão 2)
 *
 * Agrupa coberturas da MESMA história no pool da edição (LANÇAMENTOS + RADAR,
 * entre buckets) e mantém só a fonte primária — as demais vão para os
 * descartados. Decisão do editor (briefing do overnight 261002, registrada na
 * #9360): "agrupar coberturas da mesma história na edição, mantendo a fonte
 * primária e mandando as demais pros descartados". SEM heurística por URL para
 * descartar página de produto/modelo (barraria lançamento com link oficial,
 * regra #160) — a URL aqui só decide QUEM é a primária dentro de um grupo
 * já formado por sinais de título, nunca se um item sai sozinho.
 *
 * Casos reais (cortados pelo editor no gate 4):
 *   - 260930/261001: "Anthropic launches Claude Sonnet 5.5 ..." (VentureBeat,
 *     RADAR) + "Introducing Claude Sonnet 5.5 on AWS" (aws.amazon.com, RADAR).
 *   - 261001: "OpenAI launches Dots ..." (VentureBeat) + "A OpenAI quer
 *     controlar seu PC: como funciona o 'dots' ..." (Exame), ambos RADAR.
 *   - 261001: "Após meses de atrasos, Google anuncia Argon ..." (CNN Brasil) +
 *     "Google unveils Gemini 4 Argon ..." (VentureBeat), ambos RADAR.
 *
 * O dedup item-vs-item já existente (`dedupSecondaryIntraBucket`, #4360/#4667)
 * só compara DENTRO de um bucket, por Jaccard (RADAR em modo strict), e escolhe
 * o sobrevivente por summary/model-card — não por fonte primária. Este passe
 * roda antes dele, cruza buckets e usa sinais de evento.
 *
 * Sinais de "mesma história" (qualquer um basta; todos conservadores):
 *   (1) `sameEvent` removível (A1/B) de lib/event-dedup.ts (#9249) — nome
 *       distintivo ("Dots", "Argon") ou ≥2 conceitos de evento + mesma empresa.
 *   (2) Mesmo MODELO VERSIONADO nos dois títulos ("Sonnet 5.5", "Gemini 4",
 *       "GPT-6.1") — família de modelo + número de versão. Duas matérias no
 *       mesmo pool diário citando a mesma versão exata são, na prática, a
 *       cobertura do mesmo lançamento.
 *   (3) Jaccard de título >= `STORY_GROUP_JACCARD_THRESHOLD` (0.45, o mesmo
 *       limiar intra-edição de `INTRA_JACCARD_THRESHOLD`).
 *
 * Fonte primária do grupo (decisão do editor): domínio OFICIAL do
 * laboratório/empresa DA HISTÓRIA quando houver; senão a de maior `score`.
 * Empate residual: com descrição > sem; post > model-card/hub (#4360);
 * ordem original (LANÇAMENTOS antes de RADAR).
 * "Da história" importa: aws.amazon.com é domínio oficial (da Amazon), mas
 * "Introducing Claude Sonnet 5.5 on AWS" não é a fonte primária do lançamento
 * da Anthropic. Por isso o oficial só vence quando a empresa do host aparece
 * no título de OUTRO membro do grupo (ou o `detection_keywords` da fonte
 * oficial casa com outro membro).
 *
 * Submissão do editor (`flag: "editor_submitted"`) nunca é removida (#4192/
 * #4695) e tem precedência como primária — a curadoria dele prevalece.
 *
 * Os descartados viram `cluster_sources[]` da primária (mesma semântica do
 * #3920/#4185 — o conteúdo não some, alimenta o "Aprofunde:").
 *
 * Pure, sem I/O.
 */

import { OFFICIAL_SOURCES } from "./official-domains.ts";
import { isOfficialLancamentoUrl } from "./launch-heuristics.ts";
import { sameEvent, companiesIn, EVENT_COMPANY_ALIASES } from "./event-dedup.ts";
import { tokenizeForJaccard, jaccardSimilarity } from "./title-similarity.ts";
import { canonicalize } from "./url-utils.ts";
import { toClusterSource, type ClusterSource, type ClusterArticle } from "./cluster-sources.ts";

/** Buckets do pool agrupados entre si (notícia/lançamento — tutorial e vídeo ficam fora). */
export const STORY_GROUP_BUCKETS: readonly string[] = ["lancamento", "radar"];

/** Mesmo limiar de `INTRA_JACCARD_THRESHOLD` (dedup-intra-edition.ts). */
export const STORY_GROUP_JACCARD_THRESHOLD = 0.45;

export interface StoryArticle {
  url: string;
  title?: string;
  score?: number;
  summary?: string;
  flag?: string;
  cluster_sources?: ClusterSource[];
  [key: string]: unknown;
}

export type StorySignal = "event" | "model_version" | "jaccard";

export interface StoryGroupRemoved {
  url: string;
  title?: string;
  bucket: string;
  /** URL da fonte primária que ficou. */
  kept_url: string;
  signal: StorySignal;
}

export interface StoryGroupResult {
  /** Buckets reescritos (só os de `STORY_GROUP_BUCKETS` presentes no input). */
  buckets: Record<string, StoryArticle[]>;
  removed: StoryGroupRemoved[];
}

const MODEL_FAMILIES = [
  "claude", "sonnet", "opus", "haiku",
  "gpt", "gemini", "gemma", "llama", "grok", "qwen", "deepseek",
  "mistral", "phi", "kimi", "glm", "nemotron",
];
const MODEL_VERSION_RE = new RegExp(
  `\\b(${MODEL_FAMILIES.join("|")})[\\s-]?v?(\\d+(?:\\.\\d+)?)(?![\\d.]*\\d)`,
  "g",
);

/**
 * Tokens "família versão" do título — "Claude Sonnet 5.5" → {"sonnet 5.5"},
 * "GPT-6.1 Sol" → {"gpt 6.1"}, "Gemini 4 Argon" → {"gemini 4"}.
 * "Claude for Chrome" (sem versão) → {}.
 */
export function modelVersionTokens(title: string): Set<string> {
  const norm = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  const out = new Set<string>();
  for (const m of norm.matchAll(MODEL_VERSION_RE)) out.add(`${m[1]} ${m[2]}`);
  return out;
}

/** Sinal de mesma história entre dois títulos, ou null. */
export function sameStorySignal(a: string, b: string): StorySignal | null {
  const ev = sameEvent(a, b);
  if (ev && ev.removable) return "event";
  const mvB = modelVersionTokens(b);
  for (const t of modelVersionTokens(a)) if (mvB.has(t)) return "model_version";
  if (jaccardSimilarity(tokenizeForJaccard(a), tokenizeForJaccard(b)) >= STORY_GROUP_JACCARD_THRESHOLD) {
    return "jaccard";
  }
  return null;
}

function hostOf(url: string): { host: string; full: string } {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return { host, full: host + u.pathname };
  } catch {
    return { host: "", full: "" };
  }
}

/** Empresas (normalizadas como em event-dedup) nomeadas pelos labels do host. */
function hostCompanies(host: string): Set<string> {
  const out = new Set<string>();
  for (const label of host.split(".")) {
    const c = EVENT_COMPANY_ALIASES[label];
    if (c) out.add(c);
  }
  return out;
}

/**
 * `url` é o domínio oficial do laboratório/empresa da história contada pelos
 * `otherTitles` (títulos dos DEMAIS membros do grupo)?
 */
export function isOfficialForStory(url: string, otherTitles: string[]): boolean {
  if (!isOfficialLancamentoUrl(url)) return false;
  const { host, full } = hostOf(url);
  const storyCompanies = new Set<string>();
  for (const t of otherTitles) for (const c of companiesIn(t)) storyCompanies.add(c);
  for (const c of hostCompanies(host)) if (storyCompanies.has(c)) return true;
  for (const src of OFFICIAL_SOURCES) {
    if (!src.detection_keywords) continue;
    const hit = (src.domains ?? []).includes(host) || (src.path_patterns ?? []).some((p) => p.test(full));
    if (hit && otherTitles.some((t) => src.detection_keywords!.test(t))) return true;
  }
  return false;
}

interface Member {
  bucket: string;
  index: number;
  order: number;
  art: StoryArticle;
}

/**
 * Agrupa coberturas da mesma história entre `STORY_GROUP_BUCKETS` e devolve
 * os buckets só com a primária de cada grupo (+ submissões do editor).
 * Pure: não muta `input` (a primária enriquecida é um clone).
 */
export function groupSameStory(
  input: Record<string, unknown>,
  options: {
    /** Desempate final (#4360): página de model-card/hub perde para post com
     *  descrição. Injetado pelo caller (`isModelCardOrHubPage` vive em
     *  dedup-intra-edition.ts, que importa este módulo). */
    isModelCard?: (url: string) => boolean;
  } = {},
): StoryGroupResult {
  const isModelCard = options.isModelCard ?? (() => false);
  const members: Member[] = [];
  for (const bucket of STORY_GROUP_BUCKETS) {
    const arr = input[bucket];
    if (!Array.isArray(arr)) continue;
    (arr as StoryArticle[]).forEach((art, index) => {
      members.push({ bucket, index, order: members.length, art });
    });
  }

  // Agrupamento em ESTRELA ao redor de candidatos a primária (não single-
  // linkage): um item só entra num grupo se casar com o item-âncora dele.
  // Single-linkage encadeava histórias diferentes via roundup ("[AINews]
  // DevDay: Dots, 6.1 Sol, ...") que cita várias — calibração 261001.
  // Âncoras em ordem de prioridade: editor > URL oficial > score > ordem.
  const prio = (m: Member) => [
    m.art.flag === "editor_submitted" ? 1 : 0,
    isOfficialLancamentoUrl(m.art.url) ? 1 : 0,
    typeof m.art.score === "number" ? m.art.score : -Infinity,
  ];
  const byPrio = [...members].sort((x, y) => {
    const px = prio(x);
    const py = prio(y);
    return py[0] - px[0] || py[1] - px[1] || py[2] - px[2] || x.order - y.order;
  });
  const groupsList: Member[][] = [];
  const signalOf = new Map<number, StorySignal>(); // member.order → sinal
  for (const m of byPrio) {
    let placed = false;
    if (m.art.title) {
      for (const g of groupsList) {
        const anchor = g[0];
        if (!anchor.art.title) continue;
        // Mesma URL em 2 buckets não é "outra cobertura" — fica como está.
        if (canonicalize(anchor.art.url) === canonicalize(m.art.url)) continue;
        const sig = sameStorySignal(anchor.art.title, m.art.title);
        if (!sig) continue;
        g.push(m);
        signalOf.set(m.order, sig);
        placed = true;
        break;
      }
    }
    if (!placed) groupsList.push([m]);
  }
  const groups = groupsList;

  const drop = new Set<number>(); // member.order
  const replace = new Map<number, StoryArticle>(); // member.order → clone enriquecido
  const removed: StoryGroupRemoved[] = [];

  for (const group of groups) {
    const distinctUrls = new Set(group.map((m) => canonicalize(m.art.url)));
    if (distinctUrls.size < 2) continue;

    const rank = (m: Member) => {
      const others = group.filter((o) => o !== m).map((o) => o.art.title ?? "");
      return {
        editor: m.art.flag === "editor_submitted" ? 1 : 0,
        official: isOfficialForStory(m.art.url, others) ? 1 : 0,
        score: typeof m.art.score === "number" ? m.art.score : -Infinity,
        // Empate de oficial/score: mesmo desempate do item-vs-item (#4360) —
        // com descrição > sem; post > model-card/hub.
        summary: typeof m.art.summary === "string" && m.art.summary.trim() ? 1 : 0,
        notCard: isModelCard(m.art.url) ? 0 : 1,
      };
    };
    const ranked = group
      .map((m) => ({ m, r: rank(m) }))
      .sort(
        (x, y) =>
          y.r.editor - x.r.editor ||
          y.r.official - x.r.official ||
          y.r.score - x.r.score ||
          y.r.summary - x.r.summary ||
          y.r.notCard - x.r.notCard ||
          x.m.order - y.m.order,
      );
    const primary = ranked[0].m;
    const primaryCanon = canonicalize(primary.art.url);

    const losers = group.filter(
      (m) =>
        m !== primary &&
        m.art.flag !== "editor_submitted" &&
        canonicalize(m.art.url) !== primaryCanon,
    );
    if (losers.length === 0) continue;

    const existing = Array.isArray(primary.art.cluster_sources) ? primary.art.cluster_sources : [];
    const sources = [...existing];
    for (const l of losers) {
      if (!sources.some((c) => c.url === l.art.url)) {
        sources.push(toClusterSource(l.art as unknown as ClusterArticle));
      }
      drop.add(l.order);
      removed.push({
        url: l.art.url,
        title: l.art.title,
        bucket: l.bucket,
        kept_url: primary.art.url,
        signal: signalOf.get(l.order) ?? "event",
      });
    }
    replace.set(primary.order, { ...primary.art, cluster_sources: sources });
  }

  const buckets: Record<string, StoryArticle[]> = {};
  for (const bucket of STORY_GROUP_BUCKETS) {
    if (!Array.isArray(input[bucket])) continue;
    buckets[bucket] = members
      .filter((m) => m.bucket === bucket && !drop.has(m.order))
      .map((m) => replace.get(m.order) ?? m.art);
  }
  return { buckets, removed };
}

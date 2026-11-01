/**
 * study-source-recurrence.ts (#11763)
 *
 * Item NOVO que é cobertura secundária (imprensa) de um estudo/relatório que a
 * diar.ia.br já publicou, com URL e redação diferentes. Caso 261103: RADAR
 * trouxe "IA trabalha seis vezes mais que humanos" (CNN Brasil, "Estudo
 * interno da Anthropic…") e o relatório da Anthropic já tinha saído em 261020,
 * D1 ("…em agosto, os agentes de IA dos funcionários somavam seis vezes as
 * horas dos humanos"). URL, `fact-recurrence`, `story-twice` e tema passaram
 * limpos: a URL é nova e nenhum deles compara "mesmo relatório".
 *
 * Evidência exigida dos DOIS lados (precisão antes de recall — falso positivo
 * derruba item legítimo): (1) mesma entidade publicadora, (2) menção a
 * estudo/relatório/pesquisa, (3) número-chave compartilhado — uma razão
 * ("6x") ou ao menos 2 percentuais. Publicador sozinho, ou "estudo da
 * Anthropic" com números diferentes, NÃO casa. Pure, sem I/O; só sinaliza, o
 * editor decide no gate (warn-only).
 */
import { canonicalize } from "./url-utils.ts";

export interface StudyItem {
  label: string;
  title: string;
  url: string;
  summary?: string;
}

export interface PastStudyItem extends StudyItem {
  aammdd: string;
}

export interface StudyRecurrenceWarning {
  item_label: string;
  item_title: string;
  item_url: string;
  matched_edition: string;
  matched_label: string;
  matched_title: string;
  publisher: string;
  shared_numbers: string[];
}

/** Publicadores de estudo/relatório recorrentes na pauta (extensível). */
const PUBLISHERS = [
  "anthropic", "openai", "deepmind", "google", "microsoft", "meta", "nvidia", "amazon", "apple",
  "stanford", "mit", "harvard", "oxford", "mckinsey", "gartner", "deloitte", "pwc", "bcg",
  "forrester", "idc", "pew", "metr", "epoch", "imf", "fmi", "oecd", "ocde",
];

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const DOC_RE = /\b(estudo|estudos|relatorio|relatorios|pesquisa|levantamento|study|report|survey|paper)\b/;

const WORD_NUM: Record<string, string> = {
  duas: "2", dois: "2", tres: "3", quatro: "4", cinco: "5", seis: "6", sete: "7", oito: "8", nove: "9", dez: "10",
  two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

export function detectPublishers(text: string): Set<string> {
  const t = norm(text);
  return new Set(PUBLISHERS.filter((p) => new RegExp(`(?<![\\p{L}-])${p}(?![\\p{L}-])`, "u").test(t)));
}

/** Razões ("6x") e percentuais ("27%") citados no texto. */
export function extractKeyNumbers(text: string): { ratios: Set<string>; percents: Set<string> } {
  const t = norm(text);
  const ratios = new Set<string>();
  const percents = new Set<string>();
  for (const m of t.matchAll(/\b(\d+(?:[.,]\d+)?|[a-z]+)\s*(?:x\b|vezes\b|times\b)/g)) {
    const n = /^\d/.test(m[1]) ? m[1].replace(",", ".") : WORD_NUM[m[1]];
    if (n && Number(n) >= 2 && Number(n) <= 100) ratios.add(`${Number(n)}x`);
  }
  for (const m of t.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(?:%|por cento\b)/g)) percents.add(`${Number(m[1].replace(",", "."))}%`);
  return { ratios, percents };
}

/** Domínios próprios por publicador quando o rótulo difere do nome (extensível). */
const HOST_ALIASES: Record<string, string[]> = {
  google: ["withgoogle"], deepmind: ["google"], meta: ["facebook", "fb"], microsoft: ["msft"],
  amazon: ["aws"], mit: [], fmi: ["imf"], ocde: ["oecd"],
};

function hostLabels(url: string): string[] {
  try {
    return new URL(url).hostname.toLowerCase().split(".");
  } catch {
    return [];
  }
}

/** Compara por RÓTULO do host (anthropic.com sim; metropoles.com.br não é "meta"). */
function hostMentions(url: string, publisher: string): boolean {
  const labels = hostLabels(url);
  return labels.includes(publisher) || (HOST_ALIASES[publisher] ?? []).some((a) => labels.includes(a));
}

/**
 * Para cada item novo, o 1º item passado que cobre o MESMO relatório-fonte.
 * No máximo 1 aviso por item. Item cuja URL é do próprio publicador (fonte
 * primária) fica de fora — repetição de URL é problema de outro check.
 */
export function findStudySourceRecurrences(items: StudyItem[], past: PastStudyItem[]): StudyRecurrenceWarning[] {
  const prepared = past.map((p) => {
    const text = `${p.title}\n${p.summary ?? ""}`;
    return { p, text, pubs: new Set([...detectPublishers(text), ...PUBLISHERS.filter((pb) => hostMentions(p.url, pb))]), doc: DOC_RE.test(norm(text)), nums: extractKeyNumbers(text) };
  });
  const out: StudyRecurrenceWarning[] = [];
  for (const it of items) {
    const text = `${it.title}\n${it.summary ?? ""}`;
    if (!DOC_RE.test(norm(text))) continue;
    const pubs = detectPublishers(text);
    if (pubs.size === 0) continue;
    const nums = extractKeyNumbers(text);
    if (nums.ratios.size === 0 && nums.percents.size < 2) continue;
    hit: for (const c of prepared) {
      if (!c.doc || canonicalize(c.p.url) === canonicalize(it.url)) continue;
      for (const pub of pubs) {
        if (!c.pubs.has(pub) || hostMentions(it.url, pub)) continue;
        const ratios = [...nums.ratios].filter((r) => c.nums.ratios.has(r));
        const percents = [...nums.percents].filter((r) => c.nums.percents.has(r));
        if (ratios.length === 0 && percents.length < 2) continue;
        out.push({
          item_label: it.label, item_title: it.title, item_url: it.url,
          matched_edition: c.p.aammdd, matched_label: c.p.label, matched_title: c.p.title,
          publisher: pub, shared_numbers: [...ratios, ...percents],
        });
        break hit;
      }
    }
  }
  return out;
}

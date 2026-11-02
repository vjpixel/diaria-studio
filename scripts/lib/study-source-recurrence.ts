/**
 * study-source-recurrence.ts (#11763)
 *
 * Item NOVO que é cobertura secundária (imprensa) de um estudo/relatório que a
 * diar.ia.br já publicou, com URL e redação diferentes. Caso real 261103: o
 * RADAR trouxe "IA trabalha seis vezes mais que humanos" (CNN Brasil, "Estudo
 * interno da Anthropic…"), e o relatório da Anthropic já tinha saído no D1 de
 * 261020 ("…os agentes de IA dos funcionários já somavam seis vezes mais
 * horas…"). URL, `fact-recurrence`, `story-twice-in-edition` e o passe de tema
 * passaram limpos: a URL é nova e nenhum deles compara "mesmo relatório".
 *
 * Heurística determinística, sem LLM. Evidência exigida dos DOIS lados
 * (precisão antes de recall: o aviso pede corte, e falso positivo empurra o
 * editor a derrubar item legítimo):
 *   1. mesma entidade publicadora (lista curada abaixo, por nome no texto ou,
 *      no item passado, pelo host da URL);
 *   2. menção a um documento (estudo/relatório/pesquisa/levantamento/report…);
 *   3. número-chave em comum: uma razão ("6x", "seis vezes") ou pelo menos 2
 *      percentuais.
 * Publicador sozinho, ou "estudo da Anthropic" com números diferentes, não
 * casa. Item cuja URL é do próprio publicador (fonte primária) fica de fora:
 * repetir a fonte primária é caso de dedup de URL/tema, não deste check.
 *
 * Só sinaliza (warn-only): Stage 1 grava em `01-highlight-theme-check.json →
 * study_source_warnings`, Stage 4 roda a invariante `study-source-recurrence`
 * sobre o `02-reviewed.md` final. O editor decide no gate; nada é removido.
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
  matched_url: string;
  publisher: string;
  shared_numbers: string[];
}

/** Janela (dias) de edições passadas consideradas, pedida na issue (~30 dias). */
export const STUDY_RECURRENCE_WINDOW_DAYS = 30;

interface Publisher {
  id: string;
  /** Regex sobre o texto SEM acento, com caixa preservada. */
  re: RegExp;
  /** Rótulos de host que identificam a fonte primária (anthropic.com → "anthropic"). */
  hosts: string[];
}

// Nomes inequívocos casam em qualquer caixa; os que também são palavra comum
// em português ("meta" = objetivo, "epoch") ou sigla curta ("MIT", "IDC")
// exigem a grafia própria, para "a meta de 50%" não virar a Meta.
const B = "(?<![\\p{L}\\p{N}-])";
const E = "(?![\\p{L}\\p{N}-])";
const ci = (name: string) => new RegExp(`${B}${name}${E}`, "iu");
const cs = (name: string) => new RegExp(`${B}${name}${E}`, "u");

const PUBLISHERS: Publisher[] = [
  { id: "anthropic", re: ci("anthropic"), hosts: ["anthropic", "claude"] },
  { id: "openai", re: ci("openai"), hosts: ["openai", "chatgpt"] },
  { id: "deepmind", re: ci("deepmind"), hosts: ["deepmind"] },
  { id: "google", re: ci("google"), hosts: ["google", "withgoogle", "blog.google"] },
  { id: "microsoft", re: ci("microsoft"), hosts: ["microsoft", "msft"] },
  { id: "meta", re: cs("Meta"), hosts: ["meta", "facebook", "fb"] },
  { id: "nvidia", re: ci("nvidia"), hosts: ["nvidia"] },
  { id: "amazon", re: ci("amazon"), hosts: ["amazon", "aws", "aboutamazon"] },
  { id: "apple", re: cs("Apple"), hosts: ["apple"] },
  { id: "stanford", re: ci("stanford"), hosts: ["stanford"] },
  { id: "mit", re: cs("MIT"), hosts: ["mit"] },
  { id: "harvard", re: ci("harvard"), hosts: ["harvard"] },
  { id: "oxford", re: ci("oxford"), hosts: ["ox", "oxford"] },
  { id: "mckinsey", re: ci("mckinsey"), hosts: ["mckinsey"] },
  { id: "gartner", re: ci("gartner"), hosts: ["gartner"] },
  { id: "deloitte", re: ci("deloitte"), hosts: ["deloitte"] },
  { id: "pwc", re: cs("PwC|PWC"), hosts: ["pwc"] },
  { id: "bcg", re: cs("BCG"), hosts: ["bcg"] },
  { id: "forrester", re: ci("forrester"), hosts: ["forrester"] },
  { id: "idc", re: cs("IDC"), hosts: ["idc"] },
  { id: "pew", re: cs("Pew"), hosts: ["pewresearch"] },
  { id: "metr", re: cs("METR"), hosts: ["metr"] },
  { id: "epoch", re: cs("Epoch AI|Epoch"), hosts: ["epochai", "epoch"] },
  { id: "fmi", re: cs("FMI|IMF"), hosts: ["imf"] },
  { id: "ocde", re: cs("OCDE|OECD"), hosts: ["oecd"] },
];

const stripAccents = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");
const norm = (s: string) => stripAccents(s).toLowerCase();

const DOC_RE = /(?<![\p{L}])(estudos?|relatorios?|pesquisas?|levantamentos?|studies|study|reports?|surveys?|papers?)(?![\p{L}])/u;

const WORD_NUM: Record<string, string> = {
  duas: "2", dois: "2", tres: "3", quatro: "4", cinco: "5", seis: "6", sete: "7", oito: "8", nove: "9", dez: "10",
  two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
};

/** Publicadores citados no texto (por nome). */
export function detectPublishers(text: string): Set<string> {
  const t = stripAccents(text);
  return new Set(PUBLISHERS.filter((p) => p.re.test(t)).map((p) => p.id));
}

/** Razões ("6x", "seis vezes") e percentuais ("27%") citados no texto. */
export function extractKeyNumbers(text: string): { ratios: Set<string>; percents: Set<string> } {
  const t = norm(text);
  const ratios = new Set<string>();
  const percents = new Set<string>();
  for (const m of t.matchAll(/(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?|\p{L}+)\s*(?:x(?![\p{L}\p{N}])|vezes(?!\p{L})|times(?!\p{L}))/gu)) {
    const n = /^\d/.test(m[1]) ? m[1].replace(",", ".") : WORD_NUM[m[1]];
    if (n && Number(n) >= 2 && Number(n) <= 100) ratios.add(`${Number(n)}x`);
  }
  for (const m of t.matchAll(/(?<![\p{N}])(\d+(?:[.,]\d+)?)\s*(?:%|por cento(?!\p{L}))/gu)) {
    percents.add(`${Number(m[1].replace(",", "."))}%`);
  }
  return { ratios, percents };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** A URL é do próprio publicador? Compara por RÓTULO do host (metropoles.com não é "meta"). */
export function isPublisherHost(url: string, publisherId: string): boolean {
  const pub = PUBLISHERS.find((p) => p.id === publisherId);
  if (!pub) return false;
  const host = hostOf(url);
  if (!host) return false;
  const labels = host.split(".");
  return pub.hosts.some((h) => (h.includes(".") ? host === h || host.endsWith(`.${h}`) : labels.includes(h)));
}

const textOf = (it: StudyItem) => `${it.title}\n${it.summary ?? ""}`;

/**
 * Para cada item novo, o 1º item passado que cobre o MESMO relatório-fonte
 * (no máximo 1 aviso por item). Pura, sem I/O.
 */
export function findStudySourceRecurrences(items: StudyItem[], past: PastStudyItem[]): StudyRecurrenceWarning[] {
  const prepared = past
    .map((p) => {
      const text = textOf(p);
      const pubs = detectPublishers(text);
      for (const pb of PUBLISHERS) if (isPublisherHost(p.url, pb.id)) pubs.add(pb.id);
      return { p, pubs, doc: DOC_RE.test(norm(text)), nums: extractKeyNumbers(text) };
    })
    .filter((c) => c.doc && c.pubs.size > 0);
  const out: StudyRecurrenceWarning[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const key = canonicalize(it.url);
    if (seen.has(key)) continue;
    const text = textOf(it);
    if (!DOC_RE.test(norm(text))) continue;
    const pubs = [...detectPublishers(text)].filter((pb) => !isPublisherHost(it.url, pb));
    if (pubs.length === 0) continue;
    const nums = extractKeyNumbers(text);
    if (nums.ratios.size === 0 && nums.percents.size < 2) continue;
    hit: for (const c of prepared) {
      if (canonicalize(c.p.url) === key) continue;
      for (const pub of pubs) {
        if (!c.pubs.has(pub)) continue;
        const ratios = [...nums.ratios].filter((r) => c.nums.ratios.has(r));
        const percents = [...nums.percents].filter((r) => c.nums.percents.has(r));
        if (ratios.length === 0 && percents.length < 2) continue;
        seen.add(key);
        out.push({
          item_label: it.label, item_title: it.title, item_url: it.url,
          matched_edition: c.p.aammdd, matched_label: c.p.label, matched_title: c.p.title, matched_url: c.p.url,
          publisher: pub, shared_numbers: [...ratios, ...percents],
        });
        break hit;
      }
    }
  }
  return out;
}

/** Linha de aviso (🚨) comum ao Stage 1 e ao Stage 4. */
export function formatStudySourceWarning(w: StudyRecurrenceWarning): string {
  return `🚨 Mesmo estudo/relatório já publicado: [${w.item_label}] “${w.item_title}” (${w.item_url}) cobre o relatório de ${w.publisher} já publicado em ${w.matched_edition} (${w.matched_label} “${w.matched_title}”; números em comum: ${w.shared_numbers.join(", ")}). Cortar no gate, salvo fato novo.`;
}

function collectUrls(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectUrls(n, out);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "url" && typeof v === "string" && v) out.add(canonicalize(v));
      else collectUrls(v, out);
    }
  }
}

/**
 * Notas do relatório do Stage 1 (`stage-1-run.ts`, `--no-gates`): uma linha por
 * `study_source_warnings[]` de `01-highlight-theme-check.json` cujo item segue
 * em `01-approved.json` (destaque ou qualquer bucket). Pura e fail-soft: shape
 * inesperada → lista vazia.
 */
export function formatStudySourceNotes(themeCheck: unknown, approved: unknown): string[] {
  if (!themeCheck || typeof themeCheck !== "object") return [];
  const warnings = (themeCheck as { study_source_warnings?: unknown }).study_source_warnings;
  if (!Array.isArray(warnings)) return [];
  const inApproved = new Set<string>();
  collectUrls(approved, inApproved);
  const out: string[] = [];
  for (const w of warnings) {
    if (!w || typeof w !== "object") continue;
    const ww = w as Partial<StudyRecurrenceWarning>;
    if (typeof ww.item_url !== "string" || !inApproved.has(canonicalize(ww.item_url))) continue;
    out.push(formatStudySourceWarning({
      item_label: String(ww.item_label ?? "?"), item_title: String(ww.item_title ?? ""), item_url: ww.item_url,
      matched_edition: String(ww.matched_edition ?? "?"), matched_label: String(ww.matched_label ?? "?"),
      matched_title: String(ww.matched_title ?? ""), matched_url: String(ww.matched_url ?? ""),
      publisher: String(ww.publisher ?? "?"), shared_numbers: Array.isArray(ww.shared_numbers) ? ww.shared_numbers.map(String) : [],
    }));
  }
  return out;
}

/**
 * youtube-capa-hooks.ts (#12737) — miolo puro da sugestão de texto de capa
 * (o "gancho") do vídeo "diar.ia.br comentada".
 *
 * Até o #12737 o Passo A2 do `/diaria-publica` mandava "2 a 4 palavras do D1,
 * pergunta ou tensão" e o gancho saía sem apoio: na prática sempre 2 palavras e
 * uma interrogação, e o editor só via o texto na capa pronta (261111: "IA
 * demitiu?" recusado, "Ensinaram a IA e foram demitidos" aprovado). A diretriz
 * nova e o benchmark que a sustenta estão em `docs/youtube-capa-texto.md`.
 *
 * O que este módulo faz, sem I/O:
 *   - `scoreCapaHook`: confere um candidato contra a diretriz (tamanho,
 *     repetição do título, jargão, número, nome próprio, forma) e devolve
 *     pontuação 0-100, faixa de potencial e os motivos;
 *   - `seedCapaHooks`: sementes mecânicas tiradas do D1 (número saliente,
 *     nome próprio) para completar a lista que o agente escreve;
 *   - `rankCapaHooks`: ordena, garantindo pergunta e afirmação no topo;
 *   - `horizontalHookArg`/`shortHookArg`: o `--hook` pronto para o
 *     `gen-youtube-thumb.ts` de cada formato, ou o motivo de não caber;
 *   - `joinHookHistory`: cruza os ganchos registrados com as views do
 *     `data/youtube-analytics/videos.jsonl`.
 *
 * A pontuação é HEURÍSTICA, não previsão de CTR: a amostra do canal é pequena
 * (54 inscritos, 25 vídeos em 10/11/2026) e as fontes externas são blogs de
 * marketing. Ela ordena a lista que o editor vê; quem escolhe é ele.
 *
 * I/O (ler `02-reviewed.md`, gravar o registro) fica no CLI
 * `scripts/suggest-capa-hooks.ts`.
 */

import { normalizeShortCoverHook, splitHook } from "./youtube-thumb.ts";
import { contentWords, extractProperNouns } from "./youtube-title-research.ts";

export const CAPA_HOOKS_RECORD_FILE = "_internal/youtube-capa-hooks.json";
export const CAPA_HOOKS_SCHEMA_VERSION = 1;

/**
 * Faixa da diretriz (#12737): 2 a 6 palavras no total, alvo 3 a 6. O teto do
 * alvo é 6 e não 5 (o que os blogs dizem) porque o único gancho aprovado
 * explicitamente pelo editor depois da queixa tem 6 ("Ensinaram a IA e foram
 * demitidos", 261111, em 2 linhas).
 */
export const CAPA_HOOK_MIN_WORDS = 2;
export const CAPA_HOOK_MAX_WORDS = 6;
export const CAPA_HOOK_TARGET_MIN = 3;
export const CAPA_HOOK_TARGET_MAX = 6;
/** Acima disto o texto fica pequeno demais no celular (miniatura de ~240 px de largura). */
export const CAPA_HOOK_MAX_CHARS = 34;
/** Fração das palavras de conteúdo do gancho que já estão no título a partir da qual é repetição. */
export const TITLE_OVERLAP_LIMIT = 0.6;

/**
 * Jargão que o público da diária não lê de relance numa miniatura. Lista
 * curta e conservadora: marca conhecida (ChatGPT, Google) não entra aqui.
 */
export const CAPA_JARGON = [
  "llm", "llms", "agêntico", "agêntica", "agênticos", "agênticas", "agente", "agentes", "modelo", "modelos",
  "benchmark", "benchmarks", "parâmetros", "token", "tokens", "inferência", "fine-tuning", "open-source",
  "multimodal", "framework", "api", "gpu", "gpus", "startup", "big", "tech", "bigtech",
];

/**
 * Nomes que o público reconhece sem contexto. Nome próprio fora desta lista
 * não pontua (pesquisador, startup pequena), mas também não é penalizado.
 */
export const CAPA_KNOWN_NAMES = [
  "google", "openai", "chatgpt", "meta", "instagram", "whatsapp", "facebook", "microsoft", "apple", "iphone",
  "amazon", "nvidia", "tesla", "musk", "gemini", "claude", "anthropic", "youtube", "tiktok", "x", "netflix",
  "brasil", "stf", "anatel", "pix", "photos", "copilot", "siri", "alexa", "uber", "ifood", "nubank",
];

export type CapaHookForm = "pergunta" | "afirmação";
export type CapaHookOrigin = "agente" | "semente";
export type CapaPotential = "alto" | "médio" | "baixo";

export interface CapaD1 {
  title: string;
  /** Corpo do D1 (parágrafos antes do "Por que isso importa"), para achar número e nome. */
  body?: string;
}

export interface CapaHookScore {
  hook: string;
  origin: CapaHookOrigin;
  form: CapaHookForm;
  words: number;
  chars: number;
  score: number;
  potential: CapaPotential;
  /** Regra da diretriz quebrada: o candidato não deve ir para a capa. */
  violations: string[];
  /** Pontos a favor e contra, em português, para o editor. */
  notes: string[];
  /** `--hook` pronto para a capa horizontal, ou `null` (motivo em `horizontal_reason`). */
  horizontal_hook: string | null;
  horizontal_reason: string | null;
  /** `--hook` pronto para a capa do Short (2 a 5 palavras, #12462), ou `null`. */
  short_hook: string | null;
  short_reason: string | null;
}

const LINE_BREAK_RE = /\r?\n|\\n|\|/;

/** Palavras com a mesma contagem dos scripts de capa: moeda + número = 1 token (#12278). */
export function capaHookWords(hook: string): string[] {
  return hook
    .split(LINE_BREAK_RE)
    .join(" ")
    .replace(/(^|\s)((?:[A-Z]{1,3}\$|\p{Sc}))\s+(?=\d)/gu, "$1$2")
    .replace(/[?!.…]+$/u, "")
    .split(/\s+/)
    .filter(Boolean);
}

function flatHook(hook: string): string {
  return hook.split(LINE_BREAK_RE).map((l) => l.trim()).filter(Boolean).join(" ");
}

function lowerWords(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}$]+/u).filter(Boolean);
}

/**
 * `--hook` da capa horizontal: o próprio gancho quando cabe em 1 linha (até 4
 * palavras), senão quebra equilibrada em 2 linhas (até 4 por linha, #11740).
 */
export function horizontalHookArg(hook: string): { hook: string | null; reason: string | null } {
  const tryIt = (h: string): string | null => {
    try {
      splitHook(h);
      return h;
    } catch {
      return null;
    }
  };
  const direct = tryIt(hook);
  if (direct) return { hook: direct, reason: null };
  const lines = hook.split(LINE_BREAK_RE).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 1) {
    const tokens = lines[0].split(/\s+/).filter(Boolean);
    const cut = Math.ceil(tokens.length / 2);
    const broken = tryIt(`${tokens.slice(0, cut).join(" ")}|${tokens.slice(cut).join(" ")}`);
    if (broken) return { hook: broken, reason: null };
  }
  try {
    splitHook(hook);
  } catch (err) {
    return { hook: null, reason: (err as Error).message };
  }
  return { hook: null, reason: "não cabe nas regras da capa horizontal" };
}

/** `--hook` da capa do Short (2 a 5 palavras, #12462). */
export function shortHookArg(hook: string): { hook: string | null; reason: string | null } {
  try {
    return { hook: normalizeShortCoverHook(hook), reason: null };
  } catch (err) {
    return { hook: null, reason: (err as Error).message };
  }
}

const NUMBER_RE = /(?:(?:R|US)\$\s?)?\d+(?:[.,]\d+)?\s?(?:%|mil\b|milhões\b|milhão\b|bilhões\b|bilhão\b|trilhões\b|trilhão\b)?/giu;

/** Números que valem gancho: com moeda, percentual ou ordem de grandeza (não "2026", não "3"). */
export function salientNumbers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const raw = m[0].trim().replace(/\s+/g, " ");
    const hasUnit = /\$|%|mil|milh|bilh|trilh/iu.test(raw);
    if (!hasUnit) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** Pure: pontua um candidato contra a diretriz (#12737). */
export function scoreCapaHook(rawHook: string, d1: CapaD1, origin: CapaHookOrigin = "agente"): CapaHookScore {
  const hook = rawHook.replace(/\s+/g, " ").trim();
  const flat = flatHook(hook);
  const words = capaHookWords(hook).length;
  const chars = Array.from(flat).length;
  const form: CapaHookForm = flat.endsWith("?") ? "pergunta" : "afirmação";
  const violations: string[] = [];
  const notes: string[] = [];
  let score = 50;

  if (words < CAPA_HOOK_MIN_WORDS || words > CAPA_HOOK_MAX_WORDS) {
    violations.push(`${words} palavra(s); a diretriz é ${CAPA_HOOK_MIN_WORDS} a ${CAPA_HOOK_MAX_WORDS}`);
  } else if (words >= CAPA_HOOK_TARGET_MIN && words <= CAPA_HOOK_TARGET_MAX) {
    score += 15;
    notes.push(`${words} palavras, no alvo de ${CAPA_HOOK_TARGET_MIN} a ${CAPA_HOOK_TARGET_MAX}`);
  } else {
    score += 5;
    notes.push(`${words} palavras, dentro da faixa mas fora do alvo de ${CAPA_HOOK_TARGET_MIN} a ${CAPA_HOOK_TARGET_MAX}`);
  }
  if (chars > CAPA_HOOK_MAX_CHARS) {
    score -= 15;
    notes.push(`${chars} caracteres: fica pequeno no celular (teto ${CAPA_HOOK_MAX_CHARS})`);
  }

  if (/[→←⇒➜]/u.test(flat)) violations.push("seta no texto (#9721)");
  if (/\p{Extended_Pictographic}/u.test(flat)) violations.push("emoji no texto");
  if (/(\.\.\.|…)\s*\??$/u.test(flat)) {
    score -= 10;
    notes.push("reticências no fim: promessa vaga, prefira a consequência concreta");
  }
  const letters = flat.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) {
    score -= 10;
    notes.push("tudo em maiúsculas: a capa usa Georgia em caixa normal");
  }
  if ((flat.match(/\?/g) ?? []).length > 1 || /!\s*$/u.test(flat)) {
    score -= 5;
    notes.push("pontuação de exagero (mais de um ? ou ! no fim)");
  }

  // Repetição do título: a capa complementa, não repete.
  const hookContent = contentWords(flat);
  const titleContent = new Set(contentWords(d1.title));
  const titleFlat = d1.title.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const hookFlatLower = flat.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  if (hookFlatLower.length > 0 && titleFlat.includes(hookFlatLower) && words >= 3) {
    violations.push("é um trecho literal do título do D1: a capa precisa dizer outra coisa");
  } else if (hookContent.length > 0) {
    const overlap = hookContent.filter((w) => titleContent.has(w)).length / hookContent.length;
    if (overlap >= TITLE_OVERLAP_LIMIT) {
      score -= 20;
      notes.push(`repete o título (${Math.round(overlap * 100)}% das palavras de conteúdo)`);
    } else if (overlap === 0) {
      score += 10;
      notes.push("complementa o título sem repetir palavras");
    } else {
      score += 5;
    }
  }

  const lw = lowerWords(flat);
  const jargon = lw.filter((w) => CAPA_JARGON.includes(w));
  if (jargon.length > 0) {
    score -= 15 * jargon.length;
    notes.push(`jargão: ${jargon.join(", ")}`);
  }

  if (/\d/.test(flat)) {
    const d1Text = `${d1.title} ${d1.body ?? ""}`;
    const nums = flat.match(/\d+(?:[.,]\d+)?/g) ?? [];
    const supported = nums.every((n) => d1Text.includes(n));
    if (supported) {
      score += 10;
      notes.push("número concreto do D1");
    } else {
      score -= 10;
      notes.push("número que não aparece no D1: conferir com a fonte antes de usar");
    }
  }

  const known = lw.filter((w) => CAPA_KNOWN_NAMES.includes(w));
  if (known.length > 0) {
    score += 5;
    notes.push(`nome reconhecível: ${known.join(", ")}`);
  }
  if (lw.includes("você") || lw.includes("te") || lw.includes("seu") || lw.includes("sua")) {
    score += 5;
    notes.push("fala com o espectador (você/te/seu)");
  }

  // A fórmula "IA {palavra}?" de 2 palavras virou o padrão de todo dia, e o
  // editor disse que não acredita nela (#12737). Funcionou duas vezes no canal
  // ("IA brasileira?", "IA ladra?"), então pesa pouco: só não ganha de uma
  // alternativa equivalente.
  if (words === 2 && form === "pergunta" && lw[0] === "ia") {
    score -= 5;
    notes.push('fórmula "IA ...?" de 2 palavras, a de todo dia: variar quando houver alternativa');
  }

  const h = horizontalHookArg(hook);
  const s = shortHookArg(hook);
  if (!h.hook && !s.hook) violations.push("não cabe em nenhuma das capas (horizontal e Short)");

  score = Math.max(0, Math.min(100, score));
  if (violations.length > 0) score = Math.min(score, 20);
  const potential: CapaPotential = violations.length > 0 ? "baixo" : score >= 70 ? "alto" : score >= 50 ? "médio" : "baixo";

  return {
    hook,
    origin,
    form,
    words,
    chars,
    score,
    potential,
    violations,
    notes,
    horizontal_hook: h.hook,
    horizontal_reason: h.reason,
    short_hook: s.hook,
    short_reason: s.reason,
  };
}

/**
 * Pure: sementes mecânicas tiradas do D1 — até 2 números salientes (moeda,
 * percentual, ordem de grandeza) e "E o {nome}?" com o 1º nome reconhecível
 * do título. São ponto de partida, de qualidade baixa de propósito: não
 * substituem os candidatos que o agente escreve, só completam a lista.
 */
export function seedCapaHooks(d1: CapaD1): string[] {
  const out: string[] = [];
  const text = `${d1.title} ${d1.body ?? ""}`;
  // Número de 1 token só ("30%", "R$ 100") não forma gancho sozinho: fica de fora.
  for (const n of salientNumbers(text)) {
    if (out.length >= 2) break;
    if (capaHookWords(n).length >= CAPA_HOOK_MIN_WORDS) out.push(n);
  }
  const known = extractProperNouns(d1.title).find((w) => CAPA_KNOWN_NAMES.includes(w.toLowerCase()));
  if (known) out.push(`E o ${known}?`);
  return [...new Set(out)];
}

/**
 * Pure: ordena por pontuação (violação sempre no fim) e garante que, se
 * houver as duas formas sem violação, o topo 3 tenha pelo menos uma
 * pergunta e uma afirmação. O "sempre 2 palavras e interrogação" era
 * justamente o vício que o editor apontou.
 */
export function rankCapaHooks(scores: CapaHookScore[], top = 3): CapaHookScore[] {
  const seen = new Set<string>();
  const unique = scores.filter((s) => {
    const k = flatHook(s.hook).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sorted = [...unique].sort((a, b) => {
    const va = a.violations.length > 0 ? 1 : 0;
    const vb = b.violations.length > 0 ? 1 : 0;
    if (va !== vb) return va - vb;
    if (b.score !== a.score) return b.score - a.score;
    if (a.origin !== b.origin) return a.origin === "agente" ? -1 : 1;
    return 0;
  });
  const clean = sorted.filter((s) => s.violations.length === 0);
  const head = clean.slice(0, top);
  for (const form of ["pergunta", "afirmação"] as const) {
    if (head.length === 0 || head.some((s) => s.form === form)) continue;
    const best = clean.find((s) => s.form === form);
    if (!best) continue;
    // troca o último do topo pelo melhor da forma que faltou
    head[head.length - 1] = best;
  }
  const headSet = new Set(head);
  const sortedHead = [...head].sort((a, b) => b.score - a.score);
  return [...sortedHead, ...sorted.filter((s) => !headSet.has(s))];
}

// ─── Registro e histórico ────────────────────────────────────────────────────

export type CapaFormat = "horizontal" | "short";

export interface CapaHookRecordEntry {
  format: CapaFormat;
  hook: string;
  recorded_at: string;
}

export interface CapaHookRecord {
  schema_version: number;
  edition: string;
  d1_title: string;
  entries: CapaHookRecordEntry[];
}

/** Pure: acrescenta (ou troca, no mesmo formato) o gancho escolhido no registro da edição. */
export function upsertCapaHookRecord(
  prev: CapaHookRecord | null,
  input: { edition: string; d1Title: string; format: CapaFormat; hook: string; now: Date },
): CapaHookRecord {
  const entries = (prev?.entries ?? []).filter((e) => e.format !== input.format);
  entries.push({ format: input.format, hook: input.hook, recorded_at: input.now.toISOString() });
  entries.sort((a, b) => a.format.localeCompare(b.format));
  return { schema_version: CAPA_HOOKS_SCHEMA_VERSION, edition: input.edition, d1_title: input.d1Title, entries };
}

export interface HookHistoryVideoLine {
  edition?: string | null;
  kind?: string | null;
  views?: number | null;
  capturedAt?: string;
  videoId?: string;
}

export interface HookHistoryRow {
  edition: string;
  format: CapaFormat;
  hook: string;
  views: number | null;
}

/**
 * Pure: cruza os ganchos registrados com a última captura de views por
 * edição e formato (`kind` "horizontal"/"short" do `videos.jsonl`). Edição
 * sem captura sai com `views: null`.
 */
export function joinHookHistory(records: CapaHookRecord[], videos: HookHistoryVideoLine[]): HookHistoryRow[] {
  const latest = new Map<string, HookHistoryVideoLine>();
  for (const v of videos) {
    if (!v.edition || !v.kind) continue;
    const key = `${v.edition}:${v.kind}`;
    const prev = latest.get(key);
    if (!prev || (v.capturedAt ?? "") >= (prev.capturedAt ?? "")) latest.set(key, v);
  }
  const rows: HookHistoryRow[] = [];
  for (const r of records) {
    for (const e of r.entries) {
      const v = latest.get(`${r.edition}:${e.format}`);
      rows.push({ edition: r.edition, format: e.format, hook: e.hook, views: typeof v?.views === "number" ? v.views : null });
    }
  }
  return rows.sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.edition.localeCompare(b.edition));
}

/**
 * Ganchos publicados até o levantamento de 10/11/2026 (#12737, comentário da
 * issue), com as views da época. Referência fixa para o editor comparar; os
 * novos entram pelo registro (`--record`) e saem no `--history`.
 */
export const CAPA_HOOKS_BASELINE_261110: ReadonlyArray<{ hook: string; views: number }> = [
  { hook: "IA brasileira?", views: 201 },
  { hook: "IA ladra?", views: 152 },
  { hook: "Golpe da selfie", views: 39 },
  { hook: "IA europeia?", views: 33 },
  { hook: "Confiou no chatbot e morreu", views: 21 },
  { hook: "R$ 1 milhão por dia", views: 13 },
  { hook: "Caso com espiã?", views: 9 },
];

/** Pure: texto da lista para o editor (terminal / mensagem do agente). */
export function formatCapaSuggestions(ranked: CapaHookScore[], d1: CapaD1, limit = 10): string {
  const lines: string[] = [];
  lines.push(`Texto de capa — D1: ${d1.title}`);
  lines.push("Potencial é heurístico (diretriz de docs/youtube-capa-texto.md), não previsão de CTR. Quem escolhe é o editor.");
  lines.push("");
  ranked.slice(0, limit).forEach((s, i) => {
    const tag = s.origin === "semente" ? " [semente]" : "";
    lines.push(`${i + 1}. "${flatHook(s.hook)}" — ${s.potential} (${s.score}) · ${s.form} · ${s.words} palavras${tag}`);
    if (s.violations.length > 0) lines.push(`   NÃO USAR: ${s.violations.join("; ")}`);
    if (s.notes.length > 0) lines.push(`   ${s.notes.join("; ")}`);
    lines.push(`   horizontal: ${s.horizontal_hook ? `--hook "${s.horizontal_hook}"` : `não cabe (${s.horizontal_reason})`}`);
    lines.push(`   Short: ${s.short_hook ? `--hook "${s.short_hook}"` : `não cabe (${s.short_reason})`}`);
  });
  lines.push("");
  lines.push("Referência do canal (levantamento de 10/11/2026, amostra pequena):");
  lines.push(CAPA_HOOKS_BASELINE_261110.map((b) => `"${b.hook}" ${b.views}`).join(" · "));
  return lines.join("\n");
}

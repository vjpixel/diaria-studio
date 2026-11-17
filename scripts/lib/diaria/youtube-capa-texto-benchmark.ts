/**
 * scripts/lib/diaria/youtube-capa-texto-benchmark.ts (#13253)
 *
 * Miolo puro do benchmark do TEXTO das capas em canais de IA. A coleta é a do
 * benchmark visual (`scripts/youtube-capa-benchmark.ts`, #13217: mesmos 12
 * canais, YouTube Data API oficial); o texto de cada capa é transcrito por
 * leitura da miniatura e gravado num arquivo de medição
 * (`docs/measurements/youtube-capa-texto-benchmark-*.json`). Aqui fica o que
 * se decide sem rede: contagem de palavras, se o texto nomeia o protagonista,
 * se repete ou complementa o título, a sugestão de modelo e a agregação
 * "acima da média × típico".
 *
 * O `modelo` e o `diz_assunto` de cada capa são julgamento de quem
 * transcreveu, gravados no arquivo. `suggestCapaTextoModelo` é só a
 * heurística que propõe o modelo num esqueleto novo e acusa divergência; ela
 * não decide entre afirmação literal, veredito e enigma, que dependem de ler a
 * capa inteira.
 *
 * Ressalva de sempre (#13195): views acima da mediana somam pauta, título e
 * capa. A comparação aponta o que se repete, não prova causa.
 */

import { median } from "./youtube-capa-benchmark.ts";
import { CAPA_KNOWN_NAMES, capaHookWords } from "./youtube-capa-hooks.ts";

/** Modelos de texto de capa (taxonomia da #13253). */
export const CAPA_TEXTO_MODELOS = [
  "protagonista",
  "assunto-literal",
  "pergunta",
  "citacao",
  "alerta",
  "numero",
  "veredito",
  "enigma",
  "rotulo",
  "sem-texto",
] as const;
export type CapaTextoModelo = (typeof CAPA_TEXTO_MODELOS)[number];

/** O que aparece na imagem e identifica o assunto sem ler o texto. */
export const CAPA_TEXTO_VISUAIS = ["logo", "personagem", "ambos", "nenhum"] as const;
export type CapaTextoVisual = (typeof CAPA_TEXTO_VISUAIS)[number];

export type CapaTextoGrupo = "acima" | "tipico";

export interface CapaTextoEntry {
  id: string;
  canal: string;
  lang: "pt" | "en";
  grupo: CapaTextoGrupo;
  /** views ÷ mediana do próprio canal. */
  ratio: number;
  views: number;
  titulo: string;
  /** Texto da capa como aparece; linhas separadas por " | ". Vazio = sem texto. */
  texto: string;
  modelo: CapaTextoModelo;
  /** Só o TEXTO diz do que é o vídeo (quem ou o quê), sem o título nem a imagem. */
  diz_assunto: boolean;
  visual: CapaTextoVisual;
}

/** Capa horizontal do nosso canal, com as views do snapshot. */
export interface CapaProprioEntry {
  edicao: string;
  titulo: string;
  texto: string;
  views: number;
  modelo: CapaTextoModelo;
  diz_assunto: boolean;
}

export interface CapaTextoMedicao {
  schema_version: 1;
  /** Data (UTC) da coleta do benchmark. */
  coleta: string;
  nota?: string;
  capas: CapaTextoEntry[];
  canal_proprio?: CapaProprioEntry[];
}

/**
 * Nomes de empresa, produto ou pessoa que aparecem nas capas do benchmark,
 * além dos que o público da diária reconhece (`CAPA_KNOWN_NAMES`). Serve para
 * dizer se o texto NOMEIA o protagonista; não é lista de nomes "bons".
 */
export const CAPA_TEXTO_EXTRA_NAMES = [
  "gpt", "gpt5", "gpt-6", "gpt-5", "opus", "sonnet", "haiku", "fable", "grok", "spacexai", "xai", "deepseek",
  "jev", "laya", "mistral", "altman", "zuckerberg", "binance", "aws", "spacex", "nasa", "rust", "php",
  "dessa", "astra", "gmail", "github", "codex", "cybertruck", "starship", "openai's", "lula", "itaú",
] as const;

const NAME_SET = new Set<string>([...CAPA_KNOWN_NAMES, ...CAPA_TEXTO_EXTRA_NAMES]);

/** Separador de linhas da transcrição (o mesmo `|` dos ganchos, #11740). */
const LINE_SEP = /\s*\|\s*/;

function flat(texto: string): string {
  return texto.split(LINE_SEP).map((l) => l.trim()).filter(Boolean).join(" ");
}

function tokens(texto: string): string[] {
  return flat(texto)
    .toLowerCase()
    .replace(/[“”"‘’'«»]/g, " ")
    .split(/[^\p{L}\p{N}$.\-]+/u)
    .map((t) => t.replace(/^[.\-]+|[.\-]+$/g, ""))
    .filter(Boolean);
}

/** Palavras da capa, com a mesma contagem dos ganchos (moeda + número = 1). */
export function capaTextoWords(texto: string): number {
  const f = flat(texto).replace(/[“”"‘’«»]/g, "");
  return f ? capaHookWords(f).length : 0;
}

/**
 * O texto nomeia empresa, produto ou pessoa? Versão colada ao nome conta
 * ("GPT-6.1", "GPT5": o prefixo de letras é "gpt").
 */
export function namesProtagonist(texto: string): boolean {
  return tokens(texto).some((t) => {
    const base = t.replace(/'s$/, "");
    const prefix = base.match(/^\p{L}+/u)?.[0] ?? "";
    return NAME_SET.has(base) || (prefix !== base && prefix.length >= 3 && NAME_SET.has(prefix));
  });
}

const STOPWORDS = new Set([
  // en
  "the", "and", "for", "are", "is", "it", "its", "this", "that", "with", "just", "now", "new", "you", "your", "our",
  "was", "has", "have", "how", "what", "who", "why", "all", "any", "can", "did", "not", "yet", "more", "most", "even",
  "so", "be", "of", "to", "in", "on", "a", "an", "we", "they", "he", "she", "me", "my", "at", "by", "or", "as", "up",
  // pt
  "que", "com", "por", "para", "uma", "um", "uns", "umas", "dos", "das", "nos", "nas", "não", "mais", "seu", "sua",
  "seus", "suas", "ele", "ela", "eles", "elas", "está", "esta", "isso", "esse", "essa", "de", "da", "do", "em", "no",
  "na", "e", "o", "os", "as", "é", "ou", "se", "já", "vai", "foi", "ser", "te", "tudo", "quem", "como", "sobre",
]);

function norm(t: string): string {
  return t.normalize("NFD").replace(/\p{M}/gu, "").replace(/'s$/, "").replace(/-/g, "");
}

function contentWords(text: string): string[] {
  return [...new Set(tokens(text).map(norm).filter((t) => t && !STOPWORDS.has(t) && (t.length >= 3 || /\d/.test(t))))];
}

export type TitleRelation = "repete" | "parcial" | "complementa" | "sem-texto";

/**
 * Relação entre o texto da capa e o título do vídeo, pelas palavras de
 * conteúdo da capa que também estão no título: nenhuma = complementa; metade
 * ou mais = repete; entre as duas = parcial. Palavra de função não conta.
 */
export function titleRelation(texto: string, titulo: string): TitleRelation {
  const capa = contentWords(texto);
  if (capa.length === 0) return "sem-texto";
  const tit = new Set(contentWords(titulo));
  const shared = capa.filter((w) => tit.has(w)).length;
  if (shared === 0) return "complementa";
  return shared / capa.length >= 0.5 ? "repete" : "parcial";
}

const ALERTA_WORDS = new Set(["alerta", "alert", "warning", "critical", "perigo", "danger", "urgente", "urgent", "cuidado"]);
const ROTULO_RE = /^(ai news|live\b|aula\b|aula completa|opini[aã]o\b|tutorial\b|review\b|react\b)/i;
const ENIGMA_START = new Set(["it", "they", "they're", "what", "he", "she", "this", "ele", "ela", "eles", "elas", "aconteceu", "isso"]);

/**
 * Heurística (não decide): o modelo provável do texto, na ordem sem-texto,
 * citação (aspas), alerta, pergunta, protagonista (nome), número solto,
 * rótulo de formato, enigma (pronome no começo). `null` = afirmação literal,
 * veredito ou enigma sem pronome: quem transcreve decide.
 */
export function suggestCapaTextoModelo(texto: string): CapaTextoModelo | null {
  const f = flat(texto);
  if (!f) return "sem-texto";
  if (/["“”]|(^|\s)'[^']+'/.test(f)) return "citacao";
  const toks = tokens(f);
  if (toks.some((t) => ALERTA_WORDS.has(t))) return "alerta";
  // Pergunta tem palavra antes do "?": "1 2 3 ???" é enigma, não pergunta.
  if (/\p{L}[^?]*\?/u.test(f)) return "pergunta";
  if (namesProtagonist(f)) return "protagonista";
  if (/\p{L}/u.test(f) && /(^|\s)(\p{Sc}|[A-Z]{1,3}\$)?\s?\d+([.,]\d+)?(\s|$)/u.test(f)) return "numero";
  if (ROTULO_RE.test(f)) return "rotulo";
  if (ENIGMA_START.has(toks[0] ?? "")) return "enigma";
  return null;
}

/** Erros de esquema do arquivo de medição (lista vazia = ok). */
export function validateMedicao(m: unknown): string[] {
  const errs: string[] = [];
  const o = m as Partial<CapaTextoMedicao> | null;
  if (!o || typeof o !== "object") return ["arquivo não é objeto JSON"];
  if (o.schema_version !== 1) errs.push(`schema_version ${String(o.schema_version)} (esperado 1)`);
  if (!Array.isArray(o.capas)) return [...errs, "capas ausente"];
  const seen = new Set<string>();
  o.capas.forEach((c, i) => {
    const at = `capas[${i}]${c?.id ? ` (${c.id})` : ""}`;
    if (!c || typeof c.id !== "string" || !c.id) errs.push(`${at}: id ausente`);
    else if (seen.has(`${c.canal}:${c.id}`)) errs.push(`${at}: id repetido`);
    else seen.add(`${c.canal}:${c.id}`);
    if (c?.grupo !== "acima" && c?.grupo !== "tipico") errs.push(`${at}: grupo inválido`);
    if (!CAPA_TEXTO_MODELOS.includes(c?.modelo as CapaTextoModelo)) errs.push(`${at}: modelo inválido (${String(c?.modelo)})`);
    if (!CAPA_TEXTO_VISUAIS.includes(c?.visual as CapaTextoVisual)) errs.push(`${at}: visual inválido`);
    if (typeof c?.diz_assunto !== "boolean") errs.push(`${at}: diz_assunto não é booleano`);
    if (typeof c?.texto !== "string") errs.push(`${at}: texto ausente`);
    else if ((c.texto.trim() === "") !== (c.modelo === "sem-texto")) errs.push(`${at}: texto vazio só com modelo sem-texto`);
    if (typeof c?.ratio !== "number" || !Number.isFinite(c.ratio)) errs.push(`${at}: ratio inválido`);
  });
  for (const [i, p] of (o.canal_proprio ?? []).entries()) {
    if (!CAPA_TEXTO_MODELOS.includes(p?.modelo as CapaTextoModelo)) errs.push(`canal_proprio[${i}]: modelo inválido`);
    if (typeof p?.views !== "number") errs.push(`canal_proprio[${i}]: views inválido`);
  }
  return errs;
}

export interface GroupStats {
  n: number;
  modelos: Record<CapaTextoModelo, number>;
  diz_assunto: number;
  nomeia: number;
  /** Texto OU imagem identifica o assunto (nomeia, diz o assunto, ou logo/personagem). */
  assunto_identificavel: number;
  relacao: Record<TitleRelation, number>;
  palavras_mediana: number;
}

function zeroModelos(): Record<CapaTextoModelo, number> {
  return Object.fromEntries(CAPA_TEXTO_MODELOS.map((k) => [k, 0])) as Record<CapaTextoModelo, number>;
}

export function groupStats(entries: CapaTextoEntry[]): GroupStats {
  const modelos = zeroModelos();
  const relacao: Record<TitleRelation, number> = { repete: 0, parcial: 0, complementa: 0, "sem-texto": 0 };
  let diz = 0, nomeia = 0, ident = 0;
  for (const e of entries) {
    modelos[e.modelo]++;
    relacao[titleRelation(e.texto, e.titulo)]++;
    const nm = namesProtagonist(e.texto);
    if (e.diz_assunto) diz++;
    if (nm) nomeia++;
    if (e.diz_assunto || nm || e.visual !== "nenhum") ident++;
  }
  const palavras = entries.filter((e) => e.modelo !== "sem-texto").map((e) => capaTextoWords(e.texto));
  return { n: entries.length, modelos, diz_assunto: diz, nomeia, assunto_identificavel: ident, relacao, palavras_mediana: median(palavras) };
}

/** Atributo binário avaliado por canal. */
export type CapaAttr = CapaTextoModelo | "diz_assunto" | "nomeia" | "complementa" | "repete";

function hasAttr(e: CapaTextoEntry, a: CapaAttr): boolean {
  if (a === "diz_assunto") return e.diz_assunto;
  if (a === "nomeia") return namesProtagonist(e.texto);
  if (a === "complementa" || a === "repete") return titleRelation(e.texto, e.titulo) === a;
  return e.modelo === a;
}

export interface WithinChannel {
  attr: CapaAttr;
  /** Canais com os dois grupos. */
  canais: number;
  /** Média, entre os canais, da fração no grupo acima menos a fração nos típicos (em pontos, -1..1). */
  delta_medio: number;
  /** Canais em que a fração no grupo acima é maior / menor que nos típicos. */
  canais_mais: number;
  canais_menos: number;
}

/**
 * Comparação DENTRO de cada canal (a mediana do canal já normaliza o porte):
 * para cada atributo, a fração nas capas acima da média menos a fração nas
 * típicas do mesmo canal, e quantos canais vão em cada direção.
 */
export function withinChannel(entries: CapaTextoEntry[], attrs: readonly CapaAttr[]): WithinChannel[] {
  const byCanal = new Map<string, CapaTextoEntry[]>();
  for (const e of entries) byCanal.set(e.canal, [...(byCanal.get(e.canal) ?? []), e]);
  return attrs.map((attr) => {
    const deltas: number[] = [];
    for (const list of byCanal.values()) {
      const up = list.filter((e) => e.grupo === "acima");
      const ty = list.filter((e) => e.grupo === "tipico");
      if (!up.length || !ty.length) continue;
      const frac = (xs: CapaTextoEntry[]) => xs.filter((e) => hasAttr(e, attr)).length / xs.length;
      deltas.push(frac(up) - frac(ty));
    }
    const avg = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : 0;
    return {
      attr,
      canais: deltas.length,
      delta_medio: avg,
      canais_mais: deltas.filter((d) => d > 1e-9).length,
      canais_menos: deltas.filter((d) => d < -1e-9).length,
    };
  });
}

export interface ProprioRow {
  chave: string;
  n: number;
  views_mediana: number;
}

/** Nosso canal: mediana de views por modelo e por "diz o assunto". */
export function proprioSummary(rows: CapaProprioEntry[]): { porModelo: ProprioRow[]; porAssunto: ProprioRow[]; porNome: ProprioRow[] } {
  const group = (key: (r: CapaProprioEntry) => string): ProprioRow[] => {
    const m = new Map<string, number[]>();
    for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r.views]);
    return [...m.entries()]
      .map(([chave, v]) => ({ chave, n: v.length, views_mediana: median(v) }))
      .sort((a, b) => b.views_mediana - a.views_mediana || a.chave.localeCompare(b.chave));
  };
  return {
    porModelo: group((r) => r.modelo),
    porAssunto: group((r) => (r.diz_assunto ? "diz o assunto" : "não diz o assunto")),
    porNome: group((r) => (namesProtagonist(r.texto) ? "nomeia empresa/produto" : "não nomeia")),
  };
}

/** Divergências entre a heurística e o modelo gravado (só onde a heurística opina). */
export function modeloDivergences(entries: CapaTextoEntry[]): { id: string; texto: string; gravado: CapaTextoModelo; sugerido: CapaTextoModelo }[] {
  const out: { id: string; texto: string; gravado: CapaTextoModelo; sugerido: CapaTextoModelo }[] = [];
  for (const e of entries) {
    const s = suggestCapaTextoModelo(e.texto);
    if (s && s !== e.modelo) out.push({ id: e.id, texto: e.texto, gravado: e.modelo, sugerido: s });
  }
  return out;
}

const pct = (x: number, n: number) => (n ? `${Math.round((100 * x) / n)}%` : "—");

/** Relatório em markdown (as tabelas do doc saem daqui). */
export function renderMarkdown(m: CapaTextoMedicao): string {
  const up = m.capas.filter((c) => c.grupo === "acima");
  const ty = m.capas.filter((c) => c.grupo === "tipico");
  const su = groupStats(up), st = groupStats(ty);
  const L: string[] = [];
  L.push(`Coleta de ${m.coleta}: ${new Set(m.capas.map((c) => c.canal)).size} canais, ${up.length} capas acima da média, ${ty.length} típicas.`, "");
  L.push("| Modelo | Acima da média | Típicas |", "|---|---:|---:|");
  for (const k of CAPA_TEXTO_MODELOS) {
    if (!su.modelos[k] && !st.modelos[k]) continue;
    L.push(`| ${k} | ${su.modelos[k]} (${pct(su.modelos[k], su.n)}) | ${st.modelos[k]} (${pct(st.modelos[k], st.n)}) |`);
  }
  L.push("", "| Atributo | Acima da média | Típicas |", "|---|---:|---:|");
  L.push(`| Texto diz o assunto sozinho | ${pct(su.diz_assunto, su.n)} | ${pct(st.diz_assunto, st.n)} |`);
  L.push(`| Texto nomeia empresa/produto/pessoa | ${pct(su.nomeia, su.n)} | ${pct(st.nomeia, st.n)} |`);
  L.push(`| Assunto identificável (texto ou imagem) | ${pct(su.assunto_identificavel, su.n)} | ${pct(st.assunto_identificavel, st.n)} |`);
  L.push(`| Repete o título | ${pct(su.relacao.repete, su.n)} | ${pct(st.relacao.repete, st.n)} |`);
  L.push(`| Repete em parte | ${pct(su.relacao.parcial, su.n)} | ${pct(st.relacao.parcial, st.n)} |`);
  L.push(`| Complementa (nenhuma palavra do título) | ${pct(su.relacao.complementa, su.n)} | ${pct(st.relacao.complementa, st.n)} |`);
  L.push(`| Palavras (mediana, capas com texto) | ${su.palavras_mediana} | ${st.palavras_mediana} |`);
  const attrs: CapaAttr[] = ["diz_assunto", "nomeia", "repete", "complementa", "protagonista", "assunto-literal", "pergunta", "citacao", "enigma", "veredito"];
  L.push("", "| Dentro do canal | Canais | Diferença média (acima − típicas) | Canais a favor | Canais contra |", "|---|---:|---:|---:|---:|");
  for (const w of withinChannel(m.capas, attrs)) {
    const sign = w.delta_medio > 0 ? "+" : "";
    L.push(`| ${w.attr} | ${w.canais} | ${sign}${Math.round(100 * w.delta_medio)} pontos | ${w.canais_mais} | ${w.canais_menos} |`);
  }
  if (m.canal_proprio?.length) {
    const p = proprioSummary(m.canal_proprio);
    L.push("", "| Nosso canal | Capas | Views (mediana) |", "|---|---:|---:|");
    for (const r of [...p.porAssunto, ...p.porNome, ...p.porModelo]) L.push(`| ${r.chave} | ${r.n} | ${r.views_mediana} |`);
  }
  return L.join("\n");
}

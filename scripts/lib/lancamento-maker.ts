/**
 * lancamento-maker.ts (#12595)
 *
 * Item de LANÇAMENTOS precisa dizer DE QUEM é o lançamento. Caso real (edição
 * 261109): `**[Voice Chat with Agents](https://cursor.com/changelog/voice-chat)**`
 * com a descrição "Converse com seus agentes por chamada de voz em tempo real
 * no desktop, na web e no iOS." — título genérico de changelog, descrição sem
 * o nome do Cursor, e o leitor não sabe de quem é o produto.
 *
 * Fonte dos nomes aceitos, por item:
 *   1. a entrada de `OFFICIAL_SOURCES` (`official-domains.ts`, a mesma que
 *      decide se a URL é oficial, #160) que casa a URL: o nome da empresa
 *      (`company`, partido em "/" e parênteses: "Cursor (Anysphere)" →
 *      Cursor, Anysphere) e `detection_keywords`;
 *   2. os rótulos do próprio host da URL (`cursor.com` → cursor,
 *      `code.claude.com` → claude, `blog.google` → google), sem TLD e sem
 *      subdomínio genérico (blog, docs, www…);
 *   3. em host de plataforma (`github.com`, `huggingface.co`), o dono do
 *      caminho (`github.com/deepseek-ai/...` → deepseek).
 *
 * O item passa se QUALQUER nome aparecer como palavra no título ou na
 * descrição (sem acento, sem caixa; "Hugging Face" também casa
 * "HuggingFace"). `detection_keywords` sozinho não basta como critério: o do
 * Cursor exige a marca qualificada ("Cursor AI", "Anysphere") de propósito
 * (cursor do mouse), e reprovaria "O Cursor passou a permitir...".
 *
 * Heurística: consumida pelo invariante warning-only `lancamento-sem-fabricante`
 * do Stage 4 (o editor decide no gate), nunca bloqueia.
 */

import { OFFICIAL_SOURCES, type OfficialSource } from "./official-domains.ts";
import { parseSections } from "./newsletter-parse.ts";

/** TLDs e sufixos que nunca são nome de fabricante. */
const NON_BRAND_HOST_LABELS = new Set([
  "com", "ai", "io", "dev", "co", "org", "net", "br", "app", "so", "sh", "tech", "us", "uk", "fr", "de", "cn", "jp", "me", "xyz", "info", "page", "site",
  // subdomínios genéricos
  "www", "blog", "blogs", "docs", "doc", "developers", "developer", "dev", "community", "support", "help", "news", "newsroom",
  "research", "labs", "platform", "code", "cloud", "api", "hub", "about", "press", "status", "changelog", "release", "releases",
  "learn", "en", "pt", "m",
]);

/** Partes do campo `company` que são qualificador, não nome (ex.: "Google (blog)"). */
const NON_BRAND_COMPANY_PARTS = new Set([
  "blog", "patterns", "pages", "institucional", "ai research", "ex-zhipu ai",
]);

/** Hosts de plataforma: o fabricante é o dono do caminho, não o host. */
const PLATFORM_HOSTS = new Set(["github.com", "huggingface.co", "gitlab.com"]);

/**
 * 1º segmento de caminho que, num host de plataforma, não é dono de repo/modelo.
 * `huggingface.co/blog/...` anuncia modelo de TERCEIRO (Meta, Reflection...) sem
 * dono no caminho: o item é ignorado, não há nome confiável a exigir.
 */
const PLATFORM_RESERVED_SEGMENTS = new Set([
  "blog", "papers", "spaces", "datasets", "collections", "docs", "models", "organizations", "orgs", "topics", "features", "changelog",
]);

/**
 * Produto cujo nome já identifica o fabricante (o leitor sabe de quem é o
 * Gemini). Chave = 1º nome da empresa em `OFFICIAL_SOURCES.company`. Lista
 * curta de propósito: só marca inequívoca.
 */
const MAKER_PRODUCT_ALIASES: Record<string, readonly string[]> = {
  google: ["Gemini", "Gemma", "NotebookLM", "DeepMind"],
  "deepmind": ["Gemini", "Gemma", "Google"],
  openai: ["ChatGPT", "Codex", "Sora"],
  anthropic: ["Claude"],
  meta: ["Llama"],
  microsoft: ["Copilot"],
  xai: ["Grok"],
};

/** Tamanho mínimo (sem espaços) de um nome para valer — "x" de x.ai casaria qualquer coisa. */
const MIN_NAME_LEN = 3;

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Texto em minúsculas, sem acento, com tudo que não é letra/dígito virando
 * espaço e camelCase partido ("EmbeddingGemma" → "embedding gemma",
 * "OpenAI" → "open ai"). Nome e texto passam pela mesma função, então
 * "OpenAI" casa "OpenAI" e "openai" (forma compacta, ver `mentionsMaker`).
 */
export function normalizeForNameMatch(s: string): string {
  return stripAccents(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hostAndPath(url: string): { host: string; full: string; pathSegments: string[] } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    return { host, full: host + u.pathname, pathSegments: u.pathname.split("/").filter(Boolean) };
  } catch {
    return null;
  }
}

/** Pure: a entrada de `OFFICIAL_SOURCES` que casa a URL (host inteiro ou path_pattern), ou null. */
export function findOfficialSource(url: string, sources: readonly OfficialSource[] = OFFICIAL_SOURCES): OfficialSource | null {
  const hp = hostAndPath(url);
  if (!hp) return null;
  for (const src of sources) {
    if ((src.domains ?? []).includes(hp.host)) return src;
    if ((src.path_patterns ?? []).some((p) => p.test(hp.full))) return src;
  }
  return null;
}

function companyNames(company: string): string[] {
  const parts = company
    .split(/[/()]/)
    .map((p) => p.trim())
    .filter((p) => p && !NON_BRAND_COMPANY_PARTS.has(p.toLowerCase()));
  const out: string[] = [];
  for (const p of parts) {
    out.push(p);
    // "Meta AI" → também "Meta"; "Inception Labs" → também "Inception".
    const bare = p.replace(/\s+(AI|Labs?)$/i, "").trim();
    if (bare && bare !== p) out.push(bare);
  }
  const first = normalizeForNameMatch(parts[0] ?? "").split(" ")[0] ?? "";
  out.push(...(MAKER_PRODUCT_ALIASES[first] ?? MAKER_PRODUCT_ALIASES[normalizeForNameMatch(parts[0] ?? "").replace(/ /g, "")] ?? []));
  return out;
}

/** "deepseek-ai" → ["deepseek-ai", "deepseek"]; "anthropics" → ["anthropics", "anthropic"]. */
function ownerVariants(owner: string): string[] {
  const out = [owner];
  const noAi = owner.replace(/[-_.]?ai$/i, "");
  if (noAi && noAi !== owner) out.push(noAi);
  if (/s$/i.test(owner) && owner.length > MIN_NAME_LEN + 1) out.push(owner.slice(0, -1));
  return out;
}

/**
 * Pure: nomes que identificam o fabricante do lançamento linkado em `url`
 * (ver docblock do módulo). Lista sem duplicatas, na forma original.
 */
export function makerNamesForUrl(url: string): string[] {
  const hp = hostAndPath(url);
  if (!hp) return [];
  const names: string[] = [];
  const src = findOfficialSource(url);
  if (PLATFORM_HOSTS.has(hp.host)) {
    const owner = hp.pathSegments[0];
    if (!owner || PLATFORM_RESERVED_SEGMENTS.has(owner.toLowerCase())) return [];
    // Fonte que é a PRÓPRIA plataforma ("Hugging Face" num model card de
    // terceiro) não nomeia o fabricante; fonte de org (DeepSeek no GitHub) sim.
    if (src && src.primary_domain !== hp.host) names.push(...companyNames(src.company));
    names.push(...ownerVariants(owner));
  } else {
    if (src) names.push(...companyNames(src.company));
    for (const label of hp.host.split(".")) {
      if (!NON_BRAND_HOST_LABELS.has(label)) names.push(label);
    }
  }
  const seen = new Set<string>();
  return names.filter((n) => {
    const key = normalizeForNameMatch(n).replace(/ /g, "");
    if (key.length < MIN_NAME_LEN || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Pure: o texto (título + descrição) cita algum dos `names`? Casa como palavra
 * inteira no texto normalizado, nas formas com e sem espaço ("Hugging Face" ×
 * "HuggingFace"). `keywords` (o `detection_keywords` da fonte) é um sinal
 * positivo extra.
 */
export function mentionsMaker(text: string, names: readonly string[], keywords?: RegExp): boolean {
  if (keywords && keywords.test(text)) return true;
  const norm = ` ${normalizeForNameMatch(text)} `;
  const compactWords = norm.trim().split(" ");
  for (const n of names) {
    const spaced = normalizeForNameMatch(n);
    if (!spaced) continue;
    if (norm.includes(` ${spaced} `)) return true;
    const compact = spaced.replace(/ /g, "");
    // "HuggingFace" no texto × "Hugging Face" no nome (e vice-versa).
    if (compactWords.includes(compact)) return true;
    for (let i = 0; i + 1 < compactWords.length; i++) {
      if (compactWords[i] + compactWords[i + 1] === compact) return true;
    }
  }
  return false;
}

export interface LancamentoSemFabricante {
  title: string;
  url: string;
  description: string;
  /** Nomes que bastariam para o item passar. */
  expected: string[];
}

/**
 * Pure: itens da seção LANÇAMENTOS de um `02-reviewed.md` cujo título e
 * descrição não citam o fabricante. Item cuja URL não rende nenhum nome
 * (host desconhecido só com rótulos genéricos) é ignorado: não há o que
 * exigir.
 */
export function findLancamentosSemFabricante(md: string): LancamentoSemFabricante[] {
  const out: LancamentoSemFabricante[] = [];
  for (const section of parseSections(md)) {
    if (!/^LAN[ÇC]AMENTOS$/i.test(section.name)) continue;
    for (const item of section.items) {
      const names = makerNamesForUrl(item.url);
      if (names.length === 0) continue;
      const title = item.title.replace(/\*\*/g, "");
      const description = item.description.replace(/\*\*/g, "");
      const keywords = findOfficialSource(item.url)?.detection_keywords;
      if (mentionsMaker(`${title} ${description}`, names, keywords)) continue;
      out.push({ title, url: item.url, description, expected: names });
    }
  }
  return out;
}

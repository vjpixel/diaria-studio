/**
 * lib/secondary-theme-repeat.ts (#13143)
 *
 * "Possível repetição de tema" para os itens SECUNDÁRIOS (RADAR, LANÇAMENTOS,
 * USE MELHOR, VÍDEOS): mesmo assunto de um item já publicado nas últimas
 * edições, vindo de outro link.
 *
 * Caso real (edição 261116): a 261113 publicou o destaque "Claude agora monta
 * planilhas e lousas com seu time" (blog da Anthropic, Claude Sheets) e a 261116
 * trouxe no RADAR "Claude transformou planilha em uma conversa" (StartSe), mesmo
 * lançamento. O passe secundário de `check-highlight-themes.ts` (#2652) chegou a
 * emitir aviso, mas contra o item errado ("Introducing Claude Meetings", só
 * "Claude" em comum, jaccard 0.17), no meio de uma lista de avisos fracos, e o
 * aviso secundário não subia a lugar nenhum que o editor lê: o Stage 1 roda em
 * `--no-gates` e o gate 4 só lia os avisos dos candidatos a destaque. Três
 * lacunas, três ajustes:
 *
 *   1. O destaque passado nunca entrava na comparação do secundário (o pool
 *      passado vinha só dos buckets secundários do `01-approved.json`, e com o
 *      título da fonte, muitas vezes em inglês). Agora entram também os itens
 *      PUBLICADOS (`02-reviewed.md`, título em português, destaques inclusive).
 *   2. O melhor par era escolhido só pelo jaccard, que favorece o título curto
 *      que só divide a entidade. Agora ganha o par com mais termos de conteúdo
 *      em comum além da entidade (`sharedContentTerms`), e o jaccard desempata.
 *   3. O par que divide entidade E termo de conteúdo sai marcado
 *      `possible_repeat: true` e sobe ao editor: nota no relatório do Stage 1
 *      (`formatSecondaryPossibleRepeatNotes`) e aviso no gate 4 (invariante
 *      `secondary-theme-possible-repeat`).
 *
 * Premissa (registrada na PR do #13143): WARNING-ONLY, nunca remove nada. A
 * issue deixa em aberto o critério entre "mesmo fato" e "novo capítulo"
 * (desdobramento com dado novo deve passar); um sinal de título não separa os
 * dois, então quem decide é o editor no gate, como nos demais avisos de tema
 * (#2605, #8896, #11496). O item marcado segue na edição até alguém cortá-lo.
 */

import { GENERIC_ANNOUNCEMENT_TOKENS } from "./repeat-theme-check.ts";
import { canonicalize } from "./url-utils.ts";

/** Termo de conteúdo precisa ter ao menos 5 letras (tira "para", "com", "seu"...). */
export const CONTENT_TERM_MIN_LEN = 5;

/**
 * Prefixo comum mínimo para dois termos contarem como o mesmo radical
 * (planilha/planilhas, contratar/contratações). Mesmo valor de
 * `SECONDARY_PREFIX_MIN_LEN` de `check-highlight-themes.ts`.
 */
export const CONTENT_PREFIX_LEN = 6;

/**
 * Palavras que aparecem em qualquer manchete do domínio e não dizem qual é o
 * assunto. Sem elas, "Google demite time de IA" e "Google lança ferramenta de
 * IA" dividiriam "ferramenta"/"empresa" e sairiam como repetição.
 */
export const GENERIC_CONTENT_TOKENS: ReadonlySet<string> = new Set([
  ...GENERIC_ANNOUNCEMENT_TOKENS,
  // PT-BR
  "inteligencia", "artificial", "modelo", "modelos", "empresa", "empresas",
  "usuario", "usuarios", "agente", "agentes", "ferramenta", "ferramentas",
  "sobre", "depois", "entre", "ainda", "mundo", "pessoas", "segundo", "contra",
  "fazer", "melhor", "maior", "primeiro", "primeira", "trabalho", "pesquisa",
  "estudo", "recurso", "recursos", "versao", "sistema", "sistemas", "tecnologia",
  "dados", "online", "digital", "global", "mercado", "milhoes", "bilhoes",
  "anos", "brasil", "brasileiro", "brasileira", "brasileiros",
  "criar", "passo", "ganha", "permite", "mostra", "revela", "promete", "exemplos",
  "dicas", "tutorial", "curso", "gratis", "desenvolvedores", "conteudo",
  "funciona", "funcionar", "saiba", "conheca", "ideias", "passa", "testa",
  "informacoes", "profissional", "tarefas", "plataforma", "prompts", "prompt",
  "inteligente", "generativa", "agentica", "agentico",
  // EN
  "model", "models", "agent", "agents", "tools", "users", "company", "companies",
  "about", "after", "their", "using", "build", "building", "guide", "first",
  "research", "study", "feature", "features", "version", "system", "systems",
  "technology", "people", "world", "market", "million", "billion", "years",
  "intelligence", "learning", "machine", "developer", "developers", "development",
  "create", "complete", "practical", "examples", "without", "knowledge",
  "agentic", "language", "languages", "advance", "advances", "advancing",
  "deploy", "deploys", "deployment", "source", "program", "programs", "tasks",
  "prompting", "across", "engine", "platform", "introducing", "intelligent",
  "generative",
]);

/**
 * Palavra genérica do domínio (`GENERIC_CONTENT_TOKENS`). Também serve para a
 * entidade compartilhada: "Introducing" e "Agentic" abrem manchete com
 * maiúscula sem serem o nome de ninguém, e o par que só divide uma delas não
 * conta como possível repetição.
 */
export function isGenericTerm(t: string): boolean {
  return GENERIC_CONTENT_TOKENS.has(t);
}

/**
 * Tokens (já normalizados como em `tokenizeForJaccard`) das palavras que
 * começam com maiúscula no título: os nomes próprios, inclusive os grudados
 * por hífen ("Claude-maker" dá "claude" e "maker"). Um termo que é nome
 * próprio nos DOIS títulos é entidade, não assunto, e não conta como termo de
 * conteúdo (`sharedContentTerms`, parâmetro `excluded`).
 */
export function capitalizedTokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const word of title.split(/\s+/)) {
    const first = word.replace(/^[^\p{L}\p{N}]+/u, "").charAt(0);
    if (!first || first === first.toLowerCase()) continue;
    for (const t of word
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^\p{L}\p{N}]+/u)) {
      if (t) out.add(t);
    }
  }
  return out;
}

function isContentToken(t: string, excluded: ReadonlySet<string>): boolean {
  return t.length >= CONTENT_TERM_MIN_LEN && !excluded.has(t) && !GENERIC_CONTENT_TOKENS.has(t);
}

/**
 * Termos de conteúdo que os dois títulos dividem, além das entidades em
 * `excluded` (as entidades compartilhadas que já dispararam o par). Igualdade
 * exata ou prefixo comum de `CONTENT_PREFIX_LEN` letras. Cada termo de `a`
 * conta uma vez; formato "planilha/planilhas" quando a grafia difere.
 * Os tokens chegam normalizados (`tokenizeForJaccard`: minúsculas, sem acento).
 */
export function sharedContentTerms(
  tokensA: ReadonlySet<string>,
  tokensB: ReadonlySet<string>,
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  const bList = [...tokensB].filter((t) => isContentToken(t, excluded));
  const out: string[] = [];
  for (const a of tokensA) {
    if (!isContentToken(a, excluded)) continue;
    if (tokensB.has(a)) {
      out.push(a);
      continue;
    }
    if (a.length < CONTENT_PREFIX_LEN) continue;
    const prefix = a.slice(0, CONTENT_PREFIX_LEN);
    const b = bList.find((x) => x.length >= CONTENT_PREFIX_LEN && x.startsWith(prefix));
    if (b) out.push(`${a}/${b}`);
  }
  return out;
}

/** Campos de `secondary_warnings[]` que esta lib lê (shape de `SecondaryThemeWarning`). */
export interface PossibleRepeatWarning {
  bucket: string;
  item_url: string;
  item_title: string;
  matched_edition: string;
  matched_title: string;
  matched_bucket: string;
  shared_entities: string[];
  content_terms: string[];
}

/**
 * `secondary_warnings[]` de `01-highlight-theme-check.json` com
 * `possible_repeat: true`. Pura e fail-soft: shape inesperada → lista vazia;
 * item sem URL é ignorado.
 */
export function readPossibleRepeatWarnings(themeCheck: unknown): PossibleRepeatWarning[] {
  if (!themeCheck || typeof themeCheck !== "object") return [];
  const raw = (themeCheck as { secondary_warnings?: unknown }).secondary_warnings;
  if (!Array.isArray(raw)) return [];
  const out: PossibleRepeatWarning[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const r = w as Record<string, unknown>;
    if (r.possible_repeat !== true || typeof r.item_url !== "string" || !r.item_url) continue;
    const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
    out.push({
      bucket: String(r.bucket ?? "?"),
      item_url: r.item_url,
      item_title: String(r.item_title ?? ""),
      matched_edition: String(r.matched_edition ?? "?"),
      matched_title: String(r.matched_title ?? ""),
      matched_bucket: String(r.matched_bucket ?? "?"),
      shared_entities: strList(r.shared_entities),
      content_terms: strList(r.content_terms),
    });
  }
  return out;
}

/** Uma linha legível para o relatório do Stage 1 e para o gate 4. */
export function formatPossibleRepeat(w: PossibleRepeatWarning): string {
  const why = [...w.shared_entities, ...w.content_terms].join(", ");
  return (
    `Possível repetição de tema: [${w.bucket}] “${w.item_title}” (${w.item_url}) × ` +
    `${w.matched_edition} [${w.matched_bucket}] “${w.matched_title}” (em comum: ${why}). ` +
    `Cortar se for o mesmo fato; manter se for desdobramento com fato novo.`
  );
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
 * aviso `possible_repeat` cujo item segue em `01-approved.json`. Pura e
 * fail-soft.
 */
export function formatSecondaryPossibleRepeatNotes(themeCheck: unknown, approved: unknown): string[] {
  const inApproved = new Set<string>();
  collectUrls(approved, inApproved);
  return readPossibleRepeatWarnings(themeCheck)
    .filter((w) => inApproved.has(canonicalize(w.item_url)))
    .map((w) => `⚠️  ${formatPossibleRepeat(w)}`);
}

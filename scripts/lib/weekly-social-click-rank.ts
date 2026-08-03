/**
 * weekly-social-click-rank.ts (#4511 fleet review IMPORTANTE, code-reviewer)
 *
 * Núcleo de ranking/blocklist compartilhado pelas 2 skills semanais que
 * ranqueiam candidatos por taxa de clique — `/diaria-linkedin-semanal`
 * (#4456, `weekly-linkedin-select.ts`/`weekly-linkedin-filter.ts`) e
 * `/diaria-instagram-semanal` (#4483, `weekly-instagram-select.ts`).
 *
 * Até o #4511, essas funções viviam DUPLICADAS byte-a-byte nos 2 lados —
 * `weekly-instagram-select.ts` explicava a duplicação como proposital (ver
 * histórico do PR #4511/#4483, docstring removida daquele arquivo) porque,
 * no momento em que foi escrito, havia PRs concorrentes abertos tocando
 * `weekly-linkedin-select.ts` (#4507, #4501, #4495) e importar de lá
 * acoplaria o PR novo ao estado de merge daqueles. Com esses PRs já
 * mergeados, a duplicação deixou de ter justificativa: nada aqui depende da
 * diferença real de escopo entre as 2 skills (pool de seções elegíveis,
 * card de imagem) — é matemática pura de ranking/blocklist.
 *
 * O que NÃO está aqui (fica em cada módulo específico, porque a diferença é
 * REAL): extração de candidatos do markdown (`extractWeeklyCandidates` /
 * `extractInstagramCandidates`), `toRankedCandidate` (o tipo de entrada
 * difere — `WeeklyRawCandidate` tem `kind`/`section`, `InstagramRawCandidate`
 * tem `destaqueNumber`), e `dedupeCandidatesByUrl` (o LinkedIn prioriza
 * `kind:"destaque"` sobre `"section"` na hora de decidir qual cópia manter;
 * o Instagram só tem destaques, não precisa dessa lógica).
 *
 * `T extends ClickRankedCandidate` deixa as funções genéricas o bastante pra
 * aceitar tanto `WeeklyRankedCandidate` quanto `InstagramRankedCandidate`
 * sem faltar nenhum campo que elas realmente leem.
 */

import { classifyOrigin } from "../build-link-ctr.ts";
import {
  DIARIA_APOIASE_URL,
  DIARIA_CURSOS_URL,
  DIARIA_LIVROS_URL,
  DIARIA_EIA_URL,
} from "./canonical-urls.ts";

/** Subconjunto de campos que as funções deste módulo realmente leem. */
export interface ClickRankedCandidate {
  url: string;
  title: string;
  body: string;
  why: string;
  category: string;
  /** `(cliques verificados) / opens * 100`, ou 0 se `opens === 0`. */
  ratePct: number;
  /** Aberturas únicas do e-mail da edição de origem. */
  opens: number;
  /** `false` quando o post de origem está ausente/não-enriquecido no cache local de cliques. */
  hasClickData: boolean;
}

// ─── Exclusão de links comerciais/próprios ─────────────────────────────────
//
// Lista de domínios comum às 2 skills semanais (comentário 260802 (2º) do
// #4456: "Excluir do cálculo: blocos de Divulgação e parcerias comerciais,
// afiliados (Amazon, Wispr Flow, Clarice, Beehiiv), apoia.se, propriedades
// próprias (cursos., livros., eia., diar.ia.br), links de preferências e
// descadastro").

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function hostOfConst(u: string): string {
  return hostOf(u) ?? "";
}

/** Hosts de propriedade própria (subdomínios de marca) — exclusão exata de host. */
const OWN_PROPERTY_HOSTS = new Set<string>([
  hostOfConst(DIARIA_CURSOS_URL), // cursos.diar.ia.br
  hostOfConst(DIARIA_LIVROS_URL), // livros.diar.ia.br
  hostOfConst(DIARIA_EIA_URL), // eia.diar.ia.br
  hostOfConst(DIARIA_APOIASE_URL), // apoia.se
  // Domínios legados (.workers.dev) — compat com clicks de edições antigas
  // que ainda apontam pro subdomínio genérico em vez do domínio de marca.
  "cursos.diaria.workers.dev",
  "livros.diaria.workers.dev",
  "poll.diaria.workers.dev",
]);

/** Afiliados (link de parceria — nunca matéria, mesmo quando bem clicado). */
const AFFILIATE_HOST_PATTERNS: RegExp[] = [
  /(^|\.)amazon\.com\.br$/i,
  /^amzn\.to$/i,
  /^link\.amazon$/i,
  /(^|\.)wisprflow\.ai$/i,
  /(^|\.)wispr\.(ai|flow)$/i,
  /(^|\.)clarice\.ai$/i, // link de afiliado/parceria (precos-planos etc.) — cortex.clarice.ai é API, mas não é link de leitor
  /(^|\.)beehiiv\.com$/i,
];

/** Preferências/descadastro — nunca conteúdo editorial. */
function isPreferencesOrUnsubscribe(url: string): boolean {
  return /unsubscribe|preferences|beehiivstatus\.com/i.test(url);
}

/** O próprio host raiz `diar.ia.br` (a edição ou home da newsletter, não um artigo de terceiro). */
function isBareOwnDomain(host: string): boolean {
  return host === "diar.ia.br" || host === "diaria.beehiiv.com";
}

/**
 * Pure: `true` quando `url` é um link comercial, afiliado, de propriedade
 * própria, ou de preferências/descadastro — nunca conta como "matéria" na
 * seleção por clique das newsletters/posts semanais.
 *
 * Diferente de `isEditorial` (`build-link-ctr.ts`), que filtra infra de
 * tracking/social-share genérica: este filtro é ESPECÍFICO da regra
 * editorial do #4456 (exclui também parceria/Divulgação e propriedade
 * própria, que `isEditorial` deliberadamente deixa passar pra outros usos —
 * ex: o CTR table quer VER o clique em Divulgação).
 */
export function isCommercialOrOwnLink(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false; // URL ilegível — não exclui por este filtro (caller decide o resto)
  if (isBareOwnDomain(host)) return true;
  if (OWN_PROPERTY_HOSTS.has(host)) return true;
  if (AFFILIATE_HOST_PATTERNS.some((re) => re.test(host))) return true;
  if (isPreferencesOrUnsubscribe(url)) return true;
  return false;
}

/**
 * Heurística de baixa confiança (#4489 finding 5, silent-failure-hunter): a
 * blocklist acima é uma allowlist ESTÁTICA de domínio — um parceiro/afiliado
 * NOVO, ainda não cadastrado, passa despercebido do mesmo jeito que
 * `prepara.com.br` (Divulgação, não listado) quase virou destaque por engano
 * em julho/2026. Esta função NÃO bloqueia — só sinaliza pra revisão humana
 * no gate quando o TÍTULO/CORPO de um candidato de clique alto contém
 * vocabulário típico de conteúdo patrocinado/parceria, mesmo que o domínio
 * não bata em nada da blocklist.
 */
const SUSPICIOUS_COMMERCIAL_RE = /parceria|patrocinad[oa]|divulga[çc][ãa]o|cupom|desconto/i;

/** Pure: `true` quando `text` (título+corpo do candidato) contém vocabulário de conteúdo comercial/patrocinado — sinal de baixa confiança, não exclusão automática. */
export function hasSuspiciousCommercialLanguage(text: string): boolean {
  return SUSPICIOUS_COMMERCIAL_RE.test(text);
}

// ─── Ranking + desempate ────────────────────────────────────────────────────

/**
 * Pure: `true` quando a diferença de taxa entre `a` e `b` é menor que "o
 * valor de 1 clique" — usa o MAIOR incremento-de-1-clique entre os dois (o
 * denominador menor produz o incremento maior; usar o maior dos dois é a
 * leitura generosa/conservadora — nunca subestima o ruído). `opens <= 0` em
 * qualquer lado desativa a banda de ruído (não há como calibrar o incremento
 * de 1 clique sem denominador) — comparação cai pra diferença estrita.
 */
export function withinClickNoise<T extends ClickRankedCandidate>(a: T, b: T): boolean {
  if (a.opens <= 0 || b.opens <= 0) return a.ratePct === b.ratePct;
  const oneClickPct = Math.max(100 / a.opens, 100 / b.opens);
  return Math.abs(a.ratePct - b.ratePct) < oneClickPct;
}

const PROFESSIONAL_IMPLICATION_RE =
  /emprego|carreira|trabalh|profiss|mercado de trabalho|curr[ií]culo|vaga|contrata[çc][ãa]o|demiss/i;

/** Pure: heurística de "implicação profissional" — palavra-chave em título/categoria/corpo. */
export function hasProfessionalImplication<T extends ClickRankedCandidate>(c: T): boolean {
  return PROFESSIONAL_IMPLICATION_RE.test(`${c.title} ${c.category} ${c.body}`);
}

/** Pure: heurística de "ângulo Brasil" — reusa `classifyOrigin` (mesmo classificador do CTR table). */
export function hasBrazilAngle<T extends ClickRankedCandidate>(c: T): boolean {
  let domain = "";
  try {
    domain = new URL(c.url).hostname;
  } catch {
    // URL ilegível — domain fica vazio, classifyOrigin decide só pelo texto.
  }
  return classifyOrigin(`${c.title} ${c.body} ${c.why} ${c.category}`, domain) === "BR";
}

/**
 * Pure: score do critério editorial de desempate (#4456: "ângulo Brasil >
 * implicação profissional > diversidade de categoria"). Pesos em ordem
 * lexicográfica estrita (100 > 50 > 10 — nenhuma combinação dos critérios
 * mais fracos supera o mais forte).
 */
export function editorialTiebreakScore<T extends ClickRankedCandidate>(
  c: T,
  alreadySelectedCategories: Set<string>,
): number {
  let score = 0;
  if (hasBrazilAngle(c)) score += 100;
  if (hasProfessionalImplication(c)) score += 50;
  if (!alreadySelectedCategories.has(c.category.toUpperCase())) score += 10;
  return score;
}

/** Pure: ordena por taxa de clique desc, desempate estável por título. */
export function byRateDescThenTitle<T extends ClickRankedCandidate>(a: T, b: T): number {
  return b.ratePct - a.ratePct || a.title.localeCompare(b.title);
}

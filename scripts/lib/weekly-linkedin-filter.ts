/**
 * weekly-linkedin-filter.ts (#4456)
 *
 * Exclusão de links comerciais/afiliados/propriedades próprias da seleção
 * por clique da newsletter semanal do LinkedIn — comentário 260802 (2º) do
 * #4456: "Excluir do cálculo: blocos de Divulgação, afiliados (Amazon,
 * Wispr Flow, Clarice, Beehiiv), apoia.se, propriedades próprias (cursos.,
 * livros., eia., o próprio diar.ia.br), links de preferências e
 * descadastro." — sem isso, `prepara.com.br` (Divulgação, 6 cliques, o mais
 * clicado de julho) e `livros.diar.ia.br` (propriedade própria, 5 cliques)
 * contaminam o topo do ranking com clique de anúncio/link próprio em vez de
 * matéria.
 *
 * Reusa os domínios canônicos de `scripts/lib/canonical-urls.ts` (fonte
 * única já usada por CTR/dedup) em vez de hardcodear os hosts de novo.
 */

import {
  DIARIA_APOIASE_URL,
  DIARIA_CURSOS_URL,
  DIARIA_LIVROS_URL,
  DIARIA_EIA_URL,
} from "./canonical-urls.ts";

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
 * seleção por clique da newsletter semanal do LinkedIn.
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
 * em julho/2026 (ver docstring do arquivo). Esta função NÃO bloqueia — só
 * sinaliza pra revisão humana no gate (Passo 3 do SKILL.md) quando o
 * TÍTULO/CORPO de um candidato de clique alto contém vocabulário típico de
 * conteúdo patrocinado/parceria, mesmo que o domínio não bata em nada da
 * blocklist.
 */
const SUSPICIOUS_COMMERCIAL_RE = /parceria|patrocinad[oa]|divulga[çc][ãa]o|cupom|desconto/i;

/** Pure: `true` quando `text` (título+corpo do candidato) contém vocabulário de conteúdo comercial/patrocinado — sinal de baixa confiança, não exclusão automática. */
export function hasSuspiciousCommercialLanguage(text: string): boolean {
  return SUSPICIOUS_COMMERCIAL_RE.test(text);
}

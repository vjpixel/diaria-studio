// #4053: classificador de URL→conteúdo, puro e sem I/O.
//
// Motivação: as tabelas "Links mais clicados" (drill-down por campanha e
// agregado do período) indexavam por URL completa ou por origin — nenhuma
// das duas é "conteúdo". Caso concreto: a enquete "É IA?" tem 2 links por
// edição (`?...&choice=A` e `?...&choice=B`, mesmo conteúdo, resposta
// diferente) que caíam em 2 linhas com metade dos cliques cada — afundando o
// item no ranking. Este módulo resolve a URL num rótulo de CONTEÚDO estável,
// usado como chave de agrupamento em `render-links.ts`.
//
// Regras ordenadas (a primeira que casar vence), com fallback determinístico:
//   1. Enquete "É IA?" (`/vote?...&choice=A|B` no worker de poll) → rótulo
//      único, cliques de A+B somados. O split A/B fica disponível como
//      `variant` (detalhe secundário útil — sinal editorial — mas não entra
//      na chave de agrupamento).
//   2. Links afiliados da Clarice (`?via=diaria`) → "Clarice".
//   3. Superfícies próprias por host (livros/cursos/leaderboard/home).
//   4. Fallback: URL normalizada — remove `utm_*` e outros params de
//      tracking conhecidos, remove barra final, minúsculas no host. Isso já
//      resolve sozinho "mesmo destino, UTMs diferentes".

/** Hosts do worker de poll ("É IA?"). #3904: domínio de marca é eia.diar.ia.br;
 *  poll.diaria.workers.dev mantido por retrocompat com deploys/fixtures antigos. */
const POLL_HOSTS = new Set(["eia.diar.ia.br", "poll.diaria.workers.dev"]);

/** Hosts da Clarice (afiliado via Rewardful, `?via=diaria`). */
const CLARICE_HOSTS = new Set(["clarice.ai", "www.clarice.ai"]);

const OWN_HOST_LABELS: Record<string, string> = {
  "livros.diar.ia.br": "Curadoria de livros",
  "cursos.diar.ia.br": "Cursos",
};

const HOME_HOSTS = new Set(["diar.ia.br", "www.diar.ia.br"]);

/**
 * Parâmetros de tracking removidos na normalização de fallback (regra 4).
 * `utm_*` é tratado à parte (prefixo, não lista fechada).
 */
const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "igshid",
]);

function isTrackingParam(name: string): boolean {
  return /^utm_/i.test(name) || TRACKING_PARAM_NAMES.has(name.toLowerCase());
}

/**
 * Normaliza uma URL removendo params de tracking, barra final do path e
 * uppercase do host. Usada tanto pelo fallback (regra 4) quanto como helper
 * de exibição. Nunca lança — URL não-parseável retorna a string original.
 */
export function normalizeUrlForContent(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }

  const params = new URLSearchParams(u.search);
  for (const key of Array.from(params.keys())) {
    if (isTrackingParam(key)) params.delete(key);
  }
  // Ordena os params restantes — evita que a mesma URL com params em ordens
  // diferentes vire "conteúdo" diferente (ex: ?a=1&b=2 vs ?b=2&a=1).
  params.sort();
  const search = params.toString();

  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  const host = u.hostname.toLowerCase();
  return `${u.protocol}//${host}${path}${search ? `?${search}` : ""}`;
}

/**
 * Resultado da classificação de uma URL em conteúdo editorial.
 */
export interface LinkContentClassification {
  /** Rótulo de conteúdo — usado como CHAVE de agrupamento pelas tabelas. */
  content: string;
  /**
   * Detalhe secundário opcional (não entra na chave de agrupamento) — ex:
   * o choice ("A"/"B") da enquete É IA?, útil como sinal editorial mas que
   * não deve fragmentar o ranking.
   */
  variant?: string;
}

/**
 * Classifica uma URL em um rótulo de conteúdo estável, seguindo as 4 regras
 * ordenadas do módulo (poll A/B → Clarice afiliado → superfícies próprias →
 * fallback normalizado). Pura, determinística, nunca lança — URLs
 * malformadas caem no fallback (retornam a string original como conteúdo).
 */
export function classifyLinkContent(url: string): LinkContentClassification {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // URL não-parseável: sem host pra classificar — usa a própria string
    // como rótulo de conteúdo (fallback determinístico, nunca crasha).
    return { content: url };
  }

  const host = u.hostname.toLowerCase();

  // 1. Enquete "É IA?" — /vote?...&choice=A|B
  if (POLL_HOSTS.has(host) && u.pathname === "/vote") {
    const choice = u.searchParams.get("choice");
    return { content: "É IA? (voto)", variant: choice ?? undefined };
  }

  // 2. Clarice afiliado (?via=diaria)
  if (CLARICE_HOSTS.has(host) && u.searchParams.get("via") === "diaria") {
    return { content: "Clarice" };
  }

  // 3. Superfícies próprias por host
  if (OWN_HOST_LABELS[host]) {
    return { content: OWN_HOST_LABELS[host] };
  }
  if (POLL_HOSTS.has(host) && u.pathname.startsWith("/leaderboard")) {
    return { content: "Leaderboard É IA?" };
  }
  if (HOME_HOSTS.has(host) && (u.pathname === "/" || u.pathname === "")) {
    return { content: "Diar.ia (home)" };
  }

  // 4. Fallback: URL normalizada (resolve "mesmo destino, UTMs diferentes")
  return { content: normalizeUrlForContent(url) };
}

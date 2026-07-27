/**
 * launch-detect.ts (#487)
 *
 * Heurística leve pra detectar artigos de cobertura de imprensa que provavelmente
 * são *lançamentos* mas estão na bucket "noticia" porque a URL não é da fonte
 * oficial. Útil pra sinalizar ao editor candidatos a substituição (regra editorial
 * #160 — LANÇAMENTOS só com link oficial).
 *
 * Não faz fetch / web search. Apenas (a) detecta verbos de lançamento no
 * título/summary e (b) mapeia nome de empresa conhecida pro domínio oficial
 * provável. O editor decide se vale procurar e substituir.
 *
 * Edge: matches são best-effort; um título tipo "TechCrunch reports that
 * OpenAI may launch X" gera candidato porque "OpenAI" e "launch" aparecem.
 * Falsos positivos são preferíveis a falsos negativos — o editor revisa.
 */

import { companyToDomain } from "./official-domains.ts"; // #566

const LAUNCH_KEYWORDS: RegExp[] = [
  // EN
  /\blaunche?s?\b/i,
  /\breleases?\b/i,
  /\bannounces?\b/i,
  /\bunveils?\b/i,
  /\bdebuts?\b/i,
  /\bintroduces?\b/i,
  /\brolls? out\b/i,
  /\brolling out\b/i,
  /\bships?\b/i,
  /\bavailable now\b/i,
  /\bgenerally available\b/i,
  /\bopen-?sources?\b/i,
  // PT — voz ativa ("Empresa lança X")
  /\blan[çc]a(m|r|ndo)?\b/i,
  /\bapresenta(m|r|ndo)?\b/i,
  /\banuncia(m|r|ndo)?\b/i,
  /\bestreia(m|r|ndo)?\b/i,
  /\bdisponibiliza(m|r|ndo)?\b/i,
  /\bdisponível agora\b/i,
  // PT — voz passiva (#4080), formas simples/futura/progressiva: "X é/foi
  // lançado(a)(s) [pela Empresa]", "X será/serão lançado" (futura, anúncio já
  // confirmado — não confundir com modal "deve"/"pode", ver nota de escopo
  // abaixo), "X está/estão sendo lançado" ou "vem/vêm sendo apresentado"
  // (progressiva, #4080 self-review, PR #4134). "sendo" é opcional no grupo pra cobrir
  // simples/futura (sem "sendo") e progressiva (com "sendo") num regex só.
  // Cobre lançar/anunciar/apresentar nas duas flexões de gênero/número; a
  // empresa é detectada em qualquer posição do título pela regra 2 (haystack
  // completo), então não importa se vem antes ou depois do verbo.
  //
  // Nota de escopo (#4080 self-review, PR #4134): deliberadamente NÃO cobre modal +
  // infinitivo ("deve chegar em 2027", "pode ser anunciado ainda este ano")
  // — são rumor/especulação, não anúncio consumado. "deve"/"pode" não entram
  // no grupo de verbos, e "chegar"/"ser" (infinitivo) não casam com o grupo
  // abaixo (que exige a forma conjugada é/foi/são/foram/será/serão/está/
  // estão/vem/vêm) nem com o regex de "chega" mais abaixo (que exige a forma
  // conjugada "chega"/"chegam", não o infinitivo "chegar"). Ver teste
  // negativo correspondente.
  //
  // Nota: usa lookbehind `(?<=^|\s)` em vez de `\b` antes do grupo — "é" é um
  // caractere acentuado, fora de `\w` (ASCII-only em regex JS sem flag `u`),
  // então `\b` nunca encontra fronteira antes dele (os dois lados — espaço e
  // "é" — contam como "não-\w") e o match falha silenciosamente. `\b` depois
  // do particípio funciona normal (termina em o/a/s, todos `\w`).
  /(?<=^|\s)(é|foi|são|foram|será|serão|está|estão|vem|vêm)\s+(sendo\s+)?(lan[çc]ad|anunciad|apresentad)[oa]s?\b/i,
  // PT — "X ganha (nova) versão" (feature/produto novo sem verbo de anúncio).
  /\bganha(m)?\s+(nova\s+)?vers[ãa]o\b/i,
  // PT — "X chega ao/à/no/na/para <lugar>" (chegada de produto ao mercado).
  // Deliberadamente NÃO casa "chega a <valor/número>" (ex: "mercado de IA
  // chega a US$ 50 bilhões") — esse uso é estatística/análise, não lançamento;
  // ver #4080 e o teste negativo correspondente.
  //
  // #4080 self-review, PR #4134: duas travas adicionais contra sentido não-lançamento —
  // (a) `(?!\w)` depois do grupo de preposição garante palavra INTEIRA, não
  // prefixo: sem essa trava "chega aos 10 anos" casava "chega ao" (prefixo de
  // "aos") e virava falso-positivo de aniversário/marco temporal; (b) segundo
  // lookahead negativo exclui "chega à/ao marca/número ..." (marco de uso —
  // "chega à marca de 800 milhões de usuários" — não é lançamento, mesmo
  // sendo gramaticalmente "chegada a um lugar-conceito").
  /\bchega(m)?\s+(ao|à|as|no|na|para)(?!\w)(?!\s+(marca|n[uú]mero)\b)/i,
];

/**
 * Mapa empresa → domínio oficial pra sugestão de fonte primária.
 * Derivado de `scripts/lib/official-domains.ts` (fonte única de verdade).
 * Para adicionar empresa nova: editar official-domains.ts, não aqui.
 */
export const COMPANY_TO_DOMAIN = companyToDomain();

export interface LaunchCandidate {
  is_candidate: boolean;
  /** Verbo de lançamento detectado (primeira ocorrência). */
  matched_keyword?: string;
  /** Empresa identificada por keyword no título/summary. */
  matched_company?: string;
  /** Domínio oficial sugerido pra busca de fonte primária. */
  suggested_domain?: string;
}

/**
 * Detecta se um artigo é candidato a virar LANÇAMENTO via fonte primária.
 *
 * Regras (todas obrigatórias):
 * 1. Título contém verbo de lançamento.
 * 2. Título OU summary contém nome de empresa conhecida.
 * 3. URL atual NÃO é do domínio oficial dessa empresa (senão já é lançamento).
 *
 * Quando 1 e 2 batem mas o autor da regra 3 não pôde ser verificada (ex: domínio
 * desconhecido), retorna candidato mesmo assim — editor decide.
 */
export function detectLaunchCandidate(article: {
  title?: string;
  summary?: string | null;
  url?: string;
}): LaunchCandidate {
  const title = article.title ?? "";
  const summary = article.summary ?? "";
  const haystack = `${title}\n${summary}`;

  // Regra 1: verbo de lançamento no título.
  let matchedKeyword: string | undefined;
  for (const re of LAUNCH_KEYWORDS) {
    const m = title.match(re);
    if (m) {
      matchedKeyword = m[0];
      break;
    }
  }
  if (!matchedKeyword) return { is_candidate: false };

  // Regra 2: empresa conhecida no título ou summary.
  let matchedCompany: string | undefined;
  let suggestedDomain: string | undefined;
  for (const { keyword, domain } of COMPANY_TO_DOMAIN) {
    const m = haystack.match(keyword);
    if (m) {
      matchedCompany = m[0];
      suggestedDomain = domain;
      break;
    }
  }
  if (!matchedCompany || !suggestedDomain) {
    return { is_candidate: false };
  }

  // Regra 3: URL atual não é do domínio oficial.
  if (article.url) {
    let host = "";
    try {
      host = new URL(article.url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
    if (host && (host === suggestedDomain || host.endsWith(`.${suggestedDomain}`))) {
      // Já é do domínio oficial — nesse caso categorize.ts deveria ter
      // classificado como lancamento. Não-candidato.
      return { is_candidate: false };
    }
  }

  return {
    is_candidate: true,
    matched_keyword: matchedKeyword,
    matched_company: matchedCompany,
    suggested_domain: suggestedDomain,
  };
}

/**
 * launch-vs-news.ts (#1442)
 *
 * Distingue **lançamento de produto/feature** de **anúncio institucional**
 * (parceria geográfica, programa por país, evento, abertura de escritório)
 * quando o domínio fonte é oficial (openai.com, anthropic.com, blog.google,
 * etc.). Esses anúncios institucionais tem que ir pra NOTÍCIAS, não
 * LANÇAMENTOS — mesmo que o título use o verbo "Introducing".
 *
 * Histórico do bug (260521):
 *   - "Introducing OpenAI for Singapore" (programa de parceria gov plurianual)
 *   - "The next phase of OpenAI's Education for Countries" (programa educacional)
 *   Foram classificados como LANÇAMENTOS (domínio oficial + verbo "Introducing"),
 *   empurrando lançamentos reais (OlmoEarth v1.1) pro pool de Outras Notícias.
 *   Editor flagou pós-pipeline.
 *
 * Cobertura desta heurística (complementa DEAL_PATTERNS / NON_PRODUCT_ANNOUNCEMENT
 * / CUSTOMER_STORY do `categorize.ts`):
 *   - "{Product} for {Country}" — programa geográfico específico
 *   - "for Countries" — programa multi-país
 *   - "opens office in {City}" — expansão geográfica
 *   - "Summit {Year}" — evento (não lançamento)
 *
 * Não cobre (já capturado em categorize.ts):
 *   - "X acquires Y" → DEAL_PATTERNS
 *   - "X expands partnership with Y" → DEAL_PATTERNS
 *   - "X partners with Y" → CUSTOMER_STORY_PATTERNS
 */

/**
 * Lista canônica de países que aparecem em programas geográficos. Mantida
 * conservadora pra evitar falso positivo (produto com nome geográfico raro
 * — ex: "Andes" não é programa por país; um lançamento "Atlas" também não).
 *
 * Match exige preâmbulo "for {Country}" — produto-name-only sem "for" não
 * dispara o pattern.
 */
const COUNTRY_NAMES = [
  "Singapore",
  "Brazil",
  "Brasil",
  "Mexico",
  "México",
  "India",
  "Índia",
  "Germany",
  "France",
  "UK",
  "Japan",
  "Japão",
  "Korea",
  "Coreia",
  "Indonesia",
  "Indonésia",
  "Vietnam",
  "Vietnã",
  "Philippines",
  "Filipinas",
  "Thailand",
  "Tailândia",
  "Malaysia",
  "Malásia",
  "Argentina",
  "Chile",
  "Colombia",
  "Colômbia",
  "Peru",
  "Spain",
  "Espanha",
  "Italy",
  "Itália",
  "Portugal",
  "Netherlands",
  "Sweden",
  "Suécia",
  "Norway",
  "Noruega",
  "Denmark",
  "Dinamarca",
  "Finland",
  "Finlândia",
  "Israel",
  "Egypt",
  "Egito",
  "Saudi Arabia",
  "Arábia Saudita",
  "UAE",
  "Kenya",
  "Quênia",
  "Nigeria",
  "Nigéria",
  "South Africa",
  "África do Sul",
  "Australia",
  "Austrália",
  "New Zealand",
  "Nova Zelândia",
  "Canada",
  "Canadá",
  "China",
  "Russia",
  "Rússia",
  "Turkey",
  "Turquia",
  "Greece",
  "Grécia",
  "Poland",
  "Polônia",
  "Hungary",
  "Hungria",
  "Romania",
  "Romênia",
  "Bulgaria",
  "Bulgária",
  "Czech Republic",
  "Tcheca",
  "Switzerland",
  "Suíça",
  "Austria",
  "Áustria",
  "Belgium",
  "Bélgica",
  "Ireland",
  "Irlanda",
  "Scotland",
  "Escócia",
  "Wales",
  "País de Gales",
];

const COUNTRY_ALTERNATION = COUNTRY_NAMES.map((c) =>
  c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|");

/**
 * Padrões de título que indicam anúncio institucional (não produto/feature)
 * mesmo em domínio oficial. Cada match retorna `true` em `isLikelyNewsNotLaunch`.
 */
export const NEWS_TITLE_PATTERNS: RegExp[] = [
  // "for {Country}" — programa/produto específico pra um país
  // Ex: "Introducing OpenAI for Singapore", "Claude for Brazil"
  new RegExp(`\\bfor\\s+(${COUNTRY_ALTERNATION})\\b`, "i"),
  // "for Countries" (plural) — programa multi-país
  // Ex: "The next phase of OpenAI's Education for Countries"
  /\bfor\s+Countries\b/i,
  /\bpara\s+pa[ií]ses\b/i,
  // "opens office in {City/Country}" — expansão geográfica
  /\bopens?\s+(?:new\s+)?office\b/i,
  /\babre\s+(?:novo\s+)?escrit[óo]rio\b/i,
  // "Summit {Year}" / "{Year} Summit" — evento, não lançamento
  /\bsummit\s+\d{4}\b/i,
  /\b\d{4}\s+summit\b/i,
  // "X at Cloud Next" — apresentação em evento, não lançamento standalone
  /\bat\s+Cloud\s+Next\b/i,
  // Programa governamental explícito
  /\bgovernment(al)?\s+program\b/i,
  /\bprograma\s+governamental\b/i,
];

/**
 * Pure (#1442): retorna `true` se o título indica anúncio institucional
 * (parceria geográfica, programa por país, evento, abertura de escritório)
 * em vez de lançamento de produto/feature.
 *
 * Caller em `categorize.ts` aplica este check em URLs de domínio oficial
 * pra reclassificar pra `noticias`. Não afeta jornalismo (que já cai em
 * noticias por default).
 */
export function isLikelyNewsNotLaunch(title: string): boolean {
  if (!title) return false;
  return NEWS_TITLE_PATTERNS.some((re) => re.test(title));
}

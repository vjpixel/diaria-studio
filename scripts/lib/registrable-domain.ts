/**
 * registrable-domain.ts (#5735)
 *
 * Extrai o domínio registrável (eTLD+1) de uma URL, sem dependência de uma
 * lista PSL completa — um sufixo-list mínimo dos padrões `.com.br`/`.co.uk`
 * de 2 níveis já cobertos pelo corpus de fontes do projeto basta (decisão
 * documentada na issue: "sem dependência nova de PSL se um sufixo-list
 * mínimo resolver o corpus real"). Usado por
 * `scripts/validate-domain-diversity.ts` pra aplicar o cap "no máximo 2 URLs
 * do mesmo domínio por edição" — `blog.openai.com` e `openai.com` precisam
 * cair no MESMO agrupamento (`openai.com`).
 *
 * Não confundir com `scripts/lib/paywalls.ts`/`scripts/lib/aggregators.ts`
 * (que fazem match de host exato ou por sufixo pra um propósito diferente —
 * bloquear/permitir, não agrupar).
 */

/**
 * Sufixos de 2º nível conhecidos onde o "domínio" de fato precisa de 3
 * labels (`example.co.uk`, não `co.uk`). Lista deliberadamente pequena —
 * cobre os TLDs country-code mais comuns que aparecem em fontes de
 * tecnologia/notícia; não pretende ser exaustiva como a Public Suffix List.
 * Se um domínio real escapar disso, adicionar aqui é o fix (não subir pra
 * dependência de PSL sem necessidade concreta — ver docstring do módulo).
 */
const TWO_LEVEL_SUFFIXES = new Set([
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "edu.br",
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "co.jp",
  "co.in",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.za",
  "co.id",
  "co.kr",
  "com.mx",
  "com.ar",
  "com.co",
]);

/**
 * Extrai o hostname de uma URL. Retorna `null` se a URL for inválida (o
 * caller decide o que fazer — `validate-domain-diversity.ts` ignora URLs
 * que não parseiam, mesma postura de `validate-domains.ts`).
 */
export function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Domínio registrável (eTLD+1) a partir de um hostname já normalizado
 * (minúsculo, sem protocolo/path). `blog.openai.com` → `openai.com`;
 * `www.example.co.uk` → `example.co.uk`; `openai.com` → `openai.com`
 * (idempotente); hostname de 1 label (`localhost`) → devolvido como está.
 * @pure
 */
export function registrableDomainFromHostname(hostname: string): string {
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");

  const lastTwo = labels.slice(-2).join(".");
  const takeLast = TWO_LEVEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-takeLast).join(".");
}

/**
 * Domínio registrável (eTLD+1) direto de uma URL completa. `null` se a URL
 * não parsear. @pure (exceto pela chamada a `new URL`, que não tem efeito
 * colateral observável).
 */
export function registrableDomain(url: string): string | null {
  const hostname = extractHostname(url);
  if (!hostname) return null;
  return registrableDomainFromHostname(hostname);
}

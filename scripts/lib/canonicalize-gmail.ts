/**
 * canonicalize-gmail.ts (#1969)
 *
 * Forma canônica de um endereço de e-mail pra MATCHING (não pra exibição).
 *
 * O Gmail ignora **pontos** no local-part e descarta o sufixo **`+tag`**:
 * `diaria.editor@gmail.com`, `diariaeditor@gmail.com` e
 * `diaria.editor+news@googlemail.com` são a MESMA caixa. A entrega não tem
 * problema (tudo cai no mesmo inbox), mas o matching por string no código
 * tratava as formas como diferentes — submissões endereçadas à forma com ponto
 * eram silenciosamente mal-contadas/mal-filtradas (caso real 260609).
 *
 * Regra (só pra gmail.com / googlemail.com):
 *   - lowercase + trim;
 *   - extrai o e-mail de um header `"Nome" <email>` (ou acha o 1º token e-mail);
 *   - remove TODOS os pontos do local-part;
 *   - descarta o sufixo `+tag`;
 *   - normaliza o domínio googlemail.com → gmail.com (mesma caixa).
 *
 * Domínios não-Gmail: lowercase + extração apenas (pontos/+tags podem ser
 * significativos fora do Gmail — não mexer).
 */

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);
const EMAIL_TOKEN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/**
 * Extrai o e-mail de um header From (`"Nome" <email>` → `email`), ou o 1º token
 * que pareça e-mail numa string solta. Sem match → devolve a entrada trimada.
 */
export function extractEmail(from: string): string {
  const angle = from.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  const bare = from.match(EMAIL_TOKEN_RE);
  return (bare ? bare[0] : from).trim();
}

/** Forma canônica pra comparação (ver doc do módulo). */
export function canonicalizeGmail(addr: string): string {
  const email = extractEmail(addr).toLowerCase();
  const at = email.lastIndexOf("@");
  if (at === -1) return email;
  let local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    local = local.replace(/\+.*$/, "").replace(/\./g, "");
    return `${local}@gmail.com`;
  }
  return `${local}@${domain}`;
}

/** `true` se os dois endereços são a mesma caixa (canonicalizados). */
export function gmailEquivalent(a: string, b: string): boolean {
  return canonicalizeGmail(a) === canonicalizeGmail(b);
}

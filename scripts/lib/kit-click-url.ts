/**
 * kit-click-url.ts (#11403)
 *
 * O Kit embrulha todo link do e-mail entregue no domínio de click tracking
 * (`https://{conta}.click.kit-mail3.com/{token-assinante}/{id-link}/{destino}`),
 * e o último segmento do path é o destino original em base64url. Achado ao
 * vivo no e-mail de teste da 261028: as 40 âncoras do corpo seguem esse
 * formato, e decodificar o último segmento devolve a URL de destino exata
 * (inclusive o voto do É IA? já com a merge tag expandida,
 * `.../vote/261028/A?email=...`).
 *
 * Premissa documentada: o formato do path é observado, não contratual — se o
 * Kit mudar o esquema, `decodeKitClickUrl` devolve `null` (nunca lança) e quem
 * chama trata o link como opaco, igual ao comportamento anterior.
 */

/** Hosts de click tracking do Kit (`*.click.kit-mail3.com`, variações numéricas e o legado ConvertKit). */
const KIT_CLICK_HOST_RE = /\.click\.(?:kit-mail\d*|convertkit-mail\d*)\.com$/i;

/** True se a URL é um link embrulhado pelo click tracking do Kit. */
export function isKitClickUrl(url: string): boolean {
  try {
    return KIT_CLICK_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Decodifica o destino original de um link de click tracking do Kit.
 * Retorna `null` se a URL não é do Kit ou se o último segmento não decodifica
 * para uma URL http(s)/mailto.
 */
export function decodeKitClickUrl(url: string): string | null {
  if (!isKitClickUrl(url)) return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const seg = path.split("/").filter(Boolean).pop();
  if (!seg || !/^[A-Za-z0-9_-]+={0,2}$/.test(seg)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return null;
  }
  return /^(?:https?:\/\/|mailto:)/i.test(decoded) ? decoded : null;
}

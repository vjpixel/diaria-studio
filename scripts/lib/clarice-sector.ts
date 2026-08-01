/**
 * clarice-sector.ts — classificação de SETOR por e-mail (260731).
 *
 * Dimensão ORTOGONAL ao `cohort` (safra de cadastro): uma pessoa é
 * `leads-2024h2` E jurídica ao mesmo tempo. Por isso setor nunca sobrescreve
 * `cohort` no store nem entra na tabela Cohorts do dashboard (a soma das
 * linhas deixaria de bater com o total) — mora numa tabela própria.
 *
 * Hoje só o setor JURÍDICO está implementado, porque é o único com uso real
 * (proposta de Chat Jurídico + a leitura de 260731: o segmento abre 25,5%,
 * contra 10,4% da base geral). O módulo é dependency-free de propósito, no
 * mesmo espírito de `cohorts.ts` — dá pra importar do worker sem arrastar
 * node:fs/sqlite.
 *
 * DOIS SINAIS, unidos (nenhum sozinho basta):
 *
 *   1. domínio  — sufixo `.adv.br`/`.jus.br`, ou nome de domínio PRÓPRIO
 *                 (não-genérico) com marca jurídica.
 *   2. handle   — marcador jurídico no local-part, mesmo em provedor genérico
 *                 (`advogado.fulano@gmail.com`).
 *
 * O sinal 2 não é um extra: medido em 260731 sobre a base inteira, o detector
 * por domínio SOZINHO via 331 de 1.246 contatos — 27% do segmento. A maioria
 * dos advogados da base usa Gmail e se identifica no handle.
 */

/** Provedores de e-mail genéricos — domínio aqui não diz nada sobre profissão. */
const GENERIC_DOMAINS = new Set([
  "gmail.com", "hotmail.com", "outlook.com", "yahoo.com.br", "yahoo.com",
  "hotmail.com.br", "live.com", "icloud.com", "bol.com.br", "uol.com.br",
  "terra.com.br", "msn.com", "globo.com", "ig.com.br", "me.com",
  "outlook.com.br", "protonmail.com", "proton.me", "oi.com.br",
  "zipmail.com.br", "r7.com", "aol.com", "yandex.com", "yandex.ru",
  "gmail.com.br", "outlook.es", "outlook.pt", "hotmail.es", "hotmail.fr",
  "yahoo.es", "gmx.com", "mail.com", "mail.ru", "email.com", "inbox.com",
  "rocketmail.com", "ymail.com", "live.com.br", "live.com.pt", "aol.com.br",
  "sapo.pt", "clix.pt", "iol.pt",
  // erros de digitação comuns — genéricos do mesmo jeito
  "gmial.com", "gmai.com", "gmail.co", "hotmail.co", "gmail.con", "hotmai.com",
  "htomail.com", "gamil.com", "gmail.cm", "gmail.om", "gmaill.com",
  "gmailcom.com", "hotmail.con", "hotmial.com", "outlok.com", "icloud.con",
  "yaho.com",
]);

/**
 * Sufixos de domínio que JÁ identificam o setor sozinhos — registro restrito
 * no Brasil: `.adv.br` exige inscrição na OAB, `.jus.br` é do Judiciário.
 */
const JURIDICO_SUFFIXES = ["adv.br", "jus.br"] as const;

/** Marca jurídica no NOME do domínio próprio (ex: `silvaadvocacia.com.br`). */
const JURIDICO_DOMAIN_RE =
  /(advocac|advogad|juridic|jurídic|(^|[.-])adv([.-]|$)|(^|[.-])oab([.-]|$)|lawyer|(^|[.-])law([.-]|$)|sociedadedeadv|escritoriojur)/i;

/**
 * Marcador jurídico no local-part. Delimitado de propósito (início, separador
 * ou dígito) — sem isso, `adv` casaria dentro de "advento", "adverso",
 * "advindo" e encheria o segmento de falso-positivo.
 */
const JURIDICO_HANDLE_RE =
  /(^|[._-])(adv|advs|advogad[oa]s?|advocacia|advogada|juridic[oa]|oab|escritoriojur)([._-]|[0-9]|$)/i;

/** Separa o domínio no par (nome, sufixo) para os sufixos que nos interessam. */
export function splitJuridicoSuffix(domain: string): { name: string; suffix: string } {
  for (const s of JURIDICO_SUFFIXES) {
    if (domain === s) return { name: "", suffix: s };
    if (domain.endsWith("." + s)) return { name: domain.slice(0, -(s.length + 1)), suffix: s };
  }
  return { name: domain, suffix: "" };
}

/** O domínio é de provedor genérico (não diz nada sobre a profissão)? */
export function isGenericDomain(domain: string): boolean {
  return GENERIC_DOMAINS.has(domain.trim().toLowerCase());
}

/** Como este contato foi identificado como jurídico (null = não é). */
export type JuridicoSignal = "dominio" | "handle" | "ambos" | null;

/**
 * Que tipo de contato jurídico é — usado só para exibição/segmentação fina.
 * `null` quando o contato não é do setor.
 */
export type JuridicoKind =
  | "escritorio" // .adv.br — registro exige OAB
  | "tribunal" // .jus.br — Judiciário
  | "dominio-proprio" // domínio próprio com marca jurídica
  | "handle" // provedor genérico, marcador no handle
  | null;

/** Divide o e-mail em (local, domínio), ambos minúsculos. `null` se malformado. */
function parseEmail(email: string): { local: string; domain: string } | null {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1 || at === e.length - 1) return null;
  return { local: e.slice(0, at), domain: e.slice(at + 1) };
}

/** Qual(is) sinal(is) marcam este e-mail como do setor jurídico. */
export function juridicoSignal(email: string): JuridicoSignal {
  const parsed = parseEmail(email);
  if (!parsed) return null;
  const { local, domain } = parsed;

  const { name, suffix } = splitJuridicoSuffix(domain);
  const porDominio = suffix !== ""
    ? true
    : !isGenericDomain(domain) && JURIDICO_DOMAIN_RE.test(name);
  const porHandle = JURIDICO_HANDLE_RE.test(local);

  if (porDominio && porHandle) return "ambos";
  if (porDominio) return "dominio";
  if (porHandle) return "handle";
  return null;
}

/** O contato pertence ao setor jurídico? (domínio ∪ handle) */
export function isJuridicoEmail(email: string): boolean {
  return juridicoSignal(email) !== null;
}

/** Subtipo do contato jurídico, para exibição. `null` se não for do setor.
 * #4406: sem consumidor de produção hoje (a tabela Cohorts usa só
 * `isJuridicoEmail`, 1 linha agregada — decisão do editor). Mantido/testado
 * como utilitário puro pra um futuro drill-down por subtipo, se pedido. */
export function juridicoKind(email: string): JuridicoKind {
  const signal = juridicoSignal(email);
  if (signal === null) return null;
  const parsed = parseEmail(email);
  if (!parsed) return null;
  const { suffix } = splitJuridicoSuffix(parsed.domain);
  if (suffix === "adv.br") return "escritorio";
  if (suffix === "jus.br") return "tribunal";
  return signal === "handle" ? "handle" : "dominio-proprio";
}

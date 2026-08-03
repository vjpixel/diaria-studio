/**
 * apoio-email-heuristics.ts (#4490 causa 3)
 *
 * `diffApoioTags` (`scripts/sync-apoio-nivel-beehiiv.ts`) casa um apoiador da
 * apoia.se contra uma subscription Beehiiv por E-MAIL EXATO. Medido ao vivo
 * em 260802: 5 dos 21 contatos usam um e-mail diferente em cada sistema —
 * `diffApoioTags` os relatava como "sem nenhuma subscription Beehiiv casada
 * (não é erro)", uma leitura que soa conclusiva ("não assina a newsletter")
 * mas era falsa pra 4 deles:
 *
 *   | Apoiador | apoia.se                        | Beehiiv                    |
 *   |----------|----------------------------------|-----------------------------|
 *   | MURILO   | murilo.sarno@online.uscs.edu.br  | murilosarno@gmail.com       |
 *   | Vanessa  | creek.soup.8q@icloud.com (alias) | vanessaventuracontato@gmail.com |
 *   | Hugo     | oliveira.pena.h@gmail.com        | behiiv@hugopenna.com (domínio próprio) |
 *   | Fabiana  | fbartholo@hotmail.com            | fabartholo@gmail.com (typo/variação) |
 *
 * Este módulo NUNCA decide um vínculo sozinho — só GERA candidatos (com o
 * motivo da suspeita) pra apresentar ao editor, que confirma manualmente
 * (Passo 5 da skill `/diaria-apoios-sync`). `diffApoioTags` nunca aplica uma
 * mutação baseada num candidato — casamento automático continua exigindo
 * e-mail exato.
 *
 * 4 heurísticas, testadas em ordem (a 1ª que casar decide o motivo reportado
 * — evita listar o mesmo candidato 2x com motivos redundantes):
 *
 *   (a) local-part normalizado (sem pontuação/case) idêntico — cobre Gmail
 *       dot-insensitivity e variação de maiúsculas (ex: MURILO).
 *   (b) nome do contato aparece no local-part do e-mail Beehiiv, ou
 *       vice-versa — cobre alias que preserva o primeiro nome (ex: Vanessa).
 *   (c) domínio do e-mail Beehiiv não é um provedor público comum E é
 *       textualmente parecido (Levenshtein) com o nome do contato — cobre
 *       domínio próprio (ex: Hugo, hugopenna.com).
 *   (d) local-part do e-mail Beehiiv é textualmente parecido (Levenshtein,
 *       distância pequena relativa ao tamanho) com QUALQUER e-mail já
 *       conhecido do contato — cobre typo/variação de grafia (ex: Fabiana,
 *       fbartholo vs fabartholo).
 */

/** #4506 item 5: as 4 heurísticas (a-d, ver cabeçalho do módulo) só geram uma
 * dessas 4 categorias fixas — narrow de `string` livre pra union dá
 * exhaustiveness check de graça pra um futuro consumidor (ex: painel do
 * Studio listando candidatos por categoria). O texto legível pro editor
 * (que antes vivia dentro de `reason`) foi pro campo `detail`, separado. */
export type EmailMatchReason = "local-part" | "name-in-local-part" | "own-domain" | "typo-variant";

export interface EmailMatchCandidate {
  subscriptionId: string;
  email: string;
  /** Categoria fixa da heurística que gerou o candidato (#4506 item 5). */
  reason: EmailMatchReason;
  /** Texto legível pro editor confirmar manualmente — pode embutir dado
   * dinâmico (ex: o e-mail conhecido que bateu por variação/typo), o que
   * `reason` sozinho (union fixa) não comporta. */
  detail: string;
}

interface CurrentSubscription {
  subscriptionId: string;
  email: string;
}

// ---------------------------------------------------------------------------
// Normalização (pura)
// ---------------------------------------------------------------------------

function localPartOf(email: string): string {
  const at = email.indexOf("@");
  return at === -1 ? email : email.slice(0, at);
}

function domainOf(email: string): string {
  const at = email.indexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

/** Remove tudo que não for letra/número (inclusive pontos, +tags, acentos já
 * removidos por `normalizeName`) e força lowercase. */
function normalizeLocalPart(email: string): string {
  return localPartOf(email).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `hugopenna.com` -> `hugopenna` (parte antes do 1º ponto do domínio). */
function domainBase(email: string): string {
  const domain = domainOf(email);
  return domain.split(".")[0] ?? "";
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Provedores de e-mail públicos comuns — um domínio nessa lista NUNCA conta
 * como "domínio próprio" pra heurística (c) (senão TODO gmail.com pareceria
 * "pessoal" contra qualquer nome). */
const COMMON_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "hotmail.com",
  "outlook.com",
  "yahoo.com",
  "yahoo.com.br",
  "icloud.com",
  "live.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "msn.com",
  "globo.com",
  "ig.com.br",
]);

// ---------------------------------------------------------------------------
// Levenshtein (pura, sem dependência externa)
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  const curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev.splice(0, prev.length, ...curr);
  }
  return prev[n];
}

/** `true` quando a distância é pequena o bastante pra ser "provável
 * typo/variação" e não coincidência — distância absoluta <= 2 OU relativa ao
 * comprimento <= 30%. Comprimento mínimo de 4 evita falso-positivo em
 * strings curtas (2 letras têm distância <=2 pra quase tudo). */
function isCloseMatch(a: string, b: string): boolean {
  if (a.length < 4 || b.length < 4) return false;
  const dist = levenshtein(a, b);
  if (dist === 0) return false; // igualdade já é pego pela heurística (a)
  const maxLen = Math.max(a.length, b.length);
  return dist <= 2 || dist / maxLen <= 0.3;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Pure: gera candidatos heurísticos de e-mail pra um apoiador que NÃO casou
 * por e-mail exato contra nenhuma subscription Beehiiv (`current`). NUNCA
 * decide sozinho — só sugere, com o motivo da suspeita (`reason`), pra
 * confirmação manual do editor. Um mesmo assinante Beehiiv nunca aparece 2x
 * na lista (a 1ª heurística que casar decide o motivo).
 */
export function findEmailMatchCandidates(
  contactName: string,
  knownEmails: readonly string[],
  current: readonly CurrentSubscription[],
): EmailMatchCandidate[] {
  const knownNormalizedLocalParts = new Set(
    knownEmails.map((e) => normalizeLocalPart(e)).filter((lp) => lp.length > 0),
  );
  const normalizedName = normalizeName(contactName);
  const candidates: EmailMatchCandidate[] = [];

  for (const sub of current) {
    const subLocal = normalizeLocalPart(sub.email);
    if (!subLocal) continue;

    // (a) local-part normalizado idêntico a um e-mail já conhecido do contato.
    if (subLocal.length >= 3 && knownNormalizedLocalParts.has(subLocal)) {
      candidates.push({
        subscriptionId: sub.subscriptionId,
        email: sub.email,
        reason: "local-part",
        detail: "local-part normalizado (sem pontuação/case) igual a um e-mail já conhecido do contato",
      });
      continue;
    }

    // (b) nome do contato aparece no local-part (ou vice-versa).
    if (normalizedName.length >= 4 && (subLocal.includes(normalizedName) || normalizedName.includes(subLocal))) {
      candidates.push({
        subscriptionId: sub.subscriptionId,
        email: sub.email,
        reason: "name-in-local-part",
        detail: "nome do contato aparece no local-part do e-mail Beehiiv",
      });
      continue;
    }

    // (c) domínio próprio (não é provedor público comum) textualmente
    // parecido com o nome do contato.
    const domain = domainOf(sub.email);
    if (domain && !COMMON_EMAIL_DOMAINS.has(domain)) {
      const base = domainBase(sub.email);
      if (normalizedName.length >= 4 && base.length >= 4 && (base === normalizedName || isCloseMatch(normalizedName, base))) {
        candidates.push({
          subscriptionId: sub.subscriptionId,
          email: sub.email,
          reason: "own-domain",
          detail: "domínio do e-mail Beehiiv parece pessoal e é similar ao nome do contato",
        });
        continue;
      }
    }

    // (d) local-part parecido (typo/variação) com algum e-mail já conhecido.
    let matchedKnown: string | null = null;
    for (const known of knownEmails) {
      const knownLocal = normalizeLocalPart(known);
      if (isCloseMatch(knownLocal, subLocal)) {
        matchedKnown = known;
        break;
      }
    }
    if (matchedKnown) {
      candidates.push({
        subscriptionId: sub.subscriptionId,
        email: sub.email,
        reason: "typo-variant",
        detail: `local-part parecido com ${matchedKnown} (possível variação/typo)`,
      });
    }
  }

  return candidates;
}

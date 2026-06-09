/**
 * agent-issue-validator.ts (#1421)
 *
 * Cross-check determinístico dos issues retornados por `review-test-email`
 * agent (Haiku). O agent tem viés de encoding em ambientes WSL/locale —
 * vê acentos em URL slugs (Beehiiv normaliza pra ASCII) ou entities HTML
 * encoded como corruption do email body. Caso 260520: 4 iterações do
 * loop verify→fix, ~16 falso-positivos investigados manualmente.
 *
 * Estratégia: pra cada issue de tipo conhecido, validar contra o HTML local
 * (autoritativo). Se ground truth confirma OK, drop como falso-positivo.
 *
 * Tipos validados:
 *   - `email:encoding_drop` — match texto "X" no HTML local; se presente
 *     com acentos corretos, é falso-positivo.
 *   - `email:poll_sig_missing` — verifica se `{{poll_sig}}` ou `sig=` está
 *     no HTML local.
 *   - `email:vote_edition_malformed` — checa se `&edition={AAMMDD}` ou
 *     `?edition={AAMMDD}` aparecem corretamente no HTML.
 *
 * Outros tipos passam através (caller decide o que fazer).
 *
 * Não cobre: `unexpected_content`, `formatting` etc — esses precisam
 * julgamento editorial, não validation determinística.
 */

export interface FilterResult {
  kept: string[];
  dropped: Array<{ issue: string; reason: string }>;
}

/**
 * Extrai os termos entre aspas (\`'X'\`) numa string de issue. Usado pra
 * pegar a string que o agent acha estar corrompida em encoding_drop.
 * Retorna [] quando não há aspas.
 */
export function extractQuotedTerms(issue: string): string[] {
  const out: string[] = [];
  const re = /'([^']+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(issue)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Pure: decide se uma issue `email:encoding_drop` é falso-positivo
 * cruzando os termos quoted contra o HTML local.
 *
 * Retorna `{ falsePositive: true, reason }` quando todos os termos quoted
 * aparecem no HTML local com acentos preservados (= encoding está OK,
 * agent leu mal). Retorna `{ falsePositive: false }` quando algum termo
 * falta no HTML (= corruption real OU termo não-validável).
 *
 * Quando não há termos extraíveis, retorna `{ falsePositive: false }`
 * pra preservar a issue (não dá pra validar sem termo).
 */
export function isEncodingDropFalsePositive(
  issue: string,
  htmlLocal: string,
): { falsePositive: true; reason: string } | { falsePositive: false } {
  const terms = extractQuotedTerms(issue);
  if (terms.length === 0) return { falsePositive: false };
  const missing = terms.filter((t) => !htmlLocal.includes(t));
  if (missing.length === 0) {
    return {
      falsePositive: true,
      reason: `encoding_drop falso-positivo: termo(s) [${terms.join(", ")}] presentes no HTML com acentos corretos`,
    };
  }
  return { falsePositive: false };
}

/**
 * Pure: decide se uma issue `email:poll_sig_missing` é falso-positivo
 * verificando que `{{poll_sig}}` (merge tag) OU `sig=` (URL param) está
 * no HTML local.
 */
export function isPollSigMissingFalsePositive(
  htmlLocal: string,
): { falsePositive: true; reason: string } | { falsePositive: false } {
  if (htmlLocal.includes("{{poll_sig}}") || htmlLocal.includes("&sig=") || htmlLocal.includes("?sig=")) {
    return {
      falsePositive: true,
      reason: "poll_sig_missing falso-positivo: {{poll_sig}} ou sig= presente no HTML local",
    };
  }
  return { falsePositive: false };
}

/**
 * Pure: decide se uma issue `email:vote_edition_malformed` é falso-positivo
 * verificando que `edition={AAMMDD}` aparece corretamente no HTML.
 *
 * Tipicamente o agent vê `&amp;edition=` (HTML-encoded) e interpreta como
 * `&edition&` (separador errado). Se `edition={AAMMDD}` está literalmente
 * no HTML (mesmo HTML-escaped), o agent leu mal.
 */
export function isVoteEditionMalformedFalsePositive(
  htmlLocal: string,
  editionDate: string,
): { falsePositive: true; reason: string } | { falsePositive: false } {
  const expected = `edition=${editionDate}`;
  if (htmlLocal.includes(expected) || htmlLocal.includes(`edition=${editionDate.padStart(6, "0")}`)) {
    return {
      falsePositive: true,
      reason: `vote_edition_malformed falso-positivo: ${expected} presente no HTML`,
    };
  }
  return { falsePositive: false };
}

/**
 * #1949: "título sem negrito" é falso-positivo sob o DS #1936 — manchetes são
 * Georgia serif SEM bold por design (hierarquia por tamanho/fonte, não peso).
 *
 * Code-review: SÓ casa issues `email:formatting:` com frase de AUSÊNCIA de
 * negrito. Sem o gate de prefixo, um `email:link_missing` cujo título cita
 * "negrito", ou um defeito INVERSO ("título em negrito demais"), seriam dropados
 * por engano (over-drop = bug real some). `t[íi]tulo.*negrito` (greedy) foi
 * removido — pegava o defeito inverso.
 */
export function isBoldMissingFalsePositive(
  issue: string,
): { falsePositive: true; reason: string } | { falsePositive: false } {
  if (!/^email:formatting:/i.test(issue)) return { falsePositive: false };
  if (/sem\s+negrito|negrito\s+(ausente|faltando)|n[ãa]o\s+est[áa]\s+em\s+negrito/i.test(issue)) {
    return {
      falsePositive: true,
      reason: "DS #1936: manchetes são serif Georgia SEM negrito (hierarquia por tamanho/fonte)",
    };
  }
  return { falsePositive: false };
}

/**
 * #1949: "crédito/caption do É IA? não está em itálico" é falso-positivo sob o
 * DS #1936 — a legenda é sans 12px ink SEM itálico por design.
 *
 * Code-review: SÓ casa `email:formatting:` COM contexto de caption/crédito/
 * legenda (item 11 é específico do crédito do É IA?). Sem isso, um defeito de
 * hierarquia de título que só co-menciona "sem itálico" (ex: "D3 título sem
 * itálico E sem tamanho diferenciado") seria dropado por engano. `italic_literal`
 * (`*texto*` não convertido) é bug REAL — excluído.
 */
export function isItalicMissingFalsePositive(
  issue: string,
): { falsePositive: true; reason: string } | { falsePositive: false } {
  if (!/^email:formatting:/i.test(issue)) return { falsePositive: false };
  if (/italic_literal/i.test(issue)) return { falsePositive: false };
  const mentionsItalicAbsence = /n[ãa]o\s+est[áa]\s+em\s+it[áa]lico|sem\s+it[áa]lico/i.test(issue);
  const captionContext = /cr[ée]dito|caption|legenda|[ée]\s*ia\?/i.test(issue);
  if (mentionsItalicAbsence && captionContext) {
    return {
      falsePositive: true,
      reason: "DS #1936: caption/crédito do É IA? é sans ink SEM itálico",
    };
  }
  return { falsePositive: false };
}

/**
 * #1949: reclamação de merge tag inline não expandida é falso-positivo — `{{email}}`
 * e `{{poll_sig}}` são inline POR DESIGN (#1083), o Beehiiv expande no ENVIO.
 *
 * Code-review: SÓ o CONJUNTO FECHADO `{{email}}`/`{{poll_sig}}`, e SÓ em issues
 * de link/formatting. Um `{{unknown_field}}`/`{{utm_campaign}}` literal num link É
 * bug real (template var vazada) → NÃO dropar. E `email:subject_mismatch` é
 * SEMPRE blocker (#1645) — nunca dropar, mesmo se o subject contiver `{{...}}`.
 */
export function isMergeTagUnexpandedFalsePositive(
  issue: string,
): { falsePositive: true; reason: string } | { falsePositive: false } {
  if (!/^email:(link_|formatting:)/i.test(issue)) return { falsePositive: false };
  if (/\{\{\s*(email|poll_sig)\s*\}\}/i.test(issue)) {
    return {
      falsePositive: true,
      reason: "merge tags inline {{email}}/{{poll_sig}} expandem no envio (#1083)",
    };
  }
  return { falsePositive: false };
}

/**
 * Cross-check de uma lista de issues contra o HTML local. Drop os que são
 * falso-positivos verificáveis; mantém os outros (incluindo tipos não
 * conhecidos — caller decide).
 *
 * @param issues   array de strings no formato `email:tipo: detalhe`
 * @param htmlLocal HTML renderizado localmente — fonte de verdade
 * @param editionDate AAMMDD da edição (necessário pra vote_edition validation)
 */
export function filterAgentIssues(
  issues: string[],
  htmlLocal: string,
  editionDate: string,
): FilterResult {
  const kept: string[] = [];
  const dropped: Array<{ issue: string; reason: string }> = [];

  for (const issue of issues) {
    if (issue.startsWith("email:encoding_drop")) {
      const r = isEncodingDropFalsePositive(issue, htmlLocal);
      if (r.falsePositive) {
        dropped.push({ issue, reason: r.reason });
        continue;
      }
    } else if (issue.startsWith("email:poll_sig_missing")) {
      const r = isPollSigMissingFalsePositive(htmlLocal);
      if (r.falsePositive) {
        dropped.push({ issue, reason: r.reason });
        continue;
      }
    } else if (issue.startsWith("email:vote_edition_malformed")) {
      const r = isVoteEditionMalformedFalsePositive(htmlLocal, editionDate);
      if (r.falsePositive) {
        dropped.push({ issue, reason: r.reason });
        continue;
      }
    }
    // #1949: classes de FP do novo DS / merge tags — baseadas só na string do
    // issue (a reclamação inteira é FP), independem do HTML.
    const dsChecks = [
      isMergeTagUnexpandedFalsePositive(issue),
      isBoldMissingFalsePositive(issue),
      isItalicMissingFalsePositive(issue),
    ];
    const fp = dsChecks.find((r) => r.falsePositive);
    if (fp && fp.falsePositive) {
      dropped.push({ issue, reason: fp.reason });
      continue;
    }
    // Tipos não validáveis (unexpected_content, etc) passam.
    kept.push(issue);
  }

  return { kept, dropped };
}

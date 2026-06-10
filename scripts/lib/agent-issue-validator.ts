/**
 * agent-issue-validator.ts (#1421, #2013)
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
 *   - `email:link_dead` (#2013) — re-verifica o link com HEAD (fallback GET)
 *     e UA de browser; 2xx/3xx = FP. 403 em *.beehiiv.com = FP de bot-block.
 *   - `email:section_missing` (#2013) — grep da section label no HTML local
 *     (byte-idêntico ao corpo enviado); label presente = FP de truncamento.
 *   - `email:encoding_drop` de emoji em header de seção (#2013) — DS #1936
 *     renderiza headers SEM emoji (stripKickerEmoji); emoji de seção ausente
 *     no header é by-design, não corruption.
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

// ---------------------------------------------------------------------------
// #2013 — 3 classes novas de FP (link_dead falso, section_missing por
// truncamento, encoding_drop de emoji em header de seção)
// ---------------------------------------------------------------------------

/**
 * #2013: Emojis de header de seção da newsletter.
 *
 * O DS #1936 renderiza headers via `renderKicker(label)` que chama
 * `stripKickerEmoji(label)` — o emoji é REMOVIDO na saída HTML. Existe
 * apenas no MD source. Se o agent reporta `encoding_drop` citando um
 * desses emojis como ausente num header, é falso-positivo by-design.
 *
 * Lista derivada de `context/templates/newsletter.md` + `section-naming.ts`.
 */
export const SECTION_HEADER_EMOJIS: ReadonlySet<string> = new Set([
  "🚀", // LANÇAMENTOS
  "📡", // RADAR
  "🛠️", // USE MELHOR (inclui variation selector U+FE0F)
  "🎁", // SORTEIO
  "🙋", // PARA ENCERRAR (base — variantes com skin-tone são prefixadas com este)
  "🙋🏼‍♀️", // PARA ENCERRAR (sequência completa com skin-tone)
  "💼", // categoria de negócios (usado em DESTAQUE labels)
  "🌐", // categoria global/internacional
  "📺", // VÍDEOS
  "🔬", // PESQUISAS (legacy)
  "📰", // OUTRAS NOTÍCIAS (legacy)
  "⚖️", // categoria jurídico/regulação
  "🇧🇷", // Brasil
]);

/**
 * #2066: Marcadores de callout (midCallout/introCallout) — `**📣/📚/🎉 …**`.
 * `stripCalloutMarker` (newsletter-render-html.ts) remove o marcador do HTML
 * renderizado nos caminhos de callout (multi-parágrafo desde #1938/#1942;
 * single-parágrafo com imagem desde #2066). O emoji existe só no MD source
 * (`02-reviewed.md`), então `lint-test-email-encoding` o reporta como
 * `char_dropped` — falso-positivo by-design, análogo ao #2013.
 */
export const CALLOUT_MARKER_EMOJIS: ReadonlySet<string> = new Set([
  "📣", // patrocinado (Clarice) — separador "Divulgação" rotula no lugar
  "📚", // promo interna (página de livros)
  "🎉", // CTA editorial / sorteio
]);

/**
 * #2066: Pure — decide se um `email:encoding_drop` citando um marcador de
 * callout (📣/📚/🎉) é falso-positivo porque `stripCalloutMarker` o remove
 * do HTML por design. Mesmo shape do #2013: só dropa quando o ÚNICO termo
 * citado é o marcador — múltiplos termos voltam pra checagem normal (pode
 * haver texto real corrompido junto). Sem gate de frase: diferente dos emojis
 * de header (multi-propósito), os 3 marcadores só entram no MD como prefixo
 * de callout (`**📣 …**`), então a citação isolada é inequívoca.
 */
export function isEncodingDropCalloutMarkerByDesign(
  issue: string,
): { falsePositive: true; reason: string } | { falsePositive: false } {
  if (!/^email:encoding_drop/i.test(issue)) return { falsePositive: false };
  const terms = extractQuotedTerms(issue);
  if (terms.length !== 1) return { falsePositive: false };
  const [term] = terms;
  if (!CALLOUT_MARKER_EMOJIS.has(term)) return { falsePositive: false };
  return {
    falsePositive: true,
    reason: `#2066: marcador de callout '${term}' é removido do HTML por stripCalloutMarker — ausência by-design`,
  };
}

/**
 * #2013: Pure — decide se um `email:encoding_drop` reportando emoji ausente
 * é falso-positivo porque o DS #1936 remove emojis de headers por design.
 *
 * Critério: o issue cita exatamente 1 termo entre aspas que é um dos emojis
 * de section header canônicos (SECTION_HEADER_EMOJIS) E a frase menciona
 * explicitamente "header", "seção", "section", "kicker", "título da seção"
 * ou "título de seção" — indicando que a reclamação é sobre um HEADER de seção.
 *
 * Sem o gate de header na frase: emojis multi-propósito (📺, 💼, 🌐) são
 * usados também em links inline e no corpo do email. Um emoji genuinamente
 * corrompido nesse contexto cuja issue mencione o nome da seção (ex: "💼 link
 * quebrado na seção USE MELHOR") seria dropado incorretamente. O gate de
 * header garante que só issues sobre o título/kicker da seção são dropadas.
 *
 * Code-review: NÃO dropa quando há múltiplos termos (um deles pode ser
 * texto real com encoding real, não só o emoji) — nesse caso volta pra
 * checagem normal de `isEncodingDropFalsePositive`.
 */
export function isEncodingDropSectionEmojiByDesign(
  issue: string,
): { falsePositive: true; reason: string } | { falsePositive: false } {
  if (!/^email:encoding_drop/i.test(issue)) return { falsePositive: false };
  const terms = extractQuotedTerms(issue);
  // Só casa quando o único termo citado é um emoji de header — múltiplos termos
  // passam pra verificação normal (pode ter texto real + emoji misturados).
  if (terms.length !== 1) return { falsePositive: false };
  const [term] = terms;
  // Verifica se o termo é um emoji de section header (ou começa com um deles —
  // sequências com skin-tone podem ter substring da lista).
  const isHeaderEmoji = SECTION_HEADER_EMOJIS.has(term) ||
    [...SECTION_HEADER_EMOJIS].some((e) => term.startsWith(e) || e.startsWith(term));
  if (!isHeaderEmoji) return { falsePositive: false };
  // Gate de header: a frase precisa mencionar que a reclamação é sobre um
  // HEADER/kicker de seção — não apenas mencionar o nome da seção em qualquer
  // contexto. Sem isso, emojis multi-propósito (📺, 💼, 🌐) em links inline
  // seriam dropados indevidamente quando o nome da seção aparece na frase.
  const hasHeaderInPhrase =
    /header|kicker|se[çc][ãa]o|section|t[íi]tulo\s+da\s+se[çc][ãa]o|t[íi]tulo\s+de\s+se[çc][ãa]o/i.test(issue);
  if (!hasHeaderInPhrase) return { falsePositive: false };
  return {
    falsePositive: true,
    reason: `DS #1936: emoji '${term}' é removido de headers por renderKicker/stripKickerEmoji — ausência by-design (#2013)`,
  };
}

/**
 * #2013: Pure — decide se um `email:section_missing` é falso-positivo por
 * leitura truncada do Gmail, fazendo grep do label da seção no HTML local
 * (byte-idêntico ao corpo enviado).
 *
 * O DS #1936 renderiza seções com `renderKicker(label)` que produz HTML com
 * `text-transform:uppercase`. O label textual no HTML é o resultado de
 * `stripKickerEmoji(label)` — sem emoji, mas com o nome original da seção
 * (ex: "LANÇAMENTOS", "Sorteio", "Para encerrar"). Normalizamos para
 * comparação case-insensitive para cobrir variações de capitalização.
 *
 * Extrai o nome da seção da issue via pattern `'section_name'` (aspas) ou
 * o sufixo após `email:section_missing:`. Se o nome normalizado aparecer no
 * HTML local → FP (a seção existe, o agent só leu o email truncado).
 *
 * Limitação: match simples por substring — não valida se a seção tem conteúdo.
 * Mas "seção ausente + encontrada no HTML" é sempre FP de truncamento (se o
 * HTML local é correto, a seção está lá e o Beehiiv vai renderizar).
 */
export function isSectionMissingFalsePositive(
  issue: string,
  htmlLocal: string,
): { falsePositive: true; reason: string } | { falsePositive: false } {
  if (!/^email:section_missing/i.test(issue)) return { falsePositive: false };

  // Extrair o nome da seção: primeiro tenta aspas simples, depois o texto após ':'
  const quotedTerms = extractQuotedTerms(issue);
  const candidates: string[] = [];

  if (quotedTerms.length > 0) {
    candidates.push(...quotedTerms);
  } else {
    // Fallback: pega o texto após o último ':' e extrai o nome da seção.
    // O formato é "email:section_missing: SECTION_NAME resto_do_texto".
    // Nomes de seção conhecidos são multi-palavra (ex: "OUTRAS NOTÍCIAS", "USE MELHOR",
    // "PARA ENCERRAR") — testar do mais longo para o mais curto. Se nenhum casar,
    // pegar o primeiro token antes do primeiro espaço (heurística simples).
    const colonIdx = issue.lastIndexOf(":");
    if (colonIdx >= 0) {
      const suffix = issue.slice(colonIdx + 1).trim();
      if (suffix.length > 0) {
        // Nomes canônicos em ordem de especificidade (mais longo primeiro).
        const knownSectionNames = [
          "OUTRAS NOTÍCIAS", "OUTRA NOTÍCIA", "USE MELHOR",
          "PARA ENCERRAR", "LANÇAMENTOS", "LANÇAMENTO",
          "RADAR", "SORTEIO", "VÍDEOS", "VÍDEO", "PESQUISAS", "PESQUISA",
          "É IA?", "DESTAQUE",
        ];
        let matched = false;
        for (const name of knownSectionNames) {
          if (suffix.toUpperCase().startsWith(name)) {
            candidates.push(name);
            matched = true;
            break;
          }
        }
        if (!matched) {
          // Heurística: primeiro token separado por espaço ou pontuação
          const firstToken = suffix.split(/\s+/)[0].replace(/[,;:.]$/, "");
          if (firstToken.length > 0) candidates.push(firstToken);
        }
      }
    }
  }

  if (candidates.length === 0) return { falsePositive: false };

  // Normaliza o HTML para comparação: strip de emojis de seção e lowercase
  const htmlNorm = htmlLocal.toLowerCase();

  for (const candidate of candidates) {
    // Remove emojis do início do candidate (o agent pode incluir o emoji do MD)
    const stripped = candidate
      .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]*\s*/u, "")
      .trim();
    if (stripped.length === 0) continue;

    const norm = stripped.toLowerCase();
    if (htmlNorm.includes(norm)) {
      return {
        falsePositive: true,
        reason: `section_missing falso-positivo: '${stripped}' encontrada no HTML local — agent leu email truncado (#2013)`,
      };
    }
  }

  return { falsePositive: false };
}

// ---------------------------------------------------------------------------
// #2013: re-verificação de link_dead com fetch real
// ---------------------------------------------------------------------------

/** Tipo de fetch injetável (testabilidade — testes NUNCA fazem fetch real). */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** User-Agent de browser pra evitar bot-block em HEAD simples. */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Timeout curto para re-verificação (não queremos stall o loop). */
const REVERIFY_TIMEOUT_MS = 8000;

/**
 * Extrai a URL de uma string de issue `email:link_dead: {url} → ...`.
 * Retorna null se não houver URL reconhecível.
 */
export function extractLinkDeadUrl(issue: string): string | null {
  // Padrão: "email:link_dead: https://... → HTTP NNN" ou variações
  const m = issue.match(/email:link_dead[^:]*:\s*(https?:\/\/[^\s→>]+)/i);
  if (m) return m[1].trim();
  return null;
}

/**
 * #2013: Pure (async) — decide se um `email:link_dead` é falso-positivo
 * fazendo fetch real (HEAD, fallback GET) com UA de browser.
 *
 * Regras:
 *   - HTTP 2xx ou 3xx → FP (link vivo, bot-block na primeira tentativa do agent)
 *   - HTTP 403 em domínio *.beehiiv.com → FP (bot-protection conhecida)
 *   - Qualquer outro 4xx/5xx ou timeout → verdadeiro positivo (mantém issue)
 *
 * A `fetchFn` é injetável para testabilidade — testes NUNCA usam o fetch global.
 * Em produção, passar `globalThis.fetch` ou omitir.
 *
 * Code-review: só casa `email:link_dead`. Outros prefixos (link_timeout,
 * link_redirect_chain_long) não são re-verificados — têm semântica diferente.
 */
export async function isLinkDeadFalsePositive(
  issue: string,
  fetchFn: FetchFn,
): Promise<{ falsePositive: true; reason: string } | { falsePositive: false }> {
  if (!/^email:link_dead/i.test(issue)) return { falsePositive: false };

  const url = extractLinkDeadUrl(issue);
  if (!url) return { falsePositive: false };

  // FP known: 403 em *.beehiiv.com (bot-protection — página existe pra humanos)
  try {
    const hostname = new URL(url).hostname;
    if (hostname.endsWith(".beehiiv.com") || hostname === "beehiiv.com") {
      // Fazer o request pra confirmar o 403 (não assumir só pelo hostname)
      const status = await headOrGet(url, fetchFn);
      if (status === 403) {
        return {
          falsePositive: true,
          reason: `link_dead falso-positivo: ${url} → HTTP 403 em *.beehiiv.com (bot-protection conhecida, página existe pra humanos — #2013)`,
        };
      }
      if (status !== null && status >= 200 && status < 400) {
        return {
          falsePositive: true,
          reason: `link_dead falso-positivo: ${url} → HTTP ${status} na re-verificação (link vivo — #2013)`,
        };
      }
      return { falsePositive: false };
    }
  } catch {
    // URL mal-formada — não dá pra re-verificar
    return { falsePositive: false };
  }

  // Re-verificação geral: HEAD, fallback GET
  const status = await headOrGet(url, fetchFn);
  if (status !== null && status >= 200 && status < 400) {
    return {
      falsePositive: true,
      reason: `link_dead falso-positivo: ${url} → HTTP ${status} na re-verificação (link vivo — #2013)`,
    };
  }

  return { falsePositive: false };
}

/**
 * Faz HEAD, com fallback GET se o servidor rejeitar HEAD (alguns CDNs retornam
 * 405 Method Not Allowed). Retorna o status final ou null em caso de timeout/erro.
 *
 * Interno — não exportado.
 *
 * #2048 item 9: divergência intencional vs `verify-accessibility.ts`:
 *   - Aqui: timeout fixo `REVERIFY_TIMEOUT_MS = 8000ms` (re-verificação rápida,
 *     pós-issue-validator; context = validação de issue de email, não pipeline).
 *   - verify-accessibility: `CONFIG.timeouts.verify` (configurável, pipeline Stage 1).
 * Os dois contextos têm requisitos de latência distintos — extrair para lib
 * forçaria um timeout unificado ou um parâmetro extra, aumentando o acoplamento
 * sem ganho real. Mantidos separados; documentada a divergência aqui.
 */
async function headOrGet(url: string, fetchFn: FetchFn): Promise<number | null> {
  const headers = { "User-Agent": BROWSER_UA };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REVERIFY_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method: "HEAD",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status === 405) {
      // HEAD rejeitado — tentar GET
      clearTimeout(t);
      const controller2 = new AbortController();
      const t2 = setTimeout(() => controller2.abort(), REVERIFY_TIMEOUT_MS);
      try {
        const res2 = await fetchFn(url, {
          method: "GET",
          headers,
          redirect: "follow",
          signal: controller2.signal,
        });
        return res2.status;
      } catch {
        return null;
      } finally {
        clearTimeout(t2);
      }
    }
    return res.status;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// filterAgentIssues — integração de todas as classes
// ---------------------------------------------------------------------------

/**
 * Cross-check de uma lista de issues contra o HTML local. Drop os que são
 * falso-positivos verificáveis; mantém os outros (incluindo tipos não
 * conhecidos — caller decide).
 *
 * Versão assíncrona (#2013): aceita `fetchFn` opcional para re-verificar
 * links reportados como mortos. Se omitida, o check `link_dead` é pulado
 * (comportamento síncrono compatível com v1421).
 *
 * #2047: os fetches de `link_dead` são independentes entre si e rodados em
 * paralelo via `Promise.all`. A ordem dos issues em `kept`/`dropped` é
 * preservada — `Promise.all` mantém a posição original.
 *
 * #2047: `linkCheckCache` (opcional) — Map<url, boolean|null> reutilizado
 * entre iterações do loop verify→fix do orchestrator-stage-4. O caller
 * cria o Map UMA vez fora do loop e passa em cada chamada. Evita re-fetch
 * do mesmo URL em iterações posteriores (link genuinamente morto continua
 * morto; link vivo continua vivo). `null` = inconclusivo (re-fetcha).
 *
 * Tipos cobertos:
 *   Síncronos: encoding_drop, poll_sig_missing, vote_edition_malformed,
 *              merge_tag_unexpanded, bold_missing, italic_missing,
 *              encoding_drop (emoji de header — DS by-design), section_missing.
 *   Assíncrono (requer fetchFn): link_dead re-verificação.
 *
 * @param issues          array de strings no formato `email:tipo: detalhe`
 * @param htmlLocal       HTML renderizado localmente — fonte de verdade
 * @param editionDate     AAMMDD da edição (necessário pra vote_edition validation)
 * @param fetchFn         (opcional) função de fetch injetável pro check link_dead.
 *                        Testes NUNCA usam fetch real — passar mock ou omitir pra
 *                        pular o check de rede.
 * @param linkCheckCache  (opcional) Map<url, boolean> — consulta antes do fetch,
 *                        popula depois. Caller mantém o Map vivo entre iterações
 *                        do loop verify→fix pra evitar re-fetches redundantes.
 */
export async function filterAgentIssues(
  issues: string[],
  htmlLocal: string,
  editionDate: string,
  fetchFn?: FetchFn,
  linkCheckCache?: Map<string, boolean | null>,
): Promise<FilterResult> {
  // ---------------------------------------------------------------------------
  // Fase 1: verificações síncronas (encoding, poll_sig, section, DS checks, etc)
  // ---------------------------------------------------------------------------
  // Para cada issue, calcula o resultado síncrono. Para link_dead com fetchFn,
  // marca como "pendente" para processar em paralelo na Fase 2.
  // ---------------------------------------------------------------------------

  type SyncResult =
    | { kind: "drop"; reason: string }
    | { kind: "keep" }
    | { kind: "link_dead_pending"; issue: string; url: string };

  const syncResults: SyncResult[] = issues.map((issue) => {
    if (issue.startsWith("email:encoding_drop")) {
      // #2013: verificar primeiro se é emoji de header (by-design) — antes do
      // check de encoding genérico, pois o emoji não vai estar no HTML local.
      const emojiCheck = isEncodingDropSectionEmojiByDesign(issue);
      if (emojiCheck.falsePositive) return { kind: "drop", reason: emojiCheck.reason };
      // #2066: marcador de callout (📣/📚/🎉) stripped por design — idem.
      const markerCheck = isEncodingDropCalloutMarkerByDesign(issue);
      if (markerCheck.falsePositive) return { kind: "drop", reason: markerCheck.reason };
      const r = isEncodingDropFalsePositive(issue, htmlLocal);
      if (r.falsePositive) return { kind: "drop", reason: r.reason };
    } else if (issue.startsWith("email:poll_sig_missing")) {
      const r = isPollSigMissingFalsePositive(htmlLocal);
      if (r.falsePositive) return { kind: "drop", reason: r.reason };
    } else if (issue.startsWith("email:vote_edition_malformed")) {
      const r = isVoteEditionMalformedFalsePositive(htmlLocal, editionDate);
      if (r.falsePositive) return { kind: "drop", reason: r.reason };
    } else if (issue.startsWith("email:section_missing")) {
      // #2013: grep da section label no HTML local — presente = FP de truncamento.
      const r = isSectionMissingFalsePositive(issue, htmlLocal);
      if (r.falsePositive) return { kind: "drop", reason: r.reason };
    } else if (issue.startsWith("email:link_dead") && fetchFn) {
      // #2047: re-verificação de link com fetch real — paralelo na Fase 2.
      // Verificar cache primeiro; se há hit definitivo (true/false), resolver aqui.
      const url = extractLinkDeadUrl(issue);
      if (url && linkCheckCache) {
        const cached = linkCheckCache.get(url);
        if (cached === true) {
          // Cache: link vivo confirmado anteriormente → FP
          return { kind: "drop", reason: `link_dead falso-positivo (cache): ${url} já verificado como vivo (#2047)` };
        }
        if (cached === false) {
          // Cache: link morto confirmado anteriormente → mantém
          return { kind: "keep" };
        }
        // cached === undefined → URL nova, ou null → inconclusivo → vai pro fetch paralelo
      }
      if (url) {
        return { kind: "link_dead_pending", issue, url };
      }
      // URL não extraível → conservador (mantém)
      return { kind: "keep" };
    }

    // #1949: classes de FP do novo DS / merge tags — baseadas só na string do
    // issue (a reclamação inteira é FP), independem do HTML.
    const dsChecks = [
      isMergeTagUnexpandedFalsePositive(issue),
      isBoldMissingFalsePositive(issue),
      isItalicMissingFalsePositive(issue),
    ];
    const fp = dsChecks.find((r) => r.falsePositive);
    if (fp && fp.falsePositive) return { kind: "drop", reason: fp.reason };

    // Tipos não validáveis (unexpected_content, etc) passam.
    return { kind: "keep" };
  });

  // ---------------------------------------------------------------------------
  // Fase 2: resolução paralela dos link_dead pendentes (#2047)
  // ---------------------------------------------------------------------------
  // Coletar todos os link_dead_pending, fazer os fetches em paralelo (Promise.all),
  // depois substituir cada resultado pendente pelo seu resultado real.
  // ---------------------------------------------------------------------------

  const pendingIndices: number[] = [];
  const pendingFetches: Promise<{ falsePositive: true; reason: string } | { falsePositive: false }>[] = [];

  for (let i = 0; i < syncResults.length; i++) {
    const sr = syncResults[i];
    if (sr.kind === "link_dead_pending") {
      pendingIndices.push(i);
      pendingFetches.push(isLinkDeadFalsePositive(sr.issue, fetchFn!));
    }
  }

  if (pendingFetches.length > 0) {
    const fetchResults = await Promise.all(pendingFetches);
    for (let j = 0; j < pendingIndices.length; j++) {
      const i = pendingIndices[j];
      const pending = syncResults[i] as { kind: "link_dead_pending"; issue: string; url: string };
      const result = fetchResults[j];
      if (result.falsePositive) {
        // Populat cache com hit positivo (link vivo)
        if (linkCheckCache) linkCheckCache.set(pending.url, true);
        syncResults[i] = { kind: "drop", reason: result.reason };
      } else {
        // Populat cache com hit negativo (link morto)
        if (linkCheckCache) linkCheckCache.set(pending.url, false);
        syncResults[i] = { kind: "keep" };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Fase 3: montar kept/dropped preservando a ordem original dos issues
  // ---------------------------------------------------------------------------

  const kept: string[] = [];
  const dropped: Array<{ issue: string; reason: string }> = [];

  for (let i = 0; i < issues.length; i++) {
    const sr = syncResults[i];
    if (sr.kind === "drop") {
      dropped.push({ issue: issues[i], reason: sr.reason });
    } else {
      kept.push(issues[i]);
    }
  }

  return { kept, dropped };
}

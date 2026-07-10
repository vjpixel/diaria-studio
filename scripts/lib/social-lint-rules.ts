/**
 * lib/social-lint-rules.ts (#2833)
 *
 * Regras individuais de lint pra `03-social.md` — cada `lint*`/`check*` é
 * uma regra independente (CTAs, relative-time, schema LinkedIn, e-mail CTA,
 * credential bio, antithesis-reveal, trailing hook/question, post_pixel vs
 * D1, deixis pessoal, cobertura do humanizador). O runner/CLI que dispatcha
 * `--check <regra>` fica em scripts/lint-social-md.ts.
 *
 * Extraído de scripts/lint-social-md.ts — movimentação pura, sem mudança de
 * comportamento. lint-social-md.ts re-exporta esses símbolos pra manter
 * compat com importadores existentes.
 */

import { tokenizeForJaccard, jaccardSimilarity } from "../dedup.ts"; // #1861
import { DIARIA_LINKEDIN_PAGE_SLUG } from "./canonical-urls.ts"; // #2790 fonte única (reexportada abaixo p/ back-compat)
import { extractSection } from "./extract-section.ts"; // #2834 fonte única (era duplicada em publish-instagram.ts/publish-threads.ts)

// ---------------------------------------------------------------------------
// Pure helpers — exportadas pra tests
// ---------------------------------------------------------------------------

export interface LintError {
  platform: "linkedin" | "facebook";
  rule: string;
  detail: string;
  line?: number;
}

/** Extrai a seção de uma plataforma do md (`# LinkedIn` ou `# Facebook`). */
export function extractPlatformSection(md: string, platform: "linkedin" | "facebook"): string | null {
  const normalized = md.replace(/\r\n/g, "\n");
  const platTitle = platform.charAt(0).toUpperCase() + platform.slice(1);
  const re = new RegExp(`(?:^|\\n)# ${platTitle}\\n([\\s\\S]*?)(?=\\n# |$)`, "i");
  const match = normalized.match(re);
  return match ? match[1] : null;
}

/**
 * #2343: extrai a lista de destaques (`## dN`) presentes numa seção de plataforma.
 * Retorna a lista em ordem canônica d1..d3, sem duplicatas; [] se nenhum achado.
 * Compartilhado por publish-facebook.ts e publish-linkedin.ts (evita drift de regex).
 */
export function parseDestaqueHeaders(section: string): string[] {
  const destaques: string[] = [];
  // Match ## d1, ## d2, ## d3 headers (not ## post_pixel etc)
  const headerRe = /(?:^|\n)## (d\d+)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(section)) !== null) {
    const d = m[1].toLowerCase();
    if (!destaques.includes(d)) destaques.push(d);
  }
  // Warn about any ## dN headers that are outside the canonical set [d1, d2, d3].
  // A writer typo like `## d4` instead of `## d3` would silently drop the third
  // destaque, producing only 2 social posts instead of 3 (#2356 fix 2).
  const canonical = new Set(["d1", "d2", "d3"]);
  for (const d of destaques) {
    if (!canonical.has(d)) {
      console.error(
        `[parseDestaqueHeaders] WARN: header ## ${d} encontrado mas está fora do conjunto canônico [d1, d2, d3] — ` +
          `possível typo (ex: ## d4 em vez de ## d3)? Este destaque será ignorado.`,
      );
    }
  }
  return ["d1", "d2", "d3"].filter((d) => destaques.includes(d));
}

/**
 * Valida CTAs do LinkedIn — devem usar `diar.ia.br` puro.
 *
 * Aceitos:
 *   - "...em diar.ia.br" (sem prefixo, sem ponto)
 * Rejeitados:
 *   - "...em https://diar.ia.br" (prefixo)
 *   - "...em [diar.ia.br](https://diar.ia.br)" (markdown link — agent comum confunde)
 *   - "...em diar.ia.br." (ponto final)
 */
export function lintLinkedinCTAs(linkedinSection: string): LintError[] {
  const errors: LintError[] = [];
  const lines = linkedinSection.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/diar\.ia\.br/i.test(line)) continue;
    if (!/(assine grátis|assine grátis em|assine|grátis em|notícias de IA)/i.test(line)) continue;

    // Aceita: "em diar.ia.br" no fim (com possível trailing whitespace)
    const ok = /\bem\s+diar\.ia\.br\s*$/i.test(line.trim());
    if (ok) continue;

    if (/https:\/\/diar\.ia\.br/.test(line)) {
      errors.push({
        platform: "linkedin",
        rule: "no_https_prefix",
        detail: `Linha ${i + 1} usa "https://diar.ia.br" — LinkedIn CTA deve ser apenas "diar.ia.br"`,
        line: i + 1,
      });
    } else if (/diar\.ia\.br\./.test(line)) {
      errors.push({
        platform: "linkedin",
        rule: "no_trailing_period",
        detail: `Linha ${i + 1} tem ponto final após "diar.ia.br" — LinkedIn CTA não usa ponto`,
        line: i + 1,
      });
    } else if (/\[diar\.ia\.br\]/.test(line)) {
      errors.push({
        platform: "linkedin",
        rule: "no_markdown_link",
        detail: `Linha ${i + 1} usa markdown link — LinkedIn não renderiza markdown, escrever URL crua`,
        line: i + 1,
      });
    }
  }
  return errors;
}

/**
 * Valida CTAs do Facebook — devem usar `https://diar.ia.br.` (com prefixo + ponto).
 * Regra oposta do LinkedIn (#602).
 */
export function lintFacebookCTAs(facebookSection: string): LintError[] {
  const errors: LintError[] = [];
  const lines = facebookSection.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/diar\.ia\.br/i.test(line)) continue;
    if (!/(assine grátis|assine|grátis em|notícias de IA)/i.test(line)) continue;

    // Aceita Facebook: "https://diar.ia.br." OU [https://diar.ia.br](https://diar.ia.br).
    // (Drive markdown link conversion adiciona o wrapper às vezes — ainda renderiza ok)
    const okPlain = /\bhttps:\/\/diar\.ia\.br\.\s*$/i.test(line.trim());
    const okMd = /\[https:\/\/diar\.ia\.br\]\(https:\/\/diar\.ia\.br\)\.\s*$/i.test(line.trim());
    if (okPlain || okMd) continue;

    // Falta https://
    if (!/https:\/\/diar\.ia\.br/.test(line)) {
      errors.push({
        platform: "facebook",
        rule: "missing_https_prefix",
        detail: `Linha ${i + 1} usa "diar.ia.br" sem prefixo — Facebook CTA exige "https://diar.ia.br."`,
        line: i + 1,
      });
    }
  }
  return errors;
}

export interface LintResult {
  ok: boolean;
  errors: LintError[];
}

export function lintSocialMd(md: string): LintResult {
  const errors: LintError[] = [];
  const linkedin = extractPlatformSection(md, "linkedin");
  if (linkedin !== null) {
    errors.push(...lintLinkedinCTAs(linkedin));
  }
  const facebook = extractPlatformSection(md, "facebook");
  if (facebook !== null) {
    errors.push(...lintFacebookCTAs(facebook));
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Temporal reference check (#747, #877) — social-specific
// ---------------------------------------------------------------------------

/**
 * Detecta referências temporais relativas banidas no MD de social
 * (#747, #877). Edições publicam D+1+ — palavras como "hoje", "ontem",
 * "esta semana" envelhecem mal entre escrever e publicar.
 *
 * #877 — quote-skip: matches dentro de aspas (`"..."`, `'...'`, `«...»`,
 * `“...”`) são ignorados (citação direta de fonte é OK ter relativo).
 */
export interface RelativeTimeMatch {
  word: string;
  context: string;
  line: number;
}

export interface RelativeTimeResult {
  ok: boolean;
  matches: RelativeTimeMatch[];
}

// Nota: \b não funciona com caracteres Unicode (ã, ê, etc.) — usamos
// lookahead/lookbehind em vez de \b para cobrir amanhã, mês, etc.
//
// Patterns cobertos (#877):
//   - hoje, ontem, amanhã (palavra solo; "ontem-feira" / "anteontem" não
//     casam graças aos lookahead/lookbehind contra \w e ao requirement de
//     start-of-word — `(?<![\w-])`)
//   - esta semana, próxima semana, na próxima semana, na semana passada
//   - este mês, mês passado
//   - recentemente, agora mesmo, há pouco, acabou de
//   - há N dia(s) / semana(s) / mês(es)
//   - nesta {weekday}
const RELATIVE_TIME_RE =
  /(?<![\w-])(hoje|ontem|amanhã|agora mesmo|esta semana|próxima semana|na semana passada|na próxima semana|este mês|mês passado|recentemente|há pouco|acabou de|há \d+ (?:dias?|semanas?|m[eê]s(?:es)?)|nesta (?:segunda|terça|quarta|quinta|sexta|sábado|domingo))(?![\w-])/gi;

/**
 * Identifica os ranges (start, end) de pares de aspas em uma linha.
 * Cobre `"..."`, `'...'`, `«...»`, `“...”`. Usado para skip de matches
 * dentro de citações.
 */
function quotedRanges(line: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  // Pares simétricos
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["«", "»"],
    ["“", "”"],
  ];
  for (const [open, close] of pairs) {
    let idx = 0;
    while (idx < line.length) {
      const start = line.indexOf(open, idx);
      if (start === -1) break;
      const closeIdx = line.indexOf(close, start + 1);
      if (closeIdx === -1) break;
      // Apóstrofo (`'`): só conta como aspas se houver pelo menos um espaço
      // ou início-de-string antes do par — evita falso quote em "d'água" /
      // "L'Oréal".
      if (open === "'" && start > 0 && /\w/.test(line[start - 1])) {
        idx = start + 1;
        continue;
      }
      ranges.push({ start, end: closeIdx });
      idx = closeIdx + 1;
    }
  }
  return ranges;
}

function isInQuotedRange(
  index: number,
  ranges: Array<{ start: number; end: number }>,
): boolean {
  return ranges.some((r) => index >= r.start && index <= r.end);
}

/**
 * #3208: `## post_pixel` documentadamente abre com "Hoje" (template
 * `.claude/agents/social-linkedin.md` §3d, #3052) — é publicado ao vivo no
 * mesmo dia (não agendado como main_d{N}/comment_diaria/comment_pixel, que
 * vão pra D+1+), então "hoje" é literalmente correto ali. Mascara o conteúdo
 * do bloco post_pixel (troca cada char não-newline por espaço, preservando
 * contagem de linhas — offsets de matches em OUTRAS seções continuam
 * corretos) antes do scan de tempo relativo, em vez de desligar o lint pra
 * seção inteira ou pro arquivo inteiro.
 *
 * Reusa `extractPlatformSection`/`extractPostPixelBlock` — mesmo padrão de
 * extração de seção por heading (`## post_pixel` até o próximo `## `/fim) já
 * usado por `lintLinkedinSchema`/`lintLinkedinPageLink`/`lintCredentialBio`.
 */
function maskPostPixelSection(normalizedMd: string): string {
  const linkedinSection = extractPlatformSection(normalizedMd, "linkedin");
  if (!linkedinSection) return normalizedMd;
  const ppBlock = extractPostPixelBlock(linkedinSection);
  if (!ppBlock || ppBlock.text.length === 0) return normalizedMd;
  const masked = ppBlock.text.replace(/[^\n]/g, " ");
  return normalizedMd.replace(ppBlock.text, masked);
}

export function lintRelativeTime(md: string): RelativeTimeResult {
  const normalized = md.replace(/\r\n/g, "\n");
  const lines = maskPostPixelSection(normalized).split("\n");
  const matches: RelativeTimeMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ranges = quotedRanges(line);
    RELATIVE_TIME_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RELATIVE_TIME_RE.exec(line)) !== null) {
      // #877 — pular matches dentro de aspas (citação direta)
      if (isInQuotedRange(m.index, ranges)) continue;
      matches.push({
        word: m[1],
        context: line
          .slice(Math.max(0, m.index - 20), m.index + m[1].length + 20)
          .trim(),
        line: i + 1,
      });
    }
  }

  return { ok: matches.length === 0, matches };
}

// ---------------------------------------------------------------------------
// #595: schema validation pra LinkedIn 3-textos-por-destaque
// ---------------------------------------------------------------------------

export interface LinkedinSchemaError {
  destaque: string;
  rule: string;
  detail: string;
}

export interface LinkedinSchemaResult {
  ok: boolean;
  errors: LinkedinSchemaError[];
  destaques: Array<{
    destaque: string;
    has_main: boolean;
    has_comment_diaria: boolean;
    has_comment_pixel: boolean;
    main_chars: number;
    comment_diaria_chars: number;
    comment_pixel_chars: number;
  }>;
}

/**
 * #595: Valida que cada `## d{N}` na seção LinkedIn do `03-social.md` tem
 * subseções `### comment_diaria` e `### comment_pixel`. Sem isso, Stage 4
 * (futuro publish-linkedin com 9 items) não tem como compor payload pros 3
 * scenarios Make.
 *
 * Char count limits:
 *   main: 1200-1500 (sweet spot LinkedIn)
 *   comment_diaria: 200-400 (CTA + URL)
 *   comment_pixel: 300-600 (opinião editorial)
 */
export function lintLinkedinSchema(md: string): LinkedinSchemaResult {
  const linkedinSection = extractPlatformSection(md, "linkedin");
  const errors: LinkedinSchemaError[] = [];
  const destaques: LinkedinSchemaResult["destaques"] = [];
  if (!linkedinSection) {
    return { ok: true, errors, destaques }; // sem seção LinkedIn = no-op
  }

  // Splitar por `## d{N}`. Cada chunk começa após o header.
  const chunks = linkedinSection.split(/\n## (d\d+)\n/);
  // chunks[0] = preâmbulo (vazio ou irrelevante); chunks[1] = "d1", chunks[2] = body d1, chunks[3] = "d2", etc
  for (let i = 1; i < chunks.length; i += 2) {
    const destaque = chunks[i];
    const body = chunks[i + 1] ?? "";

    // Splitar por `### comment_diaria` e `### comment_pixel`.
    const mainEnd = body.search(/\n### comment_diaria\b/);
    const commentDiariaStart = body.search(/\n### comment_diaria\b/);
    const commentPixelStart = body.search(/\n### comment_pixel\b/);

    let mainText = "";
    let commentDiariaText = "";
    let commentPixelText = "";

    if (mainEnd === -1) {
      mainText = body;
    } else {
      mainText = body.slice(0, mainEnd);
    }
    if (commentDiariaStart !== -1) {
      const start = body.indexOf("\n", commentDiariaStart + 1) + 1;
      const end = commentPixelStart !== -1 ? commentPixelStart : body.length;
      commentDiariaText = body.slice(start, end);
    }
    if (commentPixelStart !== -1) {
      const start = body.indexOf("\n", commentPixelStart + 1) + 1;
      // #1690: terminar no próximo sibling `## ` (ex: post_pixel) — senão o
      // último bloco (d3) absorve a seção post_pixel e infla comment_pixel_chars.
      const nextSibling = body.indexOf("\n## ", start);
      commentPixelText = nextSibling !== -1 ? body.slice(start, nextSibling) : body.slice(start);
    }

    // Strip char_count comments + leading whitespace
    const stripCommentMarkers = (s: string) =>
      s.replace(/<!--[\s\S]*?-->/g, "").trim();
    mainText = stripCommentMarkers(mainText);
    commentDiariaText = stripCommentMarkers(commentDiariaText);
    commentPixelText = stripCommentMarkers(commentPixelText);

    const has_main = mainText.length > 0;
    const has_comment_diaria = commentDiariaText.length > 0;
    const has_comment_pixel = commentPixelText.length > 0;

    destaques.push({
      destaque,
      has_main,
      has_comment_diaria,
      has_comment_pixel,
      main_chars: mainText.length,
      comment_diaria_chars: commentDiariaText.length,
      comment_pixel_chars: commentPixelText.length,
    });

    if (!has_main) {
      errors.push({
        destaque,
        rule: "missing_main",
        detail: `${destaque}: post principal ausente em ## ${destaque}`,
      });
    }
    if (!has_comment_diaria) {
      errors.push({
        destaque,
        rule: "missing_comment_diaria",
        detail: `${destaque}: subseção ### comment_diaria ausente — necessária pra CTA + URL (#595)`,
      });
    }
    if (!has_comment_pixel) {
      errors.push({
        destaque,
        rule: "missing_comment_pixel",
        detail: `${destaque}: subseção ### comment_pixel ausente — necessária pra amplificação 2ª conta (#595)`,
      });
    }
    // Char count ranges (warning only — não bloqueia gate; lints estritos
    // apenas missing-section)
    if (has_main && (mainText.length < 800 || mainText.length > 1800)) {
      errors.push({
        destaque,
        rule: "main_chars_out_of_range",
        detail: `${destaque}: main post ${mainText.length} chars (esperado 1200-1500, tolerância 800-1800)`,
      });
    }

    // #595 (decisão editorial 2026-05-08): main post NÃO pode mencionar
    // Diar.ia ou diar.ia.br. Branding/CTA vão exclusivamente no comment_diaria
    // (T+3min). Main post fica 100% editorial.
    if (has_main) {
      if (/\bDiar\.ia\b/i.test(mainText)) {
        errors.push({
          destaque,
          rule: "main_post_mentions_diaria",
          detail:
            `${destaque}: main post menciona "Diar.ia" — ` +
            `branding vai exclusivamente no comment_diaria (T+3min), main post fica 100% editorial.`,
        });
      }
      if (/\bdiar\.ia\.br\b/i.test(mainText)) {
        errors.push({
          destaque,
          rule: "main_post_mentions_diaria_url",
          detail:
            `${destaque}: main post contém "diar.ia.br" — ` +
            `URL/CTA pra newsletter vai exclusivamente no comment_diaria.`,
        });
      }
    }

    // #595: comment_diaria deve conter `{edition_url}` (placeholder) em Stage 2.
    // Stage 4 substitui pelo URL Beehiiv real. Lint OK se contém placeholder OU
    // já contém URL diar.ia.br/p/<slug> (substituição pós-Stage 4).
    if (has_comment_diaria) {
      const hasPlaceholder = /\{edition_url\}/.test(commentDiariaText);
      const hasResolved = /https?:\/\/diar\.ia\.br\/p\//.test(commentDiariaText);
      if (!hasPlaceholder && !hasResolved) {
        errors.push({
          destaque,
          rule: "comment_diaria_missing_edition_url",
          detail:
            `${destaque}: comment_diaria não contém ` +
            `'{edition_url}' (placeholder Stage 2) nem 'diar.ia.br/p/<slug>' (resolvido pós-Stage 4). ` +
            `Editor deve apontar pra edição completa, não pro artigo source.`,
        });
      }
    }
    if (has_comment_diaria && (commentDiariaText.length < 100 || commentDiariaText.length > 600)) {
      errors.push({
        destaque,
        rule: "comment_diaria_chars_out_of_range",
        detail: `${destaque}: comment_diaria ${commentDiariaText.length} chars (esperado 200-400, tolerância 100-600)`,
      });
    }
    if (has_comment_pixel && (commentPixelText.length < 150 || commentPixelText.length > 800)) {
      errors.push({
        destaque,
        rule: "comment_pixel_chars_out_of_range",
        detail: `${destaque}: comment_pixel ${commentPixelText.length} chars (esperado 300-600, tolerância 150-800)`,
      });
    }
  }

  // #2453: `## post_pixel` é um post standalone na conta pessoal do Pixel —
  // já é a voz do Pixel. Ter um `### comment_pixel` dentro dele seria redundante
  // (comment_pixel é para ir SOB os posts da company page d1/d2/d3, não sob
  // post_pixel). Validar que o bloco post_pixel NÃO contém essa subseção.
  //
  // #3052: post_pixel deve abrir com {outros_count} + {edition_url} literais
  // (mesma convenção do comment_diaria §3b, ver social-linkedin.md §3d) — ambos
  // resolvidos em Stage 6 (scripts/resolve-post-pixel.ts), nunca estimados ou
  // omitidos em Stage 2.
  if (linkedinSection) {
    const ppBlockMatch = ("\n" + linkedinSection).match(
      /\n## post_pixel[^\n]*\n([\s\S]*?)(?=\n## [a-z]|$)/i,
    );
    if (ppBlockMatch) {
      const ppBody = ppBlockMatch[1];
      if (/\n### comment_pixel\b/i.test(ppBody)) {
        errors.push({
          destaque: "post_pixel",
          rule: "post_pixel_has_comment_pixel",
          detail:
            "post_pixel: subseção ### comment_pixel não deve existir aqui " +
            "— comment_pixel é para os posts d1/d2/d3 da company page, não para o post pessoal standalone (#2453).",
        });
      }

      const ppText = ppBody.replace(/<!--[\s\S]*?-->/g, "").trim();
      const hasEditionUrlPlaceholder = /\{edition_url\}/.test(ppText);
      const hasEditionUrlResolved = /https?:\/\/diar\.ia\.br\/p\//.test(ppText);
      if (ppText.length > 0 && !hasEditionUrlPlaceholder && !hasEditionUrlResolved) {
        errors.push({
          destaque: "post_pixel",
          rule: "post_pixel_missing_edition_url",
          detail:
            "post_pixel: não contém '{edition_url}' (placeholder Stage 2) nem " +
            "'diar.ia.br/p/<slug>' (resolvido) — abertura deve linkar a edição completa (#3052).",
        });
      }
      const hasOutrosCountPlaceholder = /\{outros_count\}/.test(ppText);
      if (ppText.length > 0 && !hasOutrosCountPlaceholder) {
        errors.push({
          destaque: "post_pixel",
          rule: "post_pixel_missing_outros_count",
          detail:
            "post_pixel: não contém '{outros_count}' — abertura deve citar o total de " +
            "itens não-destaque da edição (mesma convenção do comment_diaria, #3052).",
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, destaques };
}

// ---------------------------------------------------------------------------
// #2458: LinkedIn page link + no email CTA guards
// ---------------------------------------------------------------------------

/**
 * #2458: padrões de CTA por e-mail que estão banidos dos posts do LinkedIn.
 * O LinkedIn não é canal de aquisição de e-mail — o foco é seguir a página.
 */
// #2458 fix (self-review): cobertura ampliada — verbos de assinatura ancorados a
// e-mail/newsletter, aceitando variantes que o agente plausivelmente emite
// ("assine a Diar.ia", "assinar a newsletter", "cadastre-se por email", "e-mail"
// com ou sem hífen). Ancorado em intenção de assinatura pra evitar falso-positivo
// em menções casuais a e-mail.
// #2489: simplificado pra evitar quantificadores aninhados `(a\s+)?(nossa\s+)?`
// que geram ReDoS teórico em input adversarial longo. Posts são curtos (baixo risco
// real), mas o padrão linear é preferível e mantém a mesma cobertura semântica.
const EMAIL_CTA_RE =
  /\b(assine\s+(?:grátis|a\s+diar\.ia|a\s+newsletter|nossa\s+newsletter|por\s+e-?mail)|assinar\s+(?:a\s+newsletter|nossa\s+newsletter)|inscreva-se\s+(?:grátis|por\s+e-?mail|na\s+newsletter)|cadastre-se\s+(?:grátis|por\s+e-?mail|para\s+receber)|receba\s+(?:a\s+diar\.ia\s+)?(?:todo\s+dia\s+)?por\s+e-?mail)\b/gi;

export interface LinkedinEmailCtaError {
  section: string;
  line: number;
  phrase: string;
}
export interface LinkedinEmailCtaResult {
  ok: boolean;
  errors: LinkedinEmailCtaError[];
}

/**
 * #2458: Detecta CTA de assinatura por e-mail na seção LinkedIn de 03-social.md.
 * Esses CTAs foram banidos — o LinkedIn usa o CTA de seguir a página.
 * Valida em TODOS os blocos: main, comment_diaria, comment_pixel, post_pixel.
 */
export function lintLinkedinEmailCTA(md: string): LinkedinEmailCtaResult {
  const errors: LinkedinEmailCtaError[] = [];
  const linkedinSection = extractPlatformSection(md, "linkedin");
  if (!linkedinSection) return { ok: true, errors };

  const lines = linkedinSection.split("\n");
  let currentSection = "preamble";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track current section header for error reporting
    if (/^## (d\d+|post_pixel)\b/i.test(line)) {
      currentSection = line.replace(/^## /, "").trim();
    } else if (/^### (comment_diaria|comment_pixel)\b/i.test(line)) {
      currentSection = line.replace(/^### /, "").trim();
    }
    EMAIL_CTA_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMAIL_CTA_RE.exec(line)) !== null) {
      errors.push({
        section: currentSection,
        line: i + 1,
        phrase: m[0],
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * #2486: Detecta CTA de assinatura por e-mail na seção que o Instagram vai
 * consumir de 03-social.md. Usa a mesma lógica de fallback de publish-instagram.ts:
 *   1. Seção `# Instagram` (quando social-instagram escrever a seção própria).
 *   2. Fallback: seção `# Facebook` (situação atual — IG herda o copy do FB).
 *
 * Importante: `lintLinkedinEmailCTA` só checa `# LinkedIn`, então o CTA banido
 * em FB/IG passava sem flag. Este lint fecha o gap para o canal Instagram.
 *
 * Interface reutiliza LinkedinEmailCtaResult para consistência com a função irmã.
 */
export function lintInstagramEmailCTA(md: string): LinkedinEmailCtaResult {
  const errors: LinkedinEmailCtaError[] = [];
  // Tentar seção Instagram primeiro; fallback para Facebook (igual a publish-instagram.ts).
  let section = extractSection(md, "Instagram") ?? extractPlatformSection(md, "facebook");
  if (!section) return { ok: true, errors };

  const lines = section.split("\n");
  let currentSection = "preamble";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^## (d\d+)\b/i.test(line)) {
      currentSection = line.replace(/^## /, "").trim();
    }
    EMAIL_CTA_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = EMAIL_CTA_RE.exec(line)) !== null) {
      errors.push({
        section: currentSection,
        line: i + 1,
        phrase: m[0],
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * URL canônica da página da Diar.ia no LinkedIn (sem https://, sem ponto final).
 * #2458 — usada pro lint (determinístico, sem ler config em runtime).
 * `platform.config.json#...diaria_linkedin_page_url` espelha este valor
 * para o fluxo de publish; o teste de drift em lint-social-md.test.ts garante que
 * os dois não divergem.
 *
 * #2790: a definição canônica mudou pra `lib/canonical-urls.ts` (fonte única ao
 * lado de `DIARIA_FACEBOOK_PAGE_SLUG`/`DIARIA_INSTAGRAM_SLUG`/etc.) — reexportada
 * aqui pra não quebrar os imports existentes deste módulo.
 */
export { DIARIA_LINKEDIN_PAGE_SLUG };

export interface LinkedinPageLinkError {
  section: string;
  destaque?: string;
  detail: string;
}
export interface LinkedinPageLinkResult {
  ok: boolean;
  errors: LinkedinPageLinkError[];
}

/**
 * #2458: Valida que o link da página da Diar.ia no LinkedIn está presente em:
 *   - Cada `### comment_diaria` (CTA de follow da página)
 *   - O `## post_pixel` (CTA de follow no post pessoal)
 *
 * O link aceito: `linkedin.com/company/diar.ia.br` (sem https://, sem ponto).
 * Posts principais `## d{N}` ficam 100% editoriais (sem URL, conforme #595).
 */
export function lintLinkedinPageLink(md: string): LinkedinPageLinkResult {
  const errors: LinkedinPageLinkError[] = [];
  const linkedinSection = extractPlatformSection(md, "linkedin");
  if (!linkedinSection) return { ok: true, errors };

  // #2675: derivar o regex do slug canônico (não duplicar a string) — evita drift
  // entre DIARIA_LINKEDIN_PAGE_SLUG e o pattern do lint num futuro rename.
  const pageRe = new RegExp(
    DIARIA_LINKEDIN_PAGE_SLUG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    "i",
  );

  // --- Checar cada comment_diaria ---
  // #2458 fix (self-review): prefixar "\n" para casar `## d1` no início da seção
  // (sem newline anterior) e aceitar trailing content/espaços no header (`[^\n]*`),
  // senão o primeiro destaque escaparia silenciosamente do check.
  const chunks = ("\n" + linkedinSection).split(/\n## (d\d+)[^\n]*\n/);
  for (let i = 1; i < chunks.length; i += 2) {
    const destaque = chunks[i];
    const body = chunks[i + 1] ?? "";
    // Extrair texto do comment_diaria
    const cdStart = body.search(/\n### comment_diaria\b/);
    const cpStart = body.search(/\n### comment_pixel\b/);
    if (cdStart === -1) continue; // sem comment_diaria → regra missing_comment_diaria já pega
    const start = body.indexOf("\n", cdStart + 1) + 1;
    // #2489: guard — se comment_pixel vier antes de comment_diaria (ou ausente),
    // cpStart ≤ cdStart produz slice vazio → falso-positivo "link ausente".
    // Usar body.length como fallback garante que o texto inteiro do comment_diaria
    // é avaliado nesses casos.
    const end = cpStart !== -1 && cpStart > cdStart ? cpStart : body.length;
    const cdText = body.slice(start, end).replace(/<!--[\s\S]*?-->/g, "").trim();
    if (!pageRe.test(cdText)) {
      errors.push({
        section: "comment_diaria",
        destaque,
        // #2489: usar a const canônica nas msgs de erro para que mudar o slug
        // atualize automaticamente todas as mensagens (evita drift).
        detail:
          `${destaque}/comment_diaria: link da página da Diar.ia no LinkedIn ausente. ` +
          `Adicionar "${DIARIA_LINKEDIN_PAGE_SLUG}" no CTA (#2458).`,
      });
    }
  }

  // --- Checar post_pixel ---
  const text = "\n" + linkedinSection.replace(/\r\n/g, "\n");
  const ppMatch = text.match(/\n## post_pixel[^\n]*\n([\s\S]*?)(?=\n## [a-z]|$)/i);
  if (ppMatch) {
    const ppText = ppMatch[1].replace(/<!--[\s\S]*?-->/g, "").trim();
    if (ppText.length > 0 && !pageRe.test(ppText)) {
      errors.push({
        section: "post_pixel",
        // #2489: usar a const canônica nas msgs de erro (consistência com comment_diaria)
        detail:
          `post_pixel: link da página da Diar.ia no LinkedIn ausente. ` +
          `Adicionar "${DIARIA_LINKEDIN_PAGE_SLUG}" ao final do post (#2458).`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// #2494: no-credential-bio guard — post_pixel / comment_pixel
// ---------------------------------------------------------------------------

/**
 * #2494: padrões de frases de credencial/bio auto-referenciais banidas do
 * `## post_pixel` e `### comment_pixel`. O post pessoal deve sustentar o ponto
 * pelo conteúdo, não pela bio ("trabalho com IA há anos", "faço uma newsletter").
 *
 * Primo das estruturas vetadas (punchline de autoridade — memória
 * `feedback_estruturas_texto_proibidas`).
 *
 * Detecta em AMBAS as seções pessoais (post_pixel + comment_pixel × 3).
 * NÃO flaga em main posts d{N} da company page.
 */
// Padrões de credencial/bio auto-referencial. Anchored com \b pra evitar
// falso-positivo em fragmentos de palavras. Case-insensitive.
// Nota de boundary: JS \b é ASCII-only — "á" não é \w, então \b após "há"
// nunca dispara. Usamos (?!\w) como lookahead de encerramento (não consome
// o char seguinte) para cobrir fins de frase com acentos.
export const CREDENTIAL_BIO_RE =
  /\b(?:trabalho\s+com\s+(?:isso|ia|intelig[eê]ncia\s+artificial)\s+h[aá]|fa[çc]o\s+(?:uma\s+)?newsletter|como\s+(?:algu[eé]m\s+que\s+)?(?:acompanha|trabalha)\s+(?:o\s+setor|(?:com\s+)?ia)|h[aá]\s+(?:alguns\s+)?anos\s+(?:que\s+)?(?:trabalho|acompanho))(?!\w)/gi;

export interface CredentialBioMatch {
  section: string;
  phrase: string;
  context: string;
  line: number;
}

export interface CredentialBioResult {
  ok: boolean;
  matches: CredentialBioMatch[];
}

/**
 * #2494: Detecta frases de credencial/bio auto-referencial em post_pixel e
 * comment_pixel. Essas frases estabelecem autoridade pela bio ("vindo de quem
 * constrói X") em vez de sustentar o ponto pelo conteúdo.
 */
export function lintCredentialBio(md: string): CredentialBioResult {
  const matches: CredentialBioMatch[] = [];

  const linkedinSection = extractPlatformSection(md, "linkedin");
  if (!linkedinSection) return { ok: true, matches };

  // Checar ## post_pixel
  const ppBlock = extractPostPixelBlock(linkedinSection);
  if (ppBlock) {
    const lines = ppBlock.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      CREDENTIAL_BIO_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CREDENTIAL_BIO_RE.exec(line)) !== null) {
        matches.push({
          section: "post_pixel",
          phrase: m[0],
          context: line.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim(),
          line: ppBlock.lineOffset + i,
        });
      }
    }
  }

  // Checar ### comment_pixel em cada destaque d1/d2/d3
  for (const { destaque, text, lineOffset } of extractCommentPixelBlocks(linkedinSection)) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      CREDENTIAL_BIO_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CREDENTIAL_BIO_RE.exec(line)) !== null) {
        matches.push({
          section: `comment_pixel (${destaque})`,
          phrase: m[0],
          context: line.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim(),
          line: lineOffset + i,
        });
      }
    }
  }

  return { ok: matches.length === 0, matches };
}

// ---------------------------------------------------------------------------
// #2526: no-antithesis-reveal — detecta construções "negar pra revelar" em
// posts social. Soa a IA. WARN-ONLY — exit 0 mesmo com matches; o orchestrator
// exibe como ⚠️ no gate, sem bloquear.
//
// Padrões banidos (o FORMATO enjoa, não o ponto):
//   1. "X de verdade, não só Y"  — ex: "É delegação de verdade, não só consulta."
//   2. "não é X, é Y" / "não é X. É Y" / "não é X e sim Y" — ex: "Não é a
//      tecnologia. É a aposta de distribuição."
//   3. Primos: "o que me chama atenção é X, não Y", "não é substituição, é
//      internalização", "não é mais um bot, e sim um colega".
//
// O que PASSA: texto reescrito direto ("a aposta de distribuição me interessa
// mais que a tecnologia") sem a estrutura de antítese-revelação.
// ---------------------------------------------------------------------------

/**
 * Padrão 1: "de verdade, não só" — ex: "delegação de verdade, não só consulta".
 * Aceita "de verdade" com vírgula+espaço (ou espaço) seguido de "não só"/"não
 * apenas". Evita casar "de verdade não sei" (sem intenção de revelar Y).
 *
 * Nota: \b não funciona com caracteres acentuados em JS (ASCII-only). Usamos
 * (?<!\w) como lookbehind de início e terminamos naturalmente na palavra
 * acentuada (ó/o não precisam de \b pois a presença de "só" já é discriminante).
 */
const ANTITHESIS_DE_VERDADE_RE =
  /(?<!\w)de verdade,?\s+n[aã]o\s+s[oó](?!\w)/gi;

/**
 * Padrão 2: "não é X, é Y" / "não é X. É Y" — a antítese-revelação clássica.
 * Cobre:
 *   - "não é X, é Y" (vírgula-separada)
 *   - "não é X. É Y" (frase nova com É maiúsculo)
 *   - "não é X e sim Y" / "não é X, e sim Y"
 *   - "não é X — é Y" (travessão)
 *
 * Heurística: "não é" seguido de qualquer conteúdo (até ~40 chars) e então
 * um dos separadores + conjugação ser/estar em posição reveladora.
 * Anchored para que "não é só isso" (onde não há revelação posterior) não case:
 * exige conteúdo significativo entre o "não é" e o "é/e sim".
 *
 * Nota: \b após "que" funciona porque "que" é ASCII — ok manter.
 */
const ANTITHESIS_NAO_E_RE =
  /n[aã]o\s+[eé]\s+(?!s[oó]\s)(?:.{3,50}?)(?:[,.]?\s+[EeÉé]\s+(?!mais|menos|por|para|que\b)|[,\s]+e\s+sim\s+|\s+[—–-]\s+(?:[EeÉé]\s+))/gi;

/**
 * Padrão 3: "o que me chama atenção é X, não Y" e primos estruturais como
 * "o que me chama atenção não é X".
 * Simples heurística: "chama atenção" + "não é" (ordem pode variar) na mesma
 * frase curta. Nota: \b após "não" falha com 'ã', mas o contexto "não é" já
 * é suficientemente discriminante sem o \b final.
 */
const ANTITHESIS_CHAMA_ATENCAO_RE =
  /o que (?:me\s+)?chama(?:\s+a\s+)?\s*aten[çc][aã]o\s+(?:[eé]\s+.{1,40}?,\s*n[aã]o\s|n[aã]o\s+[eé]\s)/gi;

export interface AntithesisRevealMatch {
  pattern: "de_verdade" | "nao_e_e" | "chama_atencao";
  line: number;
  context: string;
}

export interface AntithesisRevealResult {
  /** Sempre true — este check é WARN-ONLY, nunca bloqueia. */
  ok: true;
  matches: AntithesisRevealMatch[];
}

/**
 * #2526: detecta construções de antítese-revelação em qualquer seção do social.
 * WARN-ONLY — sempre retorna `ok: true`; matches são surfaçados como ⚠️ no gate.
 */
export function lintAntithesisReveal(md: string): AntithesisRevealResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: AntithesisRevealMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip section headers (# / ##) — formato, não prosa
    if (/^#{1,3}\s/.test(line)) continue;
    // Skip HTML comments
    if (/^<!--/.test(line.trim())) continue;

    // Padrão 1: de verdade, não só
    ANTITHESIS_DE_VERDADE_RE.lastIndex = 0;
    if (ANTITHESIS_DE_VERDADE_RE.test(line)) {
      ANTITHESIS_DE_VERDADE_RE.lastIndex = 0; // reset após test() para que exec() capture o 1º match
      const m = ANTITHESIS_DE_VERDADE_RE.exec(line) ?? line.match(ANTITHESIS_DE_VERDADE_RE);
      const idx = m ? line.indexOf(m[0]) : 0;
      matches.push({
        pattern: "de_verdade",
        line: i + 1,
        context: line.slice(Math.max(0, idx - 15), idx + 50).trim(),
      });
      continue; // evitar dupla flag na mesma linha
    }

    // Padrão 3: chama atenção (testar antes do padrão 2 pra evitar dupla flag)
    ANTITHESIS_CHAMA_ATENCAO_RE.lastIndex = 0;
    if (ANTITHESIS_CHAMA_ATENCAO_RE.test(line)) {
      ANTITHESIS_CHAMA_ATENCAO_RE.lastIndex = 0; // reset após test() para que exec() capture o 1º match
      const m = ANTITHESIS_CHAMA_ATENCAO_RE.exec(line) ?? line.match(ANTITHESIS_CHAMA_ATENCAO_RE);
      const idx = m ? line.indexOf(m[0]) : 0;
      matches.push({
        pattern: "chama_atencao",
        line: i + 1,
        context: line.slice(Math.max(0, idx - 15), idx + 60).trim(),
      });
      continue;
    }

    // Padrão 2: não é X, é Y
    ANTITHESIS_NAO_E_RE.lastIndex = 0;
    if (ANTITHESIS_NAO_E_RE.test(line)) {
      ANTITHESIS_NAO_E_RE.lastIndex = 0; // reset após test() para que exec() capture o 1º match
      const m = ANTITHESIS_NAO_E_RE.exec(line) ?? line.match(ANTITHESIS_NAO_E_RE);
      const idx = m ? line.indexOf(m[0]) : 0;
      matches.push({
        pattern: "nao_e_e",
        line: i + 1,
        context: line.slice(Math.max(0, idx - 15), idx + 60).trim(),
      });
    }
  }

  return { ok: true, matches };
}

// ---------------------------------------------------------------------------
// #2658: no-trailing-editorial-hook — detecta ", e [gancho editorial]" em posts
// social. Primo de #2526 (antítese-revelação) e #2494 (punchline de autoridade).
//
// Padrão-alvo: <fato>, e <oração que anuncia relevância em vez de afirmá-la>
//   ex: "O GPT-5.6 Sol entrou em prévia, e a escolha de focos diz mais sobre
//        estratégia do que os benchmarks costumam revelar."
//
// Só dispara quando `, e ` é seguido de oração com GATILHO EDITORIAL.
// `, e` legítimo de coordenação simples ("lançou o modelo, e disponibilizou
// a API") NÃO dispara — exige um dos gatilhos abaixo.
//
// WARN-ONLY: sempre exit 0; matches são surfaçados como ⚠️ no gate.
// ---------------------------------------------------------------------------

/**
 * Gatilhos editoriais que indicam anúncio de relevância em vez de afirmação.
 * Lista conservadora: cada item é discriminante o suficiente para não casar
 * coordenação legítima simples ("e divulgou os resultados").
 */
const EDITORIAL_HOOK_TRIGGER_RE =
  /diz mais sobre|[eé] t[aã]o relevante quanto|[eé] t[aã]o importante quanto|o que mais pesa|mais do que parece|vai al[eé]m de/i;

/**
 * Janela do lookahead: o gatilho editorial deve aparecer dentro de N chars após
 * `, e ` na mesma linha. Exportada pra que a janela de contexto cubra o gatilho
 * inteiro mesmo quando ele cai no fim do lookahead (evita clipar o gatilho do
 * texto mostrado ao editor no gate — review #2658).
 */
const EDITORIAL_HOOK_LOOKAHEAD = 100;

/**
 * Regex completo: `, e ` seguido de conteúdo que contém um gatilho editorial
 * dentro dos ~100 chars seguintes na mesma linha. O lookahead exige o gatilho.
 *
 * O conjunto de gatilhos é DERIVADO de `EDITORIAL_HOOK_TRIGGER_RE.source` —
 * single source of truth, evita drift entre as duas regex (review #2658).
 *
 * Sem flag `g`: a função captura no máximo 1 match por linha (mesma convenção de
 * `lintAntithesisReveal`), então a regex é stateless e dispensa reset de
 * `lastIndex`. Sem `[^\n]*` final: o match termina logo após `, e ` e `m.index`
 * aponta exatamente pra vírgula — janela de contexto fica determinística.
 */
const TRAILING_EDITORIAL_HOOK_RE = new RegExp(
  `, e (?=[^\\n]{0,${EDITORIAL_HOOK_LOOKAHEAD}}(?:${EDITORIAL_HOOK_TRIGGER_RE.source}))`,
  "i",
);

export interface TrailingEditorialHookMatch {
  line: number;
  context: string;
}

export interface TrailingEditorialHookResult {
  /** Sempre true — este check é WARN-ONLY, nunca bloqueia. */
  ok: true;
  matches: TrailingEditorialHookMatch[];
}

/**
 * #2658: detecta estrutura ", e [gancho editorial]" em qualquer seção do social.
 * Primo de #2526 (antítese-revelação) e #2494 (punchline de autoridade).
 *
 * O padrão abre com o fato e emenda uma oração final que ANUNCIA a relevância
 * em vez de afirmá-la. Gatilhos: "diz mais sobre", "é tão relevante quanto",
 * "é tão importante quanto", "o que mais pesa", "mais do que parece",
 * "vai além de".
 *
 * Limitação conhecida: o gatilho precisa cair dentro de ~100 chars após `, e `
 * (janela do lookahead) — uma oração com preâmbulo muito longo antes do gatilho
 * não dispara. Os exemplos reais ficam bem abaixo desse limite.
 *
 * 1 match por linha (mesma convenção de `lintAntithesisReveal`). WARN-ONLY —
 * sempre retorna `ok: true`; matches são surfaçados como ⚠️ no gate. Decisão de
 * cortar a oração ou mover o gancho pro corpo fica com o editor.
 */
export function lintTrailingEditorialHook(md: string): TrailingEditorialHookResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: TrailingEditorialHookMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip section headers (# / ## / ###) — formato, não prosa
    if (/^#{1,3}\s/.test(line)) continue;
    // Skip HTML comments
    if (/^<!--/.test(line.trim())) continue;

    const m = TRAILING_EDITORIAL_HOOK_RE.exec(line);
    if (m) {
      const idx = m.index;
      // Janela de contexto: 20 chars antes do `, e ` + o suficiente pra cobrir
      // o lookahead inteiro (até o gatilho) sem clipar (review #2658).
      matches.push({
        line: i + 1,
        context: line.slice(Math.max(0, idx - 20), idx + EDITORIAL_HOOK_LOOKAHEAD + 30).trim(),
      });
    }
  }

  return { ok: true, matches };
}

// Exportar o regex de gatilho pra testes de não-disparo
export { EDITORIAL_HOOK_TRIGGER_RE };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// ── #1762: posts social NÃO devem encerrar com pergunta (CTA-pergunta) ──────

export interface TrailingQuestionMatch {
  platform: "linkedin" | "facebook";
  destaque: string;
  sentence: string;
}
export interface TrailingQuestionResult {
  ok: boolean;
  matches: TrailingQuestionMatch[];
}

/**
 * #1762: a ÚLTIMA frase do post principal (corpo de `## d{N}`, antes dos comments
 * do LinkedIn) não pode terminar em "?". Alvo: CTA-pergunta de encerramento
 * ("Comente abaixo: ...? Como você faz X?"). Perguntas retóricas NO MEIO do corpo
 * e perguntas entre aspas (`vale a pena?"`) são aceitáveis — só a de encerramento
 * é flagada.
 *
 * Estratégia: pega a última linha de texto significativa (ignorando linhas só de
 * hashtags / só de URL), remove hashtags inline no fim, e checa se termina em "?"
 * literal (um "?" seguido de aspas de fechamento = pergunta citada → OK).
 */
// Linha que é só hashtags (tags podem ter hífen, ex: #multi-agent).
const HASHTAG_ONLY_LINE_RE = /^(#[\p{L}\w-]+(\s+#[\p{L}\w-]+)*)$/u;
// CTA fixo de assinatura (Facebook fecha com isto após o corpo) — não é o
// "fim editorial" que o #1762 mira; pulamos pra checar a última frase do corpo.
const SUBSCRIBE_CTA_LINE_RE = /diar\.ia\.br|assine\s+gr[áa]tis|receba\s+not[íi]cias/i;

/**
 * #1861: o `## post_pixel` (post pessoal standalone do Pixel) é por convenção
 * sobre o **D1** (#1690). Quando os destaques são reordenados DEPOIS de gerar o
 * social (reorder no gate / edição manual), os `## d{N}` são remapeados mas o
 * post_pixel atrelado ao D1 antigo fica stale — e nenhum lint pegava (caso
 * 260605: D1 virou MIT empregos, post_pixel ficou sobre ChatGPT, o D1 antigo).
 *
 * Heurística de ALTA precisão (evita FP num post reescrito): compara a
 * sobreposição de tokens (Jaccard, reusa o de dedup.ts) do post_pixel com o
 * main de cada destaque. O sinal real é RELATIVO — só falha quando o post_pixel
 * é claramente MAIS parecido com OUTRO destaque que com o d1, por uma margem:
 *   `bestOther ≥ simD1 + MARGIN` E `bestOther ≥ FLOOR`.
 *
 * Por que margem RELATIVA, não threshold absoluto (review #1877): o post_pixel
 * é voz PESSOAL reescrita, então o overlap literal com o main EDITORIAL do
 * destaque é naturalmente baixo (na 260605 real, o post_pixel correto batia o
 * d1 em ~0.14, os outros em ~0.05). Um floor absoluto de 0.15 deixaria passar o
 * caso stale (post sobre d2 com Jaccard ~0.12-0.14). O que discrimina é
 * bestOther superar simD1 com folga; o FLOOR baixo só evita disparar em ruído
 * (1-2 tokens coincidentes quando o post quase não casa com nada).
 *
 * Hashtags são stripadas dos DOIS lados (simetria) — senão as tags do main
 * inflam o union e derrubam todas as sims.
 */
export interface PostPixelMatchResult {
  ok: boolean;
  /** false = no-op (sem seção LinkedIn / sem post_pixel / sem d1 / post vazio). */
  checked: boolean;
  best_match?: string;
  sims?: Record<string, number>;
  detail?: string;
  /**
   * Valor do label `<!-- destaque: d{N} -->` emitido pelo social-linkedin no bloco
   * `## post_pixel`. Quando presente, indica a qual destaque o bloco declarou
   * pertencer. O lint usa isso como cross-check: se `declared_destaque` difere de
   * `best_match` Jaccard, a inconsistência é mais forte (label desatualizado é
   * evidência adicional de stale). Undefined = label ausente no bloco.
   */
  declared_destaque?: string;
}

const POST_PIXEL_MARGIN = 0.05; // bestOther tem que bater simD1 por ≥ 5 pontos
const POST_PIXEL_FLOOR = 0.08; // e ser um match topical real, não 1-2 tokens de ruído

/**
 * Tokeniza prosa social: strip comments + hashtags (em ambos os lados da
 * comparação, de forma simétrica), depois tokenizeForJaccard.
 *
 * Stripping simétrico evita falso-positivo quando entidades aparecem como
 * hashtag apenas no post_pixel (ex: #Anthropic) — sem symmetry, o tag inflaria
 * o union do post_pixel sem contrapartida no main do destaque, derrubando
 * artificialmente as sims (#2145 finding 6).
 */
function socialProseTokens(s: string): Set<string> {
  // Strip HTML comments primeiro, depois hashtags (ex: #InteligenciaArtificial).
  // A ordem importa: um hashtag dentro de um comment seria removido pelo
  // comment-strip; remover hashtags depois garante que sobraram só no texto.
  const clean = s
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/#[\p{L}\w-]+/gu, " ");
  return tokenizeForJaccard(clean);
}

export function lintPostPixelMatchesD1(md: string): PostPixelMatchResult {
  const section = extractPlatformSection(md, "linkedin");
  if (!section) return { ok: true, checked: false };

  // Mapa de blocos `## <name>` → conteúdo até o próximo `## <name>` (mesmo nível).
  const text = "\n" + section.replace(/\r\n/g, "\n");
  const blocks: Record<string, string> = {};
  const re = /\n## ([a-z0-9_]+)\s*\n([\s\S]*?)(?=\n## [a-z0-9_]+\s*\n|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks[m[1].toLowerCase()] = m[2];
  }

  const postPixelRaw = blocks["post_pixel"];
  if (!postPixelRaw || postPixelRaw.trim().length === 0) {
    return { ok: true, checked: false };
  }

  // Extrair label `<!-- destaque: d{N} -->` emitido pelo social-linkedin.
  // Usado como cross-check: se o label diz "d1" mas Jaccard aponta outro destaque,
  // reforça a evidência de stale. Se ausente → undefined (não bloqueia).
  const labelMatch = postPixelRaw.match(/<!--\s*destaque:\s*(d\d+)\s*-->/i);
  const declaredDestaque = labelMatch ? labelMatch[1].toLowerCase() : undefined;

  // Main text de um destaque = conteúdo antes do 1º `### ` (subseções comment).
  const destaqueMain = (name: string): string | null => {
    const raw = blocks[name];
    if (raw === undefined) return null;
    const idx = raw.search(/\n### /);
    return idx === -1 ? raw : raw.slice(0, idx);
  };

  const d1 = destaqueMain("d1");
  if (d1 === null) return { ok: true, checked: false }; // sem d1 não há baseline

  const ppTokens = socialProseTokens(postPixelRaw);
  // post_pixel só com hashtags/comment (sem prosa real) → não dá pra comparar.
  if (ppTokens.size === 0) return { ok: true, checked: false };

  const sims: Record<string, number> = {};
  for (const name of ["d1", "d2", "d3"]) {
    const main = destaqueMain(name);
    if (main === null) continue;
    sims[name] = jaccardSimilarity(ppTokens, socialProseTokens(main));
  }

  const simD1 = sims["d1"] ?? 0;
  let bestOther = -1;
  let bestOtherName = "";
  for (const [name, s] of Object.entries(sims)) {
    if (name === "d1") continue;
    if (s > bestOther) {
      bestOther = s;
      bestOtherName = name;
    }
  }

  if (bestOther >= simD1 + POST_PIXEL_MARGIN && bestOther >= POST_PIXEL_FLOOR) {
    const labelHint = declaredDestaque && declaredDestaque !== "d1"
      ? ` Label '<!-- destaque: ${declaredDestaque} -->' confirma dessincronização.`
      : "";
    return {
      ok: false,
      checked: true,
      best_match: bestOtherName,
      sims,
      declared_destaque: declaredDestaque,
      detail:
        `post_pixel parece sobre ${bestOtherName} (Jaccard ${bestOther.toFixed(2)}), não d1 ` +
        `(Jaccard ${simD1.toFixed(2)}). Reordenou destaques após gerar o social? Re-sincronize ` +
        `o post_pixel pro D1 atual (#1861).${labelHint}`,
    };
  }
  return { ok: true, checked: true, best_match: simD1 > 0 ? "d1" : undefined, sims, declared_destaque: declaredDestaque };
}

export function lastMeaningfulSentence(body: string): string {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, ""); // strip char_count comments
  const lines = cleaned.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (HASHTAG_ONLY_LINE_RE.test(l)) continue; // linha só de hashtags
    if (/^https?:\/\/\S+$/.test(l)) continue; // linha só de URL
    if (SUBSCRIBE_CTA_LINE_RE.test(l)) continue; // #1762: CTA de assinatura (Facebook)
    return l;
  }
  return "";
}

export function endsWithTrailingQuestion(sentence: string): boolean {
  // Remove decorações de encerramento (hashtags coladas/espaçadas + emoji +
  // espaço) iterativamente, em qualquer ordem ("...faz? 🚀 #IA" → "...faz?").
  let stripped = sentence.trimEnd();
  let prev = "";
  while (stripped !== prev) {
    prev = stripped;
    stripped = stripped.replace(/\s*#[\p{L}\w-]+\s*$/u, "").trimEnd(); // hashtag final
    stripped = stripped.replace(/[\p{Extended_Pictographic}️‍]\s*$/u, "").trimEnd(); // emoji final
  }
  // "?" literal no fim → pergunta de encerramento. "?\"" / "?'" / "?)" → citada/aparte → OK.
  return /\?$/.test(stripped);
}

export function lintTrailingQuestion(md: string): TrailingQuestionResult {
  const matches: TrailingQuestionMatch[] = [];
  for (const platform of ["linkedin", "facebook"] as const) {
    const section = extractPlatformSection(md, platform);
    if (!section) continue;
    // Prefixa "\n" pra garantir captura do 1º `## d1` mesmo sem linha em branco
    // antes (o split exige `\n## d{N}\n`). Sem isso, d1 era pulado (review #1776).
    const chunks = ("\n" + section).split(/\n## (d\d+)\n/);
    for (let i = 1; i < chunks.length; i += 2) {
      const destaque = chunks[i];
      let body = chunks[i + 1] ?? "";
      // Só o post PRINCIPAL — corta os comments do LinkedIn (### comment_*).
      const commentIdx = body.search(/\n### comment_/);
      if (commentIdx !== -1) body = body.slice(0, commentIdx);
      const last = lastMeaningfulSentence(body);
      if (last && endsWithTrailingQuestion(last)) {
        matches.push({ platform, destaque, sentence: last.slice(-100) });
      }
    }
  }
  return { ok: matches.length === 0, matches };
}

// ---------------------------------------------------------------------------
// #2148 Fix A: personal post newsletter deixis guard
// ---------------------------------------------------------------------------

/**
 * #2148: `## post_pixel` e `### comment_pixel` são postados na conta PESSOAL
 * do autor (vjpixel), sem contexto de marca. Usar "esta/essa/nossa newsletter"
 * presume que o leitor sabe de qual newsletter se trata — framing inválido num
 * post standalone no feed pessoal.
 *
 * Detecta as frases-âncora em `## post_pixel` e `### comment_pixel` dentro da
 * seção LinkedIn. NÃO flaga nos posts principais `## d{N}` da Diar.ia (esses
 * são de marca, onde a deixis é OK).
 */
export interface PersonalPostDeixisMatch {
  section: string;
  phrase: string;
  context: string;
  line: number;
}

export interface PersonalPostDeixisResult {
  ok: boolean;
  matches: PersonalPostDeixisMatch[];
}

// Âncoras de deixis que pressupõem o leitor na Diar.ia.
// Formas femininas: "esta newsletter", "essa newsletter", "nossa newsletter",
//                  "esta edição",     "essa edição",     "nossa edição".
// Formas masculinas: "este boletim", "esse boletim", "nosso boletim".
// ("boletim" é masculino — "esse/este/nosso boletim", não "essa/esta/nossa boletim".)
const NEWSLETTER_DEIXIS_RE =
  /\b(esta|essa|nossa|este|esse|nosso)\s+(newsletter|boletim|edi[çc][ãa]o)\b/gi;

/**
 * Extrai o texto de `## post_pixel` de uma seção LinkedIn.
 * (bloco top-level `## post_pixel`, encerrando no próximo `## ` ou fim)
 *
 * Exportado (#3052) para reuso por scripts/resolve-post-pixel.ts (Stage 6 —
 * resolução de {outros_count}/{edition_url} pro fluxo manual de publicação).
 */
export function extractPostPixelBlock(linkedinSection: string): { text: string; lineOffset: number } | null {
  const text = "\n" + linkedinSection.replace(/\r\n/g, "\n");
  const m = text.match(/\n## post_pixel[^\n]*\n([\s\S]*?)(?=\n## [a-z]|$)/i);
  if (!m) return null;
  // Contar linhas até o match para calcular lineOffset
  const before = text.slice(0, m.index ?? 0);
  const lineOffset = before.split("\n").length;
  return { text: m[1], lineOffset };
}

/**
 * Extrai todos os blocos `### comment_pixel` de uma seção LinkedIn.
 * Cada bloco vai do header até o próximo `### ` ou `## ` ou fim do destaque.
 */
function extractCommentPixelBlocks(linkedinSection: string): Array<{ destaque: string; text: string; lineOffset: number }> {
  const normalized = "\n" + linkedinSection.replace(/\r\n/g, "\n");
  const results: Array<{ destaque: string; text: string; lineOffset: number }> = [];
  // Iterar cada bloco de destaque `## d{N}`
  const destaqueRe = /\n## (d\d+)[^\n]*\n([\s\S]*?)(?=\n## [a-z]|$)/gi;
  let dm: RegExpExecArray | null;
  while ((dm = destaqueRe.exec(normalized)) !== null) {
    const destaque = dm[1];
    const body = dm[2];
    const destaqueLineOffset = normalized.slice(0, dm.index).split("\n").length;
    // Encontrar `### comment_pixel` dentro do body
    const cpRe = /\n### comment_pixel[^\n]*\n([\s\S]*?)(?=\n### |$)/i;
    const cp = body.match(cpRe);
    if (!cp) continue;
    const cpLineOffset = destaqueLineOffset + body.slice(0, cp.index ?? 0).split("\n").length;
    results.push({ destaque, text: cp[1], lineOffset: cpLineOffset });
  }
  return results;
}

export function lintPersonalPostNewsletterDeixis(md: string): PersonalPostDeixisResult {
  const matches: PersonalPostDeixisMatch[] = [];

  const linkedinSection = extractPlatformSection(md, "linkedin");
  if (!linkedinSection) return { ok: true, matches };

  // Checar ## post_pixel
  const ppBlock = extractPostPixelBlock(linkedinSection);
  if (ppBlock) {
    const lines = ppBlock.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      NEWSLETTER_DEIXIS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = NEWSLETTER_DEIXIS_RE.exec(line)) !== null) {
        matches.push({
          section: "post_pixel",
          phrase: m[0],
          context: line.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim(),
          line: ppBlock.lineOffset + i,
        });
      }
    }
  }

  // Checar ### comment_pixel em cada destaque
  for (const { destaque, text, lineOffset } of extractCommentPixelBlocks(linkedinSection)) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      NEWSLETTER_DEIXIS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = NEWSLETTER_DEIXIS_RE.exec(line)) !== null) {
        matches.push({
          section: `comment_pixel (${destaque})`,
          phrase: m[0],
          context: line.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20).trim(),
          line: lineOffset + i,
        });
      }
    }
  }

  return { ok: matches.length === 0, matches };
}

// ---------------------------------------------------------------------------
// #2148 Fix B: per-section humanizer coverage check
// ---------------------------------------------------------------------------

/**
 * #2148: o guard de no-op do humanizador é WHOLE-FILE — se o humanizador
 * reescreve os posts principais mas deixa comments/post_pixel intactos,
 * o arquivo MUDA → guard passa → cobertura parcial fica invisível.
 *
 * Esta função compara `03-social.md` pré e pós-humanizador
 * SEÇÃO POR SEÇÃO, identificando quais seções foram alteradas e quais não.
 *
 * Seções verificadas: `## d1`, `## d2`, `## d3` (main), `### comment_pixel`
 * (×3) e `## post_pixel`. `### comment_diaria` é CTA template — OK não mudar.
 *
 * Retorna a lista de seções não-tocadas. O orchestrator deve re-invocar o
 * humanizador mirando essas seções se a lista não estiver vazia.
 */
export interface SectionCoverageResult {
  ok: boolean;
  /**
   * Seções verificadas e se foram alteradas (true = touched pelo humanizador).
   */
  sections: Array<{ name: string; touched: boolean }>;
  /** Seções que ficaram idênticas antes vs depois. */
  untouched: string[];
  /** Seções presentes no pre mas ausentes no post (corrupção estrutural). */
  deleted: string[];
}

/** Extrai blocos nomeados de nível `##` e `###` da seção LinkedIn. */
function extractSocialSections(md: string): Record<string, string> {
  const section = extractPlatformSection(md, "linkedin");
  if (!section) return {};

  const result: Record<string, string> = {};
  const normalized = "\n" + section.replace(/\r\n/g, "\n");

  // Blocos `## d{N}` (main text apenas — até o 1º `### comment_`)
  const destaqueRe = /\n## (d\d+)[^\n]*\n([\s\S]*?)(?=\n## [a-z]|$)/gi;
  let dm: RegExpExecArray | null;
  while ((dm = destaqueRe.exec(normalized)) !== null) {
    const destaque = dm[1];
    const body = dm[2];
    // Main = até primeiro `### comment_`
    const cpIdx = body.search(/\n### comment_/);
    result[`main_${destaque}`] = cpIdx === -1 ? body : body.slice(0, cpIdx);

    // comment_pixel dentro do destaque
    const cpRe = /\n### comment_pixel[^\n]*\n([\s\S]*?)(?=\n### |$)/i;
    const cp = body.match(cpRe);
    if (cp) result[`comment_pixel_${destaque}`] = cp[1];
  }

  // post_pixel
  const pp = normalized.match(/\n## post_pixel[^\n]*\n([\s\S]*?)(?=\n## [a-z]|$)/i);
  if (pp) result["post_pixel"] = pp[1];

  return result;
}

/**
 * Compara `03-social.md` antes e depois do humanizador seção por seção.
 * Seções que mudaram = humanizador cobriu. Idênticas = não cobriu.
 *
 * `preMd`: conteúdo do arquivo ANTES do humanizador (snapshot).
 * `postMd`: conteúdo APÓS o humanizador.
 */
export function checkHumanizerSectionCoverage(preMd: string, postMd: string): SectionCoverageResult {
  const SECTIONS_TO_CHECK = [
    "main_d1", "main_d2", "main_d3",
    "comment_pixel_d1", "comment_pixel_d2", "comment_pixel_d3",
    "post_pixel",
  ];

  const preSections = extractSocialSections(preMd);
  const postSections = extractSocialSections(postMd);

  const sections: Array<{ name: string; touched: boolean }> = [];
  const untouched: string[] = [];
  const deleted: string[] = [];

  for (const name of SECTIONS_TO_CHECK) {
    const pre = preSections[name];
    const post = postSections[name];
    // Seção ausente em ambos = não existe nesta edição → skip (ok, não untouched)
    if (pre === undefined && post === undefined) continue;
    // Seção ausente no pre mas presente no post = algo adicionado → touched (ok)
    if (pre === undefined) {
      sections.push({ name, touched: true });
      continue;
    }
    // Seção presente no pre mas ausente no post = corrupção estrutural (humanizador deletou)
    if (post === undefined) {
      sections.push({ name, touched: false });
      deleted.push(name);
      continue;
    }
    const touched = pre.trim() !== post.trim();
    sections.push({ name, touched });
    if (!touched) untouched.push(name);
  }

  return { ok: untouched.length === 0 && deleted.length === 0, sections, untouched, deleted };
}


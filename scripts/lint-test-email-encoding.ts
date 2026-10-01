#!/usr/bin/env tsx
/**
 * lint-test-email-encoding.ts (#1248)
 *
 * Detecta corrupção de encoding (caracteres especiais perdidos ou
 * substituídos) entre source MD e email renderizado. Casos comuns:
 * - 'ª' / 'º' viram 'a' / 'o' por charset mismatch
 * - Acentos PT-BR (ã, ç, é, ô) viram '?', 'ï¿½' ou variantes
 * - Emojis sumidos no template
 * - Smart quotes (`'` `"` `…` `–` `—`) viram ASCII (`'` `"` `...` `-`)
 *
 * Estratégia: extrai texto limpo dos dois lados, encontra caracteres
 * não-ASCII no source e checa se aparecem no email. Falsos-positivos:
 * - Gmail proxeia conteúdo de tracking, às vezes re-escapa.
 * - Smart quotes substituídos por ASCII via autocorrect pode ser ok.
 *
 * Emoji de kicker (header de seção e categoria do DESTAQUE) é removido pelo
 * renderer (`stripKickerEmoji`) e fica FORA da checagem; emoji é comparado
 * como grapheme inteiro (ZWJ, skin tone, VS16, bandeira, keycap) — #9115.
 *
 * Reporta como warning quando char no source não aparece no email.
 * Não bloqueia automaticamente — editor revisa.
 *
 * Uso:
 *   npx tsx scripts/lint-test-email-encoding.ts \
 *     --email-file /tmp/email-260514.txt \
 *     --source-md data/editions/260514/02-reviewed.md \
 *     --out /tmp/lint-encoding.json
 *
 * Exit codes:
 *   0 = sem corrupção detectada (ou só warnings ASCII-substitutos)
 *   1 = caracteres não-ASCII do source faltando no email (drop sem fallback)
 *   2 = erro de uso
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
// #9115: mesma função que o renderer usa pra tirar o emoji do label do kicker
// (headers de seção e categoria do DESTAQUE) — fonte única, nada de regex paralela.
import { stripKickerEmoji } from "./lib/newsletter-render-html.ts";
import { ALL_SECTION_NAMES_PATTERN } from "./lib/section-naming.ts";

export interface EncodingIssue {
  type: "char_dropped" | "char_substituted";
  char: string;
  /** Codepoint do primeiro caractere de `char` (ex: U+00E3 pra ã); a
   * sequência completa, quando houver, fica em `sequence`. */
  codepoint: string;
  /** Contexto curto onde o char aparece no source. */
  source_context: string;
  /** Substituto detectado no email (ASCII-ish), se houver. */
  email_substitute?: string;
  /** #9115: codepoints em notação U+XXXX separados por espaço — só presente
   * quando `char` tem >1 codepoint (emoji com ZWJ, skin tone, VS16, bandeira,
   * keycap tratado como unidade). */
  sequence?: string;
}

export interface EncodingResult {
  total_special_chars_in_source: number;
  unique_special_chars: number;
  issues: EncodingIssue[];
  passed: boolean;
}

/**
 * Strip HTML tags + entities pra obter texto limpo.
 */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
}

/**
 * Substituições ASCII comuns que podem ser aceitáveis ou indicar drop:
 * Map { unicodeChar: [possíveis substitutos ASCII] }
 */
const ASCII_SUBSTITUTES: Record<string, string[]> = {
  "ã": ["a"],
  "õ": ["o"],
  "á": ["a"],
  "à": ["a"],
  "â": ["a"],
  "é": ["e"],
  "ê": ["e"],
  "í": ["i"],
  "ó": ["o"],
  "ô": ["o"],
  "ú": ["u"],
  "ü": ["u"],
  "ç": ["c"],
  "ª": ["a"],
  "º": ["o"],
  "—": ["-", "--"],
  "–": ["-"],
  "…": ["..."],
  "‘": ["'"], // left single quote
  "’": ["'"], // right single quote
  "“": ['"'], // left double quote
  "”": ['"'], // right double quote
};

/**
 * #9115: remove do source MD o emoji dos headers de seção e da categoria do
 * DESTAQUE — o renderer (`renderKicker` → `stripKickerEmoji`) os tira de
 * propósito, então a ausência deles no HTML/e-mail é by-design, não drop.
 *
 * Cobre as duas formas de kicker do `02-reviewed.md`:
 *   - `**🙋🏼‍♀️ PARA ENCERRAR**` (header de seção, linha inteira em negrito)
 *   - `**DESTAQUE 1 | ⚠️ SEGURANÇA**` (categoria do destaque)
 * O header de seção só é tocado quando o label limpo é um NOME DE SEÇÃO
 * conhecido: `ALL_SECTION_NAMES_PATTERN` de `section-naming.ts` (LANÇAMENTOS,
 * RADAR, USE MELHOR, VÍDEOS + legacy) mais os kickers fixos que o renderer
 * emite fora dessa lista (SORTEIO, PARA ENCERRAR, É IA?). Qualquer outra linha
 * em negrito com emoji — inclusive `**⚠️ ATENÇÃO: PRAZO ENCERRA HOJE**` —
 * continua sendo checada.
 */
export function stripSectionHeaderEmojis(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      // #9279: marcador 🎉 de abertura de box de celebração — o renderer o tira (`stripCeremonyMarker`).
      if (CEREMONY_MARKER_RE.test(line)) return line.replace(CEREMONY_MARKER_RE, "");
      const destaque = line.match(/^(\s*\*\*DESTAQUE\s+\d+\s*\|\s*)(.+?)(\*\*\s*)$/u);
      if (destaque) return destaque[1] + stripKickerEmoji(destaque[2]) + destaque[3];
      // `[^*]` — 2 spans em negrito na mesma linha (`**🔥 A** e **B**`) não é kicker.
      const header = line.match(/^(\s*\*\*)([^*]+)(\*\*\s*)$/u);
      if (!header) return line;
      const label = header[2];
      const clean = stripKickerEmoji(label);
      if (!SECTION_HEADER_LABEL_RE.test(clean)) return line;
      // só remove se o prefixo cortado contém emoji (não um "[" de link etc.)
      if (!EMOJI_RE.test(label.slice(0, label.indexOf(clean)))) return line;
      return header[1] + clean + header[3];
    })
    .join("\n");
}

const CEREMONY_MARKER_RE = new RegExp(`^\\s*\u{1F389}[${String.fromCodePoint(0xfe0e, 0xfe0f)}]?[ \\t]*`, "u");

/** Kickers fixos que o renderer emite via `renderKicker("...")` e que não estão
 * em `SECTIONS` (seções de pool) de `section-naming.ts`. */
const FIXED_KICKER_NAMES_PATTERN = String.raw`SORTEIO|PARA\s+ENCERRAR|[ÉE]\s+IA\??`;
const SECTION_HEADER_LABEL_RE = new RegExp(
  String.raw`^(?:${ALL_SECTION_NAMES_PATTERN}|${FIXED_KICKER_NAMES_PATTERN})$`,
  "iu",
);

// U+20E3 (combining enclosing keycap): `1️⃣` é emoji mesmo sem Extended_Pictographic.
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u;
// VS15 (U+FE0E) / VS16 (U+FE0F) — montado por codepoint pra não deixar caractere invisível no fonte.
const VARIATION_SELECTORS_RE = new RegExp(`[${String.fromCodePoint(0xfe0e, 0xfe0f)}]`, "gu");

function isIgnorableCodepoint(cp: number): boolean {
  return cp <= 127 || cp === 0xa0 || cp === 0xfeff;
}

function toCodepoint(ch: string): string {
  return "U+" + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * #9115: unidades a comparar. Emoji (incluindo sequências ZWJ, skin tone,
 * VS16 e bandeiras) vira UMA unidade — o grapheme inteiro —, pra que ZWJ/♀/
 * VS16/modificador nunca sejam acusados soltos quando o emoji todo sumiu (ou
 * acusados por estarem só dentro de uma sequência). Fora de emoji, segue
 * por codepoint como antes (acento, aspa tipográfica, travessão).
 */
function specialUnits(text: string): string[] {
  const units = new Set<string>();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(text)) {
    if (EMOJI_RE.test(segment)) {
      units.add(segment);
      continue;
    }
    for (const ch of segment) {
      if (!isIgnorableCodepoint(ch.codePointAt(0)!)) units.add(ch);
    }
  }
  return [...units];
}

/**
 * Detecta caracteres não-ASCII no source que não aparecem no email.
 * Considera apenas chars onde drop seria semanticamente significante
 * (acentos, smart quotes, emojis). Ignora whitespace exotic.
 */
export function checkEncoding(sourceText: string, emailText: string): EncodingIssue[] {
  const issues: EncodingIssue[] = [];
  // #9115: emoji de kicker é removido pelo renderer por design — tira do source antes.
  const source = stripSectionHeaderEmojis(sourceText);
  const emailNoVs = emailText.replace(VARIATION_SELECTORS_RE, "");

  for (const unit of specialUnits(source)) {
    if (emailText.includes(unit)) continue; // ok, preservado
    const isEmoji = EMOJI_RE.test(unit);
    // Emoji: VS15/VS16 é apresentação, não conteúdo — "⚠" e "⚠️" são o mesmo.
    if (isEmoji && emailNoVs.includes(unit.replace(VARIATION_SELECTORS_RE, ""))) continue;

    // Ausente no email. Verifica se há substituto ASCII conhecido.
    const subs = ASCII_SUBSTITUTES[unit] ?? [];
    let substitute: string | undefined;
    for (const sub of subs) {
      if (emailText.includes(sub)) {
        substitute = sub;
        break;
      }
    }

    // Pega contexto curto do source
    const idx = source.indexOf(unit);
    const start = Math.max(0, idx - 20);
    const end = Math.min(source.length, idx + unit.length + 20);
    const ctx = source.slice(start, end).replace(/\s+/g, " ").trim();

    const cps = [...unit];
    issues.push({
      type: substitute ? "char_substituted" : "char_dropped",
      char: unit,
      codepoint: toCodepoint(unit),
      source_context: ctx,
      email_substitute: substitute,
      ...(cps.length > 1 ? { sequence: cps.map(toCodepoint).join(" ") } : {}),
    });
  }

  return issues;
}

function countSpecial(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 127) count++;
  }
  return count;
}

async function mainCli(): Promise<number> {
  const { flags, values } = parseArgs(process.argv.slice(2));
  if (flags.has("help") || !values["email-file"] || !values["source-md"]) {
    console.error("Uso: lint-test-email-encoding.ts --email-file <file> --source-md <file> [--out <json>]");
    return 2;
  }
  const emailFile = values["email-file"];
  const sourceMd = values["source-md"];
  if (!existsSync(emailFile) || !existsSync(sourceMd)) {
    console.error("Arquivo(s) faltando.");
    return 2;
  }
  const sourceContent = readFileSync(sourceMd, "utf8");
  const emailRaw = readFileSync(emailFile, "utf8");
  const emailText = stripHtmlToText(emailRaw);
  const issues = checkEncoding(sourceContent, emailText);
  const dropped = issues.filter((i) => i.type === "char_dropped");
  const result: EncodingResult = {
    total_special_chars_in_source: countSpecial(sourceContent),
    unique_special_chars: new Set([...sourceContent].filter((c) => c.codePointAt(0)! > 127)).size,
    issues,
    passed: dropped.length === 0,
  };
  if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
  if (dropped.length > 0) {
    console.error(`[lint-test-email-encoding] ${dropped.length} char(s) dropados (sem substituto):`);
    for (const i of dropped) {
      console.error(`  - ${i.codepoint} '${i.char}' em "…${i.source_context}…"`);
    }
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  mainCli().then((code) => process.exit(code));
}

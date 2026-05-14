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

export interface EncodingIssue {
  type: "char_dropped" | "char_substituted";
  char: string;
  /** Codepoint Unicode (ex: U+00E3 pra ã). */
  codepoint: string;
  /** Contexto curto onde o char aparece no source. */
  source_context: string;
  /** Substituto detectado no email (ASCII-ish), se houver. */
  email_substitute?: string;
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
 * Detecta caracteres não-ASCII no source que não aparecem no email.
 * Considera apenas chars onde drop seria semanticamente significante
 * (acentos, smart quotes, emojis). Ignora whitespace exotic.
 */
export function checkEncoding(sourceText: string, emailText: string): EncodingIssue[] {
  const issues: EncodingIssue[] = [];
  // Set de chars únicos não-ASCII no source que aparecem em palavras (não whitespace)
  const sourceSpecial = new Set<string>();
  for (const ch of sourceText) {
    const cp = ch.codePointAt(0)!;
    // Codepoints > 127 (não ASCII básico). Exclui whitespace control.
    if (cp > 127 && cp !== 0xA0 && cp !== 0xFEFF) {
      sourceSpecial.add(ch);
    }
  }

  for (const ch of sourceSpecial) {
    if (emailText.includes(ch)) continue; // ok, char preservado

    // Char source ausente no email. Verifica se há substituto ASCII conhecido.
    const subs = ASCII_SUBSTITUTES[ch] ?? [];
    let substitute: string | undefined;
    for (const sub of subs) {
      if (emailText.includes(sub)) {
        substitute = sub;
        break;
      }
    }

    // Pega contexto curto do source
    const idx = sourceText.indexOf(ch);
    const start = Math.max(0, idx - 20);
    const end = Math.min(sourceText.length, idx + 20);
    const ctx = sourceText.slice(start, end).replace(/\s+/g, " ").trim();

    const cp = ch.codePointAt(0)!;
    const codepoint = "U+" + cp.toString(16).toUpperCase().padStart(4, "0");

    issues.push({
      type: substitute ? "char_substituted" : "char_dropped",
      char: ch,
      codepoint,
      source_context: ctx,
      email_substitute: substitute,
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

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function mainCli(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args["email-file"] || !args["source-md"]) {
    console.error("Uso: lint-test-email-encoding.ts --email-file <file> --source-md <file> [--out <json>]");
    return 2;
  }
  const emailFile = String(args["email-file"]);
  const sourceMd = String(args["source-md"]);
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
  if (args.out) writeFileSync(String(args.out), JSON.stringify(result, null, 2), "utf8");
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

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/lint-test-email-encoding\.ts$/.test(_argv1)) {
  mainCli().then((code) => process.exit(code));
}

/**
 * lint-checks/title-clickbait-vulgar.ts (#6008)
 *
 * Backstop editorial do padrão "clickbait elegante" (decisão do editor,
 * sessão 260824): títulos escritos pra maximizar abertura/clique mantendo a
 * linha editorial — tensão factual, pergunta provocativa, referência direta
 * ao leitor. Este check NÃO avalia o tom (isso é trabalho do rubrico nos
 * prompts de writer/title-picker) — ele flagra só a faixa VULGAR, que o
 * padrão proíbe explicitamente.
 *
 * **WARN-ONLY por design (mesmo molde de `ia-in-title.ts` #4825).** A
 * decisão final de tom é do editor no gate da Etapa 4 — o lint nunca
 * bloqueia. Padrões flagrados (blocklist):
 *
 *   - "você não vai acreditar" / variantes (com/sem acento)
 *   - "chocante" / "shocking"
 *   - "o que aconteceu depois" (curiosity gap clássico)
 *   - reticências de suspense no fim do título ("..." / "…")
 *   - "!" no título (grito)
 *   - CAPS LOCK: palavra ≥6 letras toda em maiúsculas (allowlist curto de
 *     siglas legítimas)
 *   - listicle vazio: "N coisas/motivos/dicas/erros..." sem substância
 *
 * Escopo: só títulos de DESTAQUE (mesmo recorte de #4825 — walkDestaqueTitles).
 */

import { HIGHLIGHT_HEADER_RE, SECTION_HEADER_LINE_RE } from "./highlight-parsing.ts";
import { walkDestaqueTitles } from "./destaque-title-walk.ts";
import { looksLikeTitleOption } from "../title-heuristic.ts";

export interface TitleClickbaitVulgarError {
  destaque: number;
  category: string;
  line: number;
  title: string;
  /** Padrão vulgar casado (label curta pra exibição). */
  matched: string;
}

export interface TitleClickbaitVulgarReport {
  ok: boolean;
  errors: TitleClickbaitVulgarError[];
}

// Frases proibidas, com/sem acento, case-insensitive.
const PHRASE_RES: Array<[RegExp, string]> = [
  [/\bvoc[êe]\s+n[aã]o\s+vai\s+acreditar\b/i, "você não vai acreditar"],
  [/\bn[aã]o\s+vai\s+acreditar\b/i, "não vai acreditar"],
  [/\bchocante\b/i, "chocante"],
  [/\bshocking\b/i, "shocking"],
  [/\bo\s+que\s+aconteceu\s+depois\b/i, "o que aconteceu depois"],
];

// Listicle vazio: número + substantivo genérico de lista.
const LISTICLE_RE =
  /\b\d+\s+(coisas|motivos|raz[õo]es|dicas|erros|li[çc][õo]es|segredos|truques)\b/i;

// CAPS LOCK: palavra ≥6 letras toda maiúscula. Allowlist curto de siglas
// legítimas que aparecem em títulos tech (case-sensitive match contra a
// palavra crua).
const CAPS_MIN_LEN = 6;
const CAPS_ACRONYM_ALLOWLIST = new Set([
  "OPENAI", "ANTHROPIC", "GOOGLE", "MICROSOFT", "AMAZON", "NVIDIA", "META",
  "APPLE", "TESLA", "SPACEX", "DEEPMIND", "FACEBOOK", "INSTAGRAM", "LINKEDIN",
  "CHATGPT", "CLAUDE", "GEMINI", "COPILOT", "MIDJOURNEY", "STARGATE",
]);

function findVulgarPattern(title: string): string | null {
  for (const [re, label] of PHRASE_RES) {
    if (re.test(title)) return label;
  }
  if (LISTICLE_RE.test(title)) return "listicle vazio (N coisas/motivos/…)";
  if (/[!！]/.test(title)) return "ponto de exclamação";
  if (/(\.{3,}|…)\s*$/.test(title.trim())) return "reticências de suspense no fim";
  for (const word of title.split(/[^A-Za-zÀ-ÿ]+/)) {
    if (
      word.length >= CAPS_MIN_LEN &&
      word === word.toUpperCase() &&
      /[A-ZÀ-Þ]/.test(word) &&
      !CAPS_ACRONYM_ALLOWLIST.has(word)
    ) {
      return `CAPS LOCK (${word})`;
    }
  }
  return null;
}

/**
 * Flagra títulos de DESTAQUE na faixa vulgar do clickbait.
 * WARN-ONLY (#6008) — `ok: false` nunca deve virar bloqueio de gate.
 */
export function checkTitleClickbaitVulgar(md: string): TitleClickbaitVulgarReport {
  // #5084: normaliza CRLF→LF antes do split (mesmo guard de ia-in-title.ts).
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const errors: TitleClickbaitVulgarError[] = [];

  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(HIGHLIGHT_HEADER_RE);
    if (!m) {
      i++;
      continue;
    }
    const destaqueNum = parseInt(m[1], 10);
    const category = m[2].trim();
    const { titles, nextIndex } = walkDestaqueTitles(
      lines,
      i + 1,
      category,
      looksLikeTitleOption,
    );
    for (const { title, line } of titles) {
      if (SECTION_HEADER_LINE_RE.test(title.trim())) continue;
      const matched = findVulgarPattern(title);
      if (matched) {
        errors.push({ destaque: destaqueNum, category, line, title, matched });
      }
    }
    i = nextIndex;
  }

  return { ok: errors.length === 0, errors };
}

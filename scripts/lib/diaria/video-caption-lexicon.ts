/**
 * video-caption-lexicon.ts (#12429) — grafia de nomes próprios na legenda do
 * horizontal feita só pela fala do export, sem `plan.json`.
 *
 * Com plano, o roteiro aprovado dá a grafia de cada palavra casada
 * (`alignPunctuationToScript`). Os horizontais anteriores à skill de montagem
 * (261021–261029) não têm roteiro gravado: a legenda sai do texto que o Whisper
 * ouviu, e o que corrige a grafia é (1) as regras do vocabulário do projeto
 * (`context/video-montagem/vocabulario.json`, a mesma lista do resto do
 * pipeline) e (2) este léxico, tirado do texto da própria edição
 * (`02-reviewed.md`): palavra ouvida igual a um nome próprio da edição, a menos
 * de maiúscula e acento ("openai", "gemini"), ganha a grafia da edição. Nunca
 * troca uma palavra por outra diferente ("Sepoia" ouvido não vira "Sepolia"):
 * isso fica para a conferência humana antes do envio, e as trocas feitas saem
 * listadas nas notas.
 *
 * Os aliases do vocabulário (forma ouvida → forma escrita, ex. "diária" →
 * "diar.ia.br") só valem, sem roteiro, quando a palavra ouvida vem com
 * maiúscula no meio da frase ("editor da Diária"): é o nome; "rotina diária"
 * fica como está.
 *
 * Tudo puro (sem I/O).
 */

import { normalizeToken, type VocabAlias, type Word } from "./video-montage.ts";

/**
 * Palavras comuns em português que também são nome próprio de empresa/produto:
 * o léxico nunca as aplica (a "meta" do ano não vira a "Meta").
 */
export const LEXICON_AMBIGUOUS = new Set(["meta", "sol", "claro", "vivo", "oi", "nu", "gol", "azul", "uber", "ia", "rio"]);

/** Conectivos que não quebram um nome de várias palavras ("Banco do Brasil"). */
const NAME_CONNECTORS = new Set(["de", "da", "do", "das", "dos", "e"]);

/** Token de texto: letras/números, com `.`/`-` internos ("GPT-5.6", "diar.ia.br"). */
const TOKEN_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}.\-]*[\p{L}\p{N}])?/gu;

/** Limpa o markdown da edição: links viram o rótulo, URLs, comentários HTML e marcação saem. */
function plainText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[*_`#>|]/g, " ");
}

/** Linha toda em maiúsculas (cabeçalho: "TÍTULO", "DESTAQUE 1 | SEGURANÇA"): fora do léxico. */
function isAllCapsLine(line: string): boolean {
  return /\p{L}/u.test(line) && line === line.toUpperCase();
}

function hasUpper(t: string): boolean {
  return /\p{Lu}/u.test(t);
}

/** Maiúscula além da 1ª letra ("OpenAI", "GPT", "IA"): é grafia, não início de frase. */
function hasInnerUpper(t: string): boolean {
  return /\p{Lu}/u.test(t.slice(1));
}

/**
 * Nomes próprios do texto da edição: chave normalizada (`normalizeToken`) →
 * grafia. Entra a palavra com maiúscula no meio da frase, ou com maiúscula
 * interna em qualquer posição. Fica fora: palavra que aparece também toda em
 * minúscula no texto ("Use" × "use"), palavra de 1 caractere, número puro,
 * linhas de cabeçalho em maiúsculas e as de `LEXICON_AMBIGUOUS` ("ia" é também
 * o verbo, "eu ia"). Palavra que só aparece dentro de um nome de várias
 * palavras ("Casa Branca", "Estados Unidos") também fica fora, salvo com
 * maiúscula interna: sozinha, ela é palavra comum ("em casa"). Mesma chave com
 * grafias diferentes: vence a mais frequente (empate: a primeira).
 */
export function properNounLexicon(markdown: string): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  const lowerSeen = new Set<string>();
  const standalone = new Set<string>();
  for (const rawLine of plainText(markdown).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || isAllCapsLine(line)) continue;
    const toks = [...line.matchAll(TOKEN_RE)];
    const atStart = toks.map((m) => {
      const before = line.slice(0, m.index).trimEnd();
      return before === "" || /[.!?:]["'”»)\]]*$/.test(before) || /^[-–—•\d.)\s]*$/.test(before);
    });
    // Vizinho com maiúscula fora do início de frase (pulando conectivos, sem atravessar pontuação) = nome de várias palavras.
    const capNeighbor = (i: number, step: 1 | -1): boolean => {
      for (let j = i + step; j >= 0 && j < toks.length; j += step) {
        const [a, b] = step === 1 ? [toks[i].index + toks[i][0].length, toks[j].index] : [toks[j].index + toks[j][0].length, toks[i].index];
        if (/[.!?:;,()]/.test(line.slice(a, b))) return false;
        const t = toks[j][0];
        if (NAME_CONNECTORS.has(t)) continue;
        return /^\p{Lu}/u.test(t) && !atStart[j];
      }
      return false;
    };
    toks.forEach((m, i) => {
      const tok = m[0];
      const key = normalizeToken(tok);
      if (key.length < 2 || !/\p{L}/u.test(tok)) return;
      if (!hasUpper(tok)) {
        lowerSeen.add(key);
        return;
      }
      if (atStart[i] && !hasInnerUpper(tok)) return;
      if (!capNeighbor(i, -1) && !capNeighbor(i, 1)) standalone.add(key);
      const spellings = counts.get(key) ?? new Map<string, number>();
      spellings.set(tok, (spellings.get(tok) ?? 0) + 1);
      counts.set(key, spellings);
    });
  }
  const lex = new Map<string, string>();
  for (const [key, spellings] of counts) {
    if (LEXICON_AMBIGUOUS.has(key)) continue;
    const best = [...spellings].sort((a, b) => b[1] - a[1])[0][0];
    // Palavra que o texto também escreve em minúscula é comum ("Use melhor" × "use"),
    // salvo grafia com maiúscula interna ("IA" × "ia" num link), que é sigla.
    if (lowerSeen.has(key) && !hasInnerUpper(best)) continue;
    if (!standalone.has(key) && !hasInnerUpper(best)) continue;
    lex.set(key, best);
  }
  return lex;
}

/** Uma troca feita pelo léxico ou por um alias, para as notas. */
export interface LexiconChange {
  heard: string;
  written: string;
  start: number;
  via: "lexicon" | "alias";
}

/** Separa a pontuação colada ("Gemini," → ["", "Gemini", ","]). */
function splitCore(text: string): [string, string, string] {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(text);
  return m ? [m[1], m[2], m[3]] : ["", text, ""];
}

/**
 * Aplica o léxico e os aliases às palavras ouvidas (#12429). Só troca a
 * grafia de uma palavra cuja chave normalizada é a de um nome do léxico (a
 * pontuação ouvida fica); o alias troca a palavra ouvida com maiúscula fora do
 * início de frase. Tempos intactos. Puro.
 */
export function applyProperNounLexicon(
  words: Word[],
  lexicon: Map<string, string>,
  aliases: VocabAlias[] = [],
): { words: Word[]; changes: LexiconChange[] } {
  const aliasByKey = new Map(aliases.map((a) => [normalizeToken(a.heard), a.written] as const));
  const changes: LexiconChange[] = [];
  const out = words.map((w, i) => {
    const [pre, core, post] = splitCore(w.text.trim());
    const key = normalizeToken(core);
    if (!key) return { ...w, text: w.text.trim() };
    const prev = i > 0 ? words[i - 1].text.trim() : "";
    const sentenceStart = i === 0 || /[.!?]["'”»)]*$/.test(prev);
    const alias = aliasByKey.get(key);
    if (alias !== undefined && hasUpper(core.charAt(0)) && !sentenceStart && core !== alias) {
      changes.push({ heard: core, written: alias, start: w.start, via: "alias" });
      return { ...w, text: pre + alias + post };
    }
    const spelled = lexicon.get(key);
    if (spelled !== undefined && spelled !== core) {
      changes.push({ heard: core, written: spelled, start: w.start, via: "lexicon" });
      return { ...w, text: pre + spelled + post };
    }
    return { ...w, text: w.text.trim() };
  });
  return { words: out, changes };
}

/** Resumo das trocas para as notas: uma linha por par ouvido → escrito, com a contagem. */
export function summarizeLexiconChanges(changes: LexiconChange[]): string[] {
  const byPair = new Map<string, { c: LexiconChange; n: number }>();
  for (const c of changes) {
    const k = `${c.via}\u0000${c.heard}\u0000${c.written}`;
    const cur = byPair.get(k);
    if (cur) cur.n++;
    else byPair.set(k, { c, n: 1 });
  }
  return [...byPair.values()].map(({ c, n }) => `"${c.heard}" → "${c.written}" (${c.via === "alias" ? "alias do vocabulário" : "grafia da edição"}${n > 1 ? `, ${n}x` : ""})`);
}

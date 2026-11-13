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
 * (`02-reviewed.md`, sem os blocos de template: É IA?, erro intencional, que
 * traz nomes errados de propósito, sorteio, rodapé e boxes de CTA): palavra
 * ouvida igual a um nome próprio da edição, a menos de maiúscula e de acento que
 * o falante não disse ("openai", "gemini"), ganha a grafia da edição. Nunca
 * troca uma palavra por outra diferente ("Sepoia" ouvido não vira "Sepolia"),
 * nunca muda a pontuação interna ("GPT-55" não vira "GPT-5.5") e nunca tira um
 * acento ouvido ("aí" não vira "AI"): isso fica para a conferência humana antes
 * do envio, e as trocas feitas saem listadas nas notas.
 *
 * Os aliases do vocabulário (forma ouvida → forma escrita, ex. "diária" →
 * "diar.ia.br") só valem, sem roteiro, quando a palavra ouvida vem com
 * maiúscula no meio da frase ("editor da Diária"): é o nome; "rotina diária"
 * fica como está.
 *
 * Tudo puro (sem I/O).
 */

import { PIPELINE_OWNED_SECTIONS, sectionHeaderName } from "../manual-edit-diff.ts";
import { normalizeToken, type VocabAlias, type Word } from "./video-montage.ts";

/**
 * #12955: pronomes e palavras comuns curtas que nunca são nome próprio na fala.
 * O texto da edição pode trazê-las com maiúscula (início de citação depois de
 * dois-pontos, nome de programa com sigla dentro, "Negócio em dIA"), e uma
 * entrada dessas no léxico reescreve a palavra comum em todo o vídeo.
 */
const COMMON_WORDS_12955 = [
  "eu", "tu", "ele", "ela", "eles", "elas", "nos", "voce", "voces", "gente",
  "dia", "dias", "via", "vias", "media", "midia", "mes", "ano", "anos", "hoje", "agora",
  "aqui", "isso", "isto", "esse", "essa", "este", "esta", "mas", "mais", "sim", "nao",
] as const;

/**
 * Palavras comuns em português que também são nome próprio de empresa, produto,
 * veículo ou instituição: o léxico nunca as aplica (a "meta" do ano não vira a
 * "Meta", "eu ia" não vira "IA", "aí" não vira "AI", o "pro" de "vai pro
 * trabalho" não vira o plano "Pro"). Chave já normalizada (`normalizeToken`).
 */
export const LEXICON_AMBIGUOUS: ReadonlySet<string> = new Set([
  "meta", "sol", "claro", "vivo", "oi", "nu", "gol", "azul", "uber", "ia", "ai", "rio",
  "pro", "geral", "ajustes", "vale", "caixa", "folha", "estado", "uniao", "camara", "globo",
  "senado", "governo", "congresso", "mercado",
  // #12955: palavra comum que a edição escreveu com maiúscula num nome ("Negócio em dIA") ou
  // numa citação ("disse: \"Eu quero…\""): "notícia do dia" virava "notícia do dIA" e
  // "nesse canal eu comento", "nesse canal Eu comento".
  ...COMMON_WORDS_12955,
]);

/**
 * Siglas de 4+ letras que a edição escreve em caixa-alta: as únicas palavras
 * todas em maiúsculas com 4+ letras que entram no léxico (as demais são
 * cabeçalho de seção citado no meio da linha, "na seção RADAR"). Chave
 * normalizada.
 */
const KNOWN_LONG_ACRONYMS: ReadonlySet<string> = new Set([
  "cade", "anpd", "nasa", "ibge", "anatel", "anvisa", "unesco", "otan", "nato", "fapesp", "unicamp", "embrapa", "serpro", "dataprev",
]);

/**
 * Conectivos que não quebram um nome de várias palavras ("Banco do Brasil").
 * Sem o "e": "Google e Microsoft" são dois nomes, não um.
 */
const NAME_CONNECTORS: ReadonlySet<string> = new Set(["de", "da", "do", "das", "dos"]);

/** Token de texto: letras/números, com `.`/`-` internos ("GPT-5.6", "diar.ia.br"). */
const TOKEN_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}.\-]*[\p{L}\p{N}])?/gu;

/**
 * O texto editorial da edição, sem os blocos de template (#12429): as seções
 * da pipeline (É IA?, ERRO INTENCIONAL, que traz nomes propositalmente
 * errados, SORTEIO e PARA ENCERRAR, com o rodapé "Nesta edição da diar.ia.br…"
 * e os links de curadoria), até o `---` seguinte, e os boxes de CTA (parágrafo
 * todo em negrito que não é título de link, "**A diar.ia.br mantém…**").
 */
export function editorialText(md: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of md.split(/\r?\n/)) {
    const t = line.trim();
    if (skipping) {
      if (t === "---") skipping = false;
      continue;
    }
    const header = sectionHeaderName(t);
    if (header && (PIPELINE_OWNED_SECTIONS as readonly string[]).includes(header)) {
      skipping = true;
      continue;
    }
    if (!header && /^\*\*(?!\[).+\*\*$/.test(t)) continue;
    out.push(line);
  }
  return out.join("\n");
}

/** Limpa o markdown da edição: links viram o rótulo, URLs, comentários HTML e marcação saem. */
function plainText(md: string): string {
  return editorialText(md)
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

/** Palavra toda em maiúsculas com 4+ letras ("MELHOR", "RADAR", "CADE"). */
function isLongAllCaps(t: string): boolean {
  const letters = t.match(/\p{L}/gu) ?? [];
  return letters.length >= 4 && t === t.toUpperCase();
}

/**
 * Nomes próprios do texto da edição: chave normalizada (`normalizeToken`) →
 * grafia, sobre o `editorialText` (sem os blocos de template). Entra a palavra
 * com maiúscula no meio da frase, ou com maiúscula interna em qualquer
 * posição. Fica fora: palavra que aparece também toda em minúscula no texto
 * ("Use" × "use"; vale também para sigla, "IA" × "ia"), palavra de 1
 * caractere, número puro, linhas de cabeçalho em maiúsculas, palavra toda em
 * maiúsculas com 4+ letras no meio da linha (o cabeçalho citado, "na seção
 * RADAR"), salvo sigla conhecida (`KNOWN_LONG_ACRONYMS`), e as de
 * `LEXICON_AMBIGUOUS` ("ia" é também o verbo, "eu ia"). Palavra que só aparece dentro de um nome de várias
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
      // #12955: a abertura de citação também é início de frase (`disse: "Eu quero`, `"Eu sou`).
      return before === "" || /[.!?:]["'”»)\]]*\s*["'“«(\[]*$/.test(before) || /^[-–—•\d.)\s"'“«(\[]*$/.test(before);
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
      if (isLongAllCaps(tok) && !KNOWN_LONG_ACRONYMS.has(key)) return;
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
    // inclusive a sigla ("IA" × "ia"): nenhuma grafia passa por cima do uso minúsculo.
    if (lowerSeen.has(key)) continue;
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
  /** `pronoun` (#12955): "Eu" ouvido no meio da frase volta a "eu". */
  via: "lexicon" | "alias" | "pronoun";
}

/** Sem acento e em minúscula, com a pontuação interna mantida ("GPT-5.5" → "gpt-5.5"). */
function foldCaseAccent(t: string): string {
  return t.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/** A palavra ouvida tem acento ("aí", "Câmara")? */
function hasAccent(t: string): boolean {
  return /\p{M}/u.test(t.normalize("NFD"));
}

/**
 * A grafia da edição só pode mudar a maiúscula da palavra ouvida, ou pôr o
 * acento que o Whisper não escreveu ("opus" → "Opus", "sao" → "São"): a mesma
 * sequência de letras, números e pontuação interna ("GPT-55" não vira
 * "GPT-5.5"), e acento ouvido nunca sai ("aí" não vira "AI").
 */
function isCaseOrAccentOnly(heard: string, spelled: string): boolean {
  if (foldCaseAccent(heard) !== foldCaseAccent(spelled)) return false;
  return !hasAccent(heard) || heard.normalize("NFC").toLowerCase() === spelled.normalize("NFC").toLowerCase();
}

/** Separa a pontuação colada ("Gemini," → ["", "Gemini", ","]). */
function splitCore(text: string): [string, string, string] {
  const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(text);
  return m ? [m[1], m[2], m[3]] : ["", text, ""];
}

/**
 * Aplica o léxico e os aliases às palavras ouvidas (#12429). Só troca a
 * grafia de uma palavra cuja chave normalizada é a de um nome do léxico e que
 * difere dele só na maiúscula ou num acento que o falante não disse
 * (`isCaseOrAccentOnly`; a pontuação colada ouvida fica); o alias troca a
 * palavra ouvida com maiúscula fora do início de frase. Tempos intactos. Puro.
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
    // #12955: "eu" só começa com maiúscula no início de frase (o Whisper às vezes a põe no meio);
    // depois de dois-pontos ou com aspas abrindo é citação, e fica.
    if (key === "eu" && core === "Eu" && !sentenceStart && !/:["'”»)]*$/.test(prev) && !/["'“«]/.test(pre)) {
      changes.push({ heard: core, written: "eu", start: w.start, via: "pronoun" });
      return { ...w, text: pre + "eu" + post };
    }
    const spelled = lexicon.get(key);
    if (spelled !== undefined && spelled !== core && isCaseOrAccentOnly(core, spelled)) {
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
  return [...byPair.values()].map(({ c, n }) => `"${c.heard}" → "${c.written}" (${c.via === "alias" ? "alias do vocabulário" : c.via === "pronoun" ? "pronome no meio da frase" : "grafia da edição"}${n > 1 ? `, ${n}x` : ""})`);
}

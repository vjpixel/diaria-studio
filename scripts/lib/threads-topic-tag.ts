/**
 * threads-topic-tag.ts (#11664)
 *
 * O Threads trata a PRIMEIRA hashtag do texto como o "topic tag" do post
 * (doc da Meta, https://developers.facebook.com/documentation/threads/posts/):
 * ela aparece SEM `#` no corpo e vira o link do cabeçalho (`diar.ia.br > X`).
 * Só uma por post. Exemplo que abriu a issue: `... Genie4 #DeepMind`.
 *
 * Decisão do editor (briefing overnight 261101b, opção B): a 1ª posição é
 * ocupada por uma hashtag ESCOLHIDA de propósito, nunca por tag sacrificial.
 * Premissa registrada: a escolhida é a que lê natural como palavra solta no
 * texto, ou seja, o nome do produto/tema do destaque.
 *
 * O `social-curto` já recebe essa instrução no prompt, e este módulo é o
 * guard determinístico do publicador: reordena só o bloco de hashtags do FIM
 * do texto do Threads, pondo na frente a tag de melhor nível (estável: empate
 * mantém a ordem que o agente escreveu). Não acrescenta nem remove tags.
 *
 * Níveis (menor = melhor):
 *   0. a tag aparece como PALAVRA no corpo (`#ChatGPT` e "o ChatGPT montou").
 *      É o sujeito do post e já lê natural sem `#`.
 *   1. palavra simples, sem junção de palavras (`#Google`, `#Golpe`): lê
 *      natural mesmo sem estar no corpo.
 *   2. composto que é o sujeito do corpo só com os espaços tirados
 *      (`#Genie4` e "Genie 4"; `#GeminiNotebook` e "Gemini Notebook"): é o
 *      tema, mas colado ("Genie4") lê pior que uma palavra simples.
 *   3. resto (`#ViésAlgorítmico`, composto fora do corpo).
 *   4. tag com caractere fora de letra/dígito/`_` (`#multi-agent`): o Threads
 *      pode cortar ou recusar como topic tag; nunca escolhida se houver outra.
 *
 * Hashtag no MEIO do corpo vira o topic tag antes de qualquer tag do bloco
 * final; aí reordenar o bloco não muda nada e o resultado diz isso
 * (`inlineHashtag`) para o publicador avisar.
 */

/** Linha feita só de hashtags (aceita hífen, como os outros parsers do repo). */
const HASHTAG_LINE_RE = /^\s*#[\p{L}\p{N}_-]+(?:\s+#[\p{L}\p{N}_-]+)*\s*$/u;
/** Hashtag no corpo: `#` no início ou depois de espaço/pontuação de abertura. */
const INLINE_HASHTAG_RE = /(?:^|[\s(\[“"'])#[\p{L}\p{N}_]/u;

export type ThreadsTopicTagResult = {
  text: string;
  /** Tag (sem `#`) que fica na 1ª posição do bloco final; null sem bloco. */
  topicTag: string | null;
  /** O texto mudou (a tag escolhida não era a 1ª). */
  reordered: boolean;
  /** Há hashtag no corpo antes do bloco final: ela será o topic tag. */
  inlineHashtag: boolean;
};

/** Minúsculas, sem acento: comparação de tag com o corpo. */
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Corpo sem URLs, para `claude.ai`/slugs não contarem como menção. */
function bodyWords(body: string): string[] {
  const noUrls = body.replace(/\bhttps?:\/\/\S+/gi, " ");
  return fold(noUrls).split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/**
 * Pure: nível da tag (ver docstring do módulo). `words` = palavras do corpo
 * já normalizadas por `bodyWords`.
 */
export function topicTagRank(tag: string, words: string[]): number {
  if (/[^\p{L}\p{N}_]/u.test(tag)) return 4;
  const t = fold(tag);
  if (words.includes(t)) return 0;
  // Junção de palavras: minúscula seguida de maiúscula, ou letra colada a dígito.
  const compound = /\p{Ll}\p{Lu}|\p{L}\p{N}|\p{N}\p{L}/u.test(tag);
  if (!compound) return 1;
  // Composto que é a sequência de 2-4 palavras consecutivas do corpo, coladas.
  for (let i = 0; i < words.length; i++) {
    let joined = words[i];
    for (let n = 2; n <= 4 && i + n - 1 < words.length; n++) {
      joined += words[i + n - 1];
      if (joined === t) return 2;
      if (joined.length >= t.length) break;
    }
  }
  return 3;
}

/**
 * Pure: reordena o bloco de hashtags do fim de `text` para que a tag escolhida
 * (ver níveis) fique em 1º. A tag escolhida vai para o início da 1ª linha de
 * hashtags e sai de onde estava; o resto fica na ordem original. Idempotente.
 */
export function chooseThreadsTopicTag(text: string): ThreadsTopicTagResult {
  const trimmed = text.replace(/\s+$/, "");
  const lines = trimmed.split("\n");
  let start = lines.length;
  while (start > 0 && (HASHTAG_LINE_RE.test(lines[start - 1]) || lines[start - 1].trim() === "")) start--;
  // Linhas em branco logo antes do bloco são separador, não parte dele.
  while (start < lines.length && lines[start].trim() === "") start++;
  const body = lines.slice(0, start).join("\n");
  const inlineHashtag = INLINE_HASHTAG_RE.test(body.replace(/\bhttps?:\/\/\S+/gi, " "));
  if (start === lines.length) {
    return { text, topicTag: null, reordered: false, inlineHashtag };
  }

  const blockLines = lines.slice(start);
  const tags: { tag: string; line: number }[] = [];
  blockLines.forEach((l, idx) => {
    for (const m of l.matchAll(/#([\p{L}\p{N}_-]+)/gu)) tags.push({ tag: m[1], line: idx });
  });
  const words = bodyWords(body);
  let best = 0;
  let bestRank = topicTagRank(tags[0].tag, words);
  for (let i = 1; i < tags.length; i++) {
    const r = topicTagRank(tags[i].tag, words);
    if (r < bestRank) {
      best = i;
      bestRank = r;
    }
  }
  const chosen = tags[best].tag;
  if (best === 0) return { text, topicTag: chosen, reordered: false, inlineHashtag };

  // Monta as linhas de novo: a escolhida abre a 1ª linha não vazia do bloco.
  const byLine = blockLines.map((_, idx) => tags.filter((t, i) => t.line === idx && i !== best).map((t) => `#${t.tag}`));
  const firstTagLine = blockLines.findIndex((l) => l.trim() !== "");
  byLine[firstTagLine].unshift(`#${chosen}`);
  const rebuilt: string[] = [];
  blockLines.forEach((l, idx) => {
    if (l.trim() === "") rebuilt.push(l);
    else if (byLine[idx].length > 0) rebuilt.push(byLine[idx].join(" "));
  });
  const trailingWs = text.slice(trimmed.length);
  const out = [...lines.slice(0, start), ...rebuilt].join("\n") + trailingWs;
  return { text: out, topicTag: chosen, reordered: true, inlineHashtag };
}

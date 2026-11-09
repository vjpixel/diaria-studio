/**
 * lint-checks/title-shorts-front-load.ts (#12464, item 1 da #12462)
 *
 * O título do D1 é o título do Short do YouTube (`buildYouTubeShortTitle`,
 * sem `#Shorts` desde #12463), e o feed de Shorts no celular mostra só os
 * primeiros ~40 caracteres. Decisão do editor (08/11/2026): a regra é
 * FRONT-LOAD, não teto — os primeiros ~40 caracteres do D1 trazem o assunto e
 * o gancho e se leem sozinhos; o teto de 70 do assunto do e-mail
 * (`MAX_SUBJECT_LENGTH`, `title-limits.ts`) continua valendo. O corte de
 * celular da caixa de entrada (~35-45) se beneficia da mesma regra.
 *
 * "Faz sentido sozinho" não é mensurável por regex. O que este check mede é
 * a fatia visível (os primeiros `SHORTS_FEED_VISIBLE_TITLE_CHARS` grafemas,
 * cortados em fronteira de palavra) e acusa o sinal mecânico de fatia que
 * NÃO se lê sozinha: ela termina numa palavra de ligação (artigo,
 * preposição, conjunção — "Google lança modelo que") ou fica com menos de 2
 * palavras. O resto do julgamento fica no prompt do `writer-destaque`/
 * `title-picker` e no gate 4, onde a fatia aparece no aviso.
 *
 * WARN-ONLY (invariante do Stage 4 e painel do Studio, nunca bloqueia).
 *
 * O número 40 é o ponto de corte que o editor confirmou na #12464 (as fontes
 * de mercado ficam entre 40 e 60); se a medição no feed real do canal der
 * outro valor, trocar só esta constante.
 */

import { collectDestaqueTitleCandidates, graphemeLength } from "./title-length.ts";

/** Caracteres do título que o feed de Shorts mostra no celular (#12464). Constante única: D1 e Short. */
export const SHORTS_FEED_VISIBLE_TITLE_CHARS = 40;

/**
 * Palavras que não fecham uma fatia legível: a fatia que termina numa delas
 * deixa o leitor no meio da frase.
 */
export const DANGLING_TAIL_WORDS: ReadonlySet<string> = new Set([
  "a", "o", "as", "os", "um", "uma", "uns", "umas",
  "de", "da", "do", "das", "dos", "em", "na", "no", "nas", "nos",
  "ao", "aos", "à", "às", "para", "pra", "por", "pela", "pelo", "pelas", "pelos",
  "com", "sem", "sobre", "entre", "até", "contra", "após", "desde",
  "e", "ou", "mas", "nem", "que", "se", "como", "quando", "onde", "porque",
  "seu", "sua", "seus", "suas", "meu", "minha", "teu", "tua",
]);

const TRAILING_JOINERS_RE = /[\s,;—–-]+$/u;
const WORD_EDGE_PUNCT_RE = /^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu;

/**
 * Fatia visível do título no feed de Shorts: os primeiros `max` grafemas,
 * recuando até o último espaço quando o corte cai no meio de uma palavra.
 * Título que cabe volta inteiro.
 */
export function shortsFeedVisibleSlice(title: string, max = SHORTS_FEED_VISIBLE_TITLE_CHARS): string {
  const clean = title.replace(/\s+/g, " ").trim();
  const graphemes = [...new Intl.Segmenter().segment(clean)].map((s) => s.segment);
  if (graphemes.length <= max) return clean;
  const head = graphemes.slice(0, max).join("");
  const cutsAtBoundary = graphemes[max] === " ";
  const lastSpace = head.lastIndexOf(" ");
  const slice = cutsAtBoundary || lastSpace <= 0 ? head : head.slice(0, lastSpace);
  return slice.replace(TRAILING_JOINERS_RE, "");
}

export interface ShortsFrontLoadWarning {
  destaque: number;
  category: string;
  title: string;
  length: number;
  /** O que o feed mostra (cortado em fronteira de palavra). */
  visible: string;
  reason: "dangling-word" | "too-few-words";
  /** Palavra de ligação em que a fatia termina (só em `dangling-word`). */
  tail?: string;
}

export interface ShortsFrontLoadReport {
  ok: boolean;
  /** Mesmo nome dos outros checks de título (o painel e os CLIs leem `errors`). */
  errors: ShortsFrontLoadWarning[];
}

/** Só o título do D1 (o que vira o Short); D2/D3 não contam. */
export function checkD1ShortsFrontLoad(md: string, max = SHORTS_FEED_VISIBLE_TITLE_CHARS): ShortsFrontLoadReport {
  const errors: ShortsFrontLoadWarning[] = [];
  for (const c of collectDestaqueTitleCandidates(md)) {
    if (c.destaque !== 1) continue;
    const length = graphemeLength(c.title);
    if (length <= max) continue;
    const visible = shortsFeedVisibleSlice(c.title, max);
    const words = visible.split(" ").filter(Boolean);
    const tail = (words[words.length - 1] ?? "").replace(WORD_EDGE_PUNCT_RE, "").toLowerCase();
    if (words.length < 2) {
      errors.push({ ...c, length, visible, reason: "too-few-words" });
    } else if (DANGLING_TAIL_WORDS.has(tail)) {
      errors.push({ ...c, length, visible, reason: "dangling-word", tail });
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Linha legível de um aviso, para o CLI e a invariante. */
export function formatShortsFrontLoadWarning(w: ShortsFrontLoadWarning): string {
  const why = w.reason === "dangling-word"
    ? `a fatia visível termina em "${w.tail}"`
    : "a fatia visível tem menos de 2 palavras";
  return (
    `DESTAQUE ${w.destaque} (${w.category}): no feed de Shorts o título aparece como "${w.visible}…" ` +
    `(${SHORTS_FEED_VISIBLE_TITLE_CHARS} de ${w.length} caracteres) e ${why} — ` +
    `traga assunto e gancho para os primeiros ~${SHORTS_FEED_VISIBLE_TITLE_CHARS} caracteres: "${w.title}"`
  );
}

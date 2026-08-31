/**
 * strip-markdown-emphasis.ts (#6862)
 *
 * Remove marcação de ênfase markdown (`**bold**`, `__bold__`, `*italic*`,
 * `_italic_`) de um texto, preservando o conteúdo — usado no ponto de
 * PUBLICAÇÃO de cada canal social (Facebook, Instagram, Threads/Curto,
 * LinkedIn), nunca na fonte (`03-social.md`).
 *
 * ## Por que não pode ser na fonte (#6862)
 *
 * `03-social.md` alimenta DOIS destinos com requisitos opostos (#6005 Parte B):
 *
 *   03-social.md ──┬──▶ legenda publicada (LI/FB/IG/Threads) → SEM markdown
 *                  └──▶ cards do carrossel (gen-carousel-cards.ts)  → COM negrito
 *
 * Decisão do editor (31/08/2026): as imagens do carrossel MANTÊM o negrito —
 * o renderizador consome a marcação de verdade (a #6751 tratou de pontuação
 * órfã quando `**bold**` encosta em pontuação nesses cards, prova de que o
 * negrito é consumido, não decorativo). `gen-carousel-cards.ts` lê o mesmo
 * `extractDestaqueBlock` que os publishers usam — remover `**` na fonte, ou
 * fazer o `social-writer` parar de emitir, quebraria o carrossel. Por isso a
 * sanitização vive aqui (chamada explícita no ponto de publicação de cada
 * canal), nunca em `extractDestaqueBlock`/`extract-section.ts` nem no agent.
 *
 * ## Por que não existe um lint bloqueando `**` em 03-social.md (achado do
 * review da PR #6866)
 *
 * Uma versão anterior desta PR tentou adicionar uma regra `no_markdown_
 * emphasis` GATE-BLOCKING no Stage 4 flagando qualquer `**` em
 * `03-social.md`. Errado: `.claude/agents/social-writer.md` (decisão #6086
 * item c) exige EXATAMENTE UM trecho em `**...**` por parágrafo de `## d{N}`
 * — é assim que o carrossel sabe qual frase é o resumo do slide. Um lint que
 * flagasse `**` no arquivo-fonte reprovaria toda edição real, sempre — o
 * negrito no arquivo-fonte não é o bug, é o contrato. O bug era só os
 * publishers não removerem essa marcação antes de publicar como texto puro.
 * A correção certa (esta) fica inteiramente no lado do PUBLISH — nenhuma
 * verificação estática do `03-social.md` consegue distinguir "negrito
 * esperado pelo contrato do carrossel" de "markdown vazando", porque os dois
 * são literalmente o mesmo byte no mesmo arquivo.
 *
 * ## Por que não é um replace ingênuo de todo asterisco/underscore
 *
 * Precisa preservar asterisco/underscore LEGÍTIMO no meio de palavra (ex:
 * "3*4", "user_name", "C**" — nenhum desses é ênfase markdown). A regra:
 * ênfase markdown nunca tem caractere alfanumérico colado no delimitador
 * pelo lado de FORA do par, e o conteúdo interno não começa/termina com
 * espaço (convenção CommonMark simplificada — não é um parser CommonMark
 * completo, cobre o padrão real de escrita do social-writer).
 */

/** Bold: `**texto**` ou `__texto__`. Roda ANTES do italic — sem isso,
 *  `**bold**` casaria como `*` + `*bold*` + `*` no passo de italic e
 *  sobraria 1 asterisco de cada lado. */
function stripBold(text: string): string {
  return text.replace(/\*\*(\S(?:[\s\S]*?\S)?)\*\*/g, "$1").replace(/__(\S(?:[\s\S]*?\S)?)__/g, "$1");
}

/** Italic: `*texto*` ou `_texto_` — só quando FLANQUEADO (delimitador não
 *  colado a caractere alfanumérico do lado de fora, nem a espaço do lado
 *  de dentro). Preserva "3*4", "user_name", "algo_importante_aqui" (sem
 *  espaço fechando o par — não é ênfase, é nome com underscore).
 *
 *  Achado do review da PR #6866: `\w` do JS é ASCII-only — "café*importante*"
 *  stripava errado (o "é" colado no delimitador não bloqueava o lookaround,
 *  já que "é" não é `\w`). Usa `\p{L}`/`\p{N}` (propriedade Unicode, flag
 *  `u`) em vez de `\w` — cobre acentuação do português sem essa lacuna. */
function stripItalic(text: string): string {
  return text
    .replace(/(?<![\p{L}\p{N}_*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\p{L}\p{N}_*])/gu, "$1")
    .replace(/(?<![\p{L}\p{N}_])_(?!\s)([^_\n]+?)(?<!\s)_(?![\p{L}\p{N}_])/gu, "$1");
}

/** Pura — remove `**`/`__`/`*`/`_` de ênfase, preserva o texto e qualquer
 *  asterisco/underscore legítimo no meio de palavra. Idempotente (rodar 2x
 *  no mesmo texto produz o mesmo resultado da 1ª vez). */
export function stripMarkdownEmphasis(text: string): string {
  return stripItalic(stripBold(text));
}


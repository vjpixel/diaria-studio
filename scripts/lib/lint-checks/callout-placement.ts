/**
 * lint-checks/callout-placement.ts (#1972 — Opção B, defesa; marcador-
 * agnóstico desde #3204)
 *
 * Detecta um callout (bold-line `**...**` OU parágrafo emoji-led) colado
 * DENTRO de uma seção de DESTAQUE, em vez de isolado entre dois `---`.
 *
 * Por que importa: `parseDestaques` fatia o reviewed.md em `^---$`. Um callout
 * colado antes do `---` de fechamento do D1 cai na seção do D1 e é absorvido
 * pelo corpo/why do destaque (render quebrado + duplicado — visto na 260609).
 * Marcador-agnóstico desde #3204: `newsletter-parse.ts`'s `locateBoxInGap`
 * extrai o box por POSIÇÃO (bloco `---`-isolado), não por marcador — mas essa
 * extração só funciona quando o box É seu próprio bloco. Um box "colado" (sem
 * `---` isolando) não tem sinal estrutural de posição pro parser pegar; este
 * lint é o backstop que ainda reconhece a FORMA do bloco (bold-line inteiro
 * OU emoji-led) pra flagrar antes que ele seja silenciosamente absorvido.
 *
 * O render já é robusto a isso quando o box ESTÁ isolado (de-dup determinístico
 * em `stripBoxDivulgacao1`/`stripBoxDivulgacao2`, Opção A), mas este lint
 * sinaliza a fonte do problema pro editor reposicionar o bloco — o callout deve
 * ser sua PRÓPRIA seção, isolada entre o `---` que fecha o D1 e o `---` que
 * abre o D2:
 *
 *   ...corpo do D1...
 *
 *   ---
 *
 *   **Callout...**
 *
 *   ---
 *
 *   **DESTAQUE 2 | ...**
 *
 * O introCallout (🎉/📣 ANTES do 1º DESTAQUE, na região de intro) é legítimo e
 * NÃO é sinalizado — só callouts dentro de uma seção que já contém um header
 * `DESTAQUE N | ...`. O TÍTULO do destaque (1ª linha de conteúdo após o
 * header — tipicamente `**[Título](url)**`, também bold-wrapped) também NÃO é
 * sinalizado — é reconhecido por POSIÇÃO (1º parágrafo da seção), não por forma.
 *
 * #3282: multi-linha-aware, igual à função irmã `lintStackedIntroCallouts`
 * abaixo. Antes, só a linha ONDE o parágrafo começava era testada contra
 * `FULL_BOLD_LINE_RE` (exige o `**` de fechamento na MESMA linha) — um
 * callout bold hard-wrapped em várias linhas (sem blank line entre elas)
 * nunca fechava `**` na 1ª linha e passava despercebido, exatamente o tipo de
 * caso que o incidente 260609 motivou este lint a pegar. Agora o parágrafo
 * inteiro é acumulado (`paraLines`/`flushParagraph`) e testado como bloco
 * único antes de decidir se é o título (posição) ou um callout colado (forma).
 *
 * #3315: `FULL_BOLD_LINE_RE` sozinho só confere que os 2 primeiros e os 2
 * últimos caracteres do blob são `**` — não que o trecho entre eles é um
 * único bold-wrap balanceado. Um parágrafo body normal, hard-wrapped (colado
 * do Google Docs — o mesmo cenário que o #3282 mira), com 2 spans bold
 * INDEPENDENTES (um logo no início, outro no fim, texto plano no meio) bate
 * nesse regex depois do join e virava falso-positivo (`ok:false` num
 * parágrafo sem problema real, travando o gate GATE-BLOCKING do Stage 4).
 * `isSingleBoldWrap` (abaixo) fecha esse gap: além do regex, exige EXATAMENTE
 * 2 ocorrências de `**` no parágrafo inteiro. A convenção de pareamento do
 * renderer (`tokenizeInline`/`isUnpairedBoldMarker` em
 * `newsletter-render-html.ts`) é alternada, não aninhada — todo par adicional
 * de `**` no meio necessariamente fecha o span aberto pelo primeiro `**` e
 * reabre outro depois, criando um gap de texto plano. Logo só existe UMA
 * forma de o parágrafo inteiro renderizar como um único span bold contínuo,
 * do 1º ao último caractere: exatamente 2 ocorrências (abertura + fechamento,
 * nada mais). Isso preserva a detecção do #3282 (o callout multi-linha real
 * daquele fix tem exatamente 2 ocorrências — abre na 1ª linha, fecha na
 * última) sem reintroduzir o falso-negativo original.
 */

export interface CalloutPlacementMatch {
  line: number;
  context: string;
}

export interface CalloutPlacementResult {
  ok: boolean;
  matches: CalloutPlacementMatch[];
}

// Separador casado na linha BRUTA (sem trim), espelhando `parseDestaques`
// (`raw.split(/^---$/m)`) e `parseSections` no render. Estrito de propósito: um
// `--- ` (espaço final) ou ` ---` (indentado) NÃO splita pra aqueles parsers, então
// o callout seguinte É absorvido no D1 — o lint precisa ser tão estrito quanto o
// splitter que protege, senão vira falso-negativo (passa, mas o render quebra).
const SEPARATOR_RE = /^---$/;
const DESTAQUE_HEADER_RE = /^(?:\*\*)?DESTAQUE\s+[123]\s*\|/;
// #3204: marcador-agnóstico — QUALQUER parágrafo INTEIRAMENTE embrulhado em
// `**...**` (mesma forma que `formatBoxInner` em newsletter-parse.ts detecta
// como box bold-line) OU iniciado por um emoji + espaço (range Unicode
// genérico — não um allowlist de 3 emojis) é candidato a box colado.
const FULL_BOLD_LINE_RE = /^\*\*[\s\S]+\*\*$/;
const EMOJI_LEAD_RE =
  /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]*\s+/u;

/**
 * #3315: conta ocorrências NÃO sobrepostas de `**` numa string (avança 2
 * posições a cada match — "****" conta como 2, não 3). Mesma convenção de
 * `countDoubleAsterisk` em `newsletter-render-html.ts` (não exportada de lá —
 * duplicada aqui, escopo pequeno o bastante pra não justificar mover pra
 * shared/).
 */
function countDoubleAsterisk(str: string): number {
  let count = 0;
  let idx = str.indexOf("**");
  while (idx !== -1) {
    count++;
    idx = str.indexOf("**", idx + 2);
  }
  return count;
}

/**
 * #3315: o parágrafo inteiro (já joined multi-linha) é um único bold-wrap —
 * abre com `**`, fecha com `**`, SEM nenhum outro `**` no meio? Ver o
 * comentário do header do arquivo pro raciocínio de paridade/pareamento
 * alternado que justifica "exatamente 2 ocorrências" em vez de só checar
 * início/fim.
 */
function isSingleBoldWrap(joined: string): boolean {
  return FULL_BOLD_LINE_RE.test(joined) && countDoubleAsterisk(joined) === 2;
}

export function lintCalloutPlacement(md: string): CalloutPlacementResult {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const matches: CalloutPlacementMatch[] = [];
  let inDestaqueSection = false;
  let sawTitle = false; // já vimos o 1º parágrafo de conteúdo (= título) desta seção?
  // #3282: acumula o parágrafo inteiro (multi-linha) antes de avaliar — mesmo
  // padrão de `lintStackedIntroCallouts` abaixo (`paraLines`/`flushParagraph`).
  let paraLines: string[] = [];
  let paraStartLine = -1;

  const flushParagraph = () => {
    if (paraLines.length === 0) return;
    if (inDestaqueSection) {
      if (!sawTitle) {
        // 1º parágrafo de conteúdo da seção = título do destaque — nunca
        // sinalizado, mesmo bold-wrapped (`**[Título](url)**` também bate em
        // FULL_BOLD_LINE_RE). Reconhecido por POSIÇÃO, não por forma.
        sawTitle = true;
      } else {
        // Testa o parágrafo INTEIRO (join por \n — FULL_BOLD_LINE_RE usa
        // `[\s\S]` no meio, então casa através de quebras de linha) — pega
        // tanto o callout de 1 linha quanto o hard-wrapped em várias. O
        // emoji-lead só precisa bater na 1ª linha (é âncora de INÍCIO, não
        // testa o parágrafo inteiro). #3315: `isSingleBoldWrap` exige
        // EXATAMENTE 2 ocorrências de `**` no blob — não basta bater
        // início/fim, senão 2 bolds independentes bookending um parágrafo
        // normal (texto plano no meio) falso-positivam como callout.
        const joined = paraLines.join("\n");
        if (isSingleBoldWrap(joined) || EMOJI_LEAD_RE.test(paraLines[0])) {
          matches.push({ line: paraStartLine, context: paraLines[0].slice(0, 80) });
        }
      }
    }
    paraLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Separador: linha bruta (sem trim) pra bater com /^---$/m do parseDestaques.
    if (SEPARATOR_RE.test(raw)) {
      flushParagraph();
      inDestaqueSection = false;
      sawTitle = false;
      continue;
    }
    const t = raw.trim();
    if (t === "") {
      flushParagraph();
      continue;
    }
    if (DESTAQUE_HEADER_RE.test(t)) {
      flushParagraph();
      inDestaqueSection = true;
      sawTitle = false;
      continue;
    }
    if (paraLines.length === 0) paraStartLine = i + 1;
    paraLines.push(t);
  }
  flushParagraph(); // edge case: arquivo termina em meio a parágrafo, sem `---`/blank final

  return { ok: matches.length === 0, matches };
}

// ---------------------------------------------------------------------------
// #2729 — ≥2 blocos de callout bold-wrap empilhados na região de intro
// (marcador-agnóstico desde #3232)
// ---------------------------------------------------------------------------

/**
 * #2729: `extractIntroCallout` (`scripts/lib/newsletter-parse.ts`, tornado
 * greedy pelo #2727 pra permitir sub-linhas `**bold**` dentro do box de
 * início de mês; marcador-agnóstico desde #3232) assume que a região de
 * intro (tudo antes do 1º `**DESTAQUE`) contém NO MÁXIMO 1 bloco `**...**` —
 * o regex greedy casa da PRIMEIRA abertura até o ÚLTIMO `**` de fim de linha
 * na região.
 *
 * Se o editor colar 2 blocos empilhados (ex: um patrocinado acima do CTA de
 * campeões/sorteio — `inject-champions-callout.ts` já tem lógica de
 * precedência que PULA a auto-injeção quando já existe um callout, mas isso
 * não impede colagem manual de 2 blocos pelo editor no Drive), o greedy funde
 * os dois num só bloco: os `**` internos (fechamento do 1º bloco + abertura
 * do 2º) vazam como texto literal no meio do parágrafo renderizado, e o
 * separador "Divulgação" do bloco patrocinado se perde.
 *
 * #3232: antes, a detecção de "abertura de bloco" exigia literalmente
 * `^\*\*\s*(🎉|📣)` — um par de blocos empilhados usando QUALQUER outro
 * marcador (ou nenhum) não era contado, e o lint não pegava a fusão greedy
 * (o mesmo tipo de gap que #3204 fechou pro box-entre-destaques). Detecção
 * agora é por PARÁGRAFO: cada parágrafo (separado por linha em branco) que
 * COMEÇA com `**` e NÃO está "dentro" de um bloco bold ainda aberto conta
 * como abertura de um NOVO bloco. Um bloco fica "aberto" entre o parágrafo
 * que abre (`**...` sem fechar `**` na mesma linha) e o próximo parágrafo que
 * fecha (termina em `**`) — isso é o que permite sub-linhas totalmente em
 * negrito (ex: "**Sorteio**", auto-contida — abre E fecha no mesmo parágrafo)
 * dentro de um bloco maior sem contar como 2ª abertura.
 *
 * Este check erra (`ok: false`) quando encontra ≥2 parágrafos de abertura na
 * região de intro (antes do 1º `**DESTAQUE`) — independente dos boxes de
 * divulgação entre destaques, cobertos por `lintCalloutPlacement`/
 * `locateBoxInGap`, semântica diferente.
 */
export interface StackedIntroCalloutResult {
  ok: boolean;
  count: number;
  lines: number[];
}

const DESTAQUE_MARKER_RE = /^\*\*DESTAQUE/;
const PARA_STARTS_BOLD_RE = /^\*\*\S/;
const PARA_ENDS_BOLD_RE = /\*\*\s*$/;

export function lintStackedIntroCallouts(md: string): StackedIntroCalloutResult {
  const normalized = md.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const matchLines: number[] = [];
  // #3232: estado do parágrafo em progresso + se estamos "dentro" de um
  // bloco bold ainda não fechado (ver comentário acima).
  let inOpenBlock = false;
  let paraLines: string[] = [];
  let paraStartLine = -1;

  const flushParagraph = () => {
    if (paraLines.length === 0) return;
    const startsWithBold = PARA_STARTS_BOLD_RE.test(paraLines[0]);
    const endsWithBold = PARA_ENDS_BOLD_RE.test(paraLines[paraLines.length - 1]);
    if (inOpenBlock) {
      // Dentro de um bloco já aberto: este parágrafo nunca conta como nova
      // abertura — só observamos se ele FECHA o bloco (ex: "**Sorteio**",
      // auto-contido, abre e fecha na mesma linha/parágrafo).
      if (endsWithBold) inOpenBlock = false;
    } else if (startsWithBold) {
      matchLines.push(paraStartLine);
      // Se o próprio parágrafo já fecha (`**...**` completo), não abre um
      // bloco pendente — senão, ficamos "dentro" até achar o fechamento.
      if (!endsWithBold) inOpenBlock = true;
    }
    paraLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    // Região de intro = tudo ANTES da 1ª linha `**DESTAQUE` — para assim que
    // encontrar o 1º destaque, espelhando `extractIntroCallout`
    // (`text.split(/^\*\*DESTAQUE/m)[0]`).
    if (DESTAQUE_MARKER_RE.test(lines[i])) {
      flushParagraph();
      break;
    }
    const t = lines[i];
    if (t.trim() === "") {
      flushParagraph();
      continue;
    }
    if (t.trim() === "---") {
      // Separador de seção: fronteira dura — nunca deveria haver um bloco
      // bold ainda "aberto" através de um `---` (defensivo, sem caso real
      // conhecido; espelha o reset de `inDestaqueSection` em
      // `lintCalloutPlacement` acima).
      flushParagraph();
      inOpenBlock = false;
      continue;
    }
    if (paraLines.length === 0) paraStartLine = i + 1;
    // code-review #3232: guarda TRIMMED (não a linha bruta) — senão um
    // callout indentado (ex: colado com espaços à frente) não bate em
    // `PARA_STARTS_BOLD_RE`/`PARA_ENDS_BOLD_RE` (`^\*\*`/`\*\*$` exigem o
    // marcador exatamente na borda da string) e o lint deixa de flagrar
    // stacking — mesmo bug de classe que a versão antiga evitava trimando
    // antes de testar `INTRO_CALLOUT_OPEN_RE`.
    paraLines.push(t.trim());
  }
  flushParagraph(); // edge case: região de intro sem `---`/`**DESTAQUE` final

  return { ok: matchLines.length < 2, count: matchLines.length, lines: matchLines };
}

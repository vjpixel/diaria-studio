/**
 * legacy-edition-parse.ts (#7569)
 *
 * Parser dos destaques das edições ANTIGAS da diar.ia.br — o formato que a
 * newsletter usou de agosto/2025 até ~abril/2026, antes do layout atual.
 *
 * ## Por que um segundo parser
 *
 * `edition-html-convert.ts` (#2791) converte o HTML publicado pro
 * pseudo-markdown que `collect-monthly.ts::parsePost` entende, e esse
 * pseudo-markdown pressupõe o formato ATUAL: `##### CATEGORIA` + `#
 * [Título](url)` + `Por que isso importa:`. As edições antigas não têm nada
 * disso: o **título é texto puro** e a **URL vive num `[Aprofunde](url)` no
 * fim do bloco**.
 *
 * Rodar só o parser moderno na janela da 1ª edição anual (ago/2025–ago/2026)
 * devolve **zero destaques nos 6 primeiros meses** — medido ao vivo em
 * 07/09/2026, antes deste módulo existir. Uma retrospectiva de aniversário
 * sem o começo da história é pior que nenhuma.
 *
 * ## O anchor é o "Aprofunde", não a moldura
 *
 * O formato antigo mudou pelo menos três vezes dentro do próprio primeiro
 * ano — e nenhuma das diferenças é cosmética:
 *
 *   - **ago–set/2025**: sem cabeçalho de seção e sem régua. Título, corpo,
 *     "Por que isso importa:", link. Três vezes seguidas, sem separador. O
 *     link vem como `Saiba mais: [https://…](https://…)`, com o rótulo FORA
 *     dos colchetes.
 *   - **out/2025**: ganha cabeçalho em CAIXA ALTA (`PRINCIPAIS NOTÍCIAS`,
 *     `BRASIL`), régua de underscores entre os blocos, e o link vira
 *     `[Aprofunde](url)`.
 *   - **nov/2025**: o "Por que isso importa" some da newsletter inteira (23
 *     edições, zero ocorrências) — quem trata o campo como obrigatório zera
 *     o mês.
 *
 * Um parser ancorado na moldura (régua/cabeçalho) devolve zero em setembro;
 * um que exija o "porquê" devolve zero em novembro. O que existe nos TRÊS é
 * o link de aprofundamento fechando cada destaque — é ele o anchor: cada
 * destaque é o trecho que TERMINA nesse link, e começa onde o anterior
 * acabou. A moldura, quando existe, só refina o começo do trecho e dá a
 * categoria.
 *
 * O rótulo do link é casado por prefixo (`aprof…`) porque pelo menos uma
 * edição real foi publicada com ele truncado (`[Aprofu](url)`, 05/11/2025).
 *
 * ## O que fica de fora
 *
 * "Notícias brasileiras", "Outras notícias" e "PARA ENCERRAR" são listas de
 * links soltos — sem "Aprofunde", logo sem anchor, logo fora. O bloco do "É
 * AI?" (só "A", "B" e o crédito da foto) idem. Nada disso precisa de
 * allowlist de seção, que envelheceria mal: as seções foram renomeadas
 * várias vezes ao longo do primeiro ano.
 */

import { htmlToLines } from "./edition-html-convert.ts";

export interface LegacyDestaque {
  position: number;
  category: string;
  title: string;
  url: string;
  body: string;
  why: string;
}

export interface LegacyParseResult {
  destaques: LegacyDestaque[];
  warnings: string[];
}

/** Régua entre blocos no layout antigo: linha só de underscores. */
const RULE_RE = /^_{3,}$/;
/** Cabeçalho de seção: linha curta sem minúsculas, com ao menos uma letra. */
const SECTION_RE = /^[^a-z]{2,40}$/;
/**
 * Link de aprofundamento que fecha cada destaque — o anchor. Duas formas
 * conviveram no primeiro ano, e as duas precisam casar:
 *
 *   - rótulo DENTRO dos colchetes — `[Aprofunde](url)` (out/2025 em diante);
 *   - rótulo FORA, com a própria URL como texto do link —
 *     `Saiba mais: [https://…](https://…)` (ago–set/2025).
 *
 * O rótulo é obrigatório numa das duas posições, nunca opcional: sem ele,
 * qualquer item das listas "Outras notícias"/"PARA ENCERRAR" (que são linhas
 * de link puro) viraria um destaque.
 *
 * Escrito como regex LITERAL de propósito — a versão anterior montava isto
 * com `new RegExp` e template literal, onde `\s` vira `s` na string antes de
 * chegar ao motor de regex, e o anchor casava com quase nada.
 */
const ANCHOR_RE =
  /^(?:(?:aprof[\w-]*|leia\s+mais|saiba\s+mais|ler\s+mais|continue\s+lendo)\s*:?\s*\[[^\]]*\]|\[\s*(?:aprof[\w-]*|leia\s+mais|saiba\s+mais|ler\s+mais|continue\s+lendo)\s*\])\((https?:\/\/[^\s)]+)\)\.?$/i;
/** Linha que é só um link markdown — item de lista, nunca título. */
const LINK_ONLY_LINE_RE = /^\[[^\]]*\]\(https?:\/\/[^\s)]+\)\.?$/;
/** "Por que isso importa", com ou sem dois-pontos, inline ou em linha solta. */
const WHY_RE = /^Por que isso importa:?\s*/i;
/** Legenda/crédito de imagem — nunca é título. */
const CAPTION_RE = /^(feito n|crédito|credito|imagem:|foto:|caption:|view image|fonte:)/i;
/** Despedida que fecha a introdução ("Até amanhã!", "Boa leitura!"). */
const FAREWELL_RE = /^(até amanhã|ate amanha|boa leitura|vamos lá|vamos la|até já|ate ja|bom proveito)[!.…]*$/i;
/** Rótulos de seção que não são CAIXA ALTA mas cumprem o mesmo papel. */
const SECTION_LABELS = [
  "bom dia",
  "principais notícias",
  "principais noticias",
  "notícias principais",
  "noticias principais",
  "notícias brasileiras",
  "noticias brasileiras",
  "outras notícias",
  "outras noticias",
  "para encerrar",
  "é ai?",
  "e ai?",
  "é ia?",
  "e ia?",
  "glossário",
  "glossario",
  "in partnership with",
  "em parceria com",
  "together with",
];
/**
 * Seções que nunca contêm destaque. Diferente das demais entradas de
 * `SECTION_LABELS`, estas SUPRIMEM a extração até a próxima régua/cabeçalho
 * — o conteúdo delas (verbete de glossário, item de lista, texto de anúncio)
 * tem a mesma forma de um destaque e passaria pelo teste de título.
 */
const SKIP_SECTIONS = [
  "glossário",
  "glossario",
  "outras notícias",
  "outras noticias",
  "notícias brasileiras",
  "noticias brasileiras",
  "para encerrar",
  "é ai?",
  "e ai?",
  "é ia?",
  "e ia?",
  "in partnership with",
  "em parceria com",
  "together with",
];
/** Linha da efeméride que fecha a introdução ("Há 43 anos…"). */
const TRIVIA_RE = /^(há|ha)\s+\d+\s+anos/i;
/** Linha da data da edição ("8 de setembro de 2025"). */
const DATE_LINE_RE = /^\d{1,2}\s+de\s+\p{L}+\s+de\s+\d{4}$/iu;
/** Título mínimo — descarta "A"/"B" do quiz e rótulos soltos. */
const MIN_TITLE_LEN = 8;

/** Compara rótulo ignorando caixa e pontuação final ("Bom dia!" = "bom dia"). */
function normalizeLabel(line: string): string {
  return line.toLowerCase().trim().replace(/[!?.:…\s]+$/u, "");
}

function isSectionHeader(line: string): boolean {
  if (SECTION_LABELS.includes(normalizeLabel(line))) return true;
  return SECTION_RE.test(line) && /\p{Lu}/u.test(line);
}

/** Uma linha pode abrir um destaque? */
function isTitleCandidate(line: string): boolean {
  if (line.length < MIN_TITLE_LEN) return false;
  if (LINK_ONLY_LINE_RE.test(line)) return false;
  if (CAPTION_RE.test(line)) return false;
  if (RULE_RE.test(line)) return false;
  if (isSectionHeader(line)) return false;
  if (WHY_RE.test(line)) return false;
  return true;
}

/** Índices das linhas que fecham um destaque. */
export function findAnchors(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ANCHOR_RE.test(lines[i].trim())) out.push(i);
  }
  return out;
}

/**
 * Onde a introdução acaba — o começo do 1º destaque.
 *
 * A intro tem forma variável (assunto, subtítulo, data, "In partnership
 * with", parágrafos de abertura, efeméride), mas sempre termina em algum
 * marcador conhecido. Pegamos o ÚLTIMO marcador antes do 1º anchor: a régua
 * ou o cabeçalho de seção quando o layout os tem, e a efeméride/data quando
 * não tem (setembro/2025). Sem nenhum marcador, começa do topo — o pior caso
 * é o título do destaque sair como o assunto da edição, o que o gate mostra.
 */
export function introEnd(lines: readonly string[], firstAnchor: number): number {
  let end = 0;
  for (let i = 0; i < firstAnchor; i++) {
    const line = lines[i].trim();
    if (RULE_RE.test(line) || isSectionHeader(line) || DATE_LINE_RE.test(line)) end = Math.max(end, i + 1);
    // A despedida ("Até amanhã!") fecha o texto de abertura do editor.
    if (FAREWELL_RE.test(line)) end = Math.max(end, i + 1);
    // A efeméride ocupa duas linhas (rótulo + parágrafo).
    if (TRIVIA_RE.test(line)) end = Math.max(end, i + 2);
  }
  return end;
}

/** Extrai um destaque do trecho `[start, anchor]`, ou `null` se não houver. */
function parseSpan(
  lines: readonly string[],
  start: number,
  anchorIdx: number,
  categoryIn: string,
  skippingIn: boolean,
): { destaque: LegacyDestaque | null; category: string; skipping: boolean } {
  let category = categoryIn;
  let skipping = skippingIn;
  const anchorMatch = lines[anchorIdx].trim().match(ANCHOR_RE);
  if (!anchorMatch) return { destaque: null, category, skipping };

  const content: string[] = [];
  let title = "";
  for (let i = start; i < anchorIdx; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // Régua e cabeçalho abrem um bloco NOVO. Se um título já tinha sido
    // escolhido antes deles, ele pertencia a um bloco sem anchor — anúncio de
    // patrocinador, quiz, lista — e não a este destaque. Descartar é o que
    // impede o anúncio ("Looking for unbiased, fact-based news?") de roubar o
    // título do destaque seguinte, caso real de out/2025.
    if (RULE_RE.test(line)) {
      title = "";
      content.length = 0;
      skipping = false;
      continue;
    }
    if (isSectionHeader(line)) {
      // Seções que nunca contêm destaque (glossário, listas de links,
      // patrocinador, quiz) SUPRIMEM a extração até o próximo cabeçalho ou
      // régua. Sem isso, o primeiro verbete do glossário — que é texto puro
      // seguido de um link, igualzinho a um destaque — vira o título do
      // destaque seguinte. Caso real de set/2025.
      skipping = SKIP_SECTIONS.includes(normalizeLabel(line));
      category = skipping ? category : line;
      title = "";
      content.length = 0;
      continue;
    }
    if (skipping) continue;
    if (!title) {
      // Antes do título, tudo que não serve de título é ruído de moldura
      // (legenda, crédito, "A"/"B" do quiz) e não vira corpo.
      if (!isTitleCandidate(line)) continue;
      title = line;
      continue;
    }
    if (CAPTION_RE.test(line)) continue;
    content.push(line);
  }

  if (!title || skipping) return { destaque: null, category, skipping };

  // "Por que isso importa" é OPCIONAL, ao contrário do formato atual: em
  // novembro/2025 a seção sumiu da newsletter inteira (medido ao vivo — 23
  // edições, zero ocorrências). Exigi-la aqui zera o mês.
  const whyIdx = content.findIndex((l) => WHY_RE.test(l));
  const body = whyIdx === -1 ? content : content.slice(0, whyIdx);
  const why =
    whyIdx === -1
      ? []
      : [content[whyIdx].replace(WHY_RE, "").trim(), ...content.slice(whyIdx + 1)].filter(Boolean);

  // Título sozinho, sem corpo nem "porquê", não é notícia — é verbete de
  // glossário ou item de lista que escapou da supressão de seção. Um
  // destaque real sempre traz ao menos um dos dois.
  if (body.length === 0 && why.length === 0) return { destaque: null, category, skipping };

  return {
    destaque: {
      position: 0, // atribuído depois do cap de 3
      category: category || "SEM CATEGORIA",
      title,
      url: anchorMatch[1],
      body: body.join("\n").trim(),
      why: why.join("\n").trim(),
    },
    category,
    skipping,
  };
}

/**
 * Parseia os destaques de uma edição no formato antigo, a partir do HTML
 * publicado. Cap de 3 (o teto editorial de sempre); excedente vira warning,
 * nunca erro.
 */
export function parseLegacyEditionHtml(html: string, label = "edicao"): LegacyParseResult {
  const warnings: string[] = [];
  const lines = htmlToLines(html);
  const anchors = findAnchors(lines);

  if (anchors.length === 0) {
    warnings.push(`${label}: formato antigo não reconhecido — nenhum link "Aprofunde" na edição`);
    return { destaques: [], warnings };
  }

  const found: LegacyDestaque[] = [];
  let category = "";
  let skipping = false;
  let start = introEnd(lines, anchors[0]);

  for (const anchorIdx of anchors) {
    const parsed = parseSpan(lines, start, anchorIdx, category, skipping);
    category = parsed.category;
    skipping = parsed.skipping;
    if (parsed.destaque) found.push(parsed.destaque);
    else warnings.push(`${label}: trecho terminando na linha ${anchorIdx} sem título reconhecível — pulado`);
    start = anchorIdx + 1;
  }

  if (found.length > 3) {
    warnings.push(`${label}: ${found.length} blocos com "Aprofunde" (esperado 3) — usando os 3 primeiros`);
  }

  const destaques = found.slice(0, 3).map((d, i) => ({ ...d, position: i + 1 }));
  return { destaques, warnings };
}

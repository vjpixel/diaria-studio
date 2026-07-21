/**
 * lint-checks/coverage-line-format.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * #592, #609: linha de cobertura é a primeira linha não-vazia do reviewed.md.
 *
 * Aceita 3 formatos (#3461 é o padrão a partir da edição 260715; #3456 e o
 * legado ficam mantidos pra edições antigas que nunca serão re-renderizadas
 * mas cujo lint não deve quebrar retroativamente):
 *   - padrão atual (#3461): bloco de boas-vindas multi-parágrafo, sem
 *     negrito — "Olá! Eu sou o [Pixel](...), editor dessa newsletter. (...)
 *     Nesta edição, a IA analisou N artigos (X enviados por mim e Y
 *     encontrados automaticamente) e selecionei os Z mais relevantes. (...)"
 *     — detectado pela linha "Nesta edição, a IA analisou...".
 *   - #3456 (curto período entre 260715 ajustes, mantido por precaução):
 *     "Para esta edição, a diar.ia.br analisou N artigos: X enviados pelo
 *     editor, {nome}, e Y encontrados automaticamente. Após a curadoria,
 *     foram selecionados os Z mais relevantes."
 *   - legado original (#592/#609): "Para esta edição, eu (o editor) enviei X
 *     submissões e a Diar.ia encontrou outros Y artigos. Selecionamos os Z
 *     mais relevantes para as pessoas que assinam a newsletter."
 *
 * Aceita variação com `???` no Y (fallback quando totalConsidered ausente).
 *
 * #701: aceita também forma singular ("1 submissão", "1 artigo",
 * "Selecionamos o artigo mais relevante" / "foi selecionado o artigo mais
 * relevante" / "selecionei o artigo mais relevante") — concordância numérica.
 */
const LEGACY_COVERAGE_LINE_RE =
  /^Para esta edi[çc][ãa]o, eu \(o editor\) enviei \d+ submiss(?:ão|ões) e a Diar\.ia encontrou outros (?:\d+|\?\?\?) artigos?\. (?:Selecionamos o artigo mais relevante|Selecionamos os \d+ mais relevantes)/i;

// #3731: "enviados"/"encontrados" também aceitam forma singular (`s?`) — o
// comentário #701 acima só cobria "submissão"/"artigo"/"o artigo mais
// relevante"; "1 enviados"/"1 encontrados" (concordância errada) ainda
// batiam aqui mesmo depois do fix de `formatCoverageLine`/
// `buildWelcomeCoverageSentence` pra "1 enviado"/"1 encontrado".
const NEW_COVERAGE_LINE_RE =
  /^Para esta edi[çc][ãa]o, a diar\.ia\.br analisou (?:\d+|\?\?\?) artigos?: \d+ enviados? pelo editor, [^,]+, e (?:\d+|\?\?\?) encontrados? automaticamente\. Após a curadoria, (?:foi selecionado o artigo mais relevante|foram selecionados os \d+ mais relevantes)/i;

const WELCOME_COVERAGE_LINE_RE =
  /^Nesta edi[çc][ãa]o, a IA analisou (?:\d+|\?\?\?) artigos? \(\d+ enviados? por mim e (?:\d+|\?\?\?) encontrados? automaticamente\) e (?:selecionei o artigo mais relevante|selecionei os \d+ mais relevantes)/i;

export const COVERAGE_LINE_RE = new RegExp(
  `(?:${LEGACY_COVERAGE_LINE_RE.source})|(?:${NEW_COVERAGE_LINE_RE.source})|(?:${WELCOME_COVERAGE_LINE_RE.source})`,
  "i",
);

/**
 * #925: pula YAML frontmatter (`---\n...\n---\n`) antes de procurar a
 * primeira linha do body. Writer agent emite `eia_answer` no frontmatter
 * (output canônico, não anomalia), e o lint não pode tratar `---` (delim
 * do frontmatter) como primeira linha de cobertura.
 *
 * Frontmatter malformado (sem fechamento) é tratado como body — não pula
 * nada, deixa o regex falhar com mensagem clara.
 */
function stripFrontmatter(md: string): string {
  if (!md.startsWith("---\n") && !md.startsWith("---\r\n")) return md;
  // Procurar fechamento — `\n---` no início de linha após o delim de abertura.
  // Buscamos a partir do índice 4 pra não pegar o `---` da abertura.
  const closeMatch = md.slice(4).match(/^---\r?\n/m);
  if (!closeMatch || closeMatch.index === undefined) return md;
  const endOfClose = 4 + closeMatch.index + closeMatch[0].length;
  return md.slice(endOfClose);
}

/**
 * Retorna o índice de char logo após a n-ésima quebra de linha (`\n`) do
 * texto, ou `text.length` se o texto tiver menos linhas que `n`. Usado pra
 * delimitar uma janela-prefixo de `text` sem alterar quebras de linha
 * (CRLF/LF) — os índices resultantes continuam válidos no texto original.
 */
function nthLineEndIndex(text: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i++) {
    const next = text.indexOf("\n", idx + 1);
    if (next === -1) return text.length;
    idx = next;
  }
  return idx + 1;
}

/**
 * Skip `TÍTULO` / `SUBTÍTULO` header block (#916) — inserido por
 * `insert-titulo-subtitulo.ts` no topo do `02-reviewed.md` pra alimentar
 * subject + preview text do Beehiiv. O bloco termina em `---`. Coverage
 * line vem depois.
 *
 * Sem este skip, `checkCoverageLine` em 02-reviewed.md falsamente reporta
 * "TÍTULO" como primeira linha e marca formato inválido (#1207).
 *
 * #3810: o `---` de fechamento é procurado numa JANELA CURTA de linhas
 * após o início do bloco — não no documento inteiro. O formato documentado
 * por `insert-titulo-subtitulo.ts` (TÍTULO/blank/título/blank/SUBTÍTULO/
 * blank/subtítulo/blank/---) cabe em ~9 linhas; damos folga generosa (20)
 * pra títulos incomuns sem abrir mão da proteção. Antes, quando o `---`
 * emitido pelo script estava ausente (causa raiz não investigada — talvez
 * edição manual), o código caía no primeiro `---` de TODO o documento (ex:
 * o separador antes de "DESTAQUE 1"), descartando como "bloco
 * TÍTULO/SUBTÍTULO" um trecho enorme que incluía a linha de cobertura real
 * — `checkCoverageLine` então reportava ausência silenciosamente. Se nenhum
 * `---` aparece na janela, tratamos como bloco malformado e NÃO removemos
 * nada — fail-open: o body original segue pra frente e a linha de
 * cobertura, se existir mais abaixo, ainda é encontrada pela busca global
 * de `checkCoverageLine`.
 */
function stripTituloSubtituloBlock(md: string): string {
  const firstLine = md.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine || !/^T[ÍI]TULO$/i.test(firstLine.trim())) return md;

  const WINDOW_LINES = 20;
  const windowEnd = nthLineEndIndex(md, WINDOW_LINES);
  const windowText = md.slice(0, windowEnd);
  const dashMatch = windowText.match(/^---\s*$/m);
  if (!dashMatch || dashMatch.index === undefined) return md;

  // Defesa extra: se algum conteúdo suspeito (a própria linha de cobertura)
  // aparece antes do `---` encontrado, esse `---` provavelmente não é o
  // terminador do bloco TÍTULO/SUBTÍTULO — não arrisca descartar conteúdo real.
  const beforeDash = md.slice(0, dashMatch.index);
  if (beforeDash.split("\n").some((l) => COVERAGE_LINE_RE.test(l.trim()))) {
    return md;
  }

  const afterDash = md.slice(dashMatch.index + dashMatch[0].length);
  // Pular newline depois do ---
  return afterDash.replace(/^\r?\n+/, "");
}

/**
 * #3459: a linha de cobertura nem sempre é a primeira linha não-vazia do body —
 * o editor pode inserir um box de intro (ex: mensagem de boas-vindas) ANTES
 * dela, isolado por `---`. Em vez de checar só a primeira linha, procura a
 * linha de cobertura em qualquer ponto do body (mesma técnica de
 * `extractCoverageLine`, que já faz busca global via regex multiline) —
 * `firstLine` continua reportando a primeira linha real pra mensagem de erro
 * quando a linha de cobertura está genuinamente ausente.
 */
export function checkCoverageLine(md: string): { ok: boolean; firstLine: string } {
  let body = stripFrontmatter(md);
  body = stripTituloSubtituloBlock(body);
  const lines = body.split("\n").map((l) => l.trim());
  const firstNonEmpty = lines.find((l) => l.length > 0) ?? "";
  const ok = lines.some((l) => COVERAGE_LINE_RE.test(l));
  return { ok, firstLine: firstNonEmpty };
}

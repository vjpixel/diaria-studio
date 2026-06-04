/**
 * lint-checks/coverage-line-format.ts (#1737 item 2 — extraído de lint-newsletter-md.ts)
 *
 * #592, #609: linha de cobertura é a primeira linha não-vazia do reviewed.md.
 * Formato canônico:
 *   "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia
 *    encontrou outros Y artigos. Selecionamos os Z mais relevantes para as
 *    pessoas que assinam a newsletter."
 *
 * Aceita variação com `???` no Y (fallback quando totalConsidered ausente).
 *
 * #701: aceita também forma singular ("1 submissão", "1 artigo",
 * "Selecionamos o artigo mais relevante") — concordância numérica.
 */
export const COVERAGE_LINE_RE =
  /^Para esta edi[çc][ãa]o, eu \(o editor\) enviei \d+ submiss(?:ão|ões) e a Diar\.ia encontrou outros (?:\d+|\?\?\?) artigos?\. (?:Selecionamos o artigo mais relevante|Selecionamos os \d+ mais relevantes)/i;

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
 * Skip `TÍTULO` / `SUBTÍTULO` header block (#916) — inserido por
 * `insert-titulo-subtitulo.ts` no topo do `02-reviewed.md` pra alimentar
 * subject + preview text do Beehiiv. O bloco termina em `---`. Coverage
 * line vem depois.
 *
 * Sem este skip, `checkCoverageLine` em 02-reviewed.md falsamente reporta
 * "TÍTULO" como primeira linha e marca formato inválido (#1207).
 */
function stripTituloSubtituloBlock(md: string): string {
  const firstLine = md.split(/\r?\n/).find((l) => l.trim().length > 0);
  if (!firstLine || !/^T[ÍI]TULO$/i.test(firstLine.trim())) return md;
  // Procurar primeiro `---` em linha própria — fim do bloco TÍTULO/SUBTÍTULO.
  const dashMatch = md.match(/^---\s*$/m);
  if (!dashMatch || dashMatch.index === undefined) return md;
  const afterDash = md.slice(dashMatch.index + dashMatch[0].length);
  // Pular newline depois do ---
  return afterDash.replace(/^\r?\n+/, "");
}

export function checkCoverageLine(md: string): { ok: boolean; firstLine: string } {
  let body = stripFrontmatter(md);
  body = stripTituloSubtituloBlock(body);
  const lines = body.split("\n");
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";
  return {
    ok: COVERAGE_LINE_RE.test(firstNonEmpty.trim()),
    firstLine: firstNonEmpty.trim(),
  };
}

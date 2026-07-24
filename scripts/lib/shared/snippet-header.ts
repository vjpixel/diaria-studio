/**
 * snippet-header.ts (#3979/#3981)
 *
 * Parsing genérico do header de comentário HTML convencional dos snippets de
 * caixa (`context/snippets/*.md`, ver `context/snippets/README.md`): um
 * bloco `<!-- ... -->` no topo do arquivo carregando METADADOS estruturados
 * (`nome:` desde #3933, `categoria:` desde #3981) + texto livre de notas —
 * nunca vaza pro leitor (`readSnippetFile`/`stitch-newsletter.ts` removem
 * TODO comentário HTML antes do conteúdo ir pra newsletter).
 *
 * Extraído de `scripts/studio-ui/studio-boxes.ts` (que introduziu esse
 * padrão com `parseBoxNome`/`stripNomeLine`/`buildBoxContentWithNome`, #3933)
 * porque o pipeline de RENDER (`scripts/lib/newsletter-parse.ts`) também
 * precisa ler `categoria:` (#3981 — renderiza o rótulo acima do box) sem
 * depender do módulo do Studio (server-only, side-effects de `spawnSync`
 * git via `checkDirtyVsGit`). `shared/` porque é lido tanto por
 * `scripts/studio-ui/` (edição) quanto por `scripts/lib/` (render) — ver
 * test/lib-boundary.test.ts (#2747), que só regula shared/diaria/mensal
 * dentro de scripts/lib — este módulo respeita a mesma direção (genérico,
 * sem import de domínio específico).
 *
 * `studio-boxes.ts` mantém suas próprias `parseBoxNome`/`stripNomeLine`/
 * `buildBoxContentWithNome` (#3933) intocadas — são o contrato testado e
 * usado pelo modo legado `{nome, body}` do PUT `/api/boxes/:slug`. As novas
 * funções (`extractBoxNotas`/`extractBoxConteudo`/`buildBoxContent`,
 * #3979/#3981) usam os helpers genéricos daqui.
 */

/** Corpo do PRIMEIRO comentário HTML se o conteúdo começa (após espaço) com
 * um — o "header" convencional dos snippets. `null` se não houver. */
export function leadingCommentInner(content: string): string | null {
  const m = /^\s*<!--([\s\S]*?)-->/.exec(content);
  return m ? m[1] : null;
}

/** Extrai o valor de `{key}:` do header de comentário (case-insensitive,
 * valor = resto da linha, trimado), ou `null` se ausente/sem header. Só olha
 * o header (1º comentário) — um `{key}:` solto no corpo não conta. Nunca
 * lança. */
export function parseBoxHeaderField(content: string, key: string): string | null {
  const inner = leadingCommentInner(content);
  if (inner === null) return null;
  const re = new RegExp(`^[ \\t]*${key}[ \\t]*:[ \\t]*(.+?)[ \\t]*$`, "im");
  const m = re.exec(inner);
  return m ? m[1].trim() : null;
}

/** Header inner MENOS as linhas `{key}:` de `keys` (case-insensitive),
 * trimado — o texto de "notas" que sobra pro editor livre (#3979: painel
 * "Notas", separado dos campos dedicados `nome`/`categoria`). `""` se não
 * houver header ou o header ficar vazio depois de remover as chaves. Nunca
 * lança. */
export function extractHeaderRemainder(content: string, keys: string[]): string {
  const inner = leadingCommentInner(content);
  if (inner === null) return "";
  let out = inner;
  for (const key of keys) {
    out = out.replace(new RegExp(`^[ \\t]*${key}[ \\t]*:.*(?:\\r?\\n)?`, "im"), "");
  }
  return out.trim();
}

/** Conteúdo com o bloco de comentário-header INTEIRO removido (não só uma
 * linha) — o que renderiza na newsletter (#3979: painel "Conteúdo" separado
 * de "Notas"). Sem header no início -> devolve o conteúdo como está. Nunca
 * lança. */
export function stripHeaderBlock(content: string): string {
  const m = /^\s*<!--[\s\S]*?-->/.exec(content);
  if (!m) return content;
  return content.slice(m[0].length).replace(/^\r?\n+/, "");
}

/** Reconstrói o conteúdo a partir de campos de header EXPLÍCITOS (#3979/
 * #3981) — `fields` é uma lista ORDENADA `{key, value}` (vira linha
 * `key: value`, omitida se `value` vazio/whitespace) seguida de `notas`
 * (texto livre, último bloco do header, omitido se vazio) + `conteudo` (o
 * resto do arquivo, o que renderiza). Sem nenhum campo/nota preenchido -> sem
 * comentário no topo (o `conteudo` puro). Nunca lança.
 *
 * Diferente de `buildBoxContentWithNome` (#3933, que faz upsert cirúrgico
 * numa linha dentro de um header PRÉ-EXISTENTE, preservando texto que a UI
 * não conhece), esta função reconstrói o header inteiro a partir dos campos
 * — correto aqui porque a UI de 2 painéis (#3979) edita TODO o header
 * (nome + categoria + notas) explicitamente; não há texto "desconhecido" a
 * preservar por fora desses 3 valores. */
export function buildContentWithHeader(
  fields: Array<{ key: string; value: string | null | undefined }>,
  notas: string | null | undefined,
  conteudo: string | null | undefined,
): string {
  const lines: string[] = [];
  for (const { key, value } of fields) {
    const clean = (value ?? "").trim();
    if (clean) lines.push(`${key}: ${clean}`);
  }
  const notasClean = (notas ?? "").trim();
  if (notasClean) lines.push(notasClean);
  const body = conteudo ?? "";
  if (lines.length === 0) return body;
  return `<!--\n${lines.join("\n")}\n-->\n\n${body}`;
}

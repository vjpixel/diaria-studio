/**
 * snippet-header.ts (#3979/#3981)
 *
 * Parsing genérico do header de comentário HTML convencional dos snippets de
 * caixa (`data/snippets/*.md` — #5227, migrado de `context/snippets/`; ver
 * `context/snippets/README.md`, que continua a spec do formato): um
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

import { createHash } from "node:crypto";

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

/** `true` se o header de comentário declara `runtime: false` (#4500, movida
 * de `scripts/studio-ui/studio-boxes.ts` pra cá em #4504 — a checagem passou
 * a ser necessária também no pipeline core, `scripts/stitch-newsletter.ts`/
 * `scripts/lib/newsletter-parse.ts`, que não pode importar de `studio-ui/`
 * por ser camada UI/server-only, ver `test/lib-boundary.test.ts`) — sinal de
 * que o `.md` é documentação/referência (não lido em runtime pelo pipeline,
 * ex: `intro-campeoes-sorteio.md`) e por isso não deve ser selecionável no
 * painel Caixas (`listBoxes`) nem atribuível a um slot de `boxes_divulgacao`
 * (`saveBoxSlots`, e o invariant check `box-divulgacao-runtime-excluded` do
 * Stage 4, #4504). Comparação case-insensitive do VALOR também (`False`/
 * `FALSE` contam) — qualquer outro valor (`true`, ausente, string
 * arbitrária) não exclui. Nunca lança. */
export function isRuntimeExcluded(content: string): boolean {
  const raw = parseBoxHeaderField(content, "runtime");
  return raw !== null && raw.trim().toLowerCase() === "false";
}

/** Valor do campo `titulo:` do header, normalizado — `false`/`true` quando
 * declarado explicitamente (case-insensitive: `False`/`TRUE` contam), `null`
 * quando o campo está ausente ou tem outro valor (o caller decide o default).
 *
 * #5882: "sem título" (1º parágrafo em prosa corrida, não título serif 26px
 * — ver `renderBoxDivulgacao`/`renderIntroCallout` em
 * `newsletter-render-html.ts`) vira uma PROPRIEDADE DECLARADA do box
 * (`titulo: false` no header, mesmo padrão de `runtime: false` acima),
 * editável no painel Caixas do Studio — em vez de detectada por regex
 * casando a FRASE exata da copy (`isConviteAmigoBox`, aposentada por esta
 * issue). Regex de copy quebrava silenciosamente com qualquer edição de
 * texto no snippet; o campo declarado sobrevive a qualquer reescrita da
 * copy. Nunca lança. */
/** `true` quando o snippet declara `seasonal:` no header (case-insensitive:
 * `True`/`TRUE` contam); `false` quando `seasonal: false`; `null` quando
 * ausente — usado pelo pipeline de curadoria pra distinguir ofertas
 * pontuais (sazonais/de alta pull) de boxes permanentes.
 */
export function readSeasonalFlag(content: string): boolean | null {
  const raw = parseBoxHeaderField(content, "seasonal");
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

export function readBoxTituloFlag(content: string): boolean | null {
  const raw = parseBoxHeaderField(content, "titulo");
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "false") return false;
  if (v === "true") return true;
  return null;
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

/** Hash determinístico (sha256, hex) do CORPO pós-cabeçalho de um snippet —
 * usado por `lint-checks/snippet-staleness.ts` (#4150) pra distinguir edição
 * de metadado (`nome:`/`categoria:`/`alt:`, dentro do cabeçalho de comentário
 * removido por `stripHeaderBlock`) de edição de conteúdo (o que de fato entra
 * na newsletter). `content` é o texto CRU do arquivo (com o comentário de
 * header, se houver) — a função já aplica `stripHeaderBlock` + trim antes de
 * hashear, então o caller não precisa fazer esse strip antes de chamar.
 * Mesmo padrão de `hashHighlights` (`lib/social-source-hash.ts`, #1413):
 * hash gravado no momento da produção, comparado depois pra detectar
 * staleness sem reimplementar comparação de conteúdo estruturado. */
export function snippetBodyHash(content: string): string {
  const body = stripHeaderBlock(content).trim();
  return createHash("sha256").update(body).digest("hex");
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

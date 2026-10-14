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
export function readBoxTituloFlag(content: string): boolean | null {
  const raw = parseBoxHeaderField(content, "titulo");
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (v === "false") return false;
  if (v === "true") return true;
  return null;
}

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

// ── Header fora da 1ª linha (#10178) ────────────────────────────────────────

/**
 * #10178: `true` quando o arquivo TEM um comentário `<!--` mas ele não abre o
 * arquivo (`leadingCommentInner` devolve `null`) — sinal de header deslocado.
 * Caso real 14/10/2026: um `.md` começando com `---` antes do comentário
 * perdeu `alt:`/`titulo:` em silêncio (`parseBoxHeaderField` só lê o 1º
 * comentário quando ele abre o arquivo) e o `---` vazou pro `02-reviewed.md`
 * via `apply-box-slot.ts` (barra duplicada). Detecção pura, nunca lança;
 * quem chama decide como avisar (warn no stitch, aviso no painel Caixas).
 */
export function hasMisplacedHeaderComment(content: string): boolean {
  return leadingCommentInner(content) === null && content.includes("<!--");
}

/** #10178: texto do aviso de header deslocado, compartilhado pelo stitch e
 * pelo painel Caixas (mesma frase nos dois lugares). */
export function misplacedHeaderWarning(filename: string): string {
  return (
    `data/snippets/${filename}: o comentário de header \`<!-- ... -->\` não está na 1ª linha do arquivo ` +
    `— os campos dele (nome:, alt:, titulo:, expires:…) são ignorados e o que vem antes vaza pra edição. ` +
    `Mova o comentário pro topo do arquivo (#10178).`
  );
}

// ── Validade da caixa: `expires:` (#10174) ──────────────────────────────────

/**
 * #10174: estado de validade de uma caixa em relação à data de uma edição.
 * - `none`: sem `expires:` no header (caixa permanente — o caso comum);
 * - `invalid`: `expires:` presente mas fora do formato `AAAA-MM-DD` (ou data
 *   impossível). Não esconde a caixa: quem chama avisa e segue;
 * - `valid`: `daysLeft` ≥ 0 (0 = a edição do próprio último dia);
 * - `expired`: a data da edição já passou do último dia.
 */
export type SnippetExpiry =
  | { status: "none" }
  | { status: "invalid"; raw: string }
  | { status: "valid" | "expired"; expires: string; daysLeft: number };

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoDateToUtcMs(iso: string): number | null {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Rejeita data impossível (2026-02-30 vira 02/03 no Date.UTC).
  return new Date(ms).toISOString().slice(0, 10) === iso ? ms : null;
}

/** #10174: `AAMMDD` (data de edição) → `AAAA-MM-DD`, ou `null` se não for 6
 * dígitos de uma data válida. Edição é sempre do século 21. */
export function aammddToIsoDate(aammdd: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})$/.exec(aammdd);
  if (!m) return null;
  const iso = `20${m[1]}-${m[2]}-${m[3]}`;
  return isoDateToUtcMs(iso) === null ? null : iso;
}

/**
 * #10174: lê `expires: AAAA-MM-DD` do header e compara com a data da EDIÇÃO
 * (`editionIsoDate`, `AAAA-MM-DD` — a data civil BRT da edição, nunca o
 * relógio: a edição é D+1 e pode ser montada na véspera). `expires` é o
 * ÚLTIMO dia em que a caixa ainda pode sair, inclusive — evento no sábado
 * 17/10 → `expires: 2026-10-17` mantém a caixa na edição de 17/10 (sai de
 * manhã, antes do evento) e a tira a partir da edição de 18/10.
 * `editionIsoDate` inválido → `none` (sem data de referência não há como
 * julgar; o caller segue o comportamento de sempre). Nunca lança.
 */
export function readSnippetExpiry(content: string, editionIsoDate: string): SnippetExpiry {
  return evaluateSnippetExpiry(parseBoxHeaderField(content, "expires"), editionIsoDate);
}

/** #10174: mesma regra de `readSnippetExpiry`, a partir do valor cru de
 * `expires:` já lido do header (`SnippetInfo.expires`). Nunca lança. */
export function evaluateSnippetExpiry(raw: string | null | undefined, editionIsoDate: string): SnippetExpiry {
  if (raw === null || raw === undefined || raw.trim() === "") return { status: "none" };
  const editionMs = isoDateToUtcMs(editionIsoDate);
  if (editionMs === null) return { status: "none" };
  const expires = raw.trim();
  const expiresMs = isoDateToUtcMs(expires);
  if (expiresMs === null) return { status: "invalid", raw: expires };
  const daysLeft = Math.round((expiresMs - editionMs) / 86_400_000);
  return { status: daysLeft < 0 ? "expired" : "valid", expires, daysLeft };
}

/** #9104: audiência default de um snippet sem `audiencia:` no header e sem
 * sinal inferível — a própria diária. Default escolhido pra não mudar nada
 * nos snippets existentes (todos sem o campo até o #9104). */
export const DEFAULT_SNIPPET_AUDIENCE = "diaria";

/** #9104: `utm_source` de link que identifica, sozinho, uma audiência que
 * NÃO é a diária — o UTM é justamente o que separa as vendas por canal
 * (ex.: `clarice-imersao1010.md` leva `utm_source=clarice`), então uma caixa
 * com esse UTM na diária quebra a atribuição. Só valores inequívocos entram
 * aqui: `meta`/`whatsapp` etc. aparecem em caixas legítimas da diária. */
export const FOREIGN_AUDIENCE_UTM_SOURCES: Readonly<Record<string, string>> = {
  clarice: "clarice",
  brevo: "brevo",
};

export type SnippetAudienceSource = "header" | "utm_source" | "default";

export interface SnippetAudience {
  /** Audiência normalizada (minúsculas, trimada) — `"diaria"` é a diária. */
  audience: string;
  /** De onde veio: campo `audiencia:` explícito, inferência por
   * `utm_source` dos links do corpo, ou default (`diaria`). */
  source: SnippetAudienceSource;
}

function utmParam(rawUrl: string, key: string): string | null {
  try {
    const v = new URL(rawUrl).searchParams.get(key);
    return v ? v.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * #9104: resolve a audiência de um snippet. Precedência:
 *   1. `audiencia:` no header (valor livre, normalizado pra minúsculas e sem
 *      acento — `Diária` = `diaria`) —
 *      sempre vence, inclusive pra declarar `diaria` numa caixa cujo link
 *      tenha um UTM de outra audiência;
 *   2. inferência EXPLÍCITA por `utm_source` dos links do CORPO
 *      (`bodyUrls`, URLs cruas, com query) — só os valores de
 *      `FOREIGN_AUDIENCE_UTM_SOURCES`; nunca pelo nome do arquivo
 *      (`clarice-divulgacao.md` é caixa da diária que divulga a Clarice);
 *   3. default `DEFAULT_SNIPPET_AUDIENCE`.
 * Nunca lança.
 */
export function resolveSnippetAudience(content: string, bodyUrls: readonly string[]): SnippetAudience {
  const header = parseBoxHeaderField(content, "audiencia");
  if (header !== null && header.trim() !== "") {
    // Sem acento: `audiencia: Diária` (grafia natural em PT) = `diaria`.
    const normalized = header.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    return { audience: normalized, source: "header" };
  }
  for (const url of bodyUrls) {
    const src = utmParam(url, "utm_source");
    if (src && FOREIGN_AUDIENCE_UTM_SOURCES[src]) {
      return { audience: FOREIGN_AUDIENCE_UTM_SOURCES[src], source: "utm_source" };
    }
  }
  return { audience: DEFAULT_SNIPPET_AUDIENCE, source: "default" };
}

/**
 * #9104: chaves de EVENTO/campanha de um snippet — duas caixas que
 * compartilham uma chave divulgam a mesma coisa (ex.: `diaria-imersao1010.md`
 * e `workshop-agente-ia-outubro.md`, ambas `utm_campaign=agente-ia`) e nunca
 * devem sair juntas na mesma edição. `evento:` no header vence (chave única);
 * sem ele, cai nos `utm_campaign` distintos dos links do corpo. Sem nenhum
 * dos dois → `[]` (a caixa não colide com nada por evento). Minúsculas,
 * sem duplicata. Nunca lança.
 */
export function extractSnippetEventKeys(content: string, bodyUrls: readonly string[]): string[] {
  const header = parseBoxHeaderField(content, "evento");
  if (header !== null && header.trim() !== "") return [header.trim().toLowerCase()];
  const keys = new Set<string>();
  for (const url of bodyUrls) {
    const c = utmParam(url, "utm_campaign");
    if (c) keys.add(c);
  }
  return [...keys];
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

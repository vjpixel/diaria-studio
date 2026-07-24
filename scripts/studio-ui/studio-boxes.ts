/**
 * studio-boxes.ts (#3924 — Studio UI: seção "Caixas" — listar e editar os
 * snippets de caixa de divulgação)
 *
 * Camada de leitura/escrita pro painel "Caixas" do Studio: os snippets
 * reusáveis injetados na newsletter (recomendação de leitura, apoio, etc.)
 * vivem em `context/snippets/*.md` — este módulo lista esse diretório
 * dinamicamente, cruza com os slots ativos em `platform.config.json` →
 * `boxes_divulgacao`, edita o conteúdo de uma caixa existente, e (#3937)
 * gerencia a PRÓPRIA atribuição dos 3 slots (`readBoxSlotsState` +
 * `saveBoxSlots`) — reescrita cirúrgica de `boxes_divulgacao`, nunca do
 * arquivo inteiro (ver docstring de `replaceBoxesDivulgacaoBlock`).
 *
 * Arquivo PRÓPRIO desta fatia (mesma convenção de `studio-review.ts` #3559 /
 * `studio-apoios.ts` #3602): `server.ts` só registra rotas, toda a lógica
 * mora aqui.
 *
 * **Fonte da verdade da lista** é o diretório em si — nenhum índice
 * separado, nenhum cache. `README.md` é excluído (documentação do formato do
 * snippet, não uma caixa de verdade) e nunca é um slug válido, tanto pro
 * `GET` (lista) quanto pro `readBox`/`saveBox` (rejeitado explicitamente,
 * mesmo que alguém tente `PUT /api/boxes/README.md` direto).
 *
 * **Slug válido** = casa `/^[a-z0-9-]+\.md$/` (sem barra, sem `..`, sem
 * maiúscula — a checagem por regex já impede traversal por construção, já
 * que nenhum caractere de separador de path é aceito) E existe como arquivo
 * em `context/snippets/`. Qualquer coisa fora disso (traversal, `README.md`,
 * extensão errada, arquivo inexistente) é tratada como "não encontrada" —
 * o caller HTTP (`server.ts`) responde 404 pra QUALQUER falha de
 * `readBox`/`saveBox` que não seja o conflito de mtime (409, ver abaixo).
 *
 * **Guard de mtime (#3729) reusado, não duplicado:** `saveBox` replica
 * literalmente o mesmo padrão de `saveReviewFile` (`studio-review.ts`) —
 * `expectedModifiedAt` (mtime ISO visto pelo client no último GET) é
 * comparado contra o mtime ATUAL em disco antes de escrever; divergência
 * (outra aba/sessão do Studio salvou a mesma caixa nesse meio tempo) aborta
 * o write e retorna `{conflict: true, currentModifiedAt}` em vez de
 * sobrescrever silenciosamente — o handler HTTP responde 409 nesse caso.
 * `force: true` ignora a divergência (o editor já confirmou no dialog de
 * conflito do client). Ao contrário de `02-reviewed.md`/`03-social.md`
 * (tocados pelo PIPELINE via `Edit`/`Write` do agente, #3729), uma caixa de
 * divulgação não é escrita automaticamente por nenhum stage — o risco aqui é
 * mais estreito (2 abas do Studio na mesma caixa), mas o mecanismo de defesa
 * é idêntico e barato de reusar.
 *
 * **Criação de caixa nova está FORA de escopo desta issue** — `saveBox` só
 * escreve em cima de um arquivo já existente (a issue pede "listar e
 * editar", não "criar"). Um `PUT` num slug bem-formado mas inexistente em
 * disco é tratado como "não encontrada" (404), igual a qualquer slug
 * inválido.
 *
 * **Atribuição de slot (#3924 leitura + #3937 escrita)** — `listBoxes` cruza
 * contra `platform.config.json` → `boxes_divulgacao.slot{1,2,3}` pra exibir o
 * badge "slot N"; `saveBoxSlots` é o único ponto desta fatia que ESCREVE
 * nesse arquivo, e faz isso cirurgicamente (só a chave `boxes_divulgacao`,
 * ver `replaceBoxesDivulgacaoBlock`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  extractHeaderRemainder,
  stripHeaderBlock,
  buildContentWithHeader,
} from "../lib/shared/snippet-header.ts"; // #3979/#3981 — helpers genéricos de header compartilhados com o render (newsletter-parse.ts)

// ── slug / path ──────────────────────────────────────────────────────────

/** Só letras minúsculas, dígitos e hífen, terminando em `.md` — sem barra,
 * sem `..`, sem maiúscula. Isso por construção já impede path traversal
 * (nenhum separador de path é aceito) e já exclui `README.md` (maiúsculas
 * não casam) — a checagem explícita de `README_FILENAME` abaixo é defesa em
 * profundidade, não a única linha de defesa. */
const BOX_SLUG_RE = /^[a-z0-9-]+\.md$/;

const README_FILENAME = "README.md";

export function isValidBoxSlug(slug: string): boolean {
  return BOX_SLUG_RE.test(slug) && slug !== README_FILENAME;
}

export function snippetsDir(rootDir: string): string {
  return resolve(rootDir, "context", "snippets");
}

/** Subpasta de caixas ARQUIVADAS (#3928): `context/snippets/_arquivo/`. Mesma
 * convenção `_arquivo/` já usada no repo pra edições arquivadas. Arquivar =
 * mover o `.md` pra cá; a caixa some de `listBoxes` (que só enumera `.md` no
 * nível de `snippetsDir` — `readdirSync` não-recursivo + `entry.isFile()`
 * exclui subpastas) sem que o conteúdo seja deletado. `_arquivo` nunca é um
 * slug válido (`isValidBoxSlug` rejeita `_`), então não há colisão. */
const ARCHIVE_DIRNAME = "_arquivo";

export function archiveDir(rootDir: string): string {
  return resolve(snippetsDir(rootDir), ARCHIVE_DIRNAME);
}

/** Path absoluto do arquivo de uma caixa — só chamar depois de confirmar
 * `isValidBoxSlug(slug)` (o regex já garante que o resultado nunca escapa de
 * `snippetsDir`, mas o caller sempre valida antes de qualquer I/O). */
export function boxFilePath(rootDir: string, slug: string): string {
  return resolve(snippetsDir(rootDir), slug);
}

/** Path absoluto de uma caixa ARQUIVADA (dentro de `_arquivo/`). Mesma pré-
 * condição de `boxFilePath`: só chamar com slug já validado. */
export function archivedBoxFilePath(rootDir: string, slug: string): string {
  return resolve(archiveDir(rootDir), slug);
}

// ── título ───────────────────────────────────────────────────────────────

const TITLE_MAX_LEN = 80;

function truncateTitle(s: string): string {
  if (s.length <= TITLE_MAX_LEN) return s;
  return s.slice(0, TITLE_MAX_LEN - 1).trimEnd() + "…";
}

/** Remove blocos de comentário HTML (`<!-- ... -->`) do conteúdo, pra fins de
 * título (#3928). TODOS os snippets de divulgação abrem, por convenção, com um
 * bloco de doc `<!-- ... -->` (ver `scripts/lib/shared/snippet-loader.ts`, que
 * remove esse header em runtime) — sem este strip, `extractBoxTitle` devolvia
 * literalmente `<!--` como título. Trata comentário multi-linha, mesma-linha e
 * múltiplos (regex não-guloso). Caso degenerado de comentário NÃO-fechado (sem
 * `-->`): descarta tudo do `<!--` em diante, pra nunca vazar `<!--` como
 * título. Nunca lança. */
function stripHtmlComments(content: string): string {
  let out = content.replace(/<!--[\s\S]*?-->/g, "");
  const unclosed = out.indexOf("<!--");
  if (unclosed !== -1) out = out.slice(0, unclosed);
  return out;
}

/** Título de exibição de uma caixa: o primeiro heading Markdown (`# ...` a
 * `###### ...`, com os `#` removidos) SE a primeira linha não-vazia for um
 * heading; senão a própria primeira linha não-vazia, como está. Blocos de
 * comentário HTML no topo (convenção de todos os snippets) são ignorados
 * primeiro (#3928 — ver `stripHtmlComments`). Truncado a ~80 chars. Arquivo
 * vazio, só linhas em branco, ou só comentário vira `"(vazio)"` — nunca lança,
 * nunca retorna string vazia (uma caixa sem título visível na lista seria
 * indistinguível de um bug de render). */
export function extractBoxTitle(content: string): string {
  const lines = stripHtmlComments(content).split(/\r?\n/);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
    const text = (heading ? heading[1] : trimmed).trim();
    if (!text) continue;
    return truncateTitle(text);
  }
  return "(vazio)";
}

// ── nome interno vs. título de conteúdo (#3933) ────────────────────────────
//
// Uma caixa tem DOIS rótulos distintos:
//   1. **nome interno** — rótulo pra o EDITOR identificar a caixa na lista do
//      Studio. Mora num campo `nome:` DENTRO do header de comentário HTML —
//      `readSnippetFile` (scripts/lib/shared/snippet-loader.ts) já remove todo
//      comentário antes do conteúdo ir pra newsletter, então `nome:` NUNCA
//      vaza pro leitor.
//   2. **título de conteúdo** — o que renderiza dentro da caixa na edição
//      (derivado por `extractBoxTitle`).
// Iguais em muitos casos, diferentes em outros. `resolveBoxDisplayName` decide
// o rótulo da lista: `nome:` explícito > título derivado > slug.

/** Corpo do PRIMEIRO comentário HTML se o conteúdo começa (após espaço) com um
 * — o "header" convencional dos snippets. `null` se não houver. */
function leadingCommentInner(content: string): string | null {
  const m = /^\s*<!--([\s\S]*?)-->/.exec(content);
  return m ? m[1] : null;
}

/** Extrai o `nome:` do header de comentário (#3933), ou `null` se ausente.
 * Chave case-insensitive; valor = resto da linha, trimado. Só olha o header
 * (1º comentário) — um `nome:` solto no corpo não conta. Nunca lança. */
export function parseBoxNome(content: string): string | null {
  const inner = leadingCommentInner(content);
  if (inner === null) return null;
  const line = /^[ \t]*nome[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(inner);
  return line ? line[1].trim() : null;
}

/** Extrai o `categoria:` do header de comentário (#3981) — mesmo contrato de
 * `parseBoxNome` (#3933): case-insensitive, só o 1º comentário, `null` se
 * ausente. Valor é o rótulo exibido como kicker acima do box na newsletter
 * (ver `readBoxDivulgacaoCategoriaForSlot` em `scripts/lib/newsletter-parse.ts`,
 * que lê este MESMO campo direto do disco no momento do render). Nunca
 * lança. */
export function parseBoxCategoria(content: string): string | null {
  const inner = leadingCommentInner(content);
  if (inner === null) return null;
  const line = /^[ \t]*categoria[ \t]*:[ \t]*(.+?)[ \t]*$/im.exec(inner);
  return line ? line[1].trim() : null;
}

/** Remove a linha `nome:` do header de comentário (#3933), devolvendo o "body"
 * que o editor vê no textarea (o resto do header + o conteúdo). Se o header
 * ficar só com espaço em branco depois, remove o bloco de comentário inteiro
 * (+ as quebras de linha subsequentes) pra não deixar um `<!-- -->` vazio no
 * topo. Idempotente (rodar 2× = rodar 1×). Nunca lança. */
export function stripNomeLine(content: string): string {
  const m = /^(\s*<!--)([\s\S]*?)(-->)/.exec(content);
  if (!m) return content;
  const [full, open, inner, close] = m;
  const cleanedInner = inner.replace(/^[ \t]*nome[ \t]*:.*(?:\r?\n)?/im, "");
  if (cleanedInner === inner) return content; // não tinha nome: — no-op
  if (cleanedInner.trim() === "") {
    // Header ficou vazio: descarta o comentário e as linhas em branco após ele.
    return content.slice(full.length).replace(/^\r?\n+/, "");
  }
  return open + cleanedInner + close + content.slice(full.length);
}

/** Reconstrói o conteúdo inserindo/atualizando o `nome:` no header (#3933).
 * `body` é o conteúdo SEM a linha `nome:` (como `stripNomeLine` devolve); mas é
 * robusto a um `body` que ainda tenha `nome:` (remove antes de reinserir, nunca
 * duplica). `nome` vazio/whitespace = sem campo (remove qualquer `nome:`
 * remanescente). Nunca lança. */
export function buildBoxContentWithNome(nome: string, body: string): string {
  const clean = (nome ?? "").trim();
  const withoutNome = stripNomeLine(body ?? "");
  if (!clean) return withoutNome;
  const m = /^(\s*<!--)([\s\S]*?)(-->)/.exec(withoutNome);
  if (m) {
    const inner = m[2].replace(/^\r?\n/, "");
    return `${m[1]}\nnome: ${clean}\n${inner}${m[3]}${withoutNome.slice(m[0].length)}`;
  }
  return `<!--\nnome: ${clean}\n-->\n\n${withoutNome}`;
}

/** Rótulo de exibição de uma caixa na lista do Studio (#3933): `nome:`
 * explícito do header, senão o título derivado do conteúdo (`extractBoxTitle`),
 * senão — se o arquivo é só comentário/vazio — o próprio slug (uma caixa que
 * existe sempre mostra algo identificável). Truncado a ~80. Nunca lança. */
export function resolveBoxDisplayName(content: string, slug: string): string {
  const nome = parseBoxNome(content);
  if (nome) return truncateTitle(nome);
  const derived = extractBoxTitle(content);
  return derived === "(vazio)" ? slug : derived;
}

// ── notas vs. conteúdo — 2 painéis separados no editor (#3979) ────────────
//
// Antes (#3933): o textarea único do editor mostrava `body` = header (menos
// `nome:`) + conteúdo, tudo misturado. #3979 separa em 2 painéis: "Conteúdo"
// (o que renderiza na edição — `extractBoxConteudo`) e "Notas" (o resto do
// header de comentário, MENOS `nome:`/`categoria:` — que têm campo dedicado
// — `extractBoxNotas`). `buildBoxContent` recompõe os 2 painéis + os 2
// campos dedicados de volta no arquivo.

/** Texto do painel "Notas" (#3979): o header de comentário MENOS as linhas
 * `nome:`/`categoria:` (que têm campo dedicado próprio), trimado. `""` se
 * não há header, ou se o header só tinha `nome:`/`categoria:`. Nunca lança. */
export function extractBoxNotas(content: string): string {
  return extractHeaderRemainder(content, ["nome", "categoria"]);
}

/** Texto do painel "Conteúdo" (#3979): o arquivo com o bloco de
 * comentário-header INTEIRO removido — exatamente o que
 * `readSnippetFile`/`stitch-newsletter.ts` injeta na newsletter. Sem header
 * -> devolve o conteúdo como está. Nunca lança. */
export function extractBoxConteudo(content: string): string {
  return stripHeaderBlock(content);
}

/** Recompõe o arquivo da caixa a partir dos 4 campos que o editor de 2
 * painéis (#3979/#3981) edita: `nome`/`categoria` (campos dedicados, viram
 * linhas `key: value` no header, nessa ordem, omitidas se vazias) + `notas`
 * (texto livre, resto do header) + `conteudo` (o que renderiza). Sem
 * nome/categoria/notas -> sem comentário no topo (conteúdo puro). Byte-
 * estável em round-trip: `buildBoxContent(readBox-fields, conteudo) ===`
 * conteúdo original, desde que o arquivo siga a convenção canônica (header
 * `<!--\n...\n-->` seguido de 1 linha em branco + conteúdo — ver
 * test/studio-boxes.test.ts). Nunca lança. */
export function buildBoxContent(
  fields: { nome?: string | null; categoria?: string | null; notas?: string | null },
  conteudo: string | null | undefined,
): string {
  return buildContentWithHeader(
    [
      { key: "nome", value: fields.nome },
      { key: "categoria", value: fields.categoria },
    ],
    fields.notas,
    conteudo,
  );
}

// ── slots (platform.config.json → boxes_divulgacao, somente leitura) ────

export type BoxSlot = 1 | 2 | 3;

/** Lê `platform.config.json` → `boxes_divulgacao.slot1/2/3` (valores são
 * filenames de snippet) e inverte pra `filename -> slot`. Fail-soft total:
 * config ausente, JSON corrompido, ou chave ausente/malformada -> `{}` (todo
 * box aparece sem badge de slot) — nunca lança. Somente leitura: nenhuma
 * função deste módulo escreve neste arquivo. */
export function readBoxSlotAssignments(rootDir: string): Partial<Record<string, BoxSlot>> {
  const configPath = resolve(rootDir, "platform.config.json");
  if (!existsSync(configPath)) return {};
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
  if (!cfg || typeof cfg !== "object") return {};
  const boxes = (cfg as Record<string, unknown>).boxes_divulgacao;
  if (!boxes || typeof boxes !== "object") return {};
  const b = boxes as Record<string, unknown>;
  const out: Partial<Record<string, BoxSlot>> = {};
  for (const [key, slot] of [
    ["slot1", 1],
    ["slot2", 2],
    ["slot3", 3],
  ] as const) {
    const filename = b[key];
    if (typeof filename === "string" && filename) out[filename] = slot;
  }
  return out;
}

// ── slots: gestão pela UI (#3937 — leitura direta + ESCRITA) ─────────────

const SLOT_KEYS = ["slot1", "slot2", "slot3"] as const;
type SlotKey = (typeof SLOT_KEYS)[number];

export interface BoxSlotsState {
  slot1: string;
  slot2: string;
  slot3: string;
  /** mtime ISO de `platform.config.json` no momento da leitura, ou `null` se
   * o arquivo não existe. O client reenvia isto como `expectedModifiedAt` no
   * PUT (guard de mtime #3729, mesmo contrato de `saveBox`/`saveReviewFile`). */
  modifiedAt: string | null;
}

function readRawBoxesDivulgacao(cfg: unknown): Record<string, unknown> {
  if (!cfg || typeof cfg !== "object") return {};
  const boxes = (cfg as Record<string, unknown>).boxes_divulgacao;
  return boxes && typeof boxes === "object" ? (boxes as Record<string, unknown>) : {};
}

/** Lê `platform.config.json` → `boxes_divulgacao.slot{1,2,3}` na forma DIRETA
 * (slot -> filename, "" se vazio/ausente) — o inverso de
 * `readBoxSlotAssignments` (que inverte pra filename -> slot, só pro badge da
 * lista). Usado pela tela de gestão de slots (#3937): mostra a atribuição
 * ATUAL de cada slot + o mtime que o client reenvia como guard de conflito no
 * save. Fail-soft total: config ausente -> todos os slots "" e
 * `modifiedAt: null`; JSON corrompido -> todos os slots "" mas `modifiedAt`
 * real (o arquivo existe, só não parseia); nunca lança. */
export function readBoxSlotsState(rootDir: string): BoxSlotsState {
  const configPath = resolve(rootDir, "platform.config.json");
  if (!existsSync(configPath)) return { slot1: "", slot2: "", slot3: "", modifiedAt: null };
  const modifiedAt = statSync(configPath).mtime.toISOString();
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return { slot1: "", slot2: "", slot3: "", modifiedAt };
  }
  const b = readRawBoxesDivulgacao(cfg);
  const get = (key: SlotKey) => (typeof b[key] === "string" ? (b[key] as string) : "");
  return { slot1: get("slot1"), slot2: get("slot2"), slot3: get("slot3"), modifiedAt };
}

/** Reescreve SÓ o bloco `"boxes_divulgacao": { ... }` dentro do texto BRUTO de
 * `platform.config.json` (#3937, regra #495) — preserva todas as outras
 * chaves (`newsletter`, `socials`, `beehiiv`, etc.) e a formatação do resto
 * do arquivo byte-a-byte. NUNCA faz `JSON.parse` + `JSON.stringify` do objeto
 * inteiro por cima — mesmo que hoje o arquivo happen to reserializar
 * idêntico (checado manualmente), isso é um acidente do formato atual, não
 * uma garantia; um `note:` com caractere especial, uma futura chave com
 * formatação não-canônica, ou qualquer edição manual do editor que fuja do
 * `JSON.stringify(_, null, 2)` puro quebraria silenciosamente sob essa
 * estratégia. Regex + substituição textual é a única forma de garantir
 * "só essa chave mudou".
 *
 * Localiza o bloco via regex ancorada na indentação da linha
 * `"boxes_divulgacao": {` e no `}` de fechamento na MESMA indentação — só
 * funciona porque o valor de `boxes_divulgacao` é sempre um objeto raso
 * (slot1/2/3 -> string), sem chaves aninhadas por dentro (se algum dia
 * ganhar aninhamento, este regex precisa ser revisitado). Se a chave não
 * existir ainda no arquivo (defensivo — não deveria acontecer no repo, onde
 * ela sempre está presente), insere um bloco novo (2 espaços de indentação,
 * convenção do repo) logo antes do fechamento do objeto top-level.
 *
 * Lança se não conseguir localizar nem o bloco nem um ponto de inserção
 * seguro (arquivo não é um objeto JSON bem-formado no nível esperado) — o
 * caller (`saveBoxSlots`) decide como reportar; nunca escreve um arquivo
 * potencialmente corrompido. */
export function replaceBoxesDivulgacaoBlock(
  raw: string,
  values: { slot1: string; slot2: string; slot3: string },
): string {
  const outerIndent = "  ";
  const innerIndent = "    ";
  const block = [
    `${outerIndent}"boxes_divulgacao": {`,
    `${innerIndent}"slot1": ${JSON.stringify(values.slot1)},`,
    `${innerIndent}"slot2": ${JSON.stringify(values.slot2)},`,
    `${innerIndent}"slot3": ${JSON.stringify(values.slot3)}`,
    `${outerIndent}}`,
  ].join("\n");

  const blockRe = /([ \t]*)"boxes_divulgacao"\s*:\s*\{[\s\S]*?\n\1\}/;
  if (blockRe.test(raw)) {
    return raw.replace(blockRe, () => block);
  }

  const topCloseRe = /\n\}(\s*)$/;
  const m = topCloseRe.exec(raw);
  if (!m) {
    throw new Error(
      "platform.config.json: não foi possível localizar boxes_divulgacao nem um ponto seguro de inserção",
    );
  }
  return raw.slice(0, m.index) + `,\n${block}\n}` + m[1];
}

export interface SaveBoxSlotsInput {
  slot1: string;
  slot2: string;
  slot3: string;
}

export interface SaveBoxSlotsOptions {
  /** mtime (ISO) visto pelo client no último GET — `undefined` pula a
   * checagem de divergência inteiramente (mesma semântica de
   * `SaveBoxOptions.expectedModifiedAt`). */
  expectedModifiedAt?: string | null;
  /** `true` = ignora divergência detectada e sobrescreve mesmo assim (o
   * editor já confirmou no dialog de conflito do client). */
  force?: boolean;
}

export interface SaveBoxSlotsResult {
  ok: boolean;
  error?: string;
  modifiedAt: string | null;
  /** `true` quando o save foi recusado por divergência de mtime (#3729) — o
   * caller HTTP responde 409. */
  conflict?: boolean;
  /** mtime atual em disco no momento da tentativa — só presente quando
   * `conflict` é `true`. */
  currentModifiedAt?: string | null;
  /** `true` quando algum slot aponta pra uma caixa inexistente/arquivada
   * (guard 1) OU a mesma caixa foi atribuída a mais de um slot (guard 2) — o
   * caller HTTP responde 400 nesse caso. */
  invalid?: boolean;
  /** Estado novo dos slots (eco pós-write), só presente em sucesso. */
  slots?: BoxSlotsState;
}

function normalizeSlotValue(v: string | undefined | null): string {
  return (v ?? "").trim();
}

/** Escreve a atribuição dos 3 slots de divulgação em `platform.config.json`
 * (#3937). Guards, na ordem em que são checados:
 *   1. cada slot não-vazio precisa ser uma caixa VIVA existente em
 *      `context/snippets/` (não arquivada, não inexistente) — senão o
 *      `stitch-newsletter` quebraria a montagem da edição;
 *   2. a mesma caixa não pode ocupar 2 slots ao mesmo tempo (injetaria a
 *      mesma divulgação 2× na mesma edição);
 *   3. escrita CIRÚRGICA — só a chave `boxes_divulgacao` é reescrita
 *      (`replaceBoxesDivulgacaoBlock`), nunca o objeto inteiro (#495);
 *   4. guard de mtime (#3729) — mesmo contrato de `saveBox`/`saveReviewFile`,
 *      checado ANTES da escrita, depois dos guards 1/2 (não faz sentido
 *      recusar por conflito uma escrita que já seria inválida por outro
 *      motivo).
 * Fail-soft: nunca lança, sempre retorna resultado tipado. */
export function saveBoxSlots(
  rootDir: string,
  input: SaveBoxSlotsInput,
  opts: SaveBoxSlotsOptions = {},
): SaveBoxSlotsResult {
  const configPath = resolve(rootDir, "platform.config.json");
  if (!existsSync(configPath)) {
    return { ok: false, error: "platform.config.json não encontrado", modifiedAt: null };
  }

  const values: Record<SlotKey, string> = {
    slot1: normalizeSlotValue(input.slot1),
    slot2: normalizeSlotValue(input.slot2),
    slot3: normalizeSlotValue(input.slot3),
  };

  // Guard 1: cada slot não-vazio precisa ser uma caixa VIVA existente.
  for (const key of SLOT_KEYS) {
    const slug = values[key];
    if (slug && (!isValidBoxSlug(slug) || !existsSync(boxFilePath(rootDir, slug)))) {
      return {
        ok: false,
        error: `a caixa "${slug}" (${key}) não existe em context/snippets/ (ou está arquivada) — atribuição rejeitada`,
        modifiedAt: null,
        invalid: true,
      };
    }
  }

  // Guard 2: nenhuma caixa em 2 slots ao mesmo tempo.
  const filled = SLOT_KEYS.map((k) => values[k]).filter((v) => v !== "");
  const dupe = filled.find((v, i) => filled.indexOf(v) !== i);
  if (dupe) {
    return {
      ok: false,
      error: `a caixa "${dupe}" foi atribuída a mais de um slot — cada caixa só pode ocupar 1 slot por vez`,
      modifiedAt: null,
      invalid: true,
    };
  }

  // Guard 4: mtime — checado antes de tocar o disco, depois dos guards 1/2.
  const currentModifiedAt = statSync(configPath).mtime.toISOString();
  if (!opts.force && opts.expectedModifiedAt !== undefined) {
    if (currentModifiedAt !== opts.expectedModifiedAt) {
      return {
        ok: false,
        error: "platform.config.json foi modificado desde que você abriu a tela — recarregue ou sobrescreva explicitamente",
        modifiedAt: currentModifiedAt,
        conflict: true,
        currentModifiedAt,
      };
    }
  }

  // Guard 3: escrita cirúrgica — só boxes_divulgacao é tocado.
  let rewritten: string;
  try {
    const raw = readFileSync(configPath, "utf8");
    rewritten = replaceBoxesDivulgacaoBlock(raw, values);
  } catch (e) {
    return { ok: false, error: (e as Error).message, modifiedAt: null };
  }

  try {
    writeFileSync(configPath, rewritten, "utf8");
  } catch (e) {
    return { ok: false, error: (e as Error).message, modifiedAt: null };
  }

  const modifiedAt = statSync(configPath).mtime.toISOString();
  return { ok: true, modifiedAt, slots: readBoxSlotsState(rootDir) };
}

// ── dirty vs. git (defesa fail-soft — sem repo git no fixture de teste) ──

/**
 * `git status --porcelain -- context/snippets/<file>` via spawn síncrono —
 * saída não-vazia = arquivo modificado/untracked vs. o HEAD do repo. Fail-soft
 * total: `git` ausente do PATH, `rootDir` não sendo um repo git (comum em
 * fixture de teste), ou qualquer erro de spawn -> `false` (nunca lança, nunca
 * derruba `listBoxes`).
 */
export function checkDirtyVsGit(rootDir: string, filename: string): boolean {
  try {
    const result = spawnSync(
      "git",
      ["status", "--porcelain", "--", `context/snippets/${filename}`],
      { cwd: rootDir, encoding: "utf8" },
    );
    if (result.error || result.status !== 0) return false;
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ── listagem ─────────────────────────────────────────────────────────────

export interface BoxListEntry {
  slug: string;
  /** Rótulo de exibição na lista (#3933): `nome:` do header se houver, senão o
   * título derivado do conteúdo, senão o slug (`resolveBoxDisplayName`). */
  title: string;
  /** `nome:` interno explícito do header, ou `null` se a caixa não tem um
   * (título derivado do conteúdo). #3933. */
  nome: string | null;
  /** `categoria:` do header (#3981) — rótulo exibido como kicker acima do
   * box na newsletter quando o slug ocupa um slot ativo. `null` se ausente. */
  categoria: string | null;
  /** Título derivado do CONTEÚDO (`extractBoxTitle`) — o que renderiza na
   * edição. A UI mostra "na edição: …" quando difere de `title`. #3933. */
  contentTitle: string;
  mtimeIso: string;
  slot: BoxSlot | null;
  dirtyVsGit: boolean;
}

/** Lista dinâmica de `context/snippets/*.md`, excluindo `README.md` —
 * ordenada por slug (ordem estável e previsível pra UI/testes). Diretório
 * ausente (clone fresco sem `context/snippets/`, ou `rootDir` de teste sem
 * essa pasta) -> `[]`, nunca lança. */
export function listBoxes(rootDir: string): BoxListEntry[] {
  const dir = snippetsDir(rootDir);
  if (!existsSync(dir)) return [];
  const slots = readBoxSlotAssignments(rootDir);
  const filenames = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isValidBoxSlug(entry.name))
    .map((entry) => entry.name)
    .sort();

  return filenames.map((filename) => {
    const filePath = resolve(dir, filename);
    const content = readFileSync(filePath, "utf8");
    const mtimeIso = statSync(filePath).mtime.toISOString();
    return {
      slug: filename,
      title: resolveBoxDisplayName(content, filename),
      nome: parseBoxNome(content),
      categoria: parseBoxCategoria(content),
      contentTitle: extractBoxTitle(content),
      mtimeIso,
      slot: slots[filename] ?? null,
      dirtyVsGit: checkDirtyVsGit(rootDir, filename),
    };
  });
}

// ── leitura de 1 caixa ───────────────────────────────────────────────────

export interface BoxContentState {
  ok: boolean;
  error?: string;
  slug: string;
  /** Conteúdo BRUTO completo do arquivo (inclui o header com `nome:`). Mantido
   * pra compat; o editor do Studio usa `body`+`nome` (#3933). */
  content: string;
  /** `nome:` interno parseado do header (#3933), ou `null`. */
  nome?: string | null;
  /** `categoria:` parseado do header (#3981), ou `null`. */
  categoria?: string | null;
  /** Conteúdo SEM a linha `nome:` — o que o textarea do editor mostra (#3933).
   * O campo "Nome interno" separado edita o `nome`. Mantido pra compat; a UI
   * atual (#3979) usa `notas`/`conteudo` (painéis separados). */
  body?: string;
  /** Painel "Notas" (#3979): header MENOS `nome:`/`categoria:`, trimado. */
  notas?: string;
  /** Painel "Conteúdo" (#3979): o arquivo com o header inteiro removido — o
   * que renderiza na newsletter. */
  conteudo?: string;
  modifiedAt: string | null;
}

/** Lê o conteúdo + mtime de UMA caixa. `ok: false` (nunca lança) tanto pra
 * slug inválido (traversal, `README.md`, extensão errada) quanto pra caixa
 * inexistente em disco — o caller HTTP (`server.ts`) trata TUDO que não é
 * `ok` como 404 (ver docstring do módulo: "qualquer outra coisa -> 404"). */
export function readBox(rootDir: string, slug: string): BoxContentState {
  if (!isValidBoxSlug(slug)) {
    return { ok: false, error: `slug inválido: ${slug}`, slug, content: "", modifiedAt: null };
  }
  const filePath = boxFilePath(rootDir, slug);
  if (!existsSync(filePath)) {
    return { ok: false, error: `caixa não encontrada: ${slug}`, slug, content: "", modifiedAt: null };
  }
  const content = readFileSync(filePath, "utf8");
  const modifiedAt = statSync(filePath).mtime.toISOString();
  return {
    ok: true,
    slug,
    content,
    nome: parseBoxNome(content),
    categoria: parseBoxCategoria(content),
    body: stripNomeLine(content),
    notas: extractBoxNotas(content),
    conteudo: extractBoxConteudo(content),
    modifiedAt,
  };
}

// ── escrita de 1 caixa (guard de mtime #3729, reusado de studio-review.ts) ─

export interface SaveBoxOptions {
  /** mtime (ISO) visto pelo client no último GET — `undefined` pula a
   * checagem de divergência inteiramente (mesma semântica de
   * `SaveReviewOptions.expectedModifiedAt` em studio-review.ts). */
  expectedModifiedAt?: string | null;
  /** `true` = ignora divergência detectada e sobrescreve mesmo assim (o
   * editor já confirmou no dialog de conflito do client). */
  force?: boolean;
}

export interface SaveBoxResult {
  ok: boolean;
  error?: string;
  slug: string;
  modifiedAt: string | null;
  /** `true` quando o save foi recusado por divergência de mtime (#3729) — o
   * caller HTTP responde 409 (não 404/400) nesse caso. */
  conflict?: boolean;
  /** mtime atual em disco no momento da tentativa — só presente quando
   * `conflict` é `true`. */
  currentModifiedAt?: string | null;
  /** `true` quando o slug é inválido OU a caixa não existe em disco — o
   * caller HTTP responde 404 nesse caso (distinto de `conflict`, que é 409,
   * e de uma falha de escrita genuína, que é 400). */
  notFound?: boolean;
}

function currentMtimeOf(filePath: string): string | null {
  return existsSync(filePath) ? statSync(filePath).mtime.toISOString() : null;
}

/** Escreve o conteúdo inteiro do editor de volta no arquivo da caixa — MESMO
 * guard de mtime de `saveReviewFile` (studio-review.ts, #3729): quando
 * `opts.expectedModifiedAt` é fornecido (não `undefined`) e `opts.force` não
 * é `true`, compara contra o mtime ATUAL em disco antes de escrever;
 * divergência aborta o write e retorna `{conflict: true}` em vez de
 * sobrescrever silenciosamente. */
export function saveBox(
  rootDir: string,
  slug: string,
  content: string,
  opts: SaveBoxOptions = {},
): SaveBoxResult {
  if (!isValidBoxSlug(slug)) {
    return { ok: false, error: `slug inválido: ${slug}`, slug, modifiedAt: null, notFound: true };
  }
  const filePath = boxFilePath(rootDir, slug);
  if (!existsSync(filePath)) {
    return { ok: false, error: `caixa não encontrada: ${slug}`, slug, modifiedAt: null, notFound: true };
  }
  if (!opts.force && opts.expectedModifiedAt !== undefined) {
    const currentModifiedAt = currentMtimeOf(filePath);
    if (currentModifiedAt !== opts.expectedModifiedAt) {
      return {
        ok: false,
        error: "o arquivo foi modificado desde que você abriu o editor — recarregue ou sobrescreva explicitamente",
        slug,
        modifiedAt: currentModifiedAt,
        conflict: true,
        currentModifiedAt,
      };
    }
  }
  try {
    writeFileSync(filePath, content, "utf8");
    const modifiedAt = statSync(filePath).mtime.toISOString();
    return { ok: true, slug, modifiedAt };
  } catch (e) {
    return { ok: false, error: (e as Error).message, slug, modifiedAt: null };
  }
}

// ── criação de caixa nova (#3928) ──────────────────────────────────────────

export interface CreateBoxResult {
  ok: boolean;
  error?: string;
  slug: string;
  modifiedAt: string | null;
  /** `true` quando o slug é inválido (traversal, `README.md`, maiúscula,
   * extensão errada) — o caller HTTP responde 400. */
  invalidSlug?: boolean;
  /** `true` quando já existe uma caixa (viva) com esse slug — o caller HTTP
   * responde 409 (edite em vez de criar). */
  exists?: boolean;
}

/** Cria uma caixa NOVA em `context/snippets/{slug}` (#3928). Ao contrário de
 * `saveBox` (que rejeita slug inexistente de propósito — a #3924 não cobria
 * criação), esta função exige que o arquivo NÃO exista ainda. Slot NÃO é
 * atribuído aqui (atribuição de slot segue fora de escopo, como na #3924).
 * Fail-soft: nunca lança, sempre retorna resultado tipado. */
export function createBox(rootDir: string, slug: string, content: string): CreateBoxResult {
  if (!isValidBoxSlug(slug)) {
    return {
      ok: false,
      error: `slug inválido: ${slug} — use só minúsculas, dígitos e hífen, terminando em .md`,
      slug,
      modifiedAt: null,
      invalidSlug: true,
    };
  }
  const filePath = boxFilePath(rootDir, slug);
  // Colide tanto com uma caixa viva quanto com uma arquivada de mesmo slug:
  // criar por cima de uma arquivada perderia a referência à arquivada.
  if (existsSync(filePath) || existsSync(archivedBoxFilePath(rootDir, slug))) {
    return {
      ok: false,
      error: `já existe uma caixa com o slug "${slug}" (viva ou arquivada) — edite ou restaure em vez de criar`,
      slug,
      modifiedAt: null,
      exists: true,
    };
  }
  try {
    mkdirSync(snippetsDir(rootDir), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    const modifiedAt = statSync(filePath).mtime.toISOString();
    return { ok: true, slug, modifiedAt };
  } catch (e) {
    return { ok: false, error: (e as Error).message, slug, modifiedAt: null };
  }
}

// ── arquivar / restaurar / listar arquivadas (#3928) ───────────────────────

export interface ArchiveBoxResult {
  ok: boolean;
  error?: string;
  slug: string;
  /** `true` quando o slug é inválido OU a caixa não existe (viva) — 404. */
  notFound?: boolean;
  /** `true` quando a caixa está atribuída a um slot ativo em
   * `platform.config.json` (auto-injetada em toda newsletter) — arquivar
   * quebraria o pipeline, então é BLOQUEADO. Caller HTTP responde 409. */
  blockedBySlot?: boolean;
  slot?: BoxSlot;
}

/** Arquiva uma caixa: MOVE `context/snippets/{slug}` -> `context/snippets/
 * _arquivo/{slug}` (#3928). A caixa some de `listBoxes` (que não enumera
 * subpastas) mas o conteúdo NÃO é deletado — reversível via `unarchiveBox`.
 *
 * **Guard de slot (defense-in-depth):** uma caixa atribuída a
 * `boxes_divulgacao.slot{1,2,3}` é auto-injetada em toda newsletter pelo
 * `stitchNewsletter` (que procura o arquivo por nome em `context/snippets/`).
 * Arquivá-la quebraria o pipeline, então é bloqueado no server mesmo que o
 * client tente — não só desabilitado na UI. Fail-soft: nunca lança. */
export function archiveBox(rootDir: string, slug: string): ArchiveBoxResult {
  if (!isValidBoxSlug(slug)) {
    return { ok: false, error: `slug inválido: ${slug}`, slug, notFound: true };
  }
  const filePath = boxFilePath(rootDir, slug);
  if (!existsSync(filePath)) {
    return { ok: false, error: `caixa não encontrada: ${slug}`, slug, notFound: true };
  }
  const slot = readBoxSlotAssignments(rootDir)[slug];
  if (slot) {
    return {
      ok: false,
      error: `a caixa "${slug}" está no slot ${slot} (platform.config.json → boxes_divulgacao) e é injetada em toda newsletter — remova a atribuição de slot antes de arquivar`,
      slug,
      blockedBySlot: true,
      slot,
    };
  }
  try {
    mkdirSync(archiveDir(rootDir), { recursive: true });
    renameSync(filePath, archivedBoxFilePath(rootDir, slug));
    return { ok: true, slug };
  } catch (e) {
    return { ok: false, error: (e as Error).message, slug };
  }
}

export interface UnarchiveBoxResult {
  ok: boolean;
  error?: string;
  slug: string;
  /** `true` quando o slug é inválido OU não há caixa arquivada com esse slug. */
  notFound?: boolean;
  /** `true` quando já existe uma caixa VIVA com o mesmo slug — restaurar
   * sobrescreveria; bloqueado. Caller HTTP responde 409. */
  conflict?: boolean;
}

/** Restaura uma caixa arquivada: MOVE `context/snippets/_arquivo/{slug}` de
 * volta pra `context/snippets/{slug}` (#3928). Bloqueia se já existe uma caixa
 * viva com o mesmo slug (não sobrescreve). Fail-soft: nunca lança. */
export function unarchiveBox(rootDir: string, slug: string): UnarchiveBoxResult {
  if (!isValidBoxSlug(slug)) {
    return { ok: false, error: `slug inválido: ${slug}`, slug, notFound: true };
  }
  const archivedPath = archivedBoxFilePath(rootDir, slug);
  if (!existsSync(archivedPath)) {
    return { ok: false, error: `caixa arquivada não encontrada: ${slug}`, slug, notFound: true };
  }
  const livePath = boxFilePath(rootDir, slug);
  if (existsSync(livePath)) {
    return {
      ok: false,
      error: `já existe uma caixa viva com o slug "${slug}" — renomeie ou remova antes de restaurar`,
      slug,
      conflict: true,
    };
  }
  try {
    renameSync(archivedPath, livePath);
    return { ok: true, slug };
  } catch (e) {
    return { ok: false, error: (e as Error).message, slug };
  }
}

export interface ArchivedBoxEntry {
  slug: string;
  title: string;
  nome: string | null;
  /** `categoria:` do header (#3981) — ver `BoxListEntry.categoria`. */
  categoria: string | null;
  contentTitle: string;
  mtimeIso: string;
}

/** Lista as caixas arquivadas em `context/snippets/_arquivo/*.md` (#3928),
 * ordenada por slug. Sem badge de slot (uma arquivada nunca está num slot) e
 * sem dirty-vs-git (irrelevante pra restaurar). Pasta ausente (nada foi
 * arquivado ainda) -> `[]`, nunca lança. */
export function listArchivedBoxes(rootDir: string): ArchivedBoxEntry[] {
  const dir = archiveDir(rootDir);
  if (!existsSync(dir)) return [];
  const filenames = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isValidBoxSlug(entry.name))
    .map((entry) => entry.name)
    .sort();
  return filenames.map((filename) => {
    const filePath = resolve(dir, filename);
    const content = readFileSync(filePath, "utf8");
    return {
      slug: filename,
      title: resolveBoxDisplayName(content, filename),
      nome: parseBoxNome(content),
      categoria: parseBoxCategoria(content),
      contentTitle: extractBoxTitle(content),
      mtimeIso: statSync(filePath).mtime.toISOString(),
    };
  });
}

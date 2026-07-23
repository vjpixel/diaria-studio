/**
 * studio-boxes.ts (#3924 — Studio UI: seção "Caixas" — listar e editar os
 * snippets de caixa de divulgação)
 *
 * Camada de leitura/escrita pro painel "Caixas" do Studio: os snippets
 * reusáveis injetados na newsletter (recomendação de leitura, apoio, etc.)
 * vivem em `context/snippets/*.md` — este módulo lista esse diretório
 * dinamicamente, cruza com os slots ativos em `platform.config.json` →
 * `boxes_divulgacao` (somente LEITURA aqui — atribuição de slot é fora de
 * escopo desta issue), e edita o conteúdo de uma caixa existente.
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
 * **Atribuição de slot é somente LEITURA** — `listBoxes` só cruza contra
 * `platform.config.json` → `boxes_divulgacao.slot{1,2,3}` pra exibir o badge
 * "slot N"; nenhuma rota desta fatia escreve nesse arquivo.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

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
  title: string;
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
      title: extractBoxTitle(content),
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
  content: string;
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
  return { ok: true, slug, content, modifiedAt };
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
    return {
      slug: filename,
      title: extractBoxTitle(readFileSync(filePath, "utf8")),
      mtimeIso: statSync(filePath).mtime.toISOString(),
    };
  });
}

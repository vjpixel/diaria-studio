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

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** Path absoluto do arquivo de uma caixa — só chamar depois de confirmar
 * `isValidBoxSlug(slug)` (o regex já garante que o resultado nunca escapa de
 * `snippetsDir`, mas o caller sempre valida antes de qualquer I/O). */
export function boxFilePath(rootDir: string, slug: string): string {
  return resolve(snippetsDir(rootDir), slug);
}

// ── título ───────────────────────────────────────────────────────────────

const TITLE_MAX_LEN = 80;

function truncateTitle(s: string): string {
  if (s.length <= TITLE_MAX_LEN) return s;
  return s.slice(0, TITLE_MAX_LEN - 1).trimEnd() + "…";
}

/** Título de exibição de uma caixa: o primeiro heading Markdown (`# ...` a
 * `###### ...`, com os `#` removidos) SE a primeira linha não-vazia for um
 * heading; senão a própria primeira linha não-vazia, como está. Truncado a
 * ~80 chars. Arquivo vazio (ou só linhas em branco) vira `"(vazio)"` — nunca
 * lança, nunca retorna string vazia (uma caixa sem título visível na lista
 * seria indistinguível de um bug de render). */
export function extractBoxTitle(content: string): string {
  const lines = content.split(/\r?\n/);
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

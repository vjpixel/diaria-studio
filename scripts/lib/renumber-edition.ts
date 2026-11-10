/**
 * scripts/lib/renumber-edition.ts (#12616)
 *
 * Miolo de `scripts/renumber-edition.ts`: troca o AAMMDD de uma edição
 * (`data/editions/{AAMM}/{de}` → `.../{para}`) e monta a lista ordenada dos
 * passos remotos que precisam rodar depois (re-upload das imagens, poll, Kit,
 * página do site, semanal de frio).
 *
 * Em 10/11/2026 duas edições foram renumeradas à mão (261110 → 261111 e
 * 261109 → 261110). As armadilhas da troca manual que este módulo fixa:
 *
 * - **Borda alfanumérica.** O ID só é trocado quando não tem letra nem dígito
 *   colado de nenhum lado: `20261109_150417.mp4` (nome do bruto no Drive),
 *   `2026-11-09` e um ID dentro de hash hex ou de ID do YouTube/Drive
 *   (`a1261109f`) ficam como estão (#12662: antes só dígito contava, e o ID
 *   entre letras era trocado, corrompendo o hash em silêncio).
 * - **`img-{de}-…` não é trocado.** É o nome do objeto já publicado no R2
 *   (`upload-images-public.ts`): trocar o texto apontaria pra uma imagem que
 *   não existe. Quem gera as URLs novas é o re-upload (passo remoto 1-2).
 * - **`06-public-images.json` sai do caminho.** Vai pra
 *   `_internal/_forensic/06-public-images.{de}.json`, como na troca manual:
 *   com o cache no lugar, o re-upload reaproveitaria as URLs antigas.
 * - **`_internal/_forensic/` não é tocado.** É registro histórico.
 * - **Destino existente ⇒ recusa.** Nunca mescla duas edições.
 * - **Stores globais de `data/`** (#12691): `intentional-errors.jsonl`,
 *   `eia-used.json` e `exploration-quota.json` guardam o ID fora da pasta;
 *   só o campo/chave da edição muda, e entrada já existente do ID novo recusa.
 * - **O que fica fora** (#12691): pasta do vídeo no Drive, cache local do
 *   vídeo, outras sessões/máquinas e histórico — `leftOutItems`, impresso
 *   pelo CLI.
 *
 * - **Vídeo com destino existente** (#12713): origem só com o vídeo vira
 *   mescla só do vídeo (`planVideoMerge`/`renumberVideoMerge`), e
 *   `applyVideoOutDir` troca nomes e XMLs na pasta `YouTube/{AAMMDD}` local.
 *
 * Idempotente: a pasta nova guarda `_internal/renumber-edition.json`; rodar de
 * novo com a origem já movida e esse relatório no destino retoma (pula a parte
 * local, segue nos passos remotos ainda não concluídos).
 *
 * Tudo aqui é síncrono e de sistema de arquivos local. Nada chama rede: os
 * passos remotos são só DESCRITOS (argv), e quem os executa é o CLI.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { editionDir } from "./edition-paths.ts";
import { EDITION_LOCK_TTL_MS, readEditionLock, type EditionLockRecord } from "./edition-lock.ts";

export const RENUMBER_REPORT_FILENAME = "renumber-edition.json";
const FORENSIC_DIR = join("_internal", "_forensic");
const PUBLIC_IMAGES_FILENAME = "06-public-images.json";
/** Acima disso o arquivo não é lido como texto (vídeo, áudio, dump). */
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif", ".mp4", ".mov", ".mkv", ".webm",
  ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".pdf", ".zip", ".gz", ".prproj", ".psd",
]);

/** AAMMDD com mês 01-12 e dia 01-31. */
export function isValidEditionId(id: string): boolean {
  if (!/^\d{6}$/.test(id)) return false;
  const mm = Number(id.slice(2, 4));
  const dd = Number(id.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/**
 * Regex do ID com borda alfanumérica (#12662): nem letra nem dígito colado de
 * nenhum lado. Separador (`-`, `_`, `/`, `.`, `=`, espaço, aspas) é borda.
 */
function idRegex(id: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${id}(?![\\p{L}\\p{N}])`, "gu");
}

/**
 * Troca `from` por `to` com borda alfanumérica, preservando `img-{from}-…`
 * (objeto já publicado no R2). Devolve o texto novo e quantas trocas fez.
 */
export function replaceEditionId(text: string, from: string, to: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(idRegex(from), (match, offset: number, whole: string) => {
    if (whole.slice(Math.max(0, offset - 4), offset) === "img-") return match;
    count += 1;
    return to;
  });
  return { text: out, count };
}

/** Nome de arquivo/pasta com o ID trocado (mesma regra de borda), ou `null` se não muda. */
export function renamedSegment(name: string, from: string, to: string): string | null {
  const r = replaceEditionId(name, from, to);
  return r.count > 0 ? r.text : null;
}

export type RemoteStepId =
  | "upload-images-newsletter"
  | "upload-images-social"
  | "close-poll"
  | "kit-newsletter"
  | "site-page"
  | "kit-semanal-frio";

export interface RemoteStep {
  id: RemoteStepId;
  /** argv depois de `npx tsx` (o primeiro item é o script). */
  argv: string[];
  why: string;
}

export interface RemoteStepState {
  id: RemoteStepId;
  status: "pending" | "done" | "failed" | "skipped";
  exit_code?: number;
  at?: string;
  reason?: string;
}

export interface RenumberReport {
  from: string;
  to: string;
  from_dir: string;
  to_dir: string;
  renumbered_at: string;
  rewritten_files: Array<{ path: string; count: number }>;
  renamed_paths: Array<{ from: string; to: string }>;
  /** `img-{de}-…` deixados como estão (o re-upload gera os novos). */
  preserved_img_refs: number;
  public_images_moved_to: string | null;
  /** #12691 — stores globais de `data/` reescritos (opcional: relatório antigo não tem). */
  global_stores?: Array<{ path: string; count: number }>;
  /**
   * #12719 — stores globais ainda por reescrever. Gravado logo depois do
   * `renameSync` e esvaziado store a store: falha no meio deixa a lista no
   * relatório da pasta nova, e a retomada (`completePendingGlobalStores`)
   * termina o que faltou.
   */
  global_stores_pending?: string[];
  /**
   * #12726 — impressão digital (sha256) das entradas de `from` de cada store
   * pendente, tirada na mesma leitura que conferiu o conflito. A retomada
   * recusa se ela mudou: outra sessão escreveu sob o ID antigo (ex.
   * `/diaria-edicao {de}` de uma edição nova) e a troca levaria isso junto.
   * Ausente em relatório anterior ao #12726: só a checagem de conflito vale.
   */
  global_stores_fingerprints?: Record<string, string>;
  remote_steps: RemoteStepState[];
}

export type RenumberPlanResult =
  | { ok: true; resume: boolean; fromDir: string; toDir: string }
  | { ok: false; code: 2; reason: string };

/** Valida a troca e decide entre execução nova e retomada. Não escreve nada. */
export function planRenumber(root: string, from: string, to: string): RenumberPlanResult {
  if (!isValidEditionId(from)) return { ok: false, code: 2, reason: `--from inválido: ${JSON.stringify(from)} (esperado AAMMDD).` };
  if (!isValidEditionId(to)) return { ok: false, code: 2, reason: `--to inválido: ${JSON.stringify(to)} (esperado AAMMDD).` };
  if (from === to) return { ok: false, code: 2, reason: "--from e --to iguais: nada a renumerar." };
  const fromDir = resolve(root, editionDir(from));
  const toDir = resolve(root, editionDir(to));
  const fromExists = existsSync(fromDir);
  const toExists = existsSync(toDir);
  if (fromExists && toExists) {
    return { ok: false, code: 2, reason: `destino ${relative(root, toDir)} já existe — recusado (nunca mescla duas edições).` };
  }
  if (!fromExists && toExists) {
    const report = readRenumberReport(toDir);
    if (report && report.from === from && report.to === to) return { ok: true, resume: true, fromDir, toDir };
    return {
      ok: false,
      code: 2,
      reason: `origem ${relative(root, fromDir)} não existe e o destino ${relative(root, toDir)} já existe sem relatório de ${from} → ${to} — recusado.`,
    };
  }
  if (!fromExists) return { ok: false, code: 2, reason: `origem ${relative(root, fromDir)} não existe.` };
  return { ok: true, resume: false, fromDir, toDir };
}

export function readRenumberReport(dir: string): RenumberReport | null {
  const p = join(dir, "_internal", RENUMBER_REPORT_FILENAME);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as RenumberReport;
  } catch {
    return null;
  }
}

export function writeRenumberReport(dir: string, report: RenumberReport): void {
  const p = join(dir, "_internal", RENUMBER_REPORT_FILENAME);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(report, null, 2) + "\n");
}

function isForensic(rel: string): boolean {
  return rel === FORENSIC_DIR || rel.startsWith(FORENSIC_DIR + sep);
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Lista recursiva (arquivos e pastas), filhos antes dos pais, fora de `_forensic/`. */
function walk(dir: string, base: string = dir): Array<{ abs: string; rel: string; isDir: boolean }> {
  const out: Array<{ abs: string; rel: string; isDir: boolean }> = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = relative(base, abs);
    if (isForensic(rel)) continue;
    const isDir = statSync(abs).isDirectory();
    if (isDir) out.push(...walk(abs, base));
    out.push({ abs, rel, isDir });
  }
  return out;
}

export interface LocalScan {
  rewritten: Array<{ path: string; count: number }>;
  renames: Array<{ from: string; to: string }>;
  preserved: number;
  publicImages: boolean;
}

/** O que a parte local faria, sem escrever nada (dry-run e base do `renumberLocal`). */
export function scanLocal(fromDir: string, from: string, to: string): LocalScan {
  const rewritten: Array<{ path: string; count: number }> = [];
  const renames: Array<{ from: string; to: string }> = [];
  let preserved = 0;
  for (const e of walk(fromDir)) {
    const rel = e.rel.split(sep).join("/");
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    const next = renamedSegment(name, from, to);
    if (next) renames.push({ from: rel, to: rel.slice(0, rel.length - name.length) + next });
    if (e.isDir || rel === PUBLIC_IMAGES_FILENAME) continue;
    const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")).toLowerCase() : "";
    if (BINARY_EXTENSIONS.has(ext)) continue;
    if (statSync(e.abs).size > MAX_TEXT_BYTES) continue;
    const buf = readFileSync(e.abs);
    if (looksBinary(buf)) continue;
    const text = buf.toString("utf8");
    preserved += (text.match(new RegExp(`img-${from}(?![\\p{L}\\p{N}])`, "gu")) ?? []).length;
    const r = replaceEditionId(text, from, to);
    if (r.count > 0) rewritten.push({ path: rel, count: r.count });
  }
  return { rewritten, renames, preserved, publicImages: existsSync(join(fromDir, PUBLIC_IMAGES_FILENAME)) };
}

/** Recusa (lança) se algum nome novo do `scan` já existe em `dir`. Não escreve nada. */
function assertNoRenameCollision(dir: string, scan: LocalScan, where: string): void {
  for (const r of scan.renames) {
    if (existsSync(join(dir, r.to))) throw new Error(`${r.to} já existe ${where} — recusado (renomear sobrescreveria).`);
  }
}

/**
 * Aplica um `LocalScan` em `dir`: reescreve o conteúdo e renomeia. `walk`
 * lista filhos antes dos pais, então renomear nessa ordem mantém válidos os
 * caminhos ainda não renomeados.
 */
function applyLocalScan(dir: string, scan: LocalScan, from: string, to: string): void {
  for (const f of scan.rewritten) {
    const abs = join(dir, f.path);
    writeFileSync(abs, replaceEditionId(readFileSync(abs, "utf8"), from, to).text);
  }
  for (const r of scan.renames) renameSync(join(dir, r.from), join(dir, r.to));
}

// ---------------------------------------------------------------------------
// #12713 — vídeo fora do caminho da renumeração da edição inteira.
//
// Caso de 10/11/2026 (Nubank, 261112 → 261111): a pasta de origem só tinha o
// vídeo (`_internal/video-montagem/` + `diaria-comentada-{AAMMDD}.srt`) e a
// edição de destino já existia. `planRenumber` recusa destino existente (nunca
// mescla duas edições); aqui a mescla é permitida SÓ quando tudo na origem é
// artefato de vídeo e o destino não tem vídeo nenhum. O conteúdo passa pela
// mesma troca com borda (o `"edition"` do `blocks.json`, que o `build` confere,
// e os caminhos `YouTube/{AAMMDD}/{AAMMDD}_…` de `source.json`, `plan.json`,
// `audio-tratado.meta.json`), e os nomes com o ID são renomeados.
// ---------------------------------------------------------------------------

export const VIDEO_STATE_REL = join("_internal", "video-montagem");
export const VIDEO_MERGE_REPORT_FILENAME = "renumber-video.json";

/** `diaria-comentada-{id}…` na raiz da edição (srt, mp4, short), com borda depois do ID. */
function isRootVideoFile(name: string, id: string): boolean {
  const prefix = `diaria-comentada-${id}`;
  return name.startsWith(prefix) && !/^[\p{L}\p{N}]/u.test(name.slice(prefix.length));
}

function isUnder(rel: string, dirRel: string): boolean {
  return rel === dirRel || rel.startsWith(dirRel + sep);
}

export interface VideoMergeReport {
  from: string;
  to: string;
  from_dir: string;
  to_dir: string;
  merged_at: string;
  /** Arquivos/pastas movidos da origem pro destino (relativos à pasta da edição, nome novo). */
  moved: Array<{ from: string; to: string }>;
  rewritten_files: Array<{ path: string; count: number }>;
  renamed_paths: Array<{ from: string; to: string }>;
  /** A pasta de origem ficou vazia e foi removida. */
  removed_from_dir: boolean;
}

export type VideoMergePlan =
  | { ok: true; done: false; fromDir: string; toDir: string; rootFiles: string[]; hasState: boolean }
  | { ok: true; done: true; fromDir: string; toDir: string }
  | { ok: false; reason: string | null };

/**
 * #12713 — decide se a troca pode ser a mescla só do vídeo. `reason: null` =
 * não se aplica (a recusa do `planRenumber` é a que vale); com texto = se
 * aplicaria, mas é recusada por isto. Não escreve nada.
 */
export function planVideoMerge(root: string, from: string, to: string): VideoMergePlan {
  if (!isValidEditionId(from) || !isValidEditionId(to) || from === to) return { ok: false, reason: null };
  const fromDir = resolve(root, editionDir(from));
  const toDir = resolve(root, editionDir(to));
  const fromExists = existsSync(fromDir);
  const toExists = existsSync(toDir);
  if (!toExists) return { ok: false, reason: null };
  if (!fromExists) {
    const p = join(toDir, VIDEO_STATE_REL, VIDEO_MERGE_REPORT_FILENAME);
    const report = existsSync(p) ? (readJson(p) as Partial<VideoMergeReport> | null) : null;
    if (report && report.from === from && report.to === to) return { ok: true, done: true, fromDir, toDir };
    return { ok: false, reason: null };
  }
  const others: string[] = [];
  const rootFiles: string[] = [];
  let hasState = false;
  for (const e of walk(fromDir)) {
    if (e.isDir) continue;
    if (isUnder(e.rel, VIDEO_STATE_REL)) {
      hasState = true;
      continue;
    }
    if (!e.rel.includes(sep) && isRootVideoFile(e.rel, from)) {
      rootFiles.push(e.rel);
      continue;
    }
    others.push(e.rel.split(sep).join("/"));
  }
  // `walk` pula `_internal/_forensic/`: forense na origem também não é "só vídeo".
  if (existsSync(join(fromDir, FORENSIC_DIR))) others.push(FORENSIC_DIR.split(sep).join("/") + "/");
  const toRel = relative(root, toDir).split(sep).join("/");
  if (others.length > 0) {
    const sample = others.slice(0, 5).join(", ") + (others.length > 5 ? `, … (+${others.length - 5})` : "");
    return {
      ok: false,
      reason: `a origem não é só vídeo (${sample}) — a mescla no destino existente só vale pra origem com _internal/video-montagem/ e diaria-comentada-${from}*.`,
    };
  }
  if (!hasState && rootFiles.length === 0) return { ok: false, reason: null };
  if (hasState && existsSync(join(toDir, VIDEO_STATE_REL))) {
    return { ok: false, reason: `${toRel}/_internal/video-montagem/ já existe — recusado (nunca mescla dois vídeos).` };
  }
  for (const name of rootFiles) {
    const next = renamedSegment(name, from, to) ?? name;
    if (existsSync(join(toDir, next))) return { ok: false, reason: `${toRel}/${next} já existe — recusado (mover sobrescreveria).` };
  }
  return { ok: true, done: false, fromDir, toDir, rootFiles: rootFiles.sort(), hasState };
}

export interface VideoMergeScan {
  moved: Array<{ from: string; to: string }>;
  rewritten: Array<{ path: string; count: number }>;
  renames: Array<{ from: string; to: string }>;
}

/** O que a mescla do vídeo faria (dry-run). Caminhos relativos à pasta da edição. */
export function scanVideoMerge(plan: Extract<VideoMergePlan, { ok: true; done: false }>, from: string, to: string): VideoMergeScan {
  const stateRel = VIDEO_STATE_REL.split(sep).join("/");
  const moved: Array<{ from: string; to: string }> = [];
  const rewritten: Array<{ path: string; count: number }> = [];
  const renames: Array<{ from: string; to: string }> = [];
  if (plan.hasState) {
    const s = scanLocal(join(plan.fromDir, VIDEO_STATE_REL), from, to);
    moved.push({ from: stateRel + "/", to: stateRel + "/" });
    for (const f of s.rewritten) rewritten.push({ path: `${stateRel}/${f.path}`, count: f.count });
    for (const r of s.renames) renames.push({ from: `${stateRel}/${r.from}`, to: `${stateRel}/${r.to}` });
  }
  for (const name of plan.rootFiles) {
    moved.push({ from: name, to: renamedSegment(name, from, to) ?? name });
    const abs = join(plan.fromDir, name);
    const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")).toLowerCase() : "";
    if (BINARY_EXTENSIONS.has(ext) || statSync(abs).size > MAX_TEXT_BYTES) continue;
    const buf = readFileSync(abs);
    if (looksBinary(buf)) continue;
    const r = replaceEditionId(buf.toString("utf8"), from, to);
    if (r.count > 0) rewritten.push({ path: name, count: r.count });
  }
  return { moved, rewritten, renames };
}

/**
 * #12713 — move o vídeo da origem pra edição de destino já existente: troca o
 * ID no conteúdo e nos nomes (na origem, antes de mover), move
 * `_internal/video-montagem/` e os `diaria-comentada-{de}*` da raiz, apaga as
 * pastas da origem que ficaram vazias (`rmdir`, nunca recursivo) e grava
 * `_internal/video-montagem/renumber-video.json` no destino. Não toca no resto
 * do destino nem roda passo remoto nenhum (a edição de destino é outra).
 */
export function renumberVideoMerge(root: string, from: string, to: string, nowIso: string): VideoMergeReport {
  const plan = planVideoMerge(root, from, to);
  if (!plan.ok) throw new Error(plan.reason ?? `mescla do vídeo ${from} → ${to} não se aplica.`);
  if (plan.done) throw new Error("renumberVideoMerge chamado com a mescla já feita.");
  const scan = scanVideoMerge(plan, from, to);
  const stateFrom = join(plan.fromDir, VIDEO_STATE_REL);
  const stateScan = plan.hasState ? scanLocal(stateFrom, from, to) : null;
  if (stateScan) assertNoRenameCollision(stateFrom, stateScan, "no vídeo da origem");

  if (stateScan) applyLocalScan(stateFrom, stateScan, from, to);
  for (const name of plan.rootFiles) {
    if (!scan.rewritten.some((f) => f.path === name)) continue;
    const abs = join(plan.fromDir, name);
    writeFileSync(abs, replaceEditionId(readFileSync(abs, "utf8"), from, to).text);
  }
  if (plan.hasState) {
    mkdirSync(join(plan.toDir, "_internal"), { recursive: true });
    renameSync(stateFrom, join(plan.toDir, VIDEO_STATE_REL));
  }
  for (const m of scan.moved) {
    if (m.from.endsWith("/")) continue;
    renameSync(join(plan.fromDir, m.from), join(plan.toDir, m.to));
  }
  const removedFromDir = removeEmptyDirs(plan.fromDir);

  const report: VideoMergeReport = {
    from,
    to,
    from_dir: relative(root, plan.fromDir).split(sep).join("/"),
    to_dir: relative(root, plan.toDir).split(sep).join("/"),
    merged_at: nowIso,
    moved: scan.moved,
    rewritten_files: scan.rewritten,
    renamed_paths: scan.renames,
    removed_from_dir: removedFromDir,
  };
  // Sem vídeo de estado (só o .srt na raiz) o relatório vai pra uma pasta nova
  // do vídeo no destino: é ali que a retomada procura.
  const reportPath = join(plan.toDir, VIDEO_STATE_REL, VIDEO_MERGE_REPORT_FILENAME);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  return report;
}

/** Remove `dir` e subpastas se estiverem vazios (`rmdirSync`, nunca recursivo). Devolve se `dir` sumiu. */
function removeEmptyDirs(dir: string): boolean {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) removeEmptyDirs(abs);
  }
  if (readdirSync(dir).length > 0) return false;
  rmdirSync(dir);
  return true;
}

/**
 * #12713 — pasta de saída do vídeo (`--video-dir`, a pasta `YouTube/{AAMMDD}`
 * da edição pelo Drive montado, ex.: `G:/Meu Drive/…/YouTube/261112`): troca o
 * ID no conteúdo dos XMLs/SRT/JSON (os `pathurl` do Premiere) e nos nomes com o
 * ID (`{AAMMDD}_audio_tratado-*.wav`, `{AAMMDD}_titulo_vertical-*.png`,
 * `{AAMMDD} - previa *.mp4`), com a mesma borda: o bruto `20261112_*.mp4`
 * fica como está. A pasta em si NÃO é renomeada (fica na lista "fica fora").
 * Só o caminho local que quem chama passou; nada de API do Drive.
 */
export function scanVideoOutDir(dir: string, from: string, to: string): LocalScan {
  return scanLocal(dir, from, to);
}

export function applyVideoOutDir(dir: string, from: string, to: string): LocalScan {
  const scan = scanVideoOutDir(dir, from, to);
  assertNoRenameCollision(dir, scan, "na pasta do vídeo");
  applyLocalScan(dir, scan, from, to);
  return scan;
}

/**
 * Parte local, na pasta de ORIGEM (antes do `mv`, pra uma falha no meio deixar
 * tudo debaixo de um único caminho): tira o `06-public-images.json` do
 * caminho, reescreve o conteúdo dos arquivos de texto, renomeia arquivos e
 * pastas com o ID (filhos antes dos pais), move a pasta pra `editionDir(to)`
 * e só então reescreve os stores globais (#12719). Colisão de nome ou
 * conflito nos stores em qualquer ponto ⇒ lança ANTES de escrever (a
 * varredura confere todas primeiro).
 */
export function renumberLocal(
  root: string,
  from: string,
  to: string,
  nowIso: string,
  remoteSteps: RemoteStep[] = [],
  io: RenumberIo = DEFAULT_RENUMBER_IO,
): RenumberReport {
  const plan = planRenumber(root, from, to);
  if (!plan.ok) throw new Error(plan.reason);
  if (plan.resume) throw new Error("renumberLocal chamado numa retomada — a parte local já foi feita.");
  const { fromDir, toDir } = plan;
  const scan = scanLocal(fromDir, from, to);

  const forensicTarget = join(fromDir, FORENSIC_DIR, `06-public-images.${from}.json`);
  if (scan.publicImages && existsSync(forensicTarget)) {
    throw new Error(`${relative(root, forensicTarget)} já existe — recusado (não sobrescreve forense).`);
  }
  assertNoRenameCollision(fromDir, scan, "na edição");
  // #12691 — stores globais conferidos ANTES de qualquer escrita.
  const globalChanges = scanGlobalStores(root, from, to);
  const globalRefusal = globalStoresRefusal(globalChanges, to);
  if (globalRefusal) throw new Error(globalRefusal);

  let publicImagesMovedTo: string | null = null;
  if (scan.publicImages) {
    mkdirSync(dirname(forensicTarget), { recursive: true });
    renameSync(join(fromDir, PUBLIC_IMAGES_FILENAME), forensicTarget);
    publicImagesMovedTo = relative(fromDir, forensicTarget).split(sep).join("/");
  }
  applyLocalScan(fromDir, scan, from, to);

  // #12719 — a pasta é movida ANTES de tocar nos stores globais. Antes, os
  // stores eram gravados primeiro: um `renameSync` que falhasse (EPERM/EBUSY
  // do sync do Drive/OneDrive, arquivo aberto) deixava `edition: to` nos
  // stores com a pasta ainda em `from/`, e toda nova tentativa caía no
  // conflito do `globalStoresRefusal` (exit 2). Agora uma falha aqui deixa os
  // stores intactos, e a retomada é a execução nova de sempre (o conteúdo já
  // trocado na origem não tem mais o ID antigo: a nova varredura não refaz).
  io.mkdirp(dirname(toDir));
  io.renameDir(fromDir, toDir);

  const report: RenumberReport = {
    from,
    to,
    from_dir: relative(root, fromDir).split(sep).join("/"),
    to_dir: relative(root, toDir).split(sep).join("/"),
    renumbered_at: nowIso,
    rewritten_files: scan.rewritten,
    renamed_paths: scan.renames,
    preserved_img_refs: scan.preserved,
    public_images_moved_to: publicImagesMovedTo,
    global_stores: [],
    // Só os stores com entrada de `from`, conferidos acima (sem conflito).
    global_stores_pending: globalChanges.filter((c) => c.count > 0).map((c) => c.path),
    global_stores_fingerprints: Object.fromEntries(
      globalChanges.filter((c) => c.count > 0 && c.fingerprint !== null).map((c) => [c.path, c.fingerprint!]),
    ),
    remote_steps: remoteSteps.map((s) => ({ id: s.id, status: "pending" })),
  };
  writeRenumberReport(toDir, report);
  return completePendingGlobalStores(root, toDir, report, io);
}

/** Escrita de disco que os testes trocam pra simular falha (#12719). */
export interface RenumberIo {
  mkdirp: (dir: string) => void;
  renameDir: (from: string, to: string) => void;
  writeStore: (abs: string, text: string) => void;
}

export const DEFAULT_RENUMBER_IO: RenumberIo = {
  mkdirp: (dir) => void mkdirSync(dir, { recursive: true }),
  renameDir: (a, b) => renameSync(a, b),
  writeStore: (abs, text) => writeFileSync(abs, text, "utf8"),
};

/**
 * #12726 — recusa da retomada de um store global pendente: o store mudou
 * desde a tentativa que o deixou pendente, e reescrevê-lo agora mesclaria (ou
 * levaria pro ID novo) o que outra sessão gravou. Quem chama sai com exit 2
 * e nada é escrito naquele store; a lista de pendentes fica como estava.
 */
export class GlobalStoreRefusalError extends Error {
  override name = "GlobalStoreRefusalError";
}

/**
 * #12726 — motivo de recusa da retomada de UM store pendente, ou `null`.
 * Sem entrada de `from` (`count === 0`) não há o que recusar: a tentativa
 * anterior já gravou o store e só o relatório ficou pra trás. Com entrada de
 * `from`, recusa se já existe entrada de `to` (`conflict`) ou se as entradas
 * de `from` não são mais as da impressão digital gravada.
 */
export function pendingStoreRefusal(path: string, r: GlobalStoreRewrite, from: string, to: string, recorded: string | undefined, current: string | null): string | null {
  if (r.count === 0) return null;
  if (r.conflict > 0) {
    return `${path} já tem ${r.conflict} entrada(s) de ${to} além das de ${from} pendentes — recusado (nunca mescla duas edições); resolver à mão.`;
  }
  if (recorded !== undefined && recorded !== current) {
    return (
      `${path}: as entradas de ${from} mudaram desde a tentativa anterior (outra sessão escreveu sob ${from}, ex. uma edição nova com o ID antigo) — ` +
      `recusado, nada reescrito; conferir à mão quais são da edição renumerada.`
    );
  }
  return null;
}

/** #12726 — o que a retomada recusaria nos stores pendentes do relatório (sem escrever), ou `null`. */
export function pendingGlobalStoresRefusal(root: string, report: RenumberReport): string | null {
  const reasons: string[] = [];
  for (const path of report.global_stores_pending ?? []) {
    const store = GLOBAL_EDITION_STORES.find((s) => s.path === path);
    const abs = resolve(root, path);
    if (!store || !existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    const r = rewriteGlobalStore(store, text, report.from, report.to);
    if (r.unreadable) continue; // ilegível é transitório: a retomada lança (exit 1) e a próxima tenta.
    const why = pendingStoreRefusal(path, r, report.from, report.to, report.global_stores_fingerprints?.[path], globalStoreFromFingerprint(store, text, report.from));
    if (why) reasons.push(why);
  }
  return reasons.length > 0 ? reasons.join(" ") : null;
}

/**
 * #12719 — reescreve os stores globais listados em `global_stores_pending`,
 * um por vez, gravando o relatório depois de cada um (falha no meio não perde
 * o que já foi). Roda no fim do `renumberLocal` e na retomada.
 *
 * #12726 — na retomada o store pode ter mudado desde a tentativa anterior
 * (EBUSY do sync, e alguém roda `/diaria-edicao {de}` antes de retomar):
 * entrada de `to` já existente ou entradas de `from` diferentes da impressão
 * digital gravada ⇒ `GlobalStoreRefusalError` (exit 2), nada escrito naquele
 * store. Store sem entrada de `from` sai da lista sem escrita (a tentativa
 * anterior gravou e só o relatório ficou pra trás). Store ilegível lança, e a
 * lista fica como estava pra próxima tentativa.
 */
export function completePendingGlobalStores(
  root: string,
  toDir: string,
  reportIn: RenumberReport,
  io: RenumberIo = DEFAULT_RENUMBER_IO,
): RenumberReport {
  let report = reportIn;
  const pending = [...(report.global_stores_pending ?? [])];
  for (const path of pending) {
    const store = GLOBAL_EDITION_STORES.find((s) => s.path === path);
    const abs = resolve(root, path);
    if (store && existsSync(abs)) {
      const text = readFileSync(abs, "utf8");
      const r = rewriteGlobalStore(store, text, report.from, report.to);
      if (r.unreadable) throw new Error(`${path} ilegível (sync em trânsito?) — store global pendente; rodar de novo o mesmo comando termina.`);
      const refusal = pendingStoreRefusal(path, r, report.from, report.to, report.global_stores_fingerprints?.[path], globalStoreFromFingerprint(store, text, report.from));
      if (refusal) throw new GlobalStoreRefusalError(refusal);
      if (r.count > 0) {
        io.writeStore(abs, r.text);
        report = { ...report, global_stores: [...(report.global_stores ?? []), { path, count: r.count }] };
      }
    }
    report = { ...report, global_stores_pending: (report.global_stores_pending ?? []).filter((p) => p !== path) };
    writeRenumberReport(toDir, report);
  }
  return report;
}

function readJson(p: string): Record<string, unknown> | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Passos remotos, na ordem da troca manual de 10/11/2026. Os que dependem de
 * algo já publicado só entram se o estado local mostrar que foi publicado
 * (broadcast do Kit, página do site, semanal de frio). `dir` é a pasta NOVA,
 * relativa à raiz do repo.
 */
export function buildRemoteSteps(root: string, dir: string, to: string): RemoteStep[] {
  const abs = resolve(root, dir);
  const steps: RemoteStep[] = [
    {
      id: "upload-images-newsletter",
      argv: ["scripts/upload-images-public.ts", "--edition-dir", dir, "--mode", "newsletter"],
      why: `imagens re-publicadas como img-${to}-… (06-public-images.json novo).`,
    },
    {
      id: "upload-images-social",
      argv: ["scripts/upload-images-public.ts", "--edition-dir", dir, "--mode", "social"],
      why: "idem, imagens das redes.",
    },
    {
      id: "close-poll",
      argv: ["scripts/close-poll.ts", "--edition", to],
      why: `gabarito do É IA? gravado sob o ID ${to}.`,
    },
  ];
  if (existsSync(join(abs, "_internal", "newsletter-kit-published.json"))) {
    steps.push({
      id: "kit-newsletter",
      argv: ["scripts/publish-newsletter-kit.ts", dir],
      why: "broadcast já existente no Kit atualizado (UTMs, /vote/, imagens).",
    });
  }
  const site = readJson(join(abs, "_internal", "site-page-published.json"));
  if (site) {
    const slug = typeof site.slug === "string" && site.slug.trim() !== "" ? site.slug : null;
    steps.push({
      id: "site-page",
      argv: slug
        ? ["scripts/publish-edition-site-page.ts", "--edition-dir", dir, "--slug", slug]
        : ["scripts/publish-edition-site-page.ts", "--edition-dir", dir, "--slug-from-d1"],
      why: "página da edição republicada (datePublished, UTMs, jogar?edition=).",
    });
  }
  // #12720 — só a semanal AGENDADA acompanha o principal. Desagendada pelo
  // `--unschedule` (`created_unverified`), ela volta junto com o principal na
  // Etapa 6 da pasta nova: `schedule-newsletter-kit.ts` chama o publisher da
  // semanal, que retoma o rascunho mesmo fora de segunda (#12725). Rodar o
  // passo aqui, com o principal em rascunho, recusaria (exit 2: principal não
  // agendado).
  if (readJson(join(abs, "_internal", SEMANAL_FRIO_STATE))?.status === "scheduled") {
    steps.push({
      id: "kit-semanal-frio",
      argv: ["scripts/publish-kit-semanal-frio.ts", "--edition-dir", dir, "--push"],
      why: "semanal de frio já agendada re-sincronizada com o principal, mesmo fora de segunda (#12616).",
    });
  }
  return steps;
}

/** Estado da semanal de frio do Kit (`publish-kit-semanal-frio.ts`). */
const SEMANAL_FRIO_STATE = "kit-semanal-frio-published.json";

/** Envio ou post já agendado com o horário do dia antigo (#12662). */
export interface ScheduledSend {
  /** `kit-newsletter`, `kit-semanal-frio`, `brevo-diaria` ou `social:{plataforma}/{destaque}[/{subtipo}]`. */
  what: string;
  scheduled_at: string | null;
  /** Como reagendar, pronto pra copiar (com a pasta NOVA). */
  reschedule: string;
  /**
   * #12721 — o `--unschedule` tem caminho automático pra este item (Kit com
   * `broadcast_id`, post com `worker_queue_key`). `false` = segue agendado
   * depois do `--unschedule` (Brevo, Buffer/X), e o `--run-remote` continua
   * exigindo `--ack-scheduled`.
   */
  auto_unschedule: boolean;
}

/**
 * #12662 — o que já está AGENDADO na edição. O horário fica gravado em ISO
 * (`scheduled_at: "2026-11-09T09:00:00Z"`), que a troca de ID não toca, e
 * nenhum passo remoto o move: `publish-newsletter-kit.ts` faz o PATCH do
 * broadcast repondo `send_at = existing.scheduled_at` (o e-mail sai no dia
 * antigo) e os posts na fila do Worker (`06-social-published.json`) disparam
 * no horário e com o texto antigos. `stateDir` é onde o estado está agora
 * (origem antes do `--apply`, destino na retomada); `newDirRel` entra nos
 * comandos de reagendamento.
 */
export function detectScheduledSends(stateDir: string, newDirRel: string): ScheduledSend[] {
  const out: ScheduledSend[] = [];
  const kit = readJson(join(stateDir, "_internal", "newsletter-kit-published.json"));
  if (kit && kit.status === "scheduled") {
    const at = typeof kit.scheduled_at === "string" ? kit.scheduled_at : null;
    out.push({
      what: "kit-newsletter",
      scheduled_at: at,
      reschedule: `npx tsx scripts/schedule-newsletter-kit.ts --edition-dir ${newDirRel} --scheduled-at <novo horário ISO>`,
      auto_unschedule: typeof kit.broadcast_id === "number",
    });
  }
  // #12720 — a semanal de frio é um broadcast à parte, agendado no mesmo
  // horário do principal: sem isto ela sumia do aviso quando o principal
  // virava rascunho, e disparava sozinha no dia antigo.
  const semanal = readJson(join(stateDir, "_internal", SEMANAL_FRIO_STATE));
  if (semanal && semanal.status === "scheduled") {
    out.push({
      what: "kit-semanal-frio",
      scheduled_at: typeof semanal.scheduled_at === "string" ? semanal.scheduled_at : null,
      reschedule: `acompanha o principal: depois de reagendá-lo, npx tsx scripts/publish-kit-semanal-frio.ts --edition-dir ${newDirRel} --push`,
      auto_unschedule: typeof semanal.broadcast_id === "number",
    });
  }
  const socialPath = [join(stateDir, "_internal", "06-social-published.json"), join(stateDir, "06-social-published.json")].find(
    (p) => existsSync(p),
  );
  const social = socialPath ? readJson(socialPath) : null;
  const posts = social && Array.isArray(social.posts) ? (social.posts as Array<Record<string, unknown>>) : [];
  for (const p of posts) {
    if (p === null || typeof p !== "object" || p.status !== "scheduled") continue;
    const parts = [p.platform, p.destaque, p.subtype && p.subtype !== "main" ? p.subtype : null].filter(
      (x): x is string => typeof x === "string" && x !== "",
    );
    const key = typeof p.worker_queue_key === "string" ? p.worker_queue_key : null;
    out.push({
      what: `social:${parts.join("/")}`,
      scheduled_at: typeof p.scheduled_at === "string" ? p.scheduled_at : null,
      reschedule: key
        ? `npx tsx scripts/reschedule-worker-queue-post.ts --key ${JSON.stringify(key)} --scheduled-at <novo horário ISO> … (texto novo da pasta ${newDirRel})`
        : "reagendar na própria plataforma (sem worker_queue_key no registro)",
      auto_unschedule: key !== null,
    });
  }
  // #12688 — a campanha da Brevo diária agendada também sai no dia antigo.
  const brevo = readJson(join(stateDir, "_internal", "brevo-diaria-published.json"));
  if (brevo && brevo.status === "scheduled") {
    out.push({
      what: "brevo-diaria",
      scheduled_at: typeof brevo.scheduled_at === "string" ? brevo.scheduled_at : null,
      reschedule: "desagendar/reagendar à mão no painel da Brevo (campanha agendada não é editável pela API)",
      auto_unschedule: false,
    });
  }
  return out;
}

/** Chamadas externas do `--unschedule` (#12688), injetáveis nos testes. */
export interface UnscheduleDeps {
  /** `DELETE /queue/:key` no Worker; `alreadyGone` = 404 (post pode já ter disparado). */
  deleteWorkerEntry: (key: string) => Promise<{ deleted: boolean; alreadyGone: boolean }>;
  /** `send_at: null` no broadcast + releitura; `ok` só com o desagendamento confirmado. */
  unscheduleKit: (broadcastId: number) => Promise<{ ok: boolean; message: string }>;
  nowIso: () => string;
}

export interface UnscheduleOutcome {
  /** Mesmo rótulo de `ScheduledSend.what`. */
  what: string;
  /** `manual` = sem caminho automático (Buffer/X, Brevo, post sem key). */
  result: "unscheduled" | "already_gone" | "failed" | "manual";
  detail: string;
}

/**
 * #12688 — desagenda o que `detectScheduledSends` acusa, antes da troca de ID:
 * apaga da fila do Worker os posts `scheduled` com `worker_queue_key` (estado
 * vira `deleted`, e a Etapa 5 da pasta nova reenfileira com o texto e o dia
 * novos) e tira o `send_at` do broadcast do Kit (estado volta pra `draft`,
 * sem `scheduled_at`, e a Etapa 6 reagenda). A semanal de frio agendada sai
 * primeiro, pelo mesmo `unscheduleKit` (estado `created_unverified`, #12720),
 * e a Etapa 6 da pasta nova a retoma junto com o principal, mesmo numa edição
 * que deixou de ser de segunda (#12725). Se o principal falhar depois de a
 * semanal ter saído da agenda, o `failed` do principal diz isso e como
 * reagendá-la (#12727). Substitui os dois scripts
 * avulsos da troca 261109 → 261110.
 *
 * Só grava o estado local do que foi confirmado. 404 no Worker
 * (`already_gone`) não mexe no registro: o post pode ter disparado, e quem
 * chama confere antes de seguir. Falha de um item não interrompe os outros.
 * Buffer (X), Brevo e post sem key saem `manual`, com o mesmo texto do aviso.
 */
export async function unscheduleSends(stateDir: string, deps: UnscheduleDeps): Promise<UnscheduleOutcome[]> {
  const out: UnscheduleOutcome[] = [];

  // #12720 — a semanal de frio ANTES do principal: com o principal em
  // rascunho e a semanal agendada, ela dispara sozinha no horário antigo, com
  // os links do ID antigo, pra base fria. Se ela não sair da agenda, o
  // principal também fica (o par segue coerente e os dois voltam `failed`).
  let semanalBlocked = false;
  const semanalPath = join(stateDir, "_internal", SEMANAL_FRIO_STATE);
  const semanal = readJson(semanalPath);
  // #12727 — semanal fora da agenda (desagendada nesta execução ou numa
  // anterior que parou no principal). Se o principal falha, ele segue agendado
  // no dia antigo e a semanal não: reexecutar o `--unschedule` não a vê mais
  // (já não está `scheduled`), e uma troca abandonada deixaria a base fria sem
  // envio. O `failed` do principal diz isso, com o comando que a reagenda.
  let semanalUnscheduledId: number | null =
    semanal && semanal.status === "created_unverified" && typeof semanal.broadcast_id === "number" ? semanal.broadcast_id : null;
  const semanalLeftNote = (): string =>
    semanalUnscheduledId === null
      ? ""
      : ` ATENÇÃO: a semanal de frio (broadcast ${semanalUnscheduledId}) está FORA da agenda (created_unverified) e o principal segue agendado ` +
        "no horário antigo. Repetir o mesmo comando termina a troca (a Etapa 6 da pasta nova reagenda os dois); se a troca for abandonada, " +
        `reagendar a semanal junto do principal: npx tsx scripts/publish-kit-semanal-frio.ts --edition-dir ${stateDir} --push`;
  if (semanal && semanal.status === "scheduled") {
    const id = typeof semanal.broadcast_id === "number" ? semanal.broadcast_id : null;
    let failure: string | null = null;
    if (id === null) {
      failure = "registro sem broadcast_id — desagendar à mão no Kit.";
    } else {
      try {
        const r = await deps.unscheduleKit(id);
        if (r.ok) {
          // Mesmo estado que `followMainSchedule` grava ao desagendar junto
          // com o principal: o próximo agendamento do principal a retoma.
          const next = { ...semanal, status: "created_unverified", reason: "principal desagendado (renumber-edition, #12720)" };
          writeFileSync(semanalPath, JSON.stringify(next, null, 2) + "\n", "utf8");
          semanalUnscheduledId = id;
          out.push({ what: "kit-semanal-frio", result: "unscheduled", detail: `broadcast ${id}: ${r.message}` });
        } else {
          failure = `broadcast ${id}: ${r.message}`;
        }
      } catch (e) {
        failure = `broadcast ${id}: ${(e as Error).message}`;
      }
    }
    if (failure !== null) {
      semanalBlocked = true;
      out.push({ what: "kit-semanal-frio", result: "failed", detail: failure });
    }
  }

  const kitPath = join(stateDir, "_internal", "newsletter-kit-published.json");
  const kit = readJson(kitPath);
  if (kit && kit.status === "scheduled") {
    const id = typeof kit.broadcast_id === "number" ? kit.broadcast_id : null;
    if (semanalBlocked) {
      out.push({
        what: "kit-newsletter",
        result: "failed",
        detail: "não desagendado: a semanal de frio segue agendada e sairia sozinha — desagendá-la primeiro.",
      });
    } else if (id === null) {
      out.push({ what: "kit-newsletter", result: "failed", detail: `registro sem broadcast_id — desagendar à mão no Kit.${semanalLeftNote()}` });
    } else {
      try {
        const r = await deps.unscheduleKit(id);
        if (r.ok) {
          const { scheduled_at: _dropped, ...rest } = kit;
          writeFileSync(kitPath, JSON.stringify({ ...rest, status: "draft" }, null, 2) + "\n", "utf8");
          out.push({ what: "kit-newsletter", result: "unscheduled", detail: `broadcast ${id}: ${r.message}` });
        } else {
          out.push({ what: "kit-newsletter", result: "failed", detail: `broadcast ${id}: ${r.message}${semanalLeftNote()}` });
        }
      } catch (e) {
        out.push({ what: "kit-newsletter", result: "failed", detail: `broadcast ${id}: ${(e as Error).message}${semanalLeftNote()}` });
      }
    }
  }

  const socialPath = [join(stateDir, "_internal", "06-social-published.json"), join(stateDir, "06-social-published.json")].find(
    (p) => existsSync(p),
  );
  const social = socialPath ? readJson(socialPath) : null;
  const posts = social && Array.isArray(social.posts) ? (social.posts as Array<Record<string, unknown>>) : [];
  for (const [i, p] of posts.entries()) {
    if (p === null || typeof p !== "object" || p.status !== "scheduled") continue;
    const parts = [p.platform, p.destaque, p.subtype && p.subtype !== "main" ? p.subtype : null].filter(
      (x): x is string => typeof x === "string" && x !== "",
    );
    const what = `social:${parts.join("/")}`;
    const key = typeof p.worker_queue_key === "string" ? p.worker_queue_key : null;
    if (!key) {
      out.push({ what, result: "manual", detail: "sem worker_queue_key (Buffer/X ou API direta): desagendar na própria plataforma." });
      continue;
    }
    try {
      const r = await deps.deleteWorkerEntry(key);
      if (r.deleted) {
        posts[i] = { ...p, status: "deleted", deleted_at: deps.nowIso(), deleted_reason: "renumber_edition" };
        // Grava a cada item: uma falha adiante não perde o que já saiu da fila.
        writeFileSync(socialPath!, JSON.stringify({ ...social, posts }, null, 2) + "\n", "utf8");
        out.push({ what, result: "unscheduled", detail: `${key} removida da fila do Worker.` });
      } else {
        out.push({ what, result: "already_gone", detail: `${key} não está mais na fila (404): o post pode já ter disparado — conferir antes de seguir.` });
      }
    } catch (e) {
      out.push({ what, result: "failed", detail: `${key}: ${(e as Error).message}` });
    }
  }

  const brevo = readJson(join(stateDir, "_internal", "brevo-diaria-published.json"));
  if (brevo && brevo.status === "scheduled") {
    out.push({ what: "brevo-diaria", result: "manual", detail: "campanha agendada na Brevo: desagendar à mão no painel." });
  }
  return out;
}

/**
 * #12691 — stores GLOBAIS em `data/` indexados pelo ID da edição, fora da
 * pasta dela. A troca manual de 10/11/2026 (261110 → 261111) teve de editar
 * `data/intentional-errors.jsonl` à mão; os outros dois têm a mesma forma.
 * Cada um muda só o campo/chave do ID, nunca o texto livre de outras edições.
 * Logs append-only (`run-log.jsonl`, `type-hint-divergence.jsonl`, `sources/`)
 * ficam de fora de propósito: são registro do que aconteceu sob o ID antigo.
 */
export type GlobalEditionStore =
  | { path: string; kind: "jsonl-field"; field: string }
  | { path: string; kind: "array-field"; field: string }
  | { path: string; kind: "object-key"; container: string };

export const GLOBAL_EDITION_STORES: readonly GlobalEditionStore[] = [
  { path: "data/intentional-errors.jsonl", kind: "jsonl-field", field: "edition" },
  { path: "data/eia-used.json", kind: "array-field", field: "edition_date" },
  { path: "data/exploration-quota.json", kind: "object-key", container: "editions" },
];

export interface GlobalStoreRewrite {
  text: string;
  /** Entradas de `from` trocadas pra `to`. */
  count: number;
  /** Entradas que JÁ são de `to` (trocar mesclaria duas edições). */
  conflict: number;
  /** JSON ilegível: nada é reescrito e quem chama recusa. */
  unreadable: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Pura: reescreve o conteúdo de um store global trocando o ID da edição. */
export function rewriteGlobalStore(store: GlobalEditionStore, text: string, from: string, to: string): GlobalStoreRewrite {
  const none = (unreadable: boolean): GlobalStoreRewrite => ({ text, count: 0, conflict: 0, unreadable });
  if (store.kind === "jsonl-field") {
    let count = 0;
    let conflict = 0;
    // Linha que não é JSON (append pela metade) fica como está, byte a byte.
    const lines = text.split("\n").map((line) => {
      if (line.trim() === "") return line;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        return line;
      }
      if (!isPlainObject(obj)) return line;
      if (obj[store.field] === to) conflict += 1;
      if (obj[store.field] !== from) return line;
      count += 1;
      return JSON.stringify({ ...obj, [store.field]: to });
    });
    return { text: count > 0 ? lines.join("\n") : text, count, conflict, unreadable: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return none(true);
  }
  if (store.kind === "array-field") {
    if (!Array.isArray(parsed)) return none(true);
    let count = 0;
    let conflict = 0;
    const next = parsed.map((e) => {
      if (!isPlainObject(e)) return e;
      if (e[store.field] === to) conflict += 1;
      if (e[store.field] !== from) return e;
      count += 1;
      return { ...e, [store.field]: to };
    });
    return { text: count > 0 ? JSON.stringify(next, null, 2) + "\n" : text, count, conflict, unreadable: false };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed[store.container])) return none(true);
  const inner = parsed[store.container] as Record<string, unknown>;
  const conflict = Object.hasOwn(inner, to) ? 1 : 0;
  if (!Object.hasOwn(inner, from)) return { text, count: 0, conflict, unreadable: false };
  // Mesma serialização do dono do arquivo (`exploration-quota.ts`): chaves em ordem.
  const renamed: Record<string, unknown> = {};
  for (const k of Object.keys(inner)) if (k !== from) renamed[k] = inner[k];
  renamed[to] = inner[from];
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(renamed).sort()) ordered[k] = renamed[k];
  return {
    text: JSON.stringify({ ...parsed, [store.container]: ordered }, null, 2) + "\n",
    count: 1,
    conflict,
    unreadable: false,
  };
}

/**
 * #12726 — pura: sha256 das entradas de `from` no store (linhas JSONL com o
 * campo, elementos do array, valor da chave), na ordem em que aparecem.
 * `null` sem entrada de `from` ou com store ilegível.
 */
export function globalStoreFromFingerprint(store: GlobalEditionStore, text: string, from: string): string | null {
  const parts: string[] = [];
  if (store.kind === "jsonl-field") {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const obj: unknown = JSON.parse(line);
        if (isPlainObject(obj) && obj[store.field] === from) parts.push(line.trim());
      } catch {
        // linha pela metade: fora da impressão, como fica fora da troca.
      }
    }
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (store.kind === "array-field") {
      if (!Array.isArray(parsed)) return null;
      for (const e of parsed) if (isPlainObject(e) && e[store.field] === from) parts.push(JSON.stringify(e));
    } else {
      if (!isPlainObject(parsed) || !isPlainObject(parsed[store.container])) return null;
      const inner = parsed[store.container] as Record<string, unknown>;
      if (Object.hasOwn(inner, from)) parts.push(JSON.stringify(inner[from]));
    }
  }
  if (parts.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

export interface GlobalStoreChange {
  path: string;
  count: number;
  conflict: number;
  unreadable: boolean;
  /** #12726 — `globalStoreFromFingerprint` da mesma leitura. */
  fingerprint: string | null;
}

/** O que cada store global existente mudaria. Só lista os que têm algo a dizer. */
export function scanGlobalStores(root: string, from: string, to: string): GlobalStoreChange[] {
  const out: GlobalStoreChange[] = [];
  for (const store of GLOBAL_EDITION_STORES) {
    const abs = resolve(root, store.path);
    if (!existsSync(abs)) continue;
    const text = readFileSync(abs, "utf8");
    const r = rewriteGlobalStore(store, text, from, to);
    if (r.count > 0 || r.conflict > 0 || r.unreadable) {
      out.push({ path: store.path, count: r.count, conflict: r.conflict, unreadable: r.unreadable, fingerprint: globalStoreFromFingerprint(store, text, from) });
    }
  }
  return out;
}

/** Motivo de recusa da parte global (conflito ou store ilegível), ou `null`. */
export function globalStoresRefusal(changes: GlobalStoreChange[], to: string): string | null {
  const bad = changes.filter((c) => c.conflict > 0 || c.unreadable);
  if (bad.length === 0) return null;
  return bad
    .map((c) =>
      c.unreadable
        ? `${c.path} ilegível (sync em trânsito?) — recusado, nada escrito.`
        : `${c.path} já tem ${c.conflict} entrada(s) de ${to} — recusado (nunca mescla duas edições); resolver à mão.`,
    )
    .join(" ");
}

/**
 * #12691 — o que a renumeração NÃO faz, impresso no dry-run e no fim do
 * `--apply` pra a troca não depender de memória. Tudo aqui exige rede, outra
 * máquina ou decisão humana.
 */
export function leftOutItems(from: string, to: string, opts: { videoDirDone?: boolean } = {}): string[] {
  const inside = opts.videoDirDone
    ? "os arquivos dentro dela já foram renomeados e os XMLs reescritos (--video-dir)"
    : `os arquivos dentro dela (${from}_audio_tratado-*.wav, ${from}_titulo_vertical*.png, "${from} - previa *.mp4") e os pathurl dos XMLs seguem com ${from}: repetir com --video-dir {pasta montada} ou trocar à mão`;
  return [
    `Drive: renomear a pasta ${from}/ da pasta YouTube (G:/Meu Drive/…/YouTube/${from}/) pra ${to}/ — os caminhos em _internal/video-montagem/ já apontam pro nome novo, e a montagem e o /diaria-publica procuram a pasta pelo AAMMDD; ${inside}.`,
    `Vídeo fora do disco: o título do Doc do roteiro no Drive e o projeto do Premiere (.prproj, aponta pro caminho antigo) seguem com ${from} — renomear o Doc e reimportar o XML (ou religar a mídia).`,
    `Cache local do vídeo: ~/.cache/diaria-video-montagem/${from}/ (ou DIARIA_VIDEO_CACHE_DIR) e {tmp}/diaria-video-montagem/${from}/ ficam com o nome antigo — renomear pra ${to}/ ou deixar a próxima montagem baixar de novo.`,
    `Outras máquinas e sessões: a pasta nova chega pelo sync de data/; sessão aberta (aqui ou em outra máquina) que trabalhava em ${from} precisa recomeçar com ${to}.`,
    `Histórico não reescrito: data/run-log.jsonl, data/type-hint-divergence.jsonl, data/sources/ e _internal/_forensic/ seguem com ${from} (registro do que aconteceu).`,
    `Já publicado (não agendado): post, e-mail ou vídeo que saiu com ${from} no link fica como saiu.`,
  ];
}

/** Trava viva da edição (#10309): heartbeat dentro do TTL e sem tombstone. */
export function liveEditionLock(dir: string, nowMs: number): EditionLockRecord | null {
  const lock = readEditionLock(dir);
  if (!lock) return null;
  if (lock.released_at !== undefined || lock.completed_stage !== undefined || lock.interrupted_stage !== undefined) return null;
  const hb = Date.parse(lock.heartbeat_at);
  if (!Number.isFinite(hb) || nowMs - hb > EDITION_LOCK_TTL_MS) return null;
  return lock;
}

/** Alinha o estado dos passos do relatório com a lista atual (passo novo entra `pending`). */
export function mergeStepStates(steps: RemoteStep[], prior: RemoteStepState[]): RemoteStepState[] {
  const byId = new Map(prior.map((s) => [s.id, s]));
  return steps.map((s) => byId.get(s.id) ?? { id: s.id, status: "pending" });
}

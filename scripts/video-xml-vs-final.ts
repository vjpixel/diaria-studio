/**
 * scripts/video-xml-vs-final.ts (#13196, #13197)
 *
 * Compara o XML que o `/diaria-video-montagem` gera (o `plan.json` da
 * edição, a verdade dos clipes) com o vídeo que o editor exporta do Premiere
 * para `{AAMMDD}/Final/`, e mede o que ele mudou: clipes removidos, pontas
 * aparadas ou estendidas, pausas internas tiradas, tomadas trocadas, ordem,
 * duração, loudness e as palavras que ele recuperou (o sinal da #13194).
 * Lógica pura em `scripts/lib/diaria/video-xml-vs-final.ts`; aqui o I/O.
 *
 * Método (o da #11670, agora no repo): áudio do bruto (o `audio.wav` 16 kHz
 * do cache da montagem) e do final a 16 kHz mono; envelope de energia; o
 * alinhamento monótono por correlação do `--from-audio` (#11504,
 * `alignEnvelopes`), com o final no lugar do "áudio" e o bruto no do "vídeo",
 * mais uma busca global nos vãos sem par (`alignWithReorder`: trecho
 * reordenado pelo editor).
 * Sem o `audio.wav` do cache, o áudio do bruto sai dos arquivos dele, achados
 * nesta ordem: caminho do `plan.json`, arquivo do HD do 300
 * (`VIDEO_ARCHIVE_ROOT`, default `/mnt/hd-sata/arquivo-video`, #12548), cache
 * da montagem (`{cache}/{AAMMDD}/bruto`) e a pasta `{AAMMDD}/` do Drive. Bruto
 * em vários arquivos é concatenado na linha do tempo do plano (`frames/fps`).
 * Cada trecho do final ganha o tempo no bruto; o cruzamento com os clipes do
 * plano dá as diferenças. Somente leitura sobre Drive e edição: grava só em
 * `data/video-xml-vs-final/` e no cache local.
 *
 * Uso:
 *   compare AAMMDD [--final PATH] [--seq KEY] [--dry-run]
 *       uma edição: todos os finais achados em Final/ (ou o --final dado).
 *   run [--today AAMMDD] [--days 14] [--open-issues] [--dry-run] [--no-register]
 *       a tarefa recorrente (Diaria-Video-Xml-Vs-Final-Daily): as edições da
 *       janela com plan.json e alguma sequência ainda sem comparação; depois
 *       agregado, relatório (Relatórios do Studio) e padrões.
 *   backfill [--from AAMMDD] [--to AAMMDD] [--open-issues] [--dry-run]
 *       #13197: importa os resultados da #11670 (261028–261103, sem refazer) e
 *       compara as edições de --from (default 261104) até --to (default hoje).
 *   aggregate [--open-issues] [--dry-run]
 *       só refaz agregado, relatório e padrões a partir dos registros.
 *
 * Opções comuns: --drive-root DIR (Drive for desktop; default
 * DIARIA_VIDEO_DRIVE_ROOT ou I:/Meu Drive/diaria-studio-video; ausente = API do
 * Drive), --cache-dir DIR, --work-dir DIR, --folder-id ID, --fetch-bruto (modo API:
 * baixa do Drive para `{cache}/bruto/` os arquivos do bruto em vários arquivos que
 * faltam no cache, para concatenar o áudio quando o `audio.wav` da montagem já foi
 * podado; sem a flag, só usa o que já está no cache, #12089/#13225).
 *
 * `--open-issues` abre (ou comenta) issue de ajuste do gerador quando um
 * padrão passa dos limiares de `PATTERN_RULES`; sem a flag só lista. Nunca
 * publica nada nem altera o Drive.
 *
 * Saídas (`data/video-xml-vs-final/`): `{AAMMDD}.json` (registro da edição),
 * `aggregate.json`, `report.md` e `state.json` (o que já foi comparado e as
 * issues por padrão).
 *
 * Exit: 0 ok (inclusive sem nada a comparar); 1 erro de execução, ou nenhuma
 * edição da rodada pôde ser consultada no Drive (`drive-indisponivel`); 2 uso.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { energyEnvelope, parseWavPcm16 } from "./lib/diaria/video-cut-refine.ts";
import { parseLoudnormJson, sequenceKey, type SequencePlan, type Word } from "./lib/diaria/video-montage.ts";
import {
  DEFAULT_DRIVE_ROOT,
  driveCacheDir,
  ensureCachedFile,
  findEditionFolder,
  FOLDER_MIME,
  listChildren,
  workDirDefault,
  youtubeFolderIdFrom,
  type DriveEntry,
  type MontageDriveDeps,
} from "./lib/diaria/video-montage-drive.ts";
import { isEditedFolderName, isFinalFolderName, videoVersionOf } from "./lib/diaria/drive-video-source.ts";
import {
  aggregateRecords,
  alignWithReorder,
  compareSequence,
  detectPatterns,
  driveUnavailableReason,
  driveUnreachable,
  editionsToCompare,
  EMPTY_STATE,
  finalSpansFromRuns,
  mergeEditionRecord,
  patternCommentBody,
  patternExamples,
  patternIssueBody,
  PATTERN_MARKER,
  pickFinalsPerSequence,
  renderReport,
  XML_FINAL_SCHEMA,
  brutoParts,
  brutoSearchDirs,
  brutoTimelineMatches,
  type BrutoPart,
  type DetectedPattern,
  type EditionRecord,
  type RecurringState,
  type SequenceRecord,
} from "./lib/diaria/video-xml-vs-final.ts";
import { BASELINE_11670 } from "./lib/diaria/video-xml-vs-final-baseline.ts";
import { editionsOfFolder } from "./lib/diaria/video-bruto-archive.ts";
import { concatListText, MULTI_AUDIO_FILE } from "./video-montagem.ts";

/** Montagem do HD do 300 onde o `archive-video-brutos.ts` guarda os brutos (`DEFAULT_MOUNT`, #12548). */
const DEFAULT_ARCHIVE_MOUNT = "/mnt/hd-sata";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = join("data", "video-xml-vs-final");
/** 1ª edição fora da #11670: o backfill da #13197 começa aqui. */
export const BACKFILL_FROM = "261104";
/** Alinhamento mais fino que o default do `--from-audio`: a diferença de ponta é de décimos de segundo. */
export const ALIGN_OPTS = { windowS: 10, windowHopS: 5, stepS: 0.05, subWinS: 1 } as const;
/** Abaixo disto de cobertura o par não é o mesmo som (ou o final foi editado demais): pula. */
export const MIN_COVERAGE = 0.5;

const log = (line: string) => console.error(line);

function out(rel: string): string {
  return join(ROOT, OUT_DIR, rel);
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : null;
  } catch (e) {
    throw new Error(`JSON ilegível em ${path}: ${(e as Error).message}`);
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function sh(cmd: string, args: string[]): { stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${cmd} saiu ${r.status}: ${(r.stderr || "").slice(-500)}`);
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function todayBrt(now = new Date()): string {
  const d = new Date(now.getTime() - 3 * 3_600_000);
  return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export interface PlanFileLite {
  plans: SequencePlan[];
  /** `files` = bruto em vários arquivos (#12559); `path` é então só o do 1º. */
  source: { fps?: number; audioOnly?: boolean; path?: string; files?: Array<{ id?: string; path?: string; frames?: number; offsetFrames?: number }> };
  xmlVersions?: Record<string, { id: string }>;
  stale?: Record<string, unknown>;
}

function planPath(edition: string): string {
  return join(ROOT, editionDir(edition), "_internal", "video-montagem", "plan.json");
}

/** Edições com plan.json no disco, com as sequências de cada uma. */
export function editionsWithPlan(root = ROOT): Array<{ edition: string; sequences: string[] }> {
  const base = join(root, "data", "editions");
  if (!existsSync(base)) return [];
  const outList: Array<{ edition: string; sequences: string[] }> = [];
  for (const aamm of readdirSync(base)) {
    if (!/^\d{4}$/.test(aamm)) continue;
    for (const e of readdirSync(join(base, aamm))) {
      if (!/^\d{6}$/.test(e)) continue;
      const p = join(base, aamm, e, "_internal", "video-montagem", "plan.json");
      if (!existsSync(p)) continue;
      try {
        const pf = JSON.parse(readFileSync(p, "utf8")) as PlanFileLite;
        outList.push({ edition: e, sequences: pf.plans.map((pl) => sequenceKey(pl.spec)).filter((k) => !pf.stale?.[k]) });
      } catch {
        log(`[aviso] plan.json ilegível em ${p}: edição fora da rodada`);
      }
    }
  }
  return outList.sort((a, b) => a.edition.localeCompare(b.edition));
}

export interface Finder {
  mode: "local" | "api";
  /** Os candidatos a final da edição: pastas Final/ (e Editado/ se Final/ não tiver mp4). */
  list(edition: string): Promise<Array<{ name: string; modifiedTime?: string | null; fetch: () => Promise<string> }>>;
  workDir(edition: string): string;
  /**
   * Um arquivo do bruto pelo nome, na pasta `{AAMMDD}/` do Drive. Local (Drive for desktop): lido direto.
   * API: baixado para `{cache}/{AAMMDD}/bruto/` (o mesmo da montagem) só com `--fetch-bruto` (#12089,
   * #13225); sem a flag, `null` (o cache já é procurado antes, por `locateBrutoPart`).
   * `null` = não está lá; erro de credencial/rede sobe.
   */
  brutoFile(edition: string, name: string): Promise<string | null>;
}

/** Arquivo de `dir` com este nome, sem diferenciar maiúsculas (o Drive e o Windows não diferenciam). */
function fileInDir(dir: string, name: string): string | null {
  if (!existsSync(dir)) return null;
  const want = name.toLowerCase();
  const hit = readdirSync(dir).find((n) => n.toLowerCase() === want);
  return hit && statSync(join(dir, hit)).isFile() ? join(dir, hit) : null;
}

function localFinder(driveRoot: string, workDirFlag: string | undefined): Finder {
  return {
    mode: "local",
    async list(edition) {
      const dir = join(driveRoot, edition);
      if (!existsSync(dir)) return [];
      const subs = readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory());
      const pick = (pred: (n: string) => boolean) =>
        subs.filter(pred).flatMap((s) =>
          readdirSync(join(dir, s))
            .filter((n) => /\.mp4$/i.test(n))
            .map((n) => {
              const p = join(dir, s, n);
              return { name: n, modifiedTime: statSync(p).mtime.toISOString(), fetch: async () => p };
            }),
        );
      const finals = pick(isFinalFolderName);
      return finals.length ? finals : pick(isEditedFolderName);
    },
    workDir: (edition) => resolve(workDirFlag ?? workDirDefault("local", "", tmpdir(), edition)),
    brutoFile: async (edition, name) => fileInDir(join(driveRoot, edition), name),
  };
}

async function apiFinder(cacheFlag: string | undefined, workDirFlag: string | undefined, folderIdFlag: string | undefined, fetchBruto = false): Promise<Finder> {
  const { gFetchRetry } = await import("./lib/drive-helpers.ts");
  const { gFetch } = await import("./google-auth.ts");
  const deps: MontageDriveDeps = { driveFetch: (url, init) => gFetchRetry(url, init ?? {}), uploadFetch: (url, init) => gFetch(url, init ?? {}) };
  const rootId = () => {
    if (folderIdFlag?.trim()) return folderIdFlag.trim();
    const id = youtubeFolderIdFrom(JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")));
    if (!id) throw new Error("modo API do Drive sem pasta de vídeo: publishing.youtube.drive_folder_id no platform.config.json ou --folder-id");
    return id;
  };
  const cacheOf = (edition: string) => driveCacheDir(edition, cacheFlag, process.env.DIARIA_VIDEO_CACHE_DIR, homedir());
  return {
    mode: "api",
    async list(edition) {
      // Pasta ausente = sem final (ainda); qualquer outra falha (credencial, rede, pasta duplicada) sobe e vira
      // `drive-indisponivel` no `compareEdition`, nunca "sem final exportado" (self-review da PR #13205).
      const found = await listChildren(deps, rootId(), { name: edition, foldersOnly: true });
      if (found.length === 0) return [];
      const folder: DriveEntry = found.length === 1 ? found[0] : await findEditionFolder(deps, rootId(), edition);
      const subs = await listChildren(deps, folder.id, { foldersOnly: true });
      const filesOf = async (pred: (n: string) => boolean) => {
        const all: DriveEntry[] = [];
        for (const s of subs.filter((x) => x.mimeType === FOLDER_MIME && pred(x.name))) all.push(...(await listChildren(deps, s.id)).filter((f) => f.mimeType !== FOLDER_MIME));
        return all;
      };
      let files = (await filesOf(isFinalFolderName)).filter((f) => /\.mp4$/i.test(f.name));
      if (!files.length) files = (await filesOf(isEditedFolderName)).filter((f) => /\.mp4$/i.test(f.name));
      return files.map((f) => ({
        name: f.name,
        modifiedTime: f.modifiedTime ?? null,
        fetch: async () => (await ensureCachedFile(deps, f, join(cacheOf(edition), "final"), log)).localPath,
      }));
    },
    workDir: (edition) => resolve(workDirFlag ?? workDirDefault("api", cacheOf(edition), tmpdir(), edition)),
    async brutoFile(edition, name) {
      // Baixar o bruto (vários GB no multi-arquivo) só a pedido: o cache da montagem já foi procurado antes.
      if (!fetchBruto) return null;
      const found = await listChildren(deps, rootId(), { name: edition, foldersOnly: true });
      if (found.length === 0) return null;
      const folder: DriveEntry = found.length === 1 ? found[0] : await findEditionFolder(deps, rootId(), edition);
      const want = name.toLowerCase();
      const file = (await listChildren(deps, folder.id)).find((f) => f.mimeType !== FOLDER_MIME && f.name.toLowerCase() === want);
      if (!file) return null;
      // Mesmo destino do modo API da montagem: `{cache}/{AAMMDD}/bruto/` (reaproveita o que ela já baixou).
      return (await ensureCachedFile(deps, file, join(cacheOf(edition), "bruto"), log)).localPath;
    },
  };
}

function transcriptWords(edition: string): Word[] {
  const p = join(ROOT, editionDir(edition), "_internal", "video-montagem", "transcript.json");
  const t = readJsonSafe<{ segments?: Array<{ words?: Word[] }> }>(p);
  if (!t) {
    log(`[aviso] ${edition}: sem transcript.json, palavras recuperadas não medidas`);
    return [];
  }
  return (t.segments ?? []).flatMap((s) => s.words ?? []);
}

/** Onde procurar o bruto fora do caminho do `plan.json` (#13196/#13197, resíduo da 1ª rodada real). */
export interface BrutoLookup {
  /** Raiz do arquivo do HD do 300 (#12548); `null` = não procurar lá. */
  archiveRoot: string | null;
  /** `{cache}/{AAMMDD}` da montagem; `null` = sem cache configurado nesta máquina. */
  montageEditionCache(edition: string): string | null;
}

export function defaultBrutoLookup(cacheFlag?: string, env: NodeJS.ProcessEnv = process.env): BrutoLookup {
  return {
    archiveRoot: env.VIDEO_ARCHIVE_ROOT ?? join(env.VIDEO_ARCHIVE_MOUNT ?? DEFAULT_ARCHIVE_MOUNT, "arquivo-video"),
    montageEditionCache(edition) {
      try {
        return driveCacheDir(edition, cacheFlag, env.DIARIA_VIDEO_CACHE_DIR, homedir());
      } catch (e) {
        log(`[aviso] ${edition}: cache da montagem indisponível (${(e as Error).message}); bruto não procurado lá`);
        return null;
      }
    },
  };
}

/** Um arquivo do bruto nesta máquina: caminho do `plan.json`, arquivo do HD, cache da montagem e, por último, o Drive. */
async function locateBrutoPart(edition: string, part: BrutoPart, finder: Finder, lookup: BrutoLookup): Promise<string | null> {
  if (existsSync(part.originalPath)) return part.originalPath;
  const archiveFolders = lookup.archiveRoot && existsSync(lookup.archiveRoot) ? readdirSync(lookup.archiveRoot) : [];
  const dirs = brutoSearchDirs({
    edition,
    archiveRoot: lookup.archiveRoot,
    archiveFolders,
    montageEditionCache: lookup.montageEditionCache(edition),
    join,
    editionsOfFolder,
  });
  for (const dir of dirs) {
    const hit = fileInDir(dir, part.name);
    if (hit) return hit;
  }
  return finder.brutoFile(edition, part.name);
}

function probeDurationS(path: string): number {
  return Number(sh("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).stdout.trim());
}

/** ffmpeg de um arquivo do bruto para 16 kHz mono; com `durationS`, completa com silêncio e corta na duração da linha do tempo. */
function extract16k(src: string, out: string, durationS: number | null): void {
  const fit = durationS === null ? [] : ["-af", "apad", "-t", durationS.toFixed(6)];
  const tmp = `${out}.tmp.wav`;
  sh("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", src, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", ...fit, "-c:a", "pcm_s16le", tmp]);
  renameSync(tmp, out);
}

/**
 * O áudio 16 kHz mono do bruto, nesta ordem: o `audio.wav` do cache da
 * montagem; no bruto em vários arquivos, o concatenado que a montagem deixou
 * no mesmo diretório de trabalho (`MULTI_AUDIO_FILE`, já na linha do tempo
 * global, #12089); por fim, extraído dos arquivos do bruto achados por
 * `locateBrutoPart` (caminho do plan.json, HD, cache, Drive). Bruto em vários
 * arquivos (#12559, antes pulado pela #13225): `source.path` é só o do 1º e
 * os tempos do `plan.json` são globais, então sai um WAV por arquivo, cada um
 * na duração que ocupa na linha do tempo (`frames/fps`, `apad` + `-t`), e a
 * concatenação na ordem de `offsetFrames`, como o `ensureMultiAudio` da
 * montagem. Duração final conferida contra a linha do tempo: não bater é pulo,
 * nunca uma comparação com os tempos deslocados. `wav: null` traz o motivo.
 */
export async function brutoWav(
  edition: string,
  workDir: string,
  pf: PlanFileLite,
  finder: Finder,
  lookup: BrutoLookup = defaultBrutoLookup(),
): Promise<{ wav: string } | { wav: null; reason: string }> {
  const cached = join(workDir, "audio.wav");
  if (existsSync(cached)) return { wav: cached };
  const bp = brutoParts(pf.source);
  const montageConcat = join(workDir, MULTI_AUDIO_FILE);
  if ((pf.source.files?.length ?? 0) > 1 && existsSync(montageConcat)) {
    // Já está na linha do tempo global (a montagem conferiu a duração): só baixa para 16 kHz mono.
    const fromMontage = join(tmpdir(), "diaria-video-xml-vs-final", edition, "bruto-16k-concat-montagem.wav");
    if (!existsSync(fromMontage) || (bp.parts !== null && !brutoTimelineMatches(probeDurationS(fromMontage), bp.parts, pf.source.fps))) {
      mkdirSync(dirname(fromMontage), { recursive: true });
      log(`[video-xml-vs-final] ${edition}: áudio do bruto do concatenado da montagem (${montageConcat})…`);
      extract16k(montageConcat, fromMontage, null);
    }
    return { wav: fromMontage };
  }
  if (bp.parts === null) return { wav: null, reason: `áudio do bruto ausente (${cached}) e ${bp.reason}` };
  const parts = bp.parts;
  const own = join(tmpdir(), "diaria-video-xml-vs-final", edition, parts.length > 1 ? "bruto-multi-16k.wav" : "bruto-16k.wav");
  const fits = (p: string) => existsSync(p) && brutoTimelineMatches(probeDurationS(p), parts, pf.source.fps);
  if (fits(own)) return { wav: own };
  const local: string[] = [];
  for (const part of parts) {
    let p: string | null;
    try {
      p = await locateBrutoPart(edition, part, finder, lookup);
    } catch (e) {
      log(`[erro] ${edition}: busca do bruto ${part.name} no Drive falhou: ${(e as Error).message}`);
      return { wav: null, reason: driveUnavailableReason(`bruto ${part.name}: ${(e as Error).message}`) };
    }
    if (!p) {
      const hint = finder.mode === "api" ? "; no modo API, --fetch-bruto baixa do Drive (#13225)" : "";
      return { wav: null, reason: `áudio do bruto ausente (${cached}) e ${part.name} não achado (caminho do plan.json, arquivo do HD, cache da montagem, Drive)${hint}` };
    }
    local.push(p);
  }
  mkdirSync(dirname(own), { recursive: true });
  if (parts.length === 1) {
    log(`[video-xml-vs-final] ${edition}: extraindo o áudio do bruto (${local[0]})…`);
    extract16k(local[0], own, null);
    return { wav: own };
  }
  const dir = join(dirname(own), "bruto-parts");
  mkdirSync(dir, { recursive: true });
  const wavs: string[] = [];
  for (const [i, part] of parts.entries()) {
    const w = join(dir, `${String(i + 1).padStart(2, "0")}.wav`);
    log(`[video-xml-vs-final] ${edition}: áudio do bruto ${i + 1}/${parts.length} (${local[i]})…`);
    extract16k(local[i], w, part.durationS);
    wavs.push(w);
  }
  const list = join(dir, "list.txt");
  writeFileSync(list, concatListText(wavs));
  const tmp = `${own}.tmp.wav`;
  sh("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", tmp]);
  renameSync(tmp, own);
  if (!fits(own)) {
    return { wav: null, reason: `áudio do bruto em ${parts.length} arquivos com ${probeDurationS(own)} s, a linha do tempo do plan.json não bate (#12559)` };
  }
  return { wav: own };
}

/** Compara uma edição. `null` = sem plan.json (fora da rodada). */
export async function compareEdition(
  edition: string,
  finder: Finder,
  opts: { finalPath?: string; seq?: string; skip?: ReadonlySet<string>; plan?: PlanFileLite; brutoLookup?: BrutoLookup } = {},
): Promise<EditionRecord | null> {
  const pf = opts.plan ?? readJsonSafe<PlanFileLite>(planPath(edition));
  if (!pf) return null;
  const { reviewFinalSequence } = await import("./video-montagem.ts");
  const specs = pf.plans.map((p) => p.spec);
  const resolveKey = (name: string) => {
    try {
      return reviewFinalSequence(name, opts.seq, specs).key;
    } catch {
      return null;
    }
  };
  const record: EditionRecord = { schema: XML_FINAL_SCHEMA, edition, method: "audio-envelope-align-v1", generatedAt: new Date().toISOString(), sequences: [], skipped: [] };
  const plans = pf.plans.filter((p) => {
    const k = sequenceKey(p.spec);
    return !pf.stale?.[k] && (!opts.seq || k === opts.seq) && !opts.skip?.has(k);
  });
  let candidates: Awaited<ReturnType<Finder["list"]>>;
  try {
    candidates = opts.finalPath
      ? [{ name: basename(opts.finalPath), modifiedTime: null, fetch: async () => resolve(opts.finalPath as string) }]
      : await finder.list(edition);
  } catch (e) {
    const reason = driveUnavailableReason((e as Error).message);
    log(`[erro] ${edition}: consulta ao Drive falhou: ${(e as Error).message}`);
    for (const p of plans) record.skipped.push({ key: sequenceKey(p.spec), reason });
    return record;
  }
  const finals = pickFinalsPerSequence(candidates, resolveKey, videoVersionOf);
  if (pf.source.audioOnly) {
    for (const p of plans) record.skipped.push({ key: sequenceKey(p.spec), reason: "bruto só de áudio (#11552): sem XML de vídeo" });
    return record;
  }
  const words = transcriptWords(edition);
  const wd = finder.workDir(edition);
  // Só procura (e talvez baixa) o bruto quando alguma sequência tem final: sem final não há o que comparar.
  let brutoRes: Awaited<ReturnType<typeof brutoWav>> | null = null;
  let brutoEnv: ReturnType<typeof energyEnvelope> | null = null;
  for (const plan of plans) {
    const key = sequenceKey(plan.spec);
    const fin = finals.get(key);
    if (!fin) {
      record.skipped.push({ key, reason: "sem final exportado em Final/" });
      continue;
    }
    brutoRes ??= await brutoWav(edition, wd, pf, finder, opts.brutoLookup);
    if (brutoRes.wav === null) {
      record.skipped.push({ key, reason: brutoRes.reason });
      continue;
    }
    const bruto = brutoRes.wav;
    try {
      const finalPath = await fin.fetch();
      const tag = basename(finalPath).replace(/[^\w.-]+/g, "_");
      const fwav = join(tmpdir(), "diaria-video-xml-vs-final", edition, `${tag}.16k.wav`);
      mkdirSync(dirname(fwav), { recursive: true });
      sh("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-i", finalPath, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", fwav]);
      const loud = parseLoudnormJson(sh("ffmpeg", ["-hide_banner", "-nostats", "-i", finalPath, "-vn", "-af", "loudnorm=I=-14:TP=-1:LRA=11:print_format=json", "-f", "null", "-"]).stderr);
      brutoEnv ??= (() => {
        const b = parseWavPcm16(readFileSync(bruto));
        return energyEnvelope(b.samples, b.sampleRate);
      })();
      const fa = parseWavPcm16(readFileSync(fwav));
      const fe = energyEnvelope(fa.samples, fa.sampleRate);
      const finalDurationS = fa.samples.length / fa.sampleRate;
      const al = alignWithReorder(fe.db, brutoEnv.db, brutoEnv.hopS, ALIGN_OPTS);
      if (al.coverage < MIN_COVERAGE) {
        record.skipped.push({ key, reason: `alinhamento fraco: ${(al.coverage * 100).toFixed(0)}% do final com par no bruto (mínimo ${MIN_COVERAGE * 100}%)` });
        continue;
      }
      const fps = pf.source.fps ?? 30;
      const cmp = compareSequence({
        clips: plan.clips.map((c, i) => ({ index: i, srcIn: c.srcIn, srcOut: c.srcOut })),
        spans: finalSpansFromRuns(al.runs),
        words,
        finalDurationS,
      });
      const { summary, ...detail } = cmp;
      const seqRec: SequenceRecord = {
        key,
        target: plan.spec.target,
        finalFile: fin.name,
        xmlVersion: pf.xmlVersions?.[key]?.id ?? null,
        xmlDurationS: Math.round((plan.durationFrames / fps) * 10) / 10,
        finalDurationS: Math.round(finalDurationS * 10) / 10,
        coverage: Math.round(al.coverage * 100) / 100,
        summary,
        loudness: loud ? { inputI: loud.inputI, inputTp: loud.inputTp } : null,
        framing: null,
        captions: null,
        detail,
      };
      record.sequences.push(seqRec);
      log(`[video-xml-vs-final] ${edition} ${key}: ${summary.clipsRemoved}/${summary.clips} clipes fora, ${summary.clipsTouched} mexidos, ${summary.wordsRecovered} palavra(s) recuperada(s)`);
    } catch (e) {
      record.skipped.push({ key, reason: `erro: ${(e as Error).message.slice(0, 200)}` });
    }
  }
  return record;
}

function loadState(): RecurringState {
  return { ...EMPTY_STATE, ...(readJsonSafe<RecurringState>(out("state.json")) ?? {}) };
}

/** Registros no disco, com os desta rodada por cima (no `--dry-run` eles não foram gravados). */
function loadRecords(fresh: ReadonlyMap<string, EditionRecord> = new Map()): EditionRecord[] {
  const dir = join(ROOT, OUT_DIR);
  const onDisk = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /^\d{6}\.json$/.test(n))
        .map((n) => readJsonSafe<EditionRecord>(join(dir, n)))
        .filter((r): r is EditionRecord => r !== null)
    : [];
  const byEdition = new Map(onDisk.map((r) => [r.edition, r]));
  for (const [e, r] of fresh) byEdition.set(e, r);
  return [...byEdition.values()];
}

function saveRecord(rec: EditionRecord, state: RecurringState, dryRun: boolean, fresh: Map<string, EditionRecord>): EditionRecord {
  const merged = mergeEditionRecord(fresh.get(rec.edition) ?? readJsonSafe<EditionRecord>(out(`${rec.edition}.json`)), rec);
  fresh.set(rec.edition, merged);
  if (!dryRun) writeJson(out(`${rec.edition}.json`), merged);
  if (merged.sequences.length) state.done[rec.edition] = { at: new Date().toISOString(), sequences: merged.sequences.map((s) => s.key) };
  return merged;
}

function ghCli(args: string[]): string {
  return sh("gh", args).stdout.trim();
}

function bodyFile(text: string): string {
  const p = join(tmpdir(), `video-xml-final-13196-${process.pid}-${Math.random().toString(36).slice(2, 8)}.md`);
  writeFileSync(p, text);
  return p;
}

export interface ReportPatternsDeps {
  gh?: (args: string[]) => string;
  /**
   * Grava o estado logo depois de cada issue aberta/comentada (self-review da
   * PR #13205): um `gh` que falha no 2º padrão não pode deixar o 1º sem
   * registro, senão a rodada seguinte abre outra issue antes de o índice de
   * busca do GitHub alcançar a primeira.
   */
  persist?: (state: RecurringState) => void;
}

/** Abre ou comenta a issue de cada padrão; devolve o que fez (para o log/relatório). */
export async function reportPatterns(
  patterns: readonly DetectedPattern[],
  state: RecurringState,
  records: readonly EditionRecord[],
  openIssues: boolean,
  deps: ReportPatternsDeps = {},
): Promise<string[]> {
  const gh = deps.gh ?? ghCli;
  const done: string[] = [];
  const examples = patternExamples(records);
  for (const p of patterns) {
    const known = state.patterns[p.id];
    if (known?.evidenceHash === p.evidenceHash) continue;
    if (!openIssues) {
      done.push(`${p.id}: padrão em ${p.editions.length} edições (sem --open-issues, nada aberto)`);
      continue;
    }
    let target: number | null = known?.issue ?? null;
    if (target !== null && JSON.parse(gh(["issue", "view", String(target), "--json", "state"])).state !== "OPEN") target = null;
    if (target === null && p.trackingIssue) {
      if (JSON.parse(gh(["issue", "view", String(p.trackingIssue), "--json", "state"])).state === "OPEN") target = p.trackingIssue;
    }
    if (target === null) {
      const found = JSON.parse(gh(["issue", "list", "--state", "open", "--search", `"${PATTERN_MARKER(p.id).replace(/<!--\s*|\s*-->/g, "")}" in:body`, "--json", "number", "--limit", "5"])) as Array<{ number: number }>;
      if (found.length) target = found[0].number;
    }
    if (target !== null) {
      gh(["issue", "comment", String(target), "--body-file", bodyFile(patternCommentBody(p))]);
      done.push(`${p.id}: evidência comentada na #${target}`);
    } else {
      const url = gh(["issue", "create", "--title", p.title, "--label", `enhancement,${p.priority}`, "--body-file", bodyFile(patternIssueBody(p, { details: examples }))]);
      const m = /\/issues\/(\d+)/.exec(url);
      if (!m) throw new Error(`gh issue create sem número na saída: ${url}`);
      target = Number(m[1]);
      done.push(`${p.id}: issue #${target} aberta`);
    }
    state.patterns[p.id] = { issue: target, evidenceHash: p.evidenceHash };
    deps.persist?.(state);
  }
  return done;
}

async function finish(opts: { openIssues: boolean; dryRun: boolean; register: boolean; today: string; state: RecurringState; fresh: ReadonlyMap<string, EditionRecord> }): Promise<void> {
  const records = loadRecords(opts.fresh);
  const agg = aggregateRecords(records);
  const patterns = detectPatterns(agg);
  const skipped = records.flatMap((r) => r.skipped.map((s) => ({ edition: r.edition, ...s })));
  const report = renderReport({ agg, patterns, skipped, generatedAt: new Date().toISOString() });
  if (opts.dryRun) {
    process.stdout.write(report);
    for (const p of patterns) log(`[dry-run] padrão ${p.id} (${p.priority}) em ${p.editions.join(", ")}`);
    return;
  }
  writeJson(out("aggregate.json"), { generatedAt: new Date().toISOString(), ...agg, patterns });
  writeFileSync(out("report.md"), report);
  const actions = await reportPatterns(patterns, opts.state, records, opts.openIssues, { persist: (s) => writeJson(out("state.json"), s) });
  for (const a of actions) log(`[video-xml-vs-final] ${a}`);
  opts.state.lastRunAt = new Date().toISOString();
  writeJson(out("state.json"), opts.state);
  if (opts.register) {
    try {
      const { registerReport } = await import("./studio-ui/studio-reports.ts");
      registerReport(ROOT, {
        kind: "video-xml-final",
        sessionId: opts.today,
        title: `Vídeo XML × final ${opts.today}: ${agg.editions} edições, ${patterns.length} padrão(ões), ${agg.totals.wordsRecovered} palavra(s) recuperada(s)`,
        htmlPath: `${OUT_DIR}/report.md`,
      });
    } catch (e) {
      log(`[aviso] relatório não registrado no Studio: ${(e as Error).message}`);
    }
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values, flags, positional } = parseArgs(argv);
  const [cmd, arg] = positional;
  const usage = "uso: npx tsx scripts/video-xml-vs-final.ts <compare AAMMDD|run|backfill|aggregate> [--final PATH] [--seq KEY] [--today AAMMDD] [--days N] [--from AAMMDD] [--to AAMMDD] [--open-issues] [--dry-run] [--no-register] [--fetch-bruto]";
  if (!cmd || flags.has("help") || !["compare", "run", "backfill", "aggregate"].includes(cmd)) {
    console.error(usage);
    return 2;
  }
  for (const k of ["today", "from", "to"] as const) {
    if (values[k] !== undefined && !/^\d{6}$/.test(values[k])) {
      console.error(`--${k} deve ser AAMMDD (veio ${values[k]})`);
      return 2;
    }
  }
  const dryRun = flags.has("dry-run");
  const openIssues = flags.has("open-issues");
  const today = values.today ?? todayBrt();
  const state = loadState();
  const fresh = new Map<string, EditionRecord>();
  try {
    const driveRoot = values["drive-root"] ?? process.env.DIARIA_VIDEO_DRIVE_ROOT ?? DEFAULT_DRIVE_ROOT;
    const getFinder = async () => (existsSync(driveRoot) ? localFinder(driveRoot, values["work-dir"]) : apiFinder(values["cache-dir"], values["work-dir"], values["folder-id"], flags.has("fetch-bruto")));
    if (cmd === "compare") {
      if (!arg || !/^\d{6}$/.test(arg)) {
        console.error(usage);
        return 2;
      }
      const rec = await compareEdition(arg, await getFinder(), { finalPath: values.final, seq: values.seq });
      if (!rec) {
        console.error(`${arg}: sem plan.json (${planPath(arg)})`);
        return 1;
      }
      const merged = saveRecord(rec, state, dryRun, fresh);
      if (dryRun) process.stdout.write(JSON.stringify(merged, null, 2) + "\n");
      else writeJson(out("state.json"), state);
      for (const s of rec.skipped) log(`[pulada] ${arg} ${s.key}: ${s.reason}`);
      return driveUnreachable([rec]) ? 1 : 0;
    }
    /** Os registros comparados nesta rodada (sem o baseline importado): base do alarme de Drive inacessível. */
    const round: EditionRecord[] = [];
    if (cmd === "backfill") {
      for (const b of BASELINE_11670) saveRecord(b, state, dryRun, fresh);
      const from = values.from ?? BACKFILL_FROM;
      const to = values.to ?? today;
      const finder = await getFinder();
      for (const e of editionsWithPlan().filter((x) => x.edition >= from && x.edition <= to)) {
        const rec = await compareEdition(e.edition, finder);
        if (rec) {
          round.push(rec);
          saveRecord(rec, state, dryRun, fresh);
        }
      }
    }
    if (cmd === "run") {
      const days = values.days !== undefined ? Number(values.days) : 14;
      if (!Number.isInteger(days) || days < 1) {
        console.error(`--days deve ser inteiro >= 1 (veio ${values.days})`);
        return 2;
      }
      const todo = editionsToCompare({ withPlan: editionsWithPlan(), state, today, days });
      log(`[video-xml-vs-final] ${todo.length} edição(ões) a comparar: ${todo.join(", ") || "nenhuma"}`);
      if (todo.length) {
        const finder = await getFinder();
        for (const e of todo) {
          const rec = await compareEdition(e, finder, { skip: new Set(state.done[e]?.sequences ?? []) });
          if (rec) {
            round.push(rec);
            saveRecord(rec, state, dryRun, fresh);
          }
        }
      }
    }
    await finish({ openIssues, dryRun, register: !flags.has("no-register"), today, state, fresh });
    if (driveUnreachable(round)) {
      console.error(`video-xml-vs-final: nenhuma das ${round.length} edição(ões) pôde ser consultada no Drive (motivo em skipped: drive-indisponivel)`);
      return 1;
    }
    return 0;
  } catch (e) {
    console.error(`video-xml-vs-final: ${(e as Error).message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().then((c) => process.exit(c));
}

/**
 * scripts/video/prepara-bruto-mac.ts (#13229, decisão do editor de 25/11/2026)
 *
 * Roda NO MAC do Premiere, antes de abrir o XML: copia o bruto da edição da
 * pasta de vídeo do Drive (modo streaming) para uma pasta LOCAL, fora do Drive
 * (`publishing.video.premiere_bruto_root`, em `{raiz}/{AAMMDD}/`), que é para
 * onde o `…-local.xml` do `/diaria-video-montagem build` aponta os vídeos do
 * bruto. Na 261116 o Premiere, lendo o bruto pelo Drive em streaming, travou em
 * "Preparing audio" e trocou quadros por preto; com o XML apontando o bruto
 * para uma pasta local (copiada à mão por um script de sessão) o projeto abriu
 * rápido.
 *
 * Sem dependência além do Node: só módulos `node:` e o validador sem imports
 * `../lib/diaria/premiere-bruto-root.ts`. Roda com
 * `node scripts/video/prepara-bruto-mac.ts AAMMDD` (Node 22.18+/23.6+, que
 * executa .ts direto) ou `npx tsx scripts/video/prepara-bruto-mac.ts AAMMDD`.
 *
 * O que faz, nesta ordem:
 *   1. Limpeza: apaga as cópias locais de edições anteriores a hoje, arquivo
 *      por arquivo, SÓ depois de conferir que o original continua no Drive com
 *      o mesmo nome e o mesmo tamanho (`planCleanup`). Nunca toca no Drive.
 *      `--dry-run` só afeta a limpeza (lista em vez de apagar). Pasta local com
 *      nome que não é de edição nunca é tocada.
 *   2. Vigia `{drive}/{AAMMDD}/` (e, com XML local, a origem de cada vídeo que
 *      ele referencia, mesmo fora dessa pasta, como `261116-17/`): cada vídeo é
 *      copiado quando o tamanho fica estável (`stabilityStep`, por caminho
 *      completo), para `.part` e depois renomeado, com progresso e conferência
 *      do tamanho da cópia.
 *   3. Com `…-local.xml` na pasta da edição, o alvo passa a ser exatamente os
 *      vídeos que ele referencia (`xmlTargets`). Termina quando todos estão
 *      locais e conferidos; sem XML, termina depois de `--idle-min` minutos sem
 *      arquivo novo (ou com Ctrl+C).
 *
 * Saída: 0 = tudo que havia para copiar está local e conferido (também
 * `--clean-only`); 3 = parou (ocioso ou `--once`) com vídeo faltando, com XML
 * local ou sem ele, ou com erro de leitura (XML ilegível, stat com EIO); 2 =
 * uso ou config inválido, incluindo XML local sem nenhum vídeo sob a pasta
 * local; 1 = exceção não tratada.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsoluteRootPath, normalizeRootPath, parsePremiereBrutoRoot } from "../lib/diaria/premiere-bruto-root.ts";

// ── Pura: o que é bruto, estabilidade, XML, limpeza ─────────────────────────

/** Na pasta local de cada edição: nome → caminho do original no Drive, gravado a cada cópia (a limpeza confere por ele). */
export const ORIGINS_FILE = ".origem.json";
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv)$/i;
/** Derivado da montagem (`{AAMMDD}_{coisa}-{hash}.ext`: card, trecho, título): nunca é bruto. */
const HASHED_ASSET = /^\d{6}_.+-[0-9a-f]{8,}\.[A-Za-z0-9]+$/;

/** Pura — vídeo solto na raiz da pasta da edição que pode ser bruto (prévia, derivado com hash, `.part` e oculto ficam de fora). */
export function isBrutoCandidate(name: string): boolean {
  if (name.startsWith(".") || /\.part$/i.test(name)) return false;
  if (!VIDEO_EXT.test(name)) return false;
  if (/previa|prévia/i.test(name.normalize("NFC"))) return false;
  if (HASHED_ASSET.test(name)) return false;
  return true;
}

/** O `stat` de um caminho: arquivo, ausente (ENOENT/ENOTDIR), ou erro de leitura com o código (EIO, ETIMEDOUT: pendente, não "sumiu"). */
export type StatResult = { kind: "file"; size: number; mtimeMs: number } | { kind: "absent" } | { kind: "error"; code: string };

export function describeStat(s: StatResult): string {
  return s.kind === "file" ? `${s.size} B` : s.kind === "absent" ? "ausente" : `erro ${s.code}`;
}

export interface Observed {
  /** Caminho completo (a chave do estado: dois arquivos de mesmo nome em pastas diferentes não se misturam). */
  path: string;
  size: number;
  mtimeMs: number;
}

export interface StabilityEntry extends Observed {
  /** Observações seguidas com o mesmo tamanho e mtime (1 = acabou de mudar ou de aparecer). */
  polls: number;
}

/** Pura — junta a observação nova ao estado anterior, por caminho: mesmo tamanho e mtime soma uma volta; mudou, volta a 1. */
export function stabilityStep(prev: ReadonlyMap<string, StabilityEntry>, observed: readonly Observed[]): Map<string, StabilityEntry> {
  const next = new Map<string, StabilityEntry>();
  for (const o of observed) {
    const p = prev.get(o.path);
    const same = p !== undefined && p.size === o.size && p.mtimeMs === o.mtimeMs;
    next.set(o.path, { ...o, polls: same ? p.polls + 1 : 1 });
  }
  return next;
}

/**
 * Pura — o upload terminou? Tamanho > 0 e (o mesmo por `stablePolls`
 * observações seguidas, ou mtime mais velho que `stableAgeMs`: o arquivo que
 * já estava no Drive antes de o script começar não espera as voltas).
 */
export function isStable(e: StabilityEntry, nowMs: number, opts: { stablePolls: number; stableAgeMs: number }): boolean {
  if (e.size <= 0) return false;
  return e.polls >= opts.stablePolls || nowMs - e.mtimeMs >= opts.stableAgeMs;
}

/** Pura — `file://localhost/Users/…` (o `pathurl` do XML) → `/Users/…`; `file://localhost/I:/…` → `I:/…`. `null` = não é file URL. */
export function fileUrlToPath(url: string): string | null {
  const m = /^file:\/\/(?:localhost)?\/(.*)$/i.exec(url.trim());
  if (!m) return null;
  let p: string;
  try {
    p = m[1].split("/").map((s) => decodeURIComponent(s)).join("/");
  } catch {
    return null;
  }
  return /^[A-Za-z]:\//.test(p) ? p : `/${p}`;
}

function decodeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

/** Pura — `{file id → caminho}` dos `<file>` do bruto (`file-1`, `file-2`…, os que o `localBrutoXml` do build reescreve). */
export function brutoFilePaths(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<file id="(file-\d+)"><name>[^<]*<\/name><pathurl>([^<]*)<\/pathurl>/g)) {
    const p = fileUrlToPath(decodeXmlText(m[2]));
    if (p && !out.has(m[1])) out.set(m[1], p);
  }
  return out;
}

export interface CopyTarget {
  name: string;
  /** Onde a cópia fica (o caminho que o XML local referencia). */
  dest: string;
  /** De onde copiar (o mesmo `<file>` no XML normal; ausente = `{pasta da edição no Drive}/{nome}`). */
  src: string;
}

/** Pura — `child` está dentro de `parent` (ou é ele)? Sem caixa (o APFS padrão não diferencia) e com `/` como separador. */
export function isInsidePath(child: string, parent: string): boolean {
  const c = normalizeRootPath(child).normalize("NFC").toLowerCase();
  const p = normalizeRootPath(parent).normalize("NFC").toLowerCase();
  return c === p || c.startsWith(p === "/" ? "/" : `${p}/`);
}

/**
 * Pura — os vídeos que o XML local referencia sob `localDir`, com a origem de
 * cada um no XML normal (mesmo `file id`). `<file>` do XML local fora de
 * `localDir` (XML de outra edição ou de outra raiz) sai em `discarded`.
 */
export function xmlTargets(localXml: string, normalXml: string | null, localDir: string, driveEditionDir: string): { targets: CopyTarget[]; discarded: string[] } {
  const dir = normalizeRootPath(localDir);
  const normal = normalXml ? brutoFilePaths(normalXml) : new Map<string, string>();
  const targets: CopyTarget[] = [];
  const discarded: string[] = [];
  for (const [id, dest] of brutoFilePaths(localXml)) {
    if (!dest.startsWith(`${dir}/`) || dest.slice(dir.length + 1).includes("/")) {
      discarded.push(`${id}: ${dest}`);
      continue;
    }
    const name = dest.slice(dir.length + 1);
    targets.push({ name, dest, src: normal.get(id) ?? `${normalizeRootPath(driveEditionDir)}/${name}` });
  }
  return { targets, discarded };
}

/** Pura — junta alvos de vários XMLs locais (as sequências da edição) sem repetir destino. */
export function mergeTargets(lists: readonly (readonly CopyTarget[])[]): CopyTarget[] {
  const seen = new Map<string, CopyTarget>();
  for (const l of lists) for (const t of l) if (!seen.has(t.dest)) seen.set(t.dest, t);
  return [...seen.values()];
}

/**
 * Pura — a edição mais nova que o nome da pasta cobre: `261116` → 261116;
 * `261116-17` → 261117; `261130-01` → 261201 (o 2º dia menor que o 1º vira o
 * mês seguinte, e dezembro vira janeiro do ano seguinte). `null` = não é pasta
 * de edição (inclui dia ou mês fora de 01–31 / 01–12).
 */
export function newestEditionOf(folder: string): string | null {
  const m = /^(\d{2})(\d{2})(\d{2})(?:-(\d{2}))?$/.exec(folder);
  if (!m) return null;
  let [yy, mm] = [Number(m[1]), Number(m[2])];
  const dd = Number(m[3]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  if (!m[4]) return `${m[1]}${m[2]}${m[3]}`;
  const d2 = Number(m[4]);
  if (d2 < 1 || d2 > 31) return null;
  if (d2 < dd) {
    mm += 1;
    if (mm > 12) {
      mm = 1;
      yy = (yy + 1) % 100;
    }
  }
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(yy)}${p(mm)}${m[4]}`;
}

/** Pura — AAMMDD do dia na hora local da máquina. */
export function todayAAMMDD(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

/**
 * Pura — o conteúdo da `.origem.json` aceito: só valor texto, absoluto e
 * dentro de `driveRoot` (origem fora do Drive cairia em conferir o próprio
 * arquivo local). O resto sai em `rejected`, e aquele arquivo volta ao
 * caminho padrão `{drive}/{pasta}/{nome}`.
 */
export function validOrigins(raw: unknown, driveRoot: string): { origins: Record<string, string>; rejected: string[] } {
  const origins: Record<string, string> = {};
  const rejected: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { origins, rejected: raw === undefined ? [] : ["(não é objeto)"] };
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && isAbsoluteRootPath(v) && isInsidePath(v, driveRoot)) origins[k] = normalizeRootPath(v);
    else rejected.push(k);
  }
  return { origins, rejected };
}

export interface LocalEditionFolder {
  folder: string;
  files: { name: string; size: number }[];
  /** `.origem.json` da pasta, já validada (`validOrigins`). */
  origins?: Record<string, string>;
}

export interface CleanupAction {
  folder: string;
  name: string;
  path: string;
  action: "delete" | "keep";
  reason: string;
}

/**
 * Pura — o que a limpeza faz com as cópias locais. Só pasta de edição mais
 * velha que `today` (pela edição mais nova do nome) e diferente de `current`;
 * cada vídeo sai só se o original (o da `.origem.json`, senão
 * `{drive}/{pasta}/{nome}`) existe com o MESMO tamanho. `.part` (cópia
 * interrompida) sai sem conferir tamanho, mas só quando o original com o nome
 * sem `.part` existe; o `.DS_Store` do Finder sai sempre (não é cópia de
 * nada). Original com erro de leitura (EIO) conta como não conferido: fica.
 */
export function planCleanup(input: {
  today: string;
  current: string | null;
  localRoot: string;
  driveRoot: string;
  folders: readonly LocalEditionFolder[];
  driveStat: (path: string) => StatResult;
}): CleanupAction[] {
  const out: CleanupAction[] = [];
  const localRoot = normalizeRootPath(input.localRoot);
  const driveRoot = normalizeRootPath(input.driveRoot);
  for (const f of input.folders) {
    const newest = newestEditionOf(f.folder);
    if (!newest || newest >= input.today || f.folder === input.current) continue;
    for (const file of f.files) {
      if (file.name === ORIGINS_FILE) continue;
      const path = `${localRoot}/${f.folder}/${file.name}`;
      if (file.name === ".DS_Store") {
        out.push({ folder: f.folder, name: file.name, path, action: "delete", reason: "arquivo do Finder, não é cópia do bruto" });
        continue;
      }
      const partial = /\.part$/i.test(file.name);
      const name = partial ? file.name.slice(0, -5) : file.name;
      const original = f.origins?.[name] ?? `${driveRoot}/${f.folder}/${name}`;
      const st = input.driveStat(original);
      if (st.kind !== "file") out.push({ folder: f.folder, name: file.name, path, action: "keep", reason: `original ${describeStat(st)} no Drive (${original}): a cópia local fica` });
      else if (partial) out.push({ folder: f.folder, name: file.name, path, action: "delete", reason: `cópia interrompida; original no Drive (${original})` });
      else if (st.size !== file.size) out.push({ folder: f.folder, name: file.name, path, action: "keep", reason: `tamanho diferente no Drive (${st.size} B no Drive, ${file.size} B local): a cópia local fica` });
      else out.push({ folder: f.folder, name: file.name, path, action: "delete", reason: `original no Drive com o mesmo nome e tamanho (${original})` });
    }
  }
  return out;
}

/** Pura — `1,2 GB`, `850 MB`. */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2).replace(".", ",")} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** Pura — a linha de progresso de uma cópia. */
export function progressLine(name: string, done: number, total: number, elapsedMs: number): string {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
  const bps = elapsedMs > 0 ? (done / elapsedMs) * 1000 : 0;
  const etaS = bps > 0 ? Math.round((total - done) / bps) : null;
  const eta = etaS === null ? "?" : etaS >= 60 ? `${Math.floor(etaS / 60)} min ${etaS % 60} s` : `${etaS} s`;
  return `${name}: ${formatBytes(done)} de ${formatBytes(total)} (${pct}%), ${(bps / 1024 ** 2).toFixed(1).replace(".", ",")} MB/s, falta ${eta}`;
}

export interface CliOptions {
  edition: string;
  driveRoot: string | null;
  localRoot: string | null;
  config: string | null;
  intervalS: number;
  stablePolls: number;
  stableAgeS: number;
  idleMin: number;
  dryRun: boolean;
  noClean: boolean;
  cleanOnly: boolean;
  once: boolean;
}

export const USAGE = `uso: node scripts/video/prepara-bruto-mac.ts AAMMDD [opções]
  --drive-root DIR    pasta de vídeo do Drive no Mac (default: publishing.video.premiere_root do config)
  --local-root DIR    pasta local fora do Drive (default: publishing.video.premiere_bruto_root do config)
  --config FILE       platform.config.json (default: o do checkout deste script)
  --interval S        segundos entre varreduras (default 10)
  --stable-polls N    varreduras com o mesmo tamanho para dar o upload por terminado (default 3)
  --stable-age S      arquivo sem mudar há S segundos já conta como estável (default 120)
  --idle-min M        termina depois de M minutos sem arquivo novo (default 30)
  --dry-run           só a limpeza: lista o que apagaria (a cópia segue normal)
  --no-clean          não limpa as edições passadas
  --clean-only        só a limpeza (sai 0)
  --once              uma varredura só, sem esperar
saída: 0 = tudo local e conferido; 3 = faltou vídeo ou houve erro de leitura; 2 = uso/config; 1 = exceção`;

/** Pura — os argumentos da linha de comando. Erro = mensagem para o stderr (saída 2). */
export function parseArgs(argv: readonly string[]): CliOptions | { error: string } {
  const o: CliOptions = { edition: "", driveRoot: null, localRoot: null, config: null, intervalS: 10, stablePolls: 3, stableAgeS: 120, idleMin: 30, dryRun: false, noClean: false, cleanOnly: false, once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--drive-root" || a === "--local-root" || a === "--config") {
      const v = next();
      if (!v) return { error: `${a} precisa de um caminho` };
      if (a === "--drive-root") o.driveRoot = v;
      else if (a === "--local-root") o.localRoot = v;
      else o.config = v;
    } else if (a === "--interval" || a === "--stable-polls" || a === "--stable-age" || a === "--idle-min") {
      const v = next();
      const min = a === "--stable-polls" || a === "--interval" ? 1 : 0;
      const n = Number(v);
      if (v === undefined || !Number.isFinite(n) || n < min) return { error: `${a} precisa de um número >= ${min} (veio ${v ?? "nada"})` };
      if (a === "--interval") o.intervalS = n;
      else if (a === "--stable-polls") o.stablePolls = Math.floor(n);
      else if (a === "--stable-age") o.stableAgeS = n;
      else o.idleMin = n;
    } else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--no-clean") o.noClean = true;
    else if (a === "--clean-only") o.cleanOnly = true;
    else if (a === "--once") o.once = true;
    else if (/^\d{6}$/.test(a) && !o.edition) o.edition = a;
    else return { error: `argumento desconhecido: ${a}` };
  }
  if (!o.edition) return { error: "falta o AAMMDD da edição" };
  if (o.noClean && o.cleanOnly) return { error: "--no-clean e --clean-only juntos não fazem nada: escolha um" };
  return o;
}

/** Pura — `premiere_root` e `premiere_bruto_root` do config, pelo mesmo validador do build; `errors` = valor presente e inválido. */
export function rootsFromConfig(config: unknown): { driveRoot: string | null; localRoot: string | null; errors: string[] } {
  const v = (config as { publishing?: { video?: { premiere_root?: unknown; premiere_bruto_root?: unknown } } })?.publishing?.video;
  const errors: string[] = [];
  const pick = (x: unknown, label: string): string | null => {
    const r = parsePremiereBrutoRoot(x, label);
    if ("error" in r) {
      errors.push(r.error);
      return null;
    }
    return r.ok;
  };
  return { driveRoot: pick(v?.premiere_root, "publishing.video.premiere_root"), localRoot: pick(v?.premiere_bruto_root, "publishing.video.premiere_bruto_root"), errors };
}

// ── I/O ──────────────────────────────────────────────────────────────────────

export function statPath(path: string): StatResult {
  try {
    const s = statSync(path);
    return s.isFile() ? { kind: "file", size: s.size, mtimeMs: s.mtimeMs } : { kind: "absent" };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "EUNKNOWN";
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "error", code };
  }
}

interface DirListing {
  files: (Observed & { name: string })[];
  /** Arquivos que o `stat` não leu (EIO, ETIMEDOUT): pendentes, nunca dados por sumidos. */
  pending: { name: string; code: string }[];
  /** Erro ao listar a pasta (fora ENOENT, que é pasta vazia). */
  dirError?: string;
}

function listDir(dir: string): DirListing {
  const out: DirListing = { files: [], pending: [] };
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "EUNKNOWN";
    if (code !== "ENOENT") out.dirError = code;
    return out;
  }
  for (const name of names) {
    const path = `${normalizeRootPath(dir)}/${name}`;
    const st = statPath(path);
    if (st.kind === "file") out.files.push({ name, path, size: st.size, mtimeMs: st.mtimeMs });
    else if (st.kind === "error") out.pending.push({ name, code: st.code });
    // ausente: sumiu entre o readdir e o stat, ou é pasta
  }
  return out;
}

function writeFileAtomicSync(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** A `.origem.json` validada. Corrompida = aviso + `corrupt` (o `recordOrigin` guarda o arquivo antes de regravar). */
export function readOrigins(dir: string, driveRoot: string): { origins: Record<string, string>; corrupt: boolean } {
  const path = join(dir, ORIGINS_FILE);
  if (!existsSync(path)) return { origins: {}, corrupt: false };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`[origem] ${path} ilegível (${(e as Error).message}): a limpeza confere pelo caminho padrão no Drive`);
    return { origins: {}, corrupt: true };
  }
  const v = validOrigins(raw, driveRoot);
  if (v.rejected.length) console.error(`[origem] ${path}: entrada(s) ignorada(s) (não texto ou fora de ${driveRoot}): ${v.rejected.join(", ")}`);
  return { origins: v.origins, corrupt: false };
}

/** Grava a origem de uma cópia (atômico). `.origem.json` corrompida é guardada ao lado como `.origem.json.corrompido-{ms}`, nunca sobrescrita em silêncio. */
export function recordOrigin(dir: string, driveRoot: string, name: string, src: string): void {
  const path = join(dir, ORIGINS_FILE);
  const cur = readOrigins(dir, driveRoot);
  if (cur.corrupt) {
    const keep = `${path}.corrompido-${Date.now()}`;
    renameSync(path, keep);
    console.error(`[origem] ${ORIGINS_FILE} corrompida guardada em ${keep}; regravando só com as origens novas`);
  }
  writeFileAtomicSync(path, `${JSON.stringify({ ...cur.origins, [name]: src }, null, 2)}\n`);
}

export interface CleanupSummary {
  deleted: string[];
  wouldDelete: string[];
  kept: string[];
  removedFolders: string[];
}

export function runCleanup(opt: { localRoot: string; driveRoot: string; today: string; current: string; dryRun: boolean }): CleanupSummary {
  const sum: CleanupSummary = { deleted: [], wouldDelete: [], kept: [], removedFolders: [] };
  if (!existsSync(opt.localRoot)) return sum;
  const folders: LocalEditionFolder[] = [];
  for (const folder of readdirSync(opt.localRoot)) {
    const dir = join(opt.localRoot, folder);
    try {
      if (!statSync(dir).isDirectory() || !newestEditionOf(folder)) continue;
    } catch {
      continue;
    }
    const listing = listDir(dir);
    for (const p of listing.pending) console.error(`[limpeza] ${folder}/${p.name}: stat com erro ${p.code}, fica`);
    folders.push({ folder, files: listing.files.map(({ name, size }) => ({ name, size })), origins: readOrigins(dir, opt.driveRoot).origins });
  }
  const actions = planCleanup({ today: opt.today, current: opt.current, localRoot: opt.localRoot, driveRoot: opt.driveRoot, folders, driveStat: statPath });
  if (!actions.length) {
    console.log(`[limpeza] nada de edições anteriores a ${opt.today} em ${opt.localRoot}`);
    return sum;
  }
  let freed = 0;
  for (const a of actions) {
    const st = statPath(a.path);
    const sz = st.kind === "file" ? st.size : 0;
    const id = `${a.folder}/${a.name}`;
    if (a.action === "keep") {
      sum.kept.push(id);
      console.log(`[limpeza] fica ${id}: ${a.reason}`);
    } else if (opt.dryRun) {
      sum.wouldDelete.push(id);
      console.log(`[limpeza] --dry-run: apagaria ${id} (${formatBytes(sz)}): ${a.reason}`);
    } else {
      try {
        unlinkSync(a.path);
        freed += sz;
        sum.deleted.push(id);
        console.log(`[limpeza] apagado ${id} (${formatBytes(sz)}): ${a.reason}`);
      } catch (e) {
        sum.kept.push(id);
        console.error(`[limpeza] não apagou ${id}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
      }
    }
  }
  if (opt.dryRun) return sum;
  for (const folder of new Set(actions.map((a) => a.folder))) {
    const dir = join(opt.localRoot, folder);
    const listing = listDir(dir);
    if (listing.pending.length || listing.dirError || listing.files.some((f) => f.name !== ORIGINS_FILE)) continue;
    try {
      if (existsSync(join(dir, ORIGINS_FILE))) unlinkSync(join(dir, ORIGINS_FILE));
      rmdirSync(dir);
      sum.removedFolders.push(folder);
      console.log(`[limpeza] pasta ${folder}/ removida (vazia)`);
    } catch (e) {
      console.error(`[limpeza] pasta ${folder}/ ficou: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  console.log(`[limpeza] ${formatBytes(freed)} liberados`);
  return sum;
}

/** Cópia com `.part` + rename e conferência de tamanho. `false` = a origem mudou ou a cópia não bateu (tenta de novo na próxima varredura). */
async function copyOne(src: string, dest: string, name: string): Promise<boolean> {
  const before = statPath(src);
  if (before.kind !== "file") {
    console.error(`[cópia] ${name}: origem ${describeStat(before)} (${src})`);
    return false;
  }
  const total = before.size;
  const part = `${dest}.part`;
  const t0 = Date.now();
  let done = 0;
  let lastPrint = 0;
  const tty = process.stdout.isTTY === true;
  console.log(`[cópia] ${name}: ${formatBytes(total)} de ${src}`);
  try {
    await new Promise<void>((ok, fail) => {
      const r = createReadStream(src);
      const w = createWriteStream(part);
      r.on("data", (chunk) => {
        done += chunk.length;
        const now = Date.now();
        if (now - lastPrint >= (tty ? 1000 : 10_000)) {
          lastPrint = now;
          const line = progressLine(name, done, total, now - t0);
          if (tty) process.stdout.write(`\r${line}   `);
          else console.log(line);
        }
      });
      r.on("error", fail);
      w.on("error", fail);
      w.on("finish", () => ok());
      r.pipe(w);
    });
  } catch (e) {
    if (tty) process.stdout.write("\n");
    console.error(`[cópia] ${name}: falhou (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); tenta de novo na próxima varredura`);
    return false;
  }
  if (tty) process.stdout.write("\n");
  const copied = statPath(part);
  const srcNow = statPath(src);
  if (copied.kind !== "file" || copied.size !== total || srcNow.kind !== "file" || srcNow.size !== total) {
    console.error(`[cópia] ${name}: tamanho não confere (origem ${total} B, agora ${describeStat(srcNow)}; cópia ${describeStat(copied)}); tenta de novo`);
    try {
      unlinkSync(part);
    } catch {
      // .part sai na limpeza de um dia seguinte
    }
    return false;
  }
  renameSync(part, dest);
  const el = Date.now() - t0;
  console.log(`[cópia] ${name}: ok, ${formatBytes(total)} conferidos em ${Math.round(el / 1000)} s (${progressLine(name, total, total, el).split(", ")[1]})`);
  return true;
}

interface XmlScan {
  xmls: string[];
  targets: CopyTarget[];
  discarded: string[];
  errors: string[];
}

function scanLocalXmls(driveEditionDir: string, localDir: string): XmlScan {
  const scan: XmlScan = { xmls: [], targets: [], discarded: [], errors: [] };
  let names: string[];
  try {
    names = readdirSync(driveEditionDir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "EUNKNOWN";
    if (code !== "ENOENT") scan.errors.push(`${driveEditionDir}: ${code}`);
    return scan;
  }
  scan.xmls = names.filter((n) => /-local\.xml$/i.test(n)).sort();
  const lists: CopyTarget[][] = [];
  for (const n of scan.xmls) {
    try {
      const local = readFileSync(join(driveEditionDir, n), "utf8");
      const normalPath = join(driveEditionDir, n.replace(/-local\.xml$/i, ".xml"));
      const normal = existsSync(normalPath) ? readFileSync(normalPath, "utf8") : null;
      const r = xmlTargets(local, normal, localDir, driveEditionDir);
      lists.push(r.targets);
      scan.discarded.push(...r.discarded.map((d) => `${n} ${d}`));
    } catch (e) {
      scan.errors.push(`${n}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  scan.targets = mergeTargets(lists);
  return scan;
}

/** O realpath do caminho, ou do ancestral mais próximo que existe + o resto (a pasta local pode ainda não existir). */
function realpathNearest(p: string): string {
  const segs: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return normalizeRootPath([realpathSync(cur), ...segs].join("/"));
    } catch {
      const up = dirname(cur);
      if (up === cur) return normalizeRootPath(p);
      segs.unshift(cur.slice(up.length).replace(/^[\\/]+/, ""));
      cur = up;
    }
  }
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export async function main(argv: readonly string[], deps: { now?: () => Date } = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    console.error(`prepara-bruto-mac: ${parsed.error}\n${USAGE}`);
    return 2;
  }
  const opt = parsed;
  const configPath = opt.config ?? fileURLToPath(new URL("../../platform.config.json", import.meta.url));
  let fromConfig = { driveRoot: null as string | null, localRoot: null as string | null };
  if (existsSync(configPath)) {
    try {
      const r = rootsFromConfig(JSON.parse(readFileSync(configPath, "utf8")));
      fromConfig = r;
      if (r.errors.length && (!opt.driveRoot || !opt.localRoot)) {
        console.error(`prepara-bruto-mac: ${r.errors.join("; ")}`);
        return 2;
      }
    } catch (e) {
      console.error(`[aviso] ${configPath} ilegível (${(e as Error).message}): use --drive-root e --local-root`);
    }
  }
  const flagRoot = (v: string | null, label: string): string | null | { error: string } => {
    if (v === null) return null;
    const r = parsePremiereBrutoRoot(v, label);
    return "error" in r ? r : r.ok;
  };
  const d = flagRoot(opt.driveRoot, "--drive-root");
  const l = flagRoot(opt.localRoot, "--local-root");
  for (const x of [d, l]) if (x && typeof x === "object") {
    console.error(`prepara-bruto-mac: ${x.error}`);
    return 2;
  }
  const driveRoot = (d as string | null) ?? fromConfig.driveRoot;
  const localRoot = (l as string | null) ?? fromConfig.localRoot;
  if (!driveRoot || !localRoot) {
    console.error(`prepara-bruto-mac: falta ${!driveRoot ? "a pasta do Drive (--drive-root ou publishing.video.premiere_root)" : "a pasta local (--local-root ou publishing.video.premiere_bruto_root)"}. No Mac o config lido é o do checkout de lá: git pull, ou passe --local-root`);
    return 2;
  }
  if (isInsidePath(localRoot, driveRoot) || isInsidePath(realpathNearest(localRoot), realpathNearest(driveRoot))) {
    console.error(`prepara-bruto-mac: a pasta local (${localRoot}) não pode ficar dentro da do Drive (${driveRoot}), nem por symlink`);
    return 2;
  }
  const today = todayAAMMDD((deps.now ?? (() => new Date()))());
  if (!opt.noClean) runCleanup({ localRoot, driveRoot, today, current: opt.edition, dryRun: opt.dryRun });
  if (opt.cleanOnly) return 0;

  const driveDir = `${driveRoot}/${opt.edition}`;
  const localDir = `${localRoot}/${opt.edition}`;
  mkdirSync(localDir, { recursive: true });
  console.log(`[vigia] ${driveDir} para ${localDir} (a cada ${opt.intervalS} s; Ctrl+C para parar)`);
  const stab = { stablePolls: opt.stablePolls, stableAgeMs: opt.stableAgeS * 1000 };
  let state = new Map<string, StabilityEntry>();
  let lastActivity = Date.now();
  let announced = "";
  for (;;) {
    const listing = listDir(driveDir);
    const readErrors: string[] = [];
    if (listing.dirError) readErrors.push(`${driveDir}: ${listing.dirError}`);
    for (const p of listing.pending) readErrors.push(`${p.name}: ${p.code}`);
    const scan = scanLocalXmls(driveDir, localDir);
    readErrors.push(...scan.errors);
    if (scan.xmls.length && !scan.targets.length && !scan.errors.length) {
      console.error(
        `prepara-bruto-mac: ${scan.xmls.join(", ")} sem nenhum vídeo do bruto sob ${localDir}. O XML foi gerado com outro premiere_bruto_root; ` +
          `confira a chave no config do build ou passe --local-root com a raiz do XML. <file> descartados: ${scan.discarded.join("; ") || "nenhum <file> do bruto"}`,
      );
      return 2;
    }
    if (scan.discarded.length) console.error(`[xml] <file> fora de ${localDir}, ignorados: ${scan.discarded.join("; ")}`);
    const key = scan.xmls.join("|");
    if (key !== announced) {
      announced = key;
      if (scan.xmls.length) console.log(`[xml] ${scan.xmls.join(", ")}: ${scan.targets.length} vídeo(s) do bruto (${scan.targets.map((t) => t.name).join(", ")})`);
    }
    // O estado acompanha os candidatos da pasta da edição e as origens do XML de fora dela (261116-17/).
    const observed: Observed[] = listing.files.filter((f) => isBrutoCandidate(f.name)).map(({ path, size, mtimeMs }) => ({ path, size, mtimeMs }));
    const seen = new Set(observed.map((o) => o.path));
    for (const t of scan.targets) {
      if (seen.has(t.src)) continue;
      const st = statPath(t.src);
      if (st.kind === "file") observed.push({ path: t.src, size: st.size, mtimeMs: st.mtimeMs });
      else if (st.kind === "error") readErrors.push(`${t.src}: ${st.code}`);
      seen.add(t.src);
    }
    const prevKeys = new Set(state.keys());
    state = stabilityStep(state, observed);
    if ([...state.values()].some((e) => !prevKeys.has(e.path) || e.polls === 1)) lastActivity = Date.now();
    const now = Date.now();
    const work: CopyTarget[] = scan.xmls.length
      ? scan.targets
      : [...state.values()].map((e) => {
          const name = e.path.slice(e.path.lastIndexOf("/") + 1);
          return { name, dest: `${localDir}/${name}`, src: e.path };
        });
    for (const t of work) {
      const entry = state.get(t.src);
      if (!entry || !isStable(entry, now, stab)) continue;
      const dest = statPath(t.dest);
      if (dest.kind === "file" && dest.size === entry.size) continue;
      if (await copyOne(t.src, t.dest, t.name)) {
        recordOrigin(localDir, driveRoot, t.name, t.src);
        lastActivity = Date.now();
      }
    }
    for (const e of readErrors) console.error(`[leitura] ${e} (pendente, tenta de novo)`);
    const stop = opt.once || (Date.now() - lastActivity) / 60_000 >= opt.idleMin;
    const missingOf = (ts: readonly CopyTarget[]) =>
      ts.filter((t) => {
        const s = statPath(t.src);
        const c = statPath(t.dest);
        return s.kind !== "file" || c.kind !== "file" || c.size !== s.size;
      });
    if (scan.xmls.length) {
      const missing = missingOf(scan.targets);
      if (!missing.length && !readErrors.length) {
        console.log(`[conferência] ${scan.targets.length} vídeo(s) do XML local em ${localDir}, tamanhos iguais aos do Drive: pode abrir o ${scan.xmls.join(" / ")} no Premiere`);
        return 0;
      }
      if (stop) {
        console.error(
          `[conferência] faltam ${missing.length} vídeo(s) do XML local: ${missing.map((t) => `${t.name} (origem ${describeStat(statPath(t.src))})`).join(", ") || "nenhum"}` +
            (readErrors.length ? `; ${readErrors.length} erro(s) de leitura` : ""),
        );
        return 3;
      }
    } else if (stop) {
      const pending = missingOf(work);
      console.log(
        `[vigia] ${opt.once ? "--once" : `sem arquivo novo há ${opt.idleMin} min`}, sem XML local ainda; ${work.length - pending.length} de ${work.length} vídeo(s) local(is)` +
          (pending.length ? `; pendentes: ${pending.map((t) => t.name).join(", ")}` : "") +
          (readErrors.length ? `; ${readErrors.length} erro(s) de leitura` : ""),
      );
      return pending.length || readErrors.length ? 3 : 0;
    }
    await sleep(opt.intervalS * 1000);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error("prepara-bruto-mac:", e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}

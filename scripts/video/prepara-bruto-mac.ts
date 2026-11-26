/**
 * scripts/video/prepara-bruto-mac.ts (#13229, decisão do editor de 25/11/2026)
 *
 * Roda NO MAC do Premiere, antes de abrir o XML: copia o bruto da edição da
 * pasta de vídeo do Drive (modo streaming) para uma pasta LOCAL, fora do Drive
 * (`publishing.video.premiere_bruto_root`, em `{raiz}/{AAMMDD}/`), que é para
 * onde o `…-local.xml` do `/diaria-video-montagem build` aponta os vídeos do
 * bruto. O Premiere lendo o bruto pelo Drive em streaming travava em
 * "Preparing audio" e trocava quadros por preto (261116); com o bruto local
 * o projeto abriu rápido (validado à mão na 261116).
 *
 * Sem dependência além do Node: só módulos `node:`. Roda com
 * `node scripts/video/prepara-bruto-mac.ts AAMMDD` (Node 22.18+/23.6+, que
 * executa .ts direto) ou `npx tsx scripts/video/prepara-bruto-mac.ts AAMMDD`.
 *
 * O que faz, nesta ordem:
 *   1. Limpeza: apaga as cópias locais de edições anteriores a hoje, arquivo
 *      por arquivo, SÓ depois de conferir que o original continua no Drive com
 *      o mesmo nome e o mesmo tamanho (`planCleanup`). Nunca toca no Drive.
 *      `--dry-run` só lista. Pasta local com nome que não é de edição nunca é
 *      tocada.
 *   2. Vigia `{drive}/{AAMMDD}/`: cada vídeo do bruto que aparece é copiado
 *      quando o tamanho fica estável (`stabilityStep`), para `.part` e depois
 *      renomeado, com progresso (arquivo, tamanho, velocidade, quanto falta) e
 *      conferência do tamanho da cópia.
 *   3. Com `…-local.xml` na pasta da edição, o alvo passa a ser exatamente os
 *      vídeos que ele referencia (`xmlTargets`; a origem de cada um sai do XML
 *      normal ao lado, o que cobre bruto de outra pasta, como `261116-17/`).
 *      Termina quando todos estão locais e conferidos; sem XML, termina depois
 *      de `--idle-min` minutos sem arquivo novo (ou com Ctrl+C).
 *
 * Saída: 0 = tudo que havia para copiar está local; 3 = parou (ocioso ou
 * `--once`) com vídeo do XML ainda faltando; 2 = uso/config inválido.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Pura: o que é bruto, estabilidade, XML, limpeza ─────────────────────────

/** Na pasta local de cada edição: nome → caminho do original no Drive, gravado a cada cópia (a limpeza confere por ele). */
const ORIGINS_FILE = ".origem.json";
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

export interface Observed {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface StabilityEntry extends Observed {
  /** Observações seguidas com o mesmo tamanho e mtime (1 = acabou de mudar ou de aparecer). */
  polls: number;
}

/** Pura — junta a observação nova ao estado anterior: mesmo tamanho e mtime soma uma volta; mudou, volta a 1. */
export function stabilityStep(prev: ReadonlyMap<string, StabilityEntry>, observed: readonly Observed[]): Map<string, StabilityEntry> {
  const next = new Map<string, StabilityEntry>();
  for (const o of observed) {
    const p = prev.get(o.name);
    const same = p !== undefined && p.size === o.size && p.mtimeMs === o.mtimeMs;
    next.set(o.name, { ...o, polls: same ? p.polls + 1 : 1 });
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

function trimSlash(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Pura — os vídeos que o XML local referencia sob `localDir`, com a origem de
 * cada um no XML normal (mesmo `file id`). `<file>` do XML local fora de
 * `localDir` (XML de outra edição ou de outra raiz) fica de fora.
 */
export function xmlTargets(localXml: string, normalXml: string | null, localDir: string, driveEditionDir: string): CopyTarget[] {
  const dir = trimSlash(localDir);
  const normal = normalXml ? brutoFilePaths(normalXml) : new Map<string, string>();
  const out: CopyTarget[] = [];
  for (const [id, dest] of brutoFilePaths(localXml)) {
    if (!dest.startsWith(`${dir}/`) || dest.slice(dir.length + 1).includes("/")) continue;
    const name = dest.slice(dir.length + 1);
    out.push({ name, dest, src: normal.get(id) ?? `${trimSlash(driveEditionDir)}/${name}` });
  }
  return out;
}

/** Pura — junta alvos de vários XMLs locais (as sequências da edição) sem repetir destino. */
export function mergeTargets(lists: readonly (readonly CopyTarget[])[]): CopyTarget[] {
  const seen = new Map<string, CopyTarget>();
  for (const l of lists) for (const t of l) if (!seen.has(t.dest)) seen.set(t.dest, t);
  return [...seen.values()];
}

/** Pura — a edição mais nova que o nome da pasta cobre (`261116` → 261116; `261116-17` → 261117); `null` = não é pasta de edição. */
export function newestEditionOf(folder: string): string | null {
  const m = /^(\d{6})(?:-(\d{2}))?$/.exec(folder);
  if (!m) return null;
  return m[2] ? `${m[1].slice(0, 4)}${m[2]}` : m[1];
}

/** Pura — AAMMDD do dia na hora local da máquina. */
export function todayAAMMDD(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export interface LocalEditionFolder {
  folder: string;
  files: { name: string; size: number }[];
  /** `.origem.json` da pasta: nome → caminho do original no Drive, gravado na cópia. */
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
 * cada arquivo sai só se o original (o da `.origem.json`, senão
 * `{drive}/{pasta}/{nome}`) existe com o MESMO tamanho. `.part` (cópia
 * interrompida) sai quando o original com o nome sem `.part` existe, e o
 * `.DS_Store` do Finder sai sempre (não é cópia de nada). O resto
 * fica, com o motivo. `driveSize` devolve `null` para arquivo ausente.
 */
export function planCleanup(input: {
  today: string;
  current: string | null;
  localRoot: string;
  driveRoot: string;
  folders: readonly LocalEditionFolder[];
  driveSize: (path: string) => number | null;
}): CleanupAction[] {
  const out: CleanupAction[] = [];
  const localRoot = trimSlash(input.localRoot);
  const driveRoot = trimSlash(input.driveRoot);
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
      const size = input.driveSize(original);
      if (size === null) out.push({ folder: f.folder, name: file.name, path, action: "keep", reason: `original ausente no Drive (${original}): a cópia local fica` });
      else if (partial) out.push({ folder: f.folder, name: file.name, path, action: "delete", reason: `cópia interrompida; original no Drive (${original})` });
      else if (size !== file.size) out.push({ folder: f.folder, name: file.name, path, action: "keep", reason: `tamanho diferente no Drive (${size} B no Drive, ${file.size} B local): a cópia local fica` });
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
  --idle-min M        sem XML local, termina depois de M minutos sem arquivo novo (default 30)
  --dry-run           a limpeza só lista o que apagaria (a cópia segue normal)
  --no-clean          não limpa as edições passadas
  --clean-only        só a limpeza
  --once              uma varredura só, sem esperar`;

/** Pura — os argumentos da linha de comando. Erro = mensagem para o stderr (saída 2). */
export function parseArgs(argv: readonly string[]): CliOptions | { error: string } {
  const o: CliOptions = { edition: "", driveRoot: null, localRoot: null, config: null, intervalS: 10, stablePolls: 3, stableAgeS: 120, idleMin: 30, dryRun: false, noClean: false, cleanOnly: false, once: false };
  const num = (flag: string, v: string | undefined, min: number): number | { error: string } => {
    const n = Number(v);
    return v !== undefined && Number.isFinite(n) && n >= min ? n : { error: `${flag} precisa de um número >= ${min} (veio ${v ?? "nada"})` };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--drive-root") o.driveRoot = next() ?? null;
    else if (a === "--local-root") o.localRoot = next() ?? null;
    else if (a === "--config") o.config = next() ?? null;
    else if (a === "--interval" || a === "--stable-polls" || a === "--stable-age" || a === "--idle-min") {
      const n = num(a, next(), a === "--stable-polls" ? 1 : a === "--interval" ? 1 : 0);
      if (typeof n !== "number") return n;
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
  return o;
}

/** Pura — `premiere_root` e `premiere_bruto_root` do config (absolutos; vazio/ausente = `null`). */
export function rootsFromConfig(config: unknown): { driveRoot: string | null; localRoot: string | null } {
  const v = (config as { publishing?: { video?: { premiere_root?: unknown; premiere_bruto_root?: unknown } } })?.publishing?.video;
  const abs = (x: unknown) => (typeof x === "string" && x.trim().startsWith("/") ? trimSlash(x.trim()) : null);
  return { driveRoot: abs(v?.premiere_root), localRoot: abs(v?.premiere_bruto_root) };
}

// ── I/O ──────────────────────────────────────────────────────────────────────


function sizeOf(path: string): number | null {
  try {
    const s = statSync(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

function listFiles(dir: string): Observed[] {
  if (!existsSync(dir)) return [];
  const out: Observed[] = [];
  for (const name of readdirSync(dir)) {
    try {
      const s = statSync(join(dir, name));
      if (s.isFile()) out.push({ name, size: s.size, mtimeMs: s.mtimeMs });
    } catch {
      // sumiu entre o readdir e o stat: entra na próxima varredura
    }
  }
  return out;
}

function readOrigins(dir: string): Record<string, string> {
  try {
    const j = JSON.parse(readFileSync(join(dir, ORIGINS_FILE), "utf8")) as unknown;
    return j && typeof j === "object" ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function recordOrigin(dir: string, name: string, src: string): void {
  const o = readOrigins(dir);
  o[name] = src;
  writeFileSync(join(dir, ORIGINS_FILE), `${JSON.stringify(o, null, 2)}\n`);
}

function runCleanup(opt: { localRoot: string; driveRoot: string; today: string; current: string; dryRun: boolean }): void {
  if (!existsSync(opt.localRoot)) return;
  const folders: LocalEditionFolder[] = [];
  for (const folder of readdirSync(opt.localRoot)) {
    const dir = join(opt.localRoot, folder);
    try {
      if (!statSync(dir).isDirectory() || !newestEditionOf(folder)) continue;
    } catch {
      continue;
    }
    folders.push({ folder, files: listFiles(dir).map(({ name, size }) => ({ name, size })), origins: readOrigins(dir) });
  }
  const actions = planCleanup({ today: opt.today, current: opt.current, localRoot: opt.localRoot, driveRoot: opt.driveRoot, folders, driveSize: sizeOf });
  if (!actions.length) {
    console.log(`[limpeza] nada de edições anteriores a ${opt.today} em ${opt.localRoot}`);
    return;
  }
  let freed = 0;
  for (const a of actions) {
    const sz = sizeOf(a.path) ?? 0;
    if (a.action === "keep") {
      console.log(`[limpeza] fica ${a.folder}/${a.name}: ${a.reason}`);
      continue;
    }
    if (opt.dryRun) {
      console.log(`[limpeza] --dry-run: apagaria ${a.folder}/${a.name} (${formatBytes(sz)}): ${a.reason}`);
      continue;
    }
    try {
      unlinkSync(a.path);
      freed += sz;
      console.log(`[limpeza] apagado ${a.folder}/${a.name} (${formatBytes(sz)}): ${a.reason}`);
    } catch (e) {
      console.error(`[limpeza] não apagou ${a.folder}/${a.name}: ${(e as Error).message}`);
    }
  }
  if (!opt.dryRun) {
    for (const folder of new Set(actions.map((a) => a.folder))) {
      const dir = join(opt.localRoot, folder);
      const left = listFiles(dir).filter((f) => f.name !== ORIGINS_FILE);
      if (left.length) continue;
      try {
        if (existsSync(join(dir, ORIGINS_FILE))) unlinkSync(join(dir, ORIGINS_FILE));
        rmdirSync(dir);
        console.log(`[limpeza] pasta ${folder}/ removida (vazia)`);
      } catch (e) {
        console.error(`[limpeza] pasta ${folder}/ ficou: ${(e as Error).message}`);
      }
    }
    console.log(`[limpeza] ${formatBytes(freed)} liberados`);
  }
}

/** Cópia com `.part` + rename e conferência de tamanho. `false` = a origem mudou ou a cópia não bateu (tenta de novo na próxima varredura). */
async function copyOne(src: string, dest: string, name: string): Promise<boolean> {
  const total = sizeOf(src);
  if (total === null) {
    console.error(`[cópia] ${name}: origem ausente (${src})`);
    return false;
  }
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
    console.error(`[cópia] ${name}: falhou (${(e as Error).message}); tenta de novo na próxima varredura`);
    return false;
  }
  if (tty) process.stdout.write("\n");
  const copied = sizeOf(part);
  const srcNow = sizeOf(src);
  if (copied !== total || srcNow !== total) {
    console.error(`[cópia] ${name}: tamanho não confere (origem ${total} → ${srcNow ?? "ausente"} B, cópia ${copied ?? "ausente"} B); tenta de novo`);
    try {
      unlinkSync(part);
    } catch {
      // .part some na limpeza seguinte
    }
    return false;
  }
  renameSync(part, dest);
  console.log(`[cópia] ${name}: ok, ${formatBytes(total)} conferidos em ${Math.round((Date.now() - t0) / 1000)} s (${progressLine(name, total, total, Date.now() - t0).split(", ")[1]})`);
  return true;
}

function localXmlTargets(driveEditionDir: string, localDir: string): { xmls: string[]; targets: CopyTarget[] } {
  if (!existsSync(driveEditionDir)) return { xmls: [], targets: [] };
  const xmls = readdirSync(driveEditionDir).filter((n) => /-local\.xml$/i.test(n));
  const lists: CopyTarget[][] = [];
  for (const n of xmls) {
    try {
      const local = readFileSync(join(driveEditionDir, n), "utf8");
      const normalPath = join(driveEditionDir, n.replace(/-local\.xml$/i, ".xml"));
      const normal = existsSync(normalPath) ? readFileSync(normalPath, "utf8") : null;
      lists.push(xmlTargets(local, normal, localDir, driveEditionDir));
    } catch (e) {
      console.error(`[xml] ${n} ilegível (${(e as Error).message}): fica para a próxima varredura`);
    }
  }
  return { xmls, targets: mergeTargets(lists) };
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export async function main(argv: readonly string[]): Promise<number> {
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
      fromConfig = rootsFromConfig(JSON.parse(readFileSync(configPath, "utf8")));
    } catch (e) {
      console.error(`[aviso] ${configPath} ilegível (${(e as Error).message}): use --drive-root e --local-root`);
    }
  }
  const driveRoot = opt.driveRoot ? trimSlash(opt.driveRoot) : fromConfig.driveRoot;
  const localRoot = opt.localRoot ? trimSlash(opt.localRoot) : fromConfig.localRoot;
  if (!driveRoot || !localRoot) {
    console.error(`prepara-bruto-mac: falta ${!driveRoot ? "a pasta do Drive (--drive-root ou publishing.video.premiere_root)" : "a pasta local (--local-root ou publishing.video.premiere_bruto_root)"}`);
    return 2;
  }
  if (localRoot === driveRoot || localRoot.startsWith(`${driveRoot}/`)) {
    console.error(`prepara-bruto-mac: a pasta local (${localRoot}) não pode ficar dentro da do Drive (${driveRoot})`);
    return 2;
  }
  const today = todayAAMMDD(new Date());
  if (!opt.noClean) runCleanup({ localRoot, driveRoot, today, current: opt.edition, dryRun: opt.dryRun });
  if (opt.cleanOnly) return 0;

  const driveDir = `${driveRoot}/${opt.edition}`;
  const localDir = `${localRoot}/${opt.edition}`;
  mkdirSync(localDir, { recursive: true });
  console.log(`[vigia] ${driveDir} → ${localDir} (a cada ${opt.intervalS} s; Ctrl+C para parar)`);
  let state = new Map<string, StabilityEntry>();
  let lastActivity = Date.now();
  let announcedXml = "";
  for (;;) {
    const observed = listFiles(driveDir).filter((f) => isBrutoCandidate(f.name));
    const prevNames = new Set(state.keys());
    const nextState = stabilityStep(state, observed);
    if ([...nextState.values()].some((e) => !prevNames.has(e.name) || e.polls === 1)) lastActivity = Date.now();
    state = nextState;
    const { xmls, targets } = localXmlTargets(driveDir, localDir);
    if (xmls.join("|") !== announcedXml) {
      announcedXml = xmls.join("|");
      if (xmls.length) console.log(`[xml] ${xmls.join(", ")}: ${targets.length} vídeo(s) do bruto (${targets.map((t) => t.name).join(", ")})`);
    }
    // Com XML local, o alvo é o que ele referencia; sem ele, cada candidato estável da pasta da edição.
    const now = Date.now();
    const work: CopyTarget[] = xmls.length
      ? targets
      : [...state.values()].filter((e) => isStable(e, now, { stablePolls: opt.stablePolls, stableAgeMs: opt.stableAgeS * 1000 })).map((e) => ({ name: e.name, dest: `${localDir}/${e.name}`, src: `${driveDir}/${e.name}` }));
    for (const t of work) {
      const srcSize = sizeOf(t.src);
      if (srcSize === null || srcSize <= 0) continue;
      if (sizeOf(t.dest) === srcSize) continue;
      const entry = state.get(basename(t.src));
      if (entry && !isStable(entry, Date.now(), { stablePolls: opt.stablePolls, stableAgeMs: opt.stableAgeS * 1000 })) continue;
      if (await copyOne(t.src, t.dest, t.name)) {
        recordOrigin(localDir, t.name, t.src);
        lastActivity = Date.now();
      }
    }
    if (xmls.length) {
      const missing = targets.filter((t) => {
        const s = sizeOf(t.src);
        return s === null || sizeOf(t.dest) !== s;
      });
      if (!missing.length && targets.length) {
        console.log(`[conferência] ${targets.length} vídeo(s) do XML local em ${localDir}, tamanhos iguais aos do Drive: pode abrir o ${xmls.join(" / ")} no Premiere`);
        return 0;
      }
      if (opt.once || (Date.now() - lastActivity) / 60_000 >= opt.idleMin) {
        console.error(`[conferência] faltam ${missing.length} vídeo(s) do XML local: ${missing.map((t) => `${t.name} (${sizeOf(t.src) === null ? "ausente no Drive" : "não copiado"})`).join(", ")}`);
        return 3;
      }
    } else if (opt.once || (Date.now() - lastActivity) / 60_000 >= opt.idleMin) {
      const pending = [...state.values()].filter((e) => sizeOf(`${localDir}/${e.name}`) !== e.size);
      console.log(`[vigia] ${opt.once ? "--once" : `sem arquivo novo há ${opt.idleMin} min`}, sem XML local ainda; ${state.size - pending.length} de ${state.size} vídeo(s) local(is)${pending.length ? `; pendentes: ${pending.map((e) => e.name).join(", ")}` : ""}`);
      return pending.length ? 3 : 0;
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

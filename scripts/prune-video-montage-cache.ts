#!/usr/bin/env node
/**
 * scripts/prune-video-montage-cache.ts (#12365)
 *
 * Retenção do cache do `/diaria-video-montagem` no modo API
 * (`{raiz}/{AAMMDD}/`: `bruto/`, `work/`, `out/`, `final/`). **Dry-run é o
 * DEFAULT**: sem `--apply` só lista o que sairia, com tamanho, idade e
 * motivo — nunca apaga. Política pura em
 * `scripts/lib/diaria/video-montage-cache-retention.ts`: idade da EDIÇÃO pelo
 * nome do diretório (data de hoje em BRT), edições com mais de
 * `--keep-days` (3) saem se o vídeo foi publicado, ou sem publicação passados
 * `--unpublished-max-days` (14); edição em uso (modificada nas últimas 6h) ou
 * com upload para o Drive pendente nunca sai.
 *
 * Raízes varridas, sem repetir a mesma (comparadas por `realpath`): a padrão
 * (`~/.cache/diaria-video-montagem`) e a configurada (`--cache-dir` ou
 * `DIARIA_VIDEO_CACHE_DIR`, pelo mesmo `videoCacheRoot` da montagem). Assim,
 * depois de apontar a variável para o HD, o que ficou no `~/.cache` também
 * sai. A variável recusada pelo guard da montagem (diretório inexistente, ou
 * no mesmo disco do home: HD desmontado) é erro, exit 1, e a task agendada
 * sai `failed`. Raiz padrão ausente é normal (exit 0).
 *
 * Publicação lida em `data/editions/{AAMM}/{AAMMDD}/` (`editionDir`):
 * `_internal/05-youtube-published.json` com `videoId` (o upload do
 * `/diaria-publica-video`) ou `_internal/05-video-url.txt` com link válido.
 * Sem `data/editions` nesta máquina, ou sem a pasta da edição nele, a
 * publicação é desconhecida e a edição fica. Upload pendente:
 * `_internal/video-montagem/drive-uploads.json` da mesma pasta.
 *
 * Só olha os itens diretos de cada raiz: um symlink na raiz é ignorado (nem
 * seguido, nem apagado), e o `rmSync` de uma edição remove os links de
 * dentro dela sem tocar o alvo. A própria raiz pode ser um link (é resolvida
 * por `realpath` antes da varredura).
 * Task agendada: `Diaria-Video-Montage-Cache-Prune` (diária, `--apply`).
 *
 * Uso:
 *   npx tsx scripts/prune-video-montage-cache.ts                       # dry-run
 *   npx tsx scripts/prune-video-montage-cache.ts --apply               # apaga de verdade
 *   npx tsx scripts/prune-video-montage-cache.ts --keep-days 5 --unpublished-max-days 21
 *   npx tsx scripts/prune-video-montage-cache.ts --cache-dir DIR --data-root DIR   # outra raiz (testes)
 *   npx tsx scripts/prune-video-montage-cache.ts --json
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { formatBytes } from "./lib/onedrive-quota.ts";
import { brtDateOf } from "./lib/ads-rolling-window.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { defaultVideoCacheRoot, videoCacheRoot, type CacheRootCheck } from "./lib/diaria/video-montage-drive.ts";
import { readD1VideoUrl } from "./lib/diaria/d1-video-link-file.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./lib/diaria/youtube-upload.ts";
import {
  DEFAULT_CACHE_KEEP_DAYS,
  DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS,
  planCacheRetention,
  type CacheEntry,
  type CacheKeepReason,
  type CacheRemoveReason,
  type CacheRetentionPlan,
  type CacheSkipReason,
} from "./lib/diaria/video-montage-cache-retention.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[prune-video-montage-cache]";

/** Registro de uploads da montagem, relativo à pasta da edição (`DRIVE_UPLOADS_FILE` em video-montagem.ts). */
export const DRIVE_UPLOADS_REL = "_internal/video-montagem/drive-uploads.json";

/** Pasta da edição sob `dataRoot` (o `data/` real ou um fixture), pelo `editionDir` do projeto. */
export function editionDirUnder(dataRoot: string, edition: string): string {
  return join(dataRoot, relative("data", editionDir(edition)));
}

/** Data de hoje em BRT, como Date UTC 00:00 (a política só usa a parte de data). */
export function todayBrt(now: Date = new Date()): Date {
  return new Date(`${brtDateOf(now)}T00:00:00Z`);
}

export interface SignalRead<T> {
  value: T;
  warning: string | null;
}

/**
 * O vídeo horizontal da edição foi publicado (ou já enviado ao YouTube)?
 * Mesmos registros que a Etapa 5 lê (`video-before-publish.ts`): link do D1
 * válido, ou registro do upload com `videoId` desta edição. Pasta da edição
 * ausente = desconhecido (`null`). Registro ilegível = não publicado, com o
 * motivo em `warning` (o teto de 14 dias ainda limpa).
 */
export function editionVideoPublished(dir: string, edition: string): SignalRead<boolean | null> {
  if (!existsSync(dir)) return { value: null, warning: null };
  const d1 = readD1VideoUrl(dir);
  if (d1.url) return { value: true, warning: null };
  const reg = join(dir, YOUTUBE_PUBLISHED_FILE);
  if (!existsSync(reg)) return { value: false, warning: d1.warning };
  try {
    const j = JSON.parse(readFileSync(reg, "utf8")) as { videoId?: unknown; aammdd?: unknown };
    if (j.aammdd !== undefined && j.aammdd !== edition) {
      return { value: false, warning: `${edition}: ${YOUTUBE_PUBLISHED_FILE} é da edição ${String(j.aammdd)}` };
    }
    return { value: typeof j.videoId === "string" && j.videoId.trim() !== "", warning: d1.warning };
  } catch (e) {
    return { value: false, warning: `${edition}: ${YOUTUBE_PUBLISHED_FILE} ilegível (${(e as Error).message})` };
  }
}

/**
 * Upload para o Drive pendente? `true` com `pending` não vazio (o arquivo só
 * existe no `out/` deste cache), `false` sem registro, `null` com registro
 * ilegível (a política não apaga).
 */
export function editionPendingUpload(dir: string, edition: string): SignalRead<boolean | null> {
  const path = join(dir, DRIVE_UPLOADS_REL);
  if (!existsSync(path)) return { value: false, warning: null };
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { pending?: unknown };
    if (j.pending === undefined) return { value: false, warning: null };
    if (!Array.isArray(j.pending)) return { value: null, warning: `${edition}: ${DRIVE_UPLOADS_REL} com "pending" que não é lista` };
    return { value: j.pending.length > 0, warning: null };
  } catch (e) {
    return { value: null, warning: `${edition}: ${DRIVE_UPLOADS_REL} ilegível (${(e as Error).message})` };
  }
}

/** Tamanho e mtime mais recente da árvore (arquivos e diretórios), sem seguir symlink. */
export function treeStats(dir: string): { sizeBytes: number; lastModifiedMs: number } {
  let sizeBytes = 0;
  let last = lstatSync(dir).mtimeMs;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = join(cur, ent.name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue; // sumiu entre o readdir e o lstat
      }
      if (st.isSymbolicLink()) continue;
      last = Math.max(last, st.mtimeMs);
      if (st.isDirectory()) stack.push(p);
      else if (st.isFile()) sizeBytes += st.size;
    }
  }
  return { sizeBytes, lastModifiedMs: last };
}

/** Itens diretos da raiz do cache, sem seguir symlink. `warnings` recebe os registros ilegíveis. */
export function readCacheEntries(cacheRoot: string, dataRoot: string, warnings: string[] = []): CacheEntry[] {
  const haveEditions = existsSync(join(dataRoot, "editions"));
  const out: CacheEntry[] = [];
  for (const ent of readdirSync(cacheRoot, { withFileTypes: true })) {
    const kind: CacheEntry["kind"] = ent.isSymbolicLink() ? "symlink" : ent.isDirectory() ? "dir" : "other";
    if (kind !== "dir") {
      out.push({ name: ent.name, kind, sizeBytes: 0, published: null });
      continue;
    }
    const { sizeBytes, lastModifiedMs } = treeStats(join(cacheRoot, ent.name));
    let published: boolean | null = null;
    let pendingUpload: boolean | null = false;
    if (/^\d{6}$/.test(ent.name) && haveEditions) {
      const dir = editionDirUnder(dataRoot, ent.name);
      const pub = editionVideoPublished(dir, ent.name);
      const up = editionPendingUpload(dir, ent.name);
      published = pub.value;
      pendingUpload = up.value;
      for (const w of [pub.warning, up.warning]) if (w) warnings.push(w);
    }
    out.push({ name: ent.name, kind, sizeBytes, published, pendingUpload, lastModifiedMs });
  }
  return out;
}

export interface PruneCacheResult {
  cacheRoot: string;
  plan: CacheRetentionPlan;
  applied: boolean;
  deleted: string[];
  failed: { edition: string; error: string }[];
  warnings: string[];
}

/** I/O fino — testável contra um tmpdir. `cacheRoot` já resolvido e existente. */
export function pruneVideoMontageCache(opts: {
  cacheRoot: string;
  dataRoot: string;
  today: Date;
  nowMs?: number;
  keepDays: number;
  unpublishedMaxDays: number;
  apply: boolean;
}): PruneCacheResult {
  // A raiz pode ser um link (ex.: ~/.cache/... → HD); o que se apaga fica dentro do alvo dela.
  const cacheRoot = realpathSync(opts.cacheRoot);
  const warnings: string[] = [];
  const plan = planCacheRetention(readCacheEntries(cacheRoot, opts.dataRoot, warnings), opts.today, {
    keepDays: opts.keepDays,
    unpublishedMaxDays: opts.unpublishedMaxDays,
    nowMs: opts.nowMs ?? Date.now(),
  });
  const deleted: string[] = [];
  const failed: { edition: string; error: string }[] = [];
  if (opts.apply) {
    for (const c of plan.remove) {
      const target = join(cacheRoot, c.edition);
      try {
        // Reconfere na hora de apagar: diretório de verdade, filho direto da raiz.
        if (dirname(target) !== cacheRoot || !lstatSync(target).isDirectory()) throw new Error("não é mais um diretório direto da raiz");
        rmSync(target, { recursive: true });
        deleted.push(c.edition);
      } catch (e) {
        failed.push({ edition: c.edition, error: (e as Error).message });
      }
    }
  }
  return { cacheRoot, plan, applied: opts.apply, deleted, failed, warnings };
}

export interface CacheRootToPrune {
  root: string;
  source: "padrao" | "configurada";
}

/**
 * Raízes a varrer: a configurada (`--cache-dir`/`DIARIA_VIDEO_CACHE_DIR`,
 * com o guard da montagem: lança `VideoCacheRootMissingError`) e a padrão,
 * sem repetir a mesma pasta (realpath). Raiz ausente fica fora da lista.
 */
export function cacheRootsToPrune(
  flag: string | undefined,
  env: string | undefined,
  home: string,
  check?: (p: string) => CacheRootCheck,
): CacheRootToPrune[] {
  const configured = flag || env?.trim() ? videoCacheRoot(flag, env, home, check) : null;
  const candidates: CacheRootToPrune[] = [];
  if (configured) candidates.push({ root: configured, source: "configurada" });
  candidates.push({ root: defaultVideoCacheRoot(home), source: "padrao" });
  const seen = new Set<string>();
  const out: CacheRootToPrune[] = [];
  for (const c of candidates) {
    if (!existsSync(c.root)) continue;
    const real = realpathSync(c.root);
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(c);
  }
  return out;
}

const REASON_TEXT: Record<CacheRemoveReason | CacheKeepReason | CacheSkipReason, string> = {
  publicado: "vídeo publicado (ou já enviado ao YouTube)",
  "teto-sem-publicacao": "sem vídeo publicado, passou do teto",
  "na-janela": "dentro da janela",
  "em-uso": "modificada nas últimas horas, em uso",
  "upload-pendente": "upload para o Drive pendente",
  "registro-de-upload-ilegivel": "registro de upload ilegível",
  "aguardando-publicacao": "vídeo ainda não publicado",
  "publicacao-desconhecida": "publicação desconhecida (sem a pasta da edição em data/editions)",
  symlink: "symlink, nunca seguido",
  "nao-diretorio": "não é diretório",
  "nome-invalido": "nome não é AAMMDD",
};

function main(): void {
  const argv = process.argv.slice(2);
  const apply = hasFlag(argv, "apply");
  const keepDays = getIntArg(argv, "keep-days", { min: 1 }) ?? DEFAULT_CACHE_KEEP_DAYS;
  const unpublishedMaxDays = getIntArg(argv, "unpublished-max-days", { min: 1 }) ?? Math.max(DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS, keepDays);
  const dataRoot = getStringArg(argv, "data-root", { example: "/caminho/data" }) ?? resolve(ROOT, "data");
  const flag = getStringArg(argv, "cache-dir", { example: "/caminho/cache" });
  const env = process.env.DIARIA_VIDEO_CACHE_DIR;
  const home = homedir();
  const roots = cacheRootsToPrune(flag, env, home);
  if (roots.length === 0) {
    console.log(`${LOG_PREFIX} nenhuma raiz de cache nesta máquina (${flag ?? defaultVideoCacheRoot(home)}) — nada a fazer.`);
    return;
  }
  const today = todayBrt();
  const results = roots.map((r) => ({ ...r, result: pruneVideoMontageCache({ cacheRoot: r.root, dataRoot, today, keepDays, unpublishedMaxDays, apply }) }));
  if (env?.trim() && !flag) {
    const legacy = results.find((r) => r.source === "padrao");
    const left = legacy ? [...legacy.result.plan.keep, ...legacy.result.plan.remove].length : 0;
    if (legacy && left > 0) {
      console.warn(
        `${LOG_PREFIX} [aviso] DIARIA_VIDEO_CACHE_DIR está setada, mas ${legacy.result.cacheRoot} ainda tem ${left} edição(ões); ` +
          `a retenção cuida delas pelas mesmas regras.`,
      );
    }
  }
  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    for (const { source, result } of results) {
      const { plan } = result;
      console.log(
        `${LOG_PREFIX} cache (${source}) em ${result.cacheRoot}; mantém edições com até ${keepDays} dia(s), ` +
          `e as sem vídeo publicado até ${unpublishedMaxDays} dia(s).`,
      );
      for (const c of plan.remove) {
        console.log(`  ${apply ? "apagar" : "sairia"}  ${c.edition}  ${formatBytes(c.sizeBytes)}  (${c.ageDays}d, ${REASON_TEXT[c.reason]})`);
      }
      for (const c of plan.keep) console.log(`  fica    ${c.edition}  ${formatBytes(c.sizeBytes)}  (${c.ageDays}d, ${REASON_TEXT[c.reason]})`);
      for (const s of plan.skipped) console.log(`  ignora  ${s.name}  (${REASON_TEXT[s.reason]})`);
      console.log(
        `${LOG_PREFIX} ${plan.remove.length} edição(ões), ${formatBytes(plan.removeBytes)} ${apply ? "a apagar" : "liberáveis"}; ` +
          `${plan.keep.length} mantida(s); ${plan.skipped.length} item(ns) ignorado(s).`,
      );
    }
    if (!apply) console.log(`${LOG_PREFIX} dry-run (default): nada apagado. Rode com --apply para apagar.`);
  }
  for (const { result } of results) for (const w of result.warnings) console.warn(`${LOG_PREFIX} [aviso] ${w}`);
  if (apply) {
    const deleted = results.reduce((n, r) => n + r.result.deleted.length, 0);
    const failed = results.flatMap((r) => r.result.failed);
    console.log(`${LOG_PREFIX} apagadas: ${deleted}; falhas: ${failed.length}.`);
    for (const f of failed) console.error(`${LOG_PREFIX} falha ao apagar ${f.edition}: ${f.error}`);
    if (failed.length > 0) process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`${LOG_PREFIX} erro: ${(e as Error).message}`);
    process.exit(1);
  }
}

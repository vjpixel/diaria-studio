#!/usr/bin/env node
/**
 * scripts/prune-video-montage-cache.ts (#12365)
 *
 * Retenção do cache do `/diaria-video-montagem` no modo API
 * (`{raiz}/{AAMMDD}/`: `bruto/`, `work/`, `out/`, `final/`). **Dry-run é o
 * DEFAULT**: sem `--apply` só lista o que sairia, com tamanho, idade e
 * motivo — nunca apaga. Política pura em
 * `scripts/lib/diaria/video-montage-cache-retention.ts`: data da EDIÇÃO pelo
 * nome do diretório, janela de `--keep-days` (3), e fora dela só sai a
 * edição com o vídeo publicado (ou sem publicação passados
 * `--unpublished-max-days`, 14).
 *
 * Raiz pelo mesmo critério da montagem (`videoCacheRoot`): `--cache-dir` >
 * `DIARIA_VIDEO_CACHE_DIR` > `~/.cache/diaria-video-montagem`. A variável
 * apontando para um diretório que não existe (HD desmontado) é erro, exit 1:
 * a task agendada sai `failed` e o alarme de units pega.
 *
 * Publicação lida em `data/editions/{AAMM}/{AAMMDD}/`:
 * `_internal/05-youtube-published.json` com `videoId` (o upload do
 * `/diaria-publica-video`) ou `_internal/05-video-url.txt` com link válido.
 * Sem `data/editions` nesta máquina a publicação é desconhecida e nada fora
 * da janela sai.
 *
 * Só olha os itens DIRETOS da raiz; symlink nunca é seguido nem apagado (nem
 * na raiz, nem dentro de uma edição: `rmSync` remove o link, não o alvo).
 * Task agendada: `Diaria-Video-Montage-Cache-Prune` (diária 03:50 BRT, `--apply`).
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { walkFileSizes } from "./lib/walk-file-sizes.ts";
import { formatBytes } from "./lib/onedrive-quota.ts";
import { videoCacheRoot } from "./lib/diaria/video-montage-drive.ts";
import { readD1VideoUrl } from "./lib/diaria/d1-video-link-file.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./lib/diaria/youtube-upload.ts";
import {
  DEFAULT_CACHE_KEEP_DAYS,
  DEFAULT_CACHE_UNPUBLISHED_MAX_DAYS,
  planCacheRetention,
  type CacheEntry,
  type CacheRetentionPlan,
} from "./lib/diaria/video-montage-cache-retention.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[prune-video-montage-cache]";

/**
 * O vídeo horizontal da edição foi publicado? Mesmos registros que a
 * Etapa 5 lê (`video-before-publish.ts`): link do D1 válido, ou registro do
 * upload com `videoId` desta edição. Registro ilegível conta como não
 * publicado (o teto de 14 dias ainda limpa).
 */
export function editionVideoPublished(editionDir: string, edition: string): boolean {
  if (readD1VideoUrl(editionDir).url) return true;
  const reg = join(editionDir, YOUTUBE_PUBLISHED_FILE);
  if (!existsSync(reg)) return false;
  try {
    const j = JSON.parse(readFileSync(reg, "utf8")) as { videoId?: unknown; aammdd?: unknown };
    if (j.aammdd !== undefined && j.aammdd !== edition) return false;
    return typeof j.videoId === "string" && j.videoId.trim() !== "";
  } catch {
    return false;
  }
}

/** Itens diretos da raiz do cache, sem seguir symlink. */
export function readCacheEntries(cacheRoot: string, dataRoot: string): CacheEntry[] {
  const editionsDir = join(dataRoot, "editions");
  const haveEditions = existsSync(editionsDir);
  const out: CacheEntry[] = [];
  for (const ent of readdirSync(cacheRoot, { withFileTypes: true })) {
    const kind: CacheEntry["kind"] = ent.isSymbolicLink() ? "symlink" : ent.isDirectory() ? "dir" : "other";
    if (kind !== "dir") {
      out.push({ name: ent.name, kind, sizeBytes: 0, published: null });
      continue;
    }
    const sizeBytes = walkFileSizes(join(cacheRoot, ent.name)).reduce((s, f) => s + f.sizeBytes, 0);
    const published = /^\d{6}$/.test(ent.name) && haveEditions
      ? editionVideoPublished(join(editionsDir, ent.name.slice(0, 4), ent.name), ent.name)
      : null;
    out.push({ name: ent.name, kind, sizeBytes, published });
  }
  return out;
}

export interface PruneCacheResult {
  cacheRoot: string;
  plan: CacheRetentionPlan;
  applied: boolean;
  deleted: string[];
  failed: { edition: string; error: string }[];
}

/** I/O fino — testável contra um tmpdir. `cacheRoot` já resolvido e existente. */
export function pruneVideoMontageCache(opts: {
  cacheRoot: string;
  dataRoot: string;
  today: Date;
  keepDays: number;
  unpublishedMaxDays: number;
  apply: boolean;
}): PruneCacheResult {
  // A raiz pode ser um link (ex.: ~/.cache/... → HD); o que se apaga fica dentro do alvo dela.
  const cacheRoot = realpathSync(opts.cacheRoot);
  const plan = planCacheRetention(readCacheEntries(cacheRoot, opts.dataRoot), opts.today, {
    keepDays: opts.keepDays,
    unpublishedMaxDays: opts.unpublishedMaxDays,
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
  return { cacheRoot, plan, applied: opts.apply, deleted, failed };
}

const REASON_TEXT: Record<string, string> = {
  publicado: "vídeo publicado",
  "teto-sem-publicacao": "sem vídeo publicado, passou do teto",
  "na-janela": "dentro da janela",
  "aguardando-publicacao": "vídeo ainda não publicado",
  "publicacao-desconhecida": "publicação desconhecida (sem data/editions nesta máquina)",
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
  const cacheRoot = videoCacheRoot(getStringArg(argv, "cache-dir", { example: "/caminho/cache" }), process.env.DIARIA_VIDEO_CACHE_DIR, homedir());
  if (!existsSync(cacheRoot)) {
    console.log(`${LOG_PREFIX} ${cacheRoot} ausente nesta máquina — nada a fazer.`);
    return;
  }
  const result = pruneVideoMontageCache({ cacheRoot, dataRoot, today: new Date(), keepDays, unpublishedMaxDays, apply });
  if (hasFlag(argv, "json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const { plan } = result;
    console.log(
      `${LOG_PREFIX} cache em ${result.cacheRoot}; mantém edições com até ${keepDays} dia(s), ` +
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
    if (!apply) console.log(`${LOG_PREFIX} dry-run (default): nada apagado. Rode com --apply para apagar.`);
  }
  if (apply) {
    console.log(`${LOG_PREFIX} apagadas: ${result.deleted.length}; falhas: ${result.failed.length}.`);
    for (const f of result.failed) console.error(`${LOG_PREFIX} falha ao apagar ${f.edition}: ${f.error}`);
    if (result.failed.length > 0) process.exitCode = 1;
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

/**
 * scripts/migrate-archive-beehiiv-images.ts (#8364)
 *
 * Migra as imagens do CORPO das páginas do acervo (`/p/{slug}`) que ainda
 * dependem de `media.beehiiv.com` (host de terceiro, em migração de saída —
 * ver a issue) para o KV próprio (`POLL`, o mesmo namespace que
 * `diar.ia.br/img/{key}`/`eia.diar.ia.br/img/{key}` já servem). Baixa cada
 * URL única, sobe os bytes via `uploadImageToWorkerKV` (o MESMO helper que
 * `upload-images-public.ts` já usa em produção) e grava a entrada em
 * `scripts/lib/archive-image-migration.json` — `buildArchivePageHtml`
 * (`scripts/lib/site-archive-pages.ts`) lê esse mapa e reescreve `<img>` na
 * próxima geração/backfill (`backfill-archive-image-hosts-8364.ts` corrige
 * as páginas JÁ committed sem esperar uma regeneração completa).
 *
 * **Requer credenciais REAIS de escrita no KV de produção**
 * (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN`, mesmas variáveis
 * que `uploadImageToWorkerKV` já lê) — sem elas, roda em `--dry-run`
 * automático (não escreve nada, só reporta o que faria) e nunca finge
 * sucesso. `--dry-run` explícito faz o mesmo mesmo COM credenciais
 * presentes — útil pra conferir o plano (quantas URLs novas, quais keys)
 * antes de gastar a chamada de rede real.
 *
 * Idempotente e resumível — "skip forever" pra URL já presente no mapa
 * (mesma semântica de `verify-emails-mv.ts`, #2886): re-rodar nunca
 * re-baixa/re-sobe uma URL já migrada, só processa o delta.
 *
 * Uso:
 *   npx tsx scripts/migrate-archive-beehiiv-images.ts [--dir workers/site/public/p] [--dry-run] [--limit N]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { uploadImageToWorkerKV } from "./lib/cloudflare-kv-upload.ts";
import { ARCHIVE_BASE_URL } from "./lib/site-archive-pages.ts";
import {
  loadArchiveImageMigrationMap,
  type ArchiveImageMigrationEntry,
} from "./lib/archive-image-migration.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = resolve(ROOT, "workers", "site", "public", "p");
const MAP_PATH = resolve(ROOT, "scripts", "lib", "archive-image-migration.json");

const MEDIA_BEEHIIV_IMG_RE = /<img\b[^>]*\ssrc\s*=\s*(["'])(https:\/\/media\.beehiiv\.com\/[^"']*)\1[^>]*>/gi;

/** Pura — extrai as URLs `media.beehiiv.com` referenciadas em `<img src=...>`
 * dentro de `html`, deduplicadas e na ordem de 1ª ocorrência. Só `<img>` —
 * um link `<a href>` pro mesmo host (não existe hoje no acervo, mas se
 * existisse) não é "imagem", fica fora de propósito. */
export function extractMediaBeehiivImageUrls(html: string): string[] {
  const seen = new Set<string>();
  for (const m of html.matchAll(MEDIA_BEEHIIV_IMG_RE)) seen.add(m[2]);
  return [...seen];
}

/** Extensão do arquivo, a partir do último segmento de path ANTES da query
 * string (`?t=...`) — `.jpg` como fallback pra URL sem extensão reconhecível
 * (o Worker `poll`/`serveKvImage` deriva content-type pela extensão da key,
 * então uma key sem extensão serviria Content-Type errado). */
function extensionFor(url: string): string {
  const withoutQuery = url.split("?")[0];
  const match = withoutQuery.match(/\.([a-z0-9]{2,5})$/i);
  const ext = match ? match[1].toLowerCase() : "jpg";
  // normaliza jpeg->jpg pra bater com a convenção do resto do repo (keys
  // existentes do KV POLL usam .jpg, nunca .jpeg — ver cloudflareKvKey).
  return ext === "jpeg" ? "jpg" : ext;
}

/**
 * Key KV determinística e estável — hash da URL original (não do conteúdo:
 * `media.beehiiv.com` serve a MESMA URL com bytes idênticos ao longo do
 * tempo pra um asset já publicado, então hashear a URL é suficiente e evita
 * uma chamada de rede só pra decidir a key). Prefixo `img-archive-` evita
 * colisão com as keys por-edição (`img-{AAMMDD}-...}`) que
 * `cloudflareKvKey` já grava no MESMO namespace.
 */
export function deriveArchiveImageKey(url: string): string {
  const hash = createHash("sha1").update(url).digest("hex").slice(0, 16);
  return `img-archive-${hash}.${extensionFor(url)}`;
}

/**
 * Alt heurístico a partir dos segmentos de path que a Beehiiv usa pro asset
 * — `content.free.web` nunca traz alt melhor que `"Author"`/vazio pra
 * NENHUM destes casos (medido ao vivo, #8364), então uma heurística por
 * categoria já é estritamente melhor que o que existe hoje. Nunca lança —
 * path desconhecido cai no genérico.
 */
export function deriveArchiveImageAlt(url: string): string {
  if (url.includes("/user/profile_picture/")) return "Foto de perfil do autor da diar.ia.br";
  if (url.includes("/ad_network/advertiser/logo/")) return "Logotipo do anunciante";
  if (/\/asset\/file\/[^/]+\/[^/]*cover/i.test(url)) return "Capa da edição diar.ia.br";
  return "Imagem da edição diar.ia.br";
}

export interface MigrationFetch {
  (url: string): Promise<ArrayBuffer>;
}
export interface MigrationUpload {
  (bytes: ArrayBuffer, key: string): Promise<void>;
}

export interface MigrationRunOptions {
  pagesDir: string;
  mapPath?: string;
  dryRun: boolean;
  limit?: number;
  fetchImpl: MigrationFetch;
  uploadImpl: MigrationUpload;
  /** Injetável pra teste — evita gravar em disco de verdade quando quem
   * chama só quer inspecionar o resultado. Default: grava. */
  writeMap?: (path: string, contents: string) => void;
}

export interface MigrationRunResult {
  scanned: number;
  alreadyMigrated: number;
  newlyMigrated: { url: string; key: string; alt: string }[];
  failed: { url: string; error: string }[];
  dryRun: boolean;
}

/**
 * Miolo orquestrador — testável sem rede real via `fetchImpl`/`uploadImpl`
 * injetados. `dryRun: true` roda o download real (pra validar que a URL
 * ainda resolve e o alt/key ficam corretos) mas PULA o upload e a escrita
 * do mapa — plano sem efeito colateral.
 */
export async function runArchiveImageMigration(opts: MigrationRunOptions): Promise<MigrationRunResult> {
  const mapPath = opts.mapPath ?? MAP_PATH;
  const { map: existingMap } = loadArchiveImageMigrationMap(mapPath);
  const map: Record<string, ArchiveImageMigrationEntry> = { ...existingMap };

  const urls = new Set<string>();
  const dirEntries = readdirSync(opts.pagesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of dirEntries) {
    const filePath = join(opts.pagesDir, entry.name, "index.html");
    if (!existsSync(filePath)) continue;
    const html = readFileSync(filePath, "utf8");
    for (const url of extractMediaBeehiivImageUrls(html)) urls.add(url);
  }

  const allUrls = [...urls];
  let alreadyMigrated = 0;
  const toProcess: string[] = [];
  for (const url of allUrls) {
    if (Object.hasOwn(map, url)) alreadyMigrated++;
    else toProcess.push(url);
  }
  const limited = opts.limit ? toProcess.slice(0, opts.limit) : toProcess;

  const newlyMigrated: MigrationRunResult["newlyMigrated"] = [];
  const failed: MigrationRunResult["failed"] = [];

  for (const url of limited) {
    const key = deriveArchiveImageKey(url);
    const alt = deriveArchiveImageAlt(url);
    try {
      const bytes = await opts.fetchImpl(url);
      if (!opts.dryRun) {
        await opts.uploadImpl(bytes, key);
        map[url] = { key, alt };
      }
      newlyMigrated.push({ url, key, alt });
    } catch (e) {
      failed.push({ url, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (!opts.dryRun && newlyMigrated.length > 0) {
    const write = opts.writeMap ?? ((path: string, contents: string) => writeFileSync(path, contents, "utf8"));
    // Chaves ordenadas (não `Object.keys(map).sort()` como replacer array —
    // isso filtraria o objeto pra só essas chaves de 1º nível, apagando o
    // wrapper "map") — reconstrói o objeto pra um diff estável no commit.
    const sortedMap: Record<string, ArchiveImageMigrationEntry> = {};
    for (const key of Object.keys(map).sort()) sortedMap[key] = map[key];
    write(mapPath, JSON.stringify({ map: sortedMap }, null, 2) + "\n");
  }

  return { scanned: allUrls.length, alreadyMigrated, newlyMigrated, failed, dryRun: opts.dryRun };
}

async function realFetch(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`download falhou (${res.status})`);
  return res.arrayBuffer();
}

async function main() {
  loadProjectEnv();
  const { values, flags } = parseArgs(process.argv.slice(2));
  const pagesDir = values["dir"] ? resolve(ROOT, values["dir"]) : DEFAULT_DIR;
  const limit = values["limit"] ? Number(values["limit"]) : undefined;

  const hasCreds = !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_WORKERS_TOKEN;
  const explicitDryRun = flags.has("dry-run") || values["dry-run"] === "true";
  const dryRun = explicitDryRun || !hasCreds;
  if (!hasCreds && !explicitDryRun) {
    console.warn(
      "migrate-archive-beehiiv-images: CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_WORKERS_TOKEN ausentes — " +
        "rodando em --dry-run automático (nenhum upload real, mapa não é gravado). " +
        "Sem essas credenciais no ambiente, a migração REAL (execução pendente do #8364) precisa " +
        "rodar numa máquina/sessão com acesso ao KV de produção.",
    );
  }

  // #8364: config lida do mesmo lugar que upload-images-public.ts usa pro
  // KV namespace id (platform.config.json → poll.kv_namespace_id) — mesmo
  // namespace `POLL` que este script escreve.
  let kvNamespaceId: string | undefined;
  if (!dryRun) {
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    kvNamespaceId = cfg?.poll?.kv_namespace_id;
    if (!kvNamespaceId) {
      console.error("migrate-archive-beehiiv-images: platform.config.json → poll.kv_namespace_id não configurado.");
      process.exit(1);
    }
  }

  const uploadImpl: MigrationUpload = async (bytes, key) => {
    // uploadImageToWorkerKV lê de ARQUIVO (assinatura legada, #1119) — grava
    // um temp file de vida curta em vez de reescrever o helper compartilhado
    // só pra este caller aceitar bytes em memória.
    const tmpPath = join(mkdtempSync(join(tmpdir(), "diaria-archive-img-")), "bytes.bin");
    writeFileSync(tmpPath, Buffer.from(bytes));
    await uploadImageToWorkerKV(tmpPath, key, { kvNamespaceId: kvNamespaceId!, workerUrl: ARCHIVE_BASE_URL });
  };

  const result = await runArchiveImageMigration({
    pagesDir,
    dryRun,
    limit,
    fetchImpl: realFetch,
    uploadImpl,
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.failed.length > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}

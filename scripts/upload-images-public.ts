/**
 * upload-images-public.ts
 *
 * Faz upload das imagens da edição (destaques, capa, É IA?, slides) pro
 * Cloudflare KV servido pelo Worker (`/img/{key}`), retornando URLs públicas.
 * Único destino desde #11414 — o ramo Google Drive (`uc?id=`) foi removido;
 * o default já era KV para todos os modos desde #2147.
 *
 * Usado pelo Stage 4 (pré-render) e pelo Stage 5 (publishers sociais leem
 * `06-public-images.json` e passam a URL como `image_url`).
 *
 * Uso:
 *   npx tsx scripts/upload-images-public.ts --edition-dir data/editions/260424/
 *
 * Output (stdout JSON):
 *   {
 *     "out_path": "data/editions/260424/06-public-images.json",
 *     "images": {
 *       "d1_4x5": { "file_id": "img-260424-04-d1-4x5-HASH.jpg", "url": "https://eia.diar.ia.br/img/..." },
 *       "d2_4x5": { ... },
 *       "d3_4x5": { ... }
 *     }
 *   }
 *
 * Cache: escreve em `{edition_dir}/06-public-images.json`. Re-execuções
 * reusam file_ids existentes (skip re-upload).
 *
 * Credenciais: CLOUDFLARE_* do .env + `platform.config.json` → poll.kv_namespace_id.
 *
 * #11412 (fatia 1): com `platform.config.json → public_images_r2.enabled`, as
 * imagens content-addressed sobem pro R2 (`img/{AAMMDD}/…`, env `R2_*`) em vez
 * do KV, com a MESMA forma de URL (`/img/img-{AAMMDD}-…`). Flag desligada (o
 * default) = só KV, como antes. Detalhes e ordem de ativação:
 * `scripts/lib/public-images-r2.ts`.
 *
 * #14001: tipos, specs, cache, chave KV, decisão R2 e a checagem de completude
 * moram em `scripts/lib/public-images-upload.ts` (reexportado abaixo). Aqui
 * ficam `uploadPublicImages`, cujo default regera o carrossel do 4º post por
 * import dinâmico de `gen-carousel-cards.ts` (outro CLI de topo, que lib não
 * importa), e o `main()`.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv(); // #1157 — carrega .env antes de process.env access (CLOUDFLARE_*)

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { uploadImageToWorkerKV } from "./lib/cloudflare-kv-upload.ts"; // #1119
import {
  publicImagesR2InertMessage,
  readPublicImagesR2Settings,
  resolveR2ImageUploader,
  summarizePublicImagesR2Coverage,
  type R2ImageUploader,
} from "./lib/public-images-r2.ts"; // #11412, #12194
import { logEvent, type RunLogEvent } from "./lib/run-log.ts"; // #12194
import { readDestaqueCount } from "./lib/invariant-checks/stage-3.ts"; // #2352
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts"; // #2834
import { DIARIA_EIA_URL } from "./lib/canonical-urls.ts"; // #3904
import { staleUseMelhorImageKeys, type UseMelhorCarouselRefresh } from "./lib/use-melhor-slide-files.ts"; // #9568
import { D1_PLAY_HERO_FILE, D1_PLAY_IMAGE_KEY, D1_PLAY_STAMP_FILE } from "./lib/diaria/d1-video-hero.ts"; // #10784
import { D1_NO_VIDEO_MARKER_FILE, isNoVideoEdition } from "./lib/diaria/d1-no-video.ts"; // #11125
import type { D1PlayImageResult } from "./lib/diaria/d1-play-image.ts"; // #10784 (sharp só carrega via import dinâmico)
import {
  assertCacheCompleteness,
  defaultTargetFor,
  imageSpecsFor,
  kvKeyForSpec,
  md5OfFile,
  mergeBaseFromCache,
  mimeTypeFor,
  shouldReuseCachedUpload,
  shouldUploadToR2,
  useMelhorFontMissingWarning,
  type HostTarget,
  type ImageSpec,
  type PublicImage,
  type PublicImagesOutput,
  type UploadMode,
  type UploadOptions,
  type UploadTarget,
} from "./lib/public-images-upload.ts";

export * from "./lib/public-images-upload.ts";

export async function uploadPublicImages(
  opts: UploadOptions,
): Promise<PublicImagesOutput> {
  const { editionDir } = opts;
  const skipExisting = opts.skipExisting ?? true;
  const forceReupload = opts.forceReupload ?? false;
  const mode = opts.mode ?? "social";
  const target = opts.target ?? defaultTargetFor(mode);

  // Determinar lista de imagens a upload
  let specs: ImageSpec[];
  let useMelhorSlots: string[] = [];
  let useMelhorCarousel: UseMelhorCarouselRefresh | undefined;
  const warnings: string[] = [];
  // #9568: slots do 4º post só quando o carimbo do Stage 3 bate com o texto
  // atual (import dinâmico — o estático fecharia ciclo de módulos, ver
  // `useMelhorSlideSpecs`). Modo newsletter não sobe slides sociais.
  if (mode !== "newsletter") {
    // #10834: `## um` editado depois do Stage 3 deixava o carimbo defasado e
    // os publicadores pulavam o 4º post. Regera o carrossel ANTES de decidir
    // os slots — fail-soft (a função nunca lança; o seam idem por contrato).
    const refresh =
      opts.refreshUseMelhorCarousel ??
      (async (dir: string) => (await import("./gen-carousel-cards.ts")).refreshStaleUseMelhorCarousel(dir));
    try {
      useMelhorCarousel = await refresh(editionDir);
    } catch (e) {
      useMelhorCarousel = { status: "failed", reason: (e as Error).message };
    }
    if (useMelhorCarousel.status === "regenerated") {
      console.error(
        `upload-images-public: carrossel do 4º post estava defasado ('## um' mudou depois do Stage 3) — regerado (#10834).`,
      );
    } else if (useMelhorCarousel.status === "failed" && useMelhorCarousel.cause === "font_missing") {
      // #10879: Georgia ausente (servidor 300). O aviso genérico abaixo mandava
      // "corrigir o motivo" sem dizer qual — e o motivo não tem conserto nesta máquina.
      const msg = useMelhorFontMissingWarning(editionDir);
      console.error(`upload-images-public: ${msg}`);
      warnings.push(msg);
    } else if (useMelhorCarousel.status === "skipped" || useMelhorCarousel.status === "failed") {
      warnings.push(
        `carrossel do 4º post DEFASADO e não regerado (${useMelhorCarousel.status}: ${useMelhorCarousel.reason ?? "sem motivo"}) — ` +
          `os slides não sobem e o 4º post é pulado no LinkedIn/Instagram/Facebook (#10834). ` +
          `Conserto: corrigir o motivo e rodar "npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}" + este upload de novo.`,
      );
    }
    const { freshUseMelhorCarouselSlots } = await import("./lib/use-melhor-dispatch.ts");
    useMelhorSlots = freshUseMelhorCarouselSlots(editionDir);
  }
  specs = imageSpecsFor(mode, editionDir, { useMelhorSlots });

  // #11125: edição marcada como sem vídeo (`_internal/no-video.json`) — a
  // cópia com o convite não é gerada nem sobe, e a que sobrou de uma rodada
  // anterior (com o carimbo) sai do disco; a chave `d1_play` sai do cache logo
  // abaixo. Sem isso, cada upload em modo newsletter regerava o convite.
  const noVideo = mode !== "social" && isNoVideoEdition(editionDir);
  if (noVideo) {
    specs = specs.filter((s) => s.key !== D1_PLAY_IMAGE_KEY);
    rmSync(resolve(editionDir, D1_PLAY_HERO_FILE), { force: true });
    rmSync(resolve(editionDir, D1_PLAY_STAMP_FILE), { force: true });
    console.error(
      `upload-images-public: edição sem vídeo (${D1_NO_VIDEO_MARKER_FILE}) — D1 sai com o hero puro, sem convite nem link (#11125).`,
    );
  }

  // #10784: a cópia do hero do D1 com o convite escrito é derivada — (re)gera
  // antes do upload sempre que o hero mudou. Fail-soft: sem a cópia, a
  // newsletter usa o hero original SEM link pro vídeo/canal (#10995 —
  // `d1VideoHeroFields` devolve `{}`).
  if (mode !== "social" && specs.some((s) => s.key === D1_PLAY_IMAGE_KEY)) {
    const ensure =
      opts.ensureD1PlayImage ??
      (async (dir: string) => (await import("./lib/diaria/d1-play-image.ts")).ensureD1PlayImage(dir));
    let play: D1PlayImageResult;
    try {
      play = await ensure(editionDir);
    } catch (e) {
      // Cópia antiga pode ser de outra arte — sem regerar, não pode ir pro e-mail.
      rmSync(resolve(editionDir, D1_PLAY_HERO_FILE), { force: true });
      play = { status: "failed", path: null, reason: (e as Error).message };
    }
    if (play.status === "failed") {
      const msg = `cópia do hero do D1 com o convite NÃO gerada (${play.reason}) — a newsletter sai com o hero original SEM link pro vídeo/canal (#10784, #10995)`;
      console.error(`upload-images-public: ${msg}`);
      warnings.push(msg);
    } else if (play.status === "generated") {
      console.error(`upload-images-public: ${D1_PLAY_HERO_FILE} gerado a partir do hero do D1 (#10784).`);
    }
  }

  const cachePath = resolve(editionDir, "06-public-images.json");
  // #1865: SEMPRE carregar o `06-public-images.json` existente como base do
  // merge — preserva entries de OUTROS modos (cover/eia_a/eia_b do newsletter
  // quando o social roda, e d1/d2/d3 do social quando o newsletter roda). Os
  // dois modos gravam no mesmo arquivo. `--no-cache` (skipExisting=false) deve
  // forçar só RE-UPLOAD (decisão de reuse abaixo, que já gateia em skipExisting),
  // NÃO apagar o merge cross-mode. Antes, `--no-cache` zerava a base (`{}`) e o
  // modo que rodava por último sobrescrevia as chaves do outro → cover/É IA?
  // sumiam e a newsletter quase saiu sem capa (260605).
  const existing = mergeBaseFromCache(cachePath); // snapshot imutável (reuse + cloudflare_url lookup)
  const images: Record<string, PublicImage> = { ...existing }; // base mutável do merge
  // #11125: sem vídeo, a URL da cópia com o convite não pode sobrar no cache.
  if (noVideo) delete images[D1_PLAY_IMAGE_KEY];

  // #1865: uploaders injetáveis (default = reais). Testes stubbam pra exercitar
  // o merge sem rede.
  const uploadToCloudflare = opts.uploaders?.uploadToCloudflare ?? uploadImageToWorkerKV;

  // Cloudflare config (lazy — só carrega com o uploader real).
  // Quando opts.uploaders.uploadToCloudflare é injetado (testes), o cfConfig
  // não é necessário — o stub ignora o 3º arg. Isso elimina a dependência
  // implícita de platform.config.json nos testes (#2147 finding 6).
  let cfConfig: { kvNamespaceId: string; workerUrl: string } | null = null;
  let uploadToR2: R2ImageUploader | null = opts.uploaders?.uploadToR2 ?? null;
  // #12194: a flag como o upload a viu. Uploader R2 injetado (testes) conta
  // como ligada; com a config real, vale `public_images_r2.enabled` (inclusive
  // ligada sem env, que é justamente o caso de alarme).
  let r2FlagEnabled = uploadToR2 !== null;
  if (!opts.uploaders?.uploadToCloudflare) {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
    const kvNamespaceId = cfg?.poll?.kv_namespace_id;
    const workerUrl = cfg?.poll?.worker_url ?? DIARIA_EIA_URL; // #3904
    if (!kvNamespaceId) {
      throw new Error("platform.config.json → poll.kv_namespace_id não configurado (target=cloudflare)");
    }
    cfConfig = { kvNamespaceId, workerUrl };
    // #11412: R2 atrás da flag; sem credencial, avisa e segue no KV.
    if (opts.uploaders?.uploadToR2 === undefined) {
      const r2Settings = readPublicImagesR2Settings(cfg);
      r2FlagEnabled = r2Settings.enabled;
      const r2 = resolveR2ImageUploader(r2Settings, process.env, workerUrl);
      uploadToR2 = r2.uploader;
      if (r2.warning) warnings.push(r2.warning);
    }
  }

  for (const spec of specs) {
    const imagePath = resolve(editionDir, spec.filename);
    if (!existsSync(imagePath)) {
      // #1701: specs best-effort (d2/d3 no newsletter mode) pulam quando ausentes
      // — não bloqueiam o upload do que o email de fato usa (cover/d1/eia).
      if (spec.optional) {
        // #5085: se JÁ existe uma entry cacheada pra essa key (upload anterior
        // teve sucesso), o `continue` abaixo preserva esse cache antigo sem
        // NENHUMA reverificação — é exatamente esse silêncio que permitiu o
        // incidente ao vivo da edição 260812 (arquivo local sumiu após um
        // rename malsucedido sob junction OneDrive, e o cache stale seguiu
        // sendo servido como se fosse válido). Não bloqueamos o upload (a
        // maioria dos specs `optional` legitimamente nunca teve upload nenhum
        // — `existing[spec.key]` ausente é o caso normal), mas tornamos o
        // reuse do cache stale AUDITÁVEL em vez de silencioso.
        if (existing[spec.key]) {
          warnings.push(
            `${spec.key} (${spec.filename}): arquivo local ausente, mas 06-public-images.json ` +
              `tem uma entry cacheada de upload anterior — mantendo essa URL antiga SEM revalidar ` +
              `hash/existência. Confirme que o arquivo não sumiu por engano (ex: reorder-destaques.ts ` +
              `sob sync do Drive, #5085) antes de publicar.`,
          );
        }
        continue;
      }
      throw new Error(`Imagem não encontrada: ${imagePath}`);
    }
    const mime = mimeTypeFor(spec.filename);
    const localMd5 = md5OfFile(imagePath);

    // #1418: cache hit + md5 match → reuse. md5 ausente (entries pre-#1418)
    // OU entry legada do Drive OU bytes locais diferem → re-uploadar.
    // #1865: a decisão de REUSE ainda gateia em `skipExisting` (--no-cache →
    // false → reuse=false → re-upload). `existing[spec.key]` só alimenta o
    // shouldReuse e a preservação de cloudflare_url; não força reuse sozinho.
    const cached = existing[spec.key];
    // #11412: o target desta imagem — R2 ou KV — entra no reuse: entry de um
    // host diferente do atual é re-uploadada (ligar a flag migra o cache).
    const kvKey = kvKeyForSpec(editionDir, spec, localMd5);
    const specTarget: HostTarget = shouldUploadToR2(spec, kvKey, uploadToR2 !== null) ? "r2" : target;
    let reuse =
      skipExisting && !forceReupload && shouldReuseCachedUpload(cached, imagePath, specTarget, localMd5);
    // #1704 self-heal: pra cloudflare, a key cacheada precisa bater com a que
    // gravaríamos agora. Uma key legacy do É IA? COM hash (cacheada antes do
    // noCacheBust) passa no check de md5 mas aponta pra key errada → /vote 404.
    // Forçar re-upload nesse caso pra a key sem hash de fato cair no KV.
    if (reuse && cached?.file_id !== kvKey) {
      reuse = false;
    }
    if (reuse) continue;

    // #1584: md5 suffix no key cache-busts re-uploads.
    // #1704: imagens do É IA? (spec.noCacheBust) NÃO recebem o sufixo — o
    // Worker /vote monta a URL com convenção fixa sem hash; com sufixo dá 404.
    const key = kvKey;
    let url: string | null = null;
    let hostTarget: HostTarget = specTarget;
    if (specTarget === "r2") {
      try {
        url = await uploadToR2!(imagePath, key, mime);
      } catch (e) {
        // #11412: falha do R2 nunca deixa a edição sem a imagem — vai pro KV.
        warnings.push(`${spec.key} (${spec.filename}): upload pro R2 falhou (${(e as Error).message}) — enviada pro KV, como antes (#11412).`);
        hostTarget = target;
      }
    }
    if (url === null) url = await uploadToCloudflare(imagePath, key, cfConfig!);
    images[spec.key] = {
      file_id: key,
      url,
      mime_type: mime,
      filename: spec.filename,
      target: hostTarget,
      md5: localMd5,
      cloudflare_url: url,
    };
  }

  // #9795: chaves de slide do 4º post sem arquivo local (sobra de um render
  // com mais slides — `## um` reescrito mais curto) saem do cache; senão o
  // publish/preview seguiam montando o carrossel com slides que não existem.
  // Slots do carimbo atual (quando fresco) nunca são podados aqui (arquivo
  // atual sumido é o caso #5085, que já avisa e mantém).
  for (const key of staleUseMelhorImageKeys(images, editionDir, useMelhorSlots)) {
    delete images[key];
    warnings.push(`${key}: slide do 4º post sem arquivo local (render anterior com mais slides) — removido de 06-public-images.json (#9795).`);
  }

  writeFileSync(
    cachePath,
    JSON.stringify({ images }, null, 2) + "\n",
    "utf8",
  );

  // #12194: flag ligada e a edição inteira no KV (env ausente, PUT/HEAD
  // falhando em todas) — o fallback é seguro, mas sem isto a migração fica
  // inerte sem ninguém ver. Aviso + `warn` no run-log, que
  // `collect-edition-signals.ts` leva ao auto-reporter.
  const r2Coverage = summarizePublicImagesR2Coverage(images, r2FlagEnabled);
  if (r2Coverage.inert) {
    const message = publicImagesR2InertMessage(r2Coverage);
    warnings.push(message);
    const logRunEvent = opts.logRunEvent ?? (opts.uploaders ? undefined : (e: RunLogEvent) => void logEvent(e));
    const editionBase = basename(resolve(editionDir));
    logRunEvent?.({
      edition: /^\d{6}$/.test(editionBase) ? editionBase : null,
      stage: null,
      agent: "upload-images-public",
      level: "warn",
      message,
      details: { eligible: r2Coverage.eligible, r2: r2Coverage.r2, kv: r2Coverage.kv, kv_keys: r2Coverage.kvKeys, mode },
    });
  }

  for (const w of warnings) {
    console.warn(`⚠️  upload-images-public: ${w}`);
  }

  return {
    out_path: cachePath,
    images,
    warnings,
    r2_coverage: r2Coverage,
    ...(useMelhorCarousel && { use_melhor_carousel: useMelhorCarousel }),
  };
}

// #7596: hero2x1KeyFor migrou pra lib/shared/public-image-keys.ts (módulo

async function main(): Promise<void> {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const argv = process.argv.slice(2);
  // #2834: migrado pra lib/cli-args.ts. O parser local tinha 3 flags booleanas
  // INCONDICIONAIS (checadas antes do loop genérico, nunca consomem o próximo
  // token) — via argv.includes. #1275: --no-require-keys opt-out de validação.
  // #1418: --force-reupload ignora cache md5/target e força upload de novo.
  // O restante (--edition-dir, --mode, --target) consumia o PRÓXIMO token
  // INCONDICIONALMENTE (mesmo que comece com "--") — equivalente a
  // parseArgsSimple, não parseArgs. Filtramos os bool flags do argv antes de
  // rodar parseArgsSimple pra eles não serem "engolidos" como valor de um
  // --key anterior (no parser local eles também nunca eram consumidos como
  // valor — o branch booleano rodava primeiro pra esses tokens).
  const BOOL_FLAG_TOKENS = new Set(["--no-cache", "--no-require-keys", "--force-reupload"]);
  const noCache = argv.includes("--no-cache");
  const noRequireKeys = argv.includes("--no-require-keys");
  const forceReupload = argv.includes("--force-reupload");
  const args = parseArgsSimple(argv.filter((a) => !BOOL_FLAG_TOKENS.has(a)));
  const editionDirArg = args["edition-dir"];
  if (typeof editionDirArg !== "string") {
    console.error(
      "Uso: upload-images-public.ts --edition-dir <path> [--mode social|newsletter|all] [--target cloudflare] [--no-cache] [--force-reupload]\n" +
        "\n" +
        "Target: sempre 'cloudflare' (KV). O ramo Drive foi removido no #11414.\n" +
        "--force-reupload: ignora cache md5/target e força re-upload (recovery após bytes locais mudarem).",
    );
    process.exit(1);
  }
  const editionDir = resolve(ROOT, editionDirArg);
  const skipExisting = !noCache;
  const modeArg = args.mode;
  const mode: UploadMode =
    modeArg === "newsletter" || modeArg === "all" || modeArg === "social"
      ? modeArg
      : "social";

  const targetArg = args.target;
  if (targetArg !== undefined && targetArg !== "cloudflare") {
    // #11414: `--target drive` deixou de existir — falhar alto em vez de cair
    // em silêncio no KV, pra quem ainda tem o escape hatch antigo em script/doc.
    console.error(
      `upload-images-public: --target ${String(targetArg)} não é suportado — o único destino é 'cloudflare' (ramo Drive removido no #11414).`,
    );
    process.exit(1);
  }
  const target: UploadTarget | undefined = targetArg === "cloudflare" ? targetArg : undefined;

  const result = await uploadPublicImages({ editionDir, mode, skipExisting, target, forceReupload });
  console.log(JSON.stringify(result, null, 2));

  // #1275: validate cache completeness por default. Opt-out via --no-require-keys
  // pra casos onde caller sabe que cache final é parcial (raro).
  // #2352: pass destaque_count so d3 is not required for 2-destaque editions.
  const requireKeys = !noRequireKeys;
  if (requireKeys) {
    const dc = readDestaqueCount(editionDir);
    try {
      assertCacheCompleteness(result.images, mode, dc);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(2);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error("Fatal error:", e);
    process.exit(1);
  });
}

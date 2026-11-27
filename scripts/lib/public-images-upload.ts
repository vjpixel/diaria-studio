/**
 * scripts/lib/public-images-upload.ts — lógica de `upload-images-public.ts`
 *
 * Movida do CLI `scripts/upload-images-public.ts` em #14001, sem mudança de
 * comportamento: tipos, specs de imagem por modo, cache
 * `06-public-images.json`, chave KV, decisão R2 e a checagem de completude do
 * cache. O CLI ficou com `uploadPublicImages` (a orquestração do upload, que
 * regera o carrossel do 4º post por import dinâmico de `gen-carousel-cards.ts`,
 * outro CLI de topo que lib não importa) e com o `main()`, e reexporta este
 * módulo. Sem efeito de topo: o `.env` é carregado pelo CLI (#1157).
 *
 * Doc do fluxo completo (destinos, cache, credenciais, R2): cabeçalho de
 * `scripts/upload-images-public.ts`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  r2KeyForImageKey,
  type PublicImagesR2Coverage,
  type R2ImageUploader,
} from "./public-images-r2.ts"; // #11412, #12194
import type { RunLogEvent } from "./run-log.ts"; // #12194
import { readDestaqueCount } from "./invariant-checks/stage-3.ts"; // #2352
import { md5OfFile } from "./shared/file-md5.ts"; // #6068 (era local, #1418)
import { cloudflareKvKey } from "./cloudflare-kv-key.ts"; // #13997 (era local)
import { hero2x1KeyFor, isDestaqueImagePresent } from "./shared/public-image-keys.ts"; // #7596 — extraído pra módulo puro
import {
  useMelhorSlideFilename,
  useMelhorSlideImageKey,
  type UseMelhorCarouselRefresh,
} from "./use-melhor-slide-files.ts"; // #9568 — slides do 4º post (módulo folha: use-melhor-carousel.ts fecharia ciclo via weekly-flat-card.ts)
import { D1_PLAY_HERO_FILE, D1_PLAY_IMAGE_KEY } from "./diaria/d1-video-hero.ts"; // #10784
import type { D1PlayImageResult } from "./diaria/d1-play-image.ts"; // #10784 (sharp só carrega via import dinâmico)

export interface PublicImage {
  /** Cloudflare KV key (target=cloudflare). Entries legadas `target=drive` guardam o file_id do Drive. #1119 */
  file_id: string;
  url: string;
  mime_type: string;
  filename: string;
  /**
   * Target onde a imagem está hospedada (#1119). "cloudflare" = KV `POLL`;
   * "r2" = bucket R2 de mídia (#11412, atrás de `public_images_r2.enabled`);
   * "drive" só aparece em caches de edições antigas (o upload pro Drive foi
   * removido no #11414) e ausente = entry muito antiga (tratada como drive).
   * Entry com target diferente do que este upload usaria é re-uploadada (ver
   * `shouldReuseCachedUpload`) — ligar/desligar a flag migra o cache sozinho.
   */
  target?: "drive" | "cloudflare" | "r2";
  /** #1418: md5 dos bytes locais no momento do upload — pra detectar drift
   * em re-runs (imagem regerada local com bytes novos mas cache aponta pro
   * upload antigo). Ausente em entries pre-#1418 → assume drift e re-uploadar. */
  md5?: string;
  /** #1584: Cloudflare URL persistente, separada de `url`. Quando uma key
   * (ex: `d1`) é uploadada primeiro pra Cloudflare (mode=newsletter) e depois
   * pra Drive (mode=social), a Cloudflare URL antes era perdida ao overwrite.
   * Agora preservada aqui pro renderer do social preview continuar resolvendo. */
  cloudflare_url?: string;
}

/**
 * Target de hospedagem das imagens (#1119). Só "cloudflare" desde #11414 —
 * o escape hatch `--target drive` foi removido junto com o ramo Drive.
 */
export type UploadTarget = "cloudflare";

/** Onde uma imagem de fato fica: o target do CLI ou o R2 (#11412). */
export type HostTarget = UploadTarget | "r2";

/**
 * Default de target por modo (#1119, unificado em #2147):
 * todos os modes → cloudflare (KV). Parâmetro `mode` mantido por compat de
 * assinatura; ignorado — o retorno é sempre "cloudflare".
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function defaultTargetFor(_mode: UploadMode): UploadTarget {
  return "cloudflare";
}

export interface PublicImagesOutput {
  out_path: string;
  images: Record<string, PublicImage>;
  /**
   * #5085: specs `optional` cujo arquivo local está ausente MAS há uma entry
   * cacheada pré-existente pra essa key — o cache antigo é mantido (mesmo
   * comportamento de sempre), mas agora de forma AUDITÁVEL em vez de
   * silenciosa. Vazio na maioria das rodadas.
   */
  warnings: string[];
  /**
   * #12194: quantas imagens elegíveis da edição estão no R2 contra no KV, e se
   * a migração ficou inerte (flag ligada, 0 no R2). Sempre presente.
   */
  r2_coverage: PublicImagesR2Coverage;
  /**
   * #10834: conferência do carrossel do 4º post antes do upload (modo
   * social/all). Ausente no modo newsletter.
   */
  use_melhor_carousel?: UseMelhorCarouselRefresh;
}

/** Detecta mime type básico por extensão. */
export function mimeTypeFor(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

/**
 * Mapeamento de imagens por modo:
 * - social: cards 4:5 + heros 2:1 + carrossel — pra LinkedIn/Instagram.
 * - newsletter: cover 2x1 (= D1 inline), D2, D3, É IA? real + IA —
 *   pra Custom HTML block do Beehiiv (#74).
 * - all: union dos dois.
 *
 * Chaves usadas como `images[key].url` downstream.
 */
export type UploadMode = "social" | "newsletter" | "all";

export interface ImageSpec {
  key: string;
  filename: string;
  /**
   * #1704: quando true, a KV key NÃO recebe o sufixo md5 de cache-bust (#1584).
   * Usado pelas imagens do É IA? (A/B): o Worker `poll` monta a URL do /vote
   * com convenção FIXA `/img/img-{AAMMDD}-01-eia-{A|B}.jpg` (sem hash). Com o
   * sufixo md5 a key gravada não bate com essa URL → /vote dá 404 em TODA edição.
   *
   * Trade-off (honesto): sem o sufixo, regenerar a imagem no MESMO edition
   * reescreve a mesma key (sem cache-bust). Isso é aceitável porque (a) o /vote
   * 404 é certo e recorrente, enquanto regen-após-envio é raro; e (b) o É IA?
   * já era servido por convenção fixa de key antes do #1584 (design #1242). NÃO
   * conte com o TTL 1h do edge pra invalidar cache do Gmail Image Proxy (que
   * cacheia por URL e ignora max-age) — a real justificativa é a convenção fixa
   * do /vote, não o TTL. cover/d1 vão pro email e MANTÊM o cache-bust por hash.
   */
  noCacheBust?: boolean;
  /**
   * #1701: spec best-effort — se o arquivo não existir, PULA (não lança). Usado
   * pra d2/d3 no newsletter mode: eles sobem ao Cloudflare KV só pro social
   * preview (o EMAIL não os usa), então não devem bloquear o newsletter-mode
   * upload (que roda standalone na publicação manual/email — caso 260602 review).
   */
  optional?: boolean;
}

/**
 * #9568: specs dos slides do carrossel do 4º post (`04-um-carousel-{slot}-4x5.jpg`
 * → chave `um_carousel_{slot}`), na ordem dos `slots` recebidos. Pure — quem
 * decide QUAIS slots valem (só os de carimbo em dia com o texto, nunca arte de
 * carimbo defasado) é `freshUseMelhorCarouselSlots` em `use-melhor-dispatch.ts`,
 * chamado por `uploadPublicImages` via import dinâmico (import estático fecharia
 * o ciclo weekly-flat-card → upload-images-public → use-melhor-carousel).
 */
export function useMelhorSlideSpecs(slots: readonly string[]): ImageSpec[] {
  return slots.map((slot) => ({
    key: useMelhorSlideImageKey(slot),
    filename: useMelhorSlideFilename(slot),
    optional: true,
  }));
}

/**
 * Especifica quais imagens fazer upload por modo. Quando `editionDir` é
 * passado e o modo inclui newsletter, detecta o naming É IA? em disco:
 * novas edições usam `01-eia-A.jpg`/`01-eia-B.jpg` (#192, random); edições
 * antigas usam `01-eia-real.jpg`/`01-eia-ia.jpg`. Sem `editionDir`, default
 * pra naming novo (A/B).
 *
 * #2352: quando `editionDir` é passado, lê destaque_count de
 * `_internal/01-approved-capped.json`. Se count==2, omite as specs do D3
 * (não requer nem espera imagens d3 nessa edição). Default 3 preserva o
 * comportamento anterior para edições 3-destaque e chamadas sem editionDir.
 */
export function imageSpecsFor(
  mode: UploadMode,
  editionDir?: string,
  /** #9568: slots EM DIA do carrossel do 4º post (default: nenhum). */
  opts: { useMelhorSlots?: readonly string[] } = {},
): ImageSpec[] {
  // #2352: determine destaque count to conditionally include d3 specs.
  const destaqueCount: 2 | 3 = editionDir ? readDestaqueCount(editionDir) : 3;

  const social: ImageSpec[] = [
    // #7399: chave BASE (1:1) removida do upload — sem consumidor real (o
    // fallback do 4:5 nunca disparava porque gen-social-card-4x5.ts é
    // bloqueante, #4090). Desde o #12226 o arquivo local `04-d{N}-1x1.jpg`
    // também deixou de ser gerado. Publishers agora caem no hero 2:1
    // (`cover`/`d{N}_2x1`, sempre presente) quando o 4:5 falta.
    //
    // Card 4:5 (1080x1350, título embutido) gerado por gen-social-card-4x5.ts.
    // optional: edições sem card seguem publicando via fallback 2:1.
    { key: "d1_4x5", filename: "04-d1-4x5.jpg", optional: true },
    { key: "d2_4x5", filename: "04-d2-4x5.jpg", optional: true },
    ...(destaqueCount === 3
      ? [{ key: "d3_4x5", filename: "04-d3-4x5.jpg", optional: true }]
      : []),
    // #6005 Parte B: 4 slides sem foto do carrossel diário (3 parágrafos +
    // CTA) por destaque, gerados por `gen-carousel-cards.ts` no Stage 3.
    // optional: `resolveCarouselImageUrls` (daily-carousel-card.ts) já cai
    // pro post single-image se QUALQUER um destes faltar — não bloquear o
    // upload do resto por um carrossel parcial/ausente (edição legada, ou
    // geração pulada nesta rodada).
    ...["d1", "d2", ...(destaqueCount === 3 ? ["d3"] : [])].flatMap((d) =>
      ["p1", "p2", "p3", "cta"].map((slot) => ({
        key: `${d}_carousel_${slot}`,
        filename: `04-${d}-carousel-${slot}-4x5.jpg`,
        optional: true,
      })),
    ),
    // #9568: carrossel tipográfico do 4º post (USE MELHOR) — N slides
    // variável (capa → p1..pN → cta), só os slots de carimbo em dia
    // (`opts.useMelhorSlots`). optional: o 4º post é fail-soft
    // (tudo-ou-nada em `resolveUseMelhorCarouselImageUrls`) e nunca pode
    // bloquear o upload dos destaques.
    ...useMelhorSlideSpecs(opts.useMelhorSlots ?? []),
  ];

  const eaiSpecs = (() => {
    const newA = editionDir ? resolve(editionDir, "01-eia-A.jpg") : null;
    const newB = editionDir ? resolve(editionDir, "01-eia-B.jpg") : null;
    if (newA && newB && existsSync(newA) && existsSync(newB)) {
      return [
        { key: "eia_a", filename: "01-eia-A.jpg", noCacheBust: true },
        { key: "eia_b", filename: "01-eia-B.jpg", noCacheBust: true },
      ];
    }
    if (editionDir) {
      const oldReal = resolve(editionDir, "01-eia-real.jpg");
      if (existsSync(oldReal)) {
        return [
          { key: "eia_real", filename: "01-eia-real.jpg", noCacheBust: true },
          { key: "eia_ia", filename: "01-eia-ia.jpg", noCacheBust: true },
        ];
      }
    }
    // Default sem disco: assume novo naming (caso de teste / dry-run).
    return [
      { key: "eia_a", filename: "01-eia-A.jpg", noCacheBust: true },
      { key: "eia_b", filename: "01-eia-B.jpg", noCacheBust: true },
    ];
  })();

  // #1121: newsletter mode upload-a o que o renderer substitui via `{{IMG:...}}`:
  // cover D1 (2x1), D2 hero (2x1), D3 hero (2x1), É IA? A/B.
  //
  // #2133/#2141: D2 e D3 passaram a ter hero inline 2:1 no email. Os arquivos
  // `04-d2-2x1.jpg` e `04-d3-2x1.jpg` são gerados pelo Stage 3 e substituem os
  // placeholders `{{IMG:04-d2-2x1.jpg}}` / `{{IMG:04-d3-2x1.jpg}}`.
  //
  // #7399: chaves BASE (1:1) de d1/d2/d3 removidas — sem consumidor real do
  // upload (arquivo local continua gerado, só o KV upload foi cortado). O
  // hero 2:1 (`cover` = d1, `d2_2x1`/`d3_2x1`) agora é o fallback direto dos
  // publishers sociais quando o card 4:5 falta — ver resolvePublicCardImageUrl
  // em publish-linkedin.ts e os fallbacks equivalentes em publish-instagram.ts
  // /prep-twitter-posts.ts.
  const newsletter: ImageSpec[] = [
    { key: "cover", filename: "04-d1-2x1.jpg" },
    // #10784: cópia do hero do D1 com o convite escrito, gerada por
    // `ensureD1PlayImage` logo antes do upload. optional: falha ao gerar cai
    // no hero sem convite e sem link (o render só usa a cópia quando ela existe).
    { key: D1_PLAY_IMAGE_KEY, filename: D1_PLAY_HERO_FILE, optional: true },
    // #2133/#2141: d2/d3 hero 2x1 entram no email como {{IMG:04-d{N}-2x1.jpg}}.
    // optional=true: não bloqueiam o upload se ausentes (ex: re-run de edição
    // pré-#2133, ou regeneração manual falhou parcialmente). Desde #7399, este
    // é também o fallback direto dos publishers sociais (não passa mais pelo
    // 1:1 legado) — ver comentário acima.
    { key: "d2_2x1", filename: "04-d2-2x1.jpg", optional: true },
    // #2352: d3_2x1 only expected when destaque_count == 3.
    ...(destaqueCount === 3 ? [{ key: "d3_2x1", filename: "04-d3-2x1.jpg", optional: true }] : []),
    // #1808: box promo de livros (entre D1 e D2 no email, renderMidCallout).
    // optional — nem toda edição tem o box. Mantém o md5 cache-bust (#1584): a
    // URL é per-edição (`img-{AAMMDD}-04-livros-promo.jpg`) e o sufixo md5 evita
    // que o proxy de imagem do Gmail sirva uma promo stale se o arquivo for
    // regerado. readMidCalloutImage lê a entry `livros_promo`; sem este produtor
    // o box degradava pra só-texto silenciosamente (achado #1 da review do #1807).
    { key: "livros_promo", filename: "04-livros-promo.jpg", optional: true },
    // Imagem ARBITRÁRIA por slot de box de divulgação (capa de livro, header de
    // artigo, etc). Diferente de `livros_promo`, que só é associada ao box de
    // livros (`isBoxDivulgacaoLivros`, #2136), estas valem pra qualquer snippet
    // que caia no slot — a associação é posicional, não por link de destino.
    // optional: a maioria das edições não tem nenhuma.
    { key: "box_slot0_image", filename: "04-box-slot0.jpg", optional: true }, // #4274
    { key: "box_slot1_image", filename: "04-box-slot1.jpg", optional: true },
    { key: "box_slot2_image", filename: "04-box-slot2.jpg", optional: true },
    { key: "box_slot3_image", filename: "04-box-slot3.jpg", optional: true },
    ...eaiSpecs,
  ];
  if (mode === "social") return social;
  if (mode === "newsletter") return newsletter;
  // all — dedup por key (eaiSpecs em newsletter, d1/d2/d3 em social)
  const seen = new Set<string>();
  const out: ImageSpec[] = [];
  for (const s of [...social, ...newsletter]) {
    if (seen.has(s.key)) continue;
    seen.add(s.key);
    out.push(s);
  }
  return out;
}

function loadCache(cachePath: string): Record<string, PublicImage> {
  if (!existsSync(cachePath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return (parsed.images ?? {}) as Record<string, PublicImage>;
  } catch {
    return {};
  }
}

/**
 * #1865: base do merge cross-mode do `06-public-images.json` — SEMPRE o arquivo
 * existente, independente de `--no-cache`. Os modos `newsletter` (cover/eia_*) e
 * `social` (d1/d2/d3) gravam no MESMO arquivo; o modo que roda por último faz
 * spread por cima desta base, preservando as chaves do outro modo.
 *
 * `--no-cache` (skipExisting=false) afeta SÓ a decisão de re-upload (reuse), NÃO
 * a base do merge. Antes, `--no-cache` zerava a base (`{}`) e o social mode
 * apagava cover/eia do newsletter (260605, quase publicou sem capa).
 */
export function mergeBaseFromCache(cachePath: string): Record<string, PublicImage> {
  return { ...loadCache(cachePath) };
}

// #1418, movido pra `lib/shared/file-md5.ts` no #6068 (invariantes de Stage 4
// precisam do md5 sem carregar .env/googleapis) — re-exportado aqui pros
// callers e testes que já importavam daqui.
export { md5OfFile };

/**
 * #1418: decide se um cached entry pode ser reused pra um source path local.
 * Reuse OK quando:
 *   1. cache tem file_id válido (upload anterior teve sucesso), E
 *   2. target bate (entry legada `drive`, ou sem target, nunca é reusada), E
 *   3. md5 do cache bate com md5 atual do arquivo local
 *      (ausência de md5 no cache = entry pre-#1418 → assume drift, re-upload).
 */
export function shouldReuseCachedUpload(
  cached: PublicImage | undefined,
  imagePath: string,
  target: HostTarget,
  localMd5?: string,
): boolean {
  if (!cached?.file_id) return false;
  if ((cached.target ?? "drive") !== target) return false;
  if (!cached.md5) return false;
  return cached.md5 === (localMd5 ?? md5OfFile(imagePath));
}

/**
 * #1704: constrói a KV key Cloudflare pra um spec, omitindo o sufixo md5 de
 * cache-bust (#1584) quando `spec.noCacheBust` (imagens do É IA?, que precisam
 * casar com a convenção fixa do Worker /vote). Single source of truth — usado
 * tanto pra decidir reuse (self-heal de keys legacy) quanto pro upload.
 */
export function kvKeyForSpec(
  editionDir: string,
  spec: ImageSpec,
  localMd5: string,
): string {
  return cloudflareKvKey(editionDir, spec.filename, spec.noCacheBust ? undefined : localMd5);
}

export interface UploadOptions {
  editionDir: string;
  /** Modo de seleção de imagens (social | newsletter | all). Default: social. */
  mode?: UploadMode;
  skipExisting?: boolean;
  /** Target de hospedagem (#1119). Default deriva do mode via `defaultTargetFor`. */
  target?: UploadTarget;
  /** #1418: ignora cache md5/target e força re-upload. Útil pra recovery. */
  forceReupload?: boolean;
  /**
   * #1865: seam de injeção pro upload de rede (Cloudflare KV). Default usa a
   * implementação real; testes injetam stubs pra exercitar o merge cross-mode
   * sem rede.
   */
  uploaders?: UploadDeps;
  /**
   * #10834: seam da regeração do carrossel do 4º post defasado. Default:
   * `refreshStaleUseMelhorCarousel` de `gen-carousel-cards.ts` (import
   * dinâmico — sharp + fonte de marca só carregam no modo social).
   */
  refreshUseMelhorCarousel?: (editionDir: string) => Promise<UseMelhorCarouselRefresh>;
  /** #10784: seam da geração da cópia do hero do D1 com play (default: sharp real). */
  ensureD1PlayImage?: (editionDir: string) => Promise<D1PlayImageResult>;
  /**
   * #12194: seam do `warn` no run-log quando a flag R2 está ligada e a edição
   * caiu toda no KV. Default: `logEvent` real (data/run-log.jsonl) só com os
   * uploaders reais; com uploaders injetados (testes), nada é gravado a menos
   * que o teste passe este seam.
   */
  logRunEvent?: (event: RunLogEvent) => void;
}

export interface UploadDeps {
  uploadToCloudflare?: (
    imagePath: string,
    key: string,
    cfg: { kvNamespaceId: string; workerUrl: string },
  ) => Promise<string>;
  /**
   * #11412: uploader R2 (recebe a key no formato KV, `img-{AAMMDD}-…`, e
   * devolve a URL pública). `null` desliga o R2. Ausente: com o uploader KV
   * real, resolve pela flag `public_images_r2` + env; com o KV injetado
   * (testes), desligado — o teste não lê `platform.config.json`.
   */
  uploadToR2?: R2ImageUploader | null;
}

/**
 * #11412: a imagem vai pro R2? Só com uploader R2 ativo, só key
 * content-addressed (o É IA?, `noCacheBust`, fica no KV: o `/vote` monta a URL
 * com nome fixo) e só key com forma `img-{AAMMDD}-…`.
 */
export function shouldUploadToR2(spec: Pick<ImageSpec, "noCacheBust">, kvKey: string, r2Active: boolean): boolean {
  return r2Active && !spec.noCacheBust && r2KeyForImageKey(kvKey) !== null;
}

// #13997: `cloudflareKvKey` mora em lib/cloudflare-kv-key.ts (lib não importa
// CLI de topo, #14001); reexportada aqui para os consumidores atuais.
export { cloudflareKvKey };

/**
 * (#10879) Aviso do carrossel do 4º post defasado que não pôde ser regerado
 * porque a fonte de marca (Georgia) não existe nesta máquina. Georgia não é
 * redistribuível (#4090), então o conserto é rodar a geração numa máquina com
 * ela (ou aceitar o fallback de fonte de propósito) — nunca "tentar de novo aqui".
 */
export function useMelhorFontMissingWarning(editionDir: string): string {
  return (
    `carrossel do 4º post DEFASADO e NÃO regerado: a fonte Georgia não existe nesta máquina (#10879). ` +
    `O 4º post (USE MELHOR) vai ser PULADO no LinkedIn/Instagram/Facebook (#10834). ` +
    `Conserto: numa máquina com Georgia (Windows/macOS), rodar ` +
    `"npx tsx scripts/gen-carousel-cards.ts --edition-dir ${editionDir}" e ` +
    `"npx tsx scripts/upload-images-public.ts --edition-dir ${editionDir} --mode social"; ` +
    `ou, aceitando a arte fora da marca, re-rodar este upload com DIARIA_ALLOW_FONT_FALLBACK=1.`
  );
}

// puro, sem side effect de .env/CLI) — re-exportado aqui pra não quebrar
// consumidores existentes que importam a função a partir deste arquivo.
export { hero2x1KeyFor };

/**
 * Verifica que o cache final contém todas as keys esperadas pro mode.
 * (#1275) — defesa contra cache misto entre modes onde upload-images-public
 * é chamado várias vezes mas cache fica parcial (ex: mode newsletter rodou,
 * mode social não, mas publish-linkedin lê cache assumindo d1/d2/d3 presentes).
 *
 * #2352: `destaqueCount` (default 3) controla se d3/d3_2x1 são exigidas.
 * Para edições 2-destaque, d3 não é requerida em nenhum mode.
 *
 * #7399: a chave BASE 1:1 (`d1`/`d2`/`d3`) deixou de ser uploadada — a
 * "presença de imagem pro destaque" agora é satisfeita por QUALQUER um dos
 * dois: o card 4:5 (`d{N}_4x5`) OU o hero 2:1 (`hero2x1KeyFor`, sempre
 * presente em edições normais — é o mesmo hero que o email usa). Isso
 * substitui o requisito antigo da chave base 1:1 sem reduzir a garantia real
 * (o 1:1 nunca era, de fato, o que os publishers usavam quando o 4:5 existia).
 *
 * Throw com erro claro se alguma key estiver faltando.
 */
export function assertCacheCompleteness(
  images: Record<string, PublicImage>,
  mode: UploadMode,
  destaqueCount: 2 | 3 = 3,
): void {
  const destaques = destaqueCount === 2 ? ["d1", "d2"] : ["d1", "d2", "d3"];
  const missing: string[] = [];

  if (mode === "social" || mode === "all") {
    for (const d of destaques) {
      if (!isDestaqueImagePresent(images, d)) missing.push(d);
    }
  }
  if (mode === "newsletter" || mode === "all") {
    // #1583: newsletter sobe cover/eia (o que o EMAIL usa).
    // #2133/#2141: d2_2x1/d3_2x1 são required — email body usa {{IMG:04-d2-2x1.jpg}}
    // / {{IMG:04-d3-2x1.jpg}}; se ausentes, substitute-image-urls.ts escreve o HTML
    // com placeholders crus e sai com exit 2. Defense-in-depth na camada de upload.
    // #2352: d3_2x1 only required when destaque_count == 3.
    const newsletterKeys = [
      "cover",
      "eia_a",
      "eia_b",
      "d2_2x1",
      ...(destaqueCount === 3 ? ["d3_2x1"] : []),
    ];
    for (const k of newsletterKeys) {
      if (!images[k]?.url) missing.push(k);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `upload-images-public: cache final não tem todas as keys esperadas pro mode=${mode}. ` +
      `Missing: ${missing.join(", ")}. Presentes: ${Object.keys(images).join(", ") || "<none>"}. ` +
      `Verifique platform.config.json + se imagens locais existem em data/editions/{AAMMDD}/.`,
    );
  }
}

/**
 * scripts/lib/linkedin-daily-document.ts (#12584)
 *
 * LinkedIn da diária (D1/D2/D3) como DOCUMENTO PDF, o formato padrão do canal
 * desde o #12584 (pedido do editor, 10/11/2026: "as publicações no Linkedin
 * serem por padrão em carrossel em PDF"). Antes disso só a retrospectiva
 * semanal saía assim (#8055, PR #12371); a diária ia com a capa 4:5 única.
 *
 * O PDF encaderna os 5 slides do carrossel diário que o Instagram e o Threads
 * já publicam (#6005: capa `{d}_4x5` → p1 → p2 → p3 → CTA, URLs em
 * `06-public-images.json`, `resolveCarouselImageUrls`). Não gera arte nova.
 *
 * Ordem de fallback, igual à semanal (#8055):
 *   1. documento (`document_url` + `document_title`, com `image_urls` junto
 *      para o fallback do próprio Worker no disparo);
 *   2. carrossel de imagens (`image_urls`, `fireLinkedInCarousel`);
 *   3. imagem única de sempre (`image_url`, Worker → Make), decidido pelo
 *      chamador (`dispatchEntry` em `publish-linkedin.ts`).
 * Falha na geração/upload do PDF ou recusa 4xx do Worker (nada foi gravado)
 * desce um degrau. Falha AMBÍGUA (5xx/timeout depois dos retries do cliente:
 * a entry pode ter sido gravada) PROPAGA, sem publicar por cima (#11106).
 *
 * O documento só existe na rota do Worker (API direta do LinkedIn). O webhook
 * Make.com (`make_now`) não sabe publicar documento: nessa rota o chamador
 * fica na imagem única e registra o motivo.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildCarouselPdf } from "./shared/carousel-pdf.ts";
import { postToWorkerQueue, WorkerQueueError, type WorkerQueuePayload } from "./worker-queue-client.ts";
import { parseDestaques } from "../extract-destaques.ts";
import { cloudflareKvKey } from "../upload-images-public.ts";

/** Formato que de fato foi enfileirado para o post (gravado em
 *  `06-social-published.json` → `format`). */
export type LinkedInDailyFormat = "document" | "carousel" | "single_image";

/** PDF já hospedado, pronto pro Worker baixar no disparo. */
export interface LinkedInDocument {
  url: string;
  title: string;
}

/** Teto do `document_title` no Worker (`MAX_DOCUMENT_TITLE_LENGTH`,
 *  `workers/linkedin-cron/src/index.ts`). Paridade travada em teste. */
export const LINKEDIN_DOCUMENT_TITLE_MAX = 400;

/** `check` do alarme ao editor quando o documento da diária não sai. */
export const LINKEDIN_DAILY_DOCUMENT_FALLBACK_CHECK = "linkedin-daily-document-fallback";

/**
 * Pure: fingerprint do alarme pelo CÓDIGO do motivo, nunca pela mensagem
 * livre (mesma regra do semanal, #12394) — o mesmo motivo recorrente reusa a
 * mesma issue de alarme. `pdf_failed:<msg>` → `…:pdf_failed`;
 * `document_rejected:<código>` → `…:document_rejected:<código>`.
 */
export function linkedInDailyDocumentFallbackFingerprint(reason: string): string {
  const sep = reason.indexOf(":");
  const kind = (sep >= 0 ? reason.slice(0, sep) : reason).trim() || "unknown";
  const detail = sep >= 0 ? reason.slice(sep + 1).trim() : "";
  const code = kind === "document_rejected" ? `document_rejected:${detail || "unknown"}` : kind;
  return `${LINKEDIN_DAILY_DOCUMENT_FALLBACK_CHECK}:${code}`;
}

/**
 * Motivos de fallback que merecem alarme: o documento FOI tentado e não saiu
 * (`pdf_failed:*`, `document_rejected:*`). Os demais (`carousel_incomplete`,
 * `opt_out`, `make_now_route`) são estado conhecido da edição ou da
 * invocação, não falha do canal.
 */
export function isAlarmingDocumentFallback(reason: string | undefined): boolean {
  return typeof reason === "string" && /^(pdf_failed|document_rejected)(:|$)/.test(reason);
}

/** Remove negrito markdown (`**`, `__`) e espaços duplicados. */
function plainTitle(raw: string): string {
  return raw.replace(/\*\*|__/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Pure: título do documento (o LinkedIn mostra no visualizador). Na diária, o
 * título ESCOLHIDO do destaque em `02-reviewed.md` (#12584 item 6). Sem o
 * arquivo, sem o destaque ou com título vazio, cai num título genérico com a
 * data da edição — nunca vazio (o Worker recusa `document_title` vazio).
 * Cortado no teto do Worker.
 */
export function resolveLinkedInDocumentTitle(
  reviewedMd: string | null,
  destaque: string,
  editionDate: string,
): string {
  const n = Number(/^d([123])$/.exec(destaque)?.[1] ?? NaN);
  let title = "";
  if (reviewedMd && Number.isFinite(n)) {
    try {
      const found = parseDestaques(reviewedMd).find((d) => d.n === n);
      if (found?.title) title = plainTitle(found.title);
    } catch {
      title = "";
    }
  }
  if (!title) title = `diar.ia.br ${editionDate} — destaque ${Number.isFinite(n) ? n : destaque}`;
  return title.length > LINKEDIN_DOCUMENT_TITLE_MAX ? title.slice(0, LINKEDIN_DOCUMENT_TITLE_MAX - 1).trimEnd() + "…" : title;
}

/** Uploader do PDF (seam de teste). Recebe o arquivo local e a chave do KV;
 *  devolve a URL pública https. */
export type LinkedInPdfUploader = (filePath: string, kvKey: string) => Promise<string>;

/**
 * Gera o PDF dos slides do destaque, grava em
 * `_internal/06-linkedin-{d}-carousel.pdf` e sobe pro KV. A chave segue a
 * allowlist `^img-[^:]+$` do Worker de imagens e leva o md5 dos bytes
 * (content-addressed, mesmo esquema do #12371): um PDF regenerado nunca
 * reaproveita a URL do anterior.
 */
export async function prepareDailyLinkedInDocument(opts: {
  editionDir: string;
  destaque: string;
  carouselImageUrls: readonly string[];
  title: string;
  upload: LinkedInPdfUploader;
  buildPdf?: (urls: readonly string[]) => Promise<Uint8Array>;
}): Promise<LinkedInDocument> {
  const { editionDir, destaque, carouselImageUrls, title } = opts;
  const pdf = await (opts.buildPdf ?? ((urls) => buildCarouselPdf(urls)))(carouselImageUrls);
  const pdfPath = resolve(editionDir, "_internal", `06-linkedin-${destaque}-carousel.pdf`);
  mkdirSync(dirname(pdfPath), { recursive: true });
  writeFileSync(pdfPath, pdf);
  const md5 = createHash("md5").update(pdf).digest("hex");
  const kvKey = cloudflareKvKey(editionDir, `linkedin-${destaque}-carousel.pdf`, md5);
  const url = await opts.upload(pdfPath, kvKey);
  if (!/^https:\/\//.test(url)) throw new Error(`URL do PDF não é https: ${url}`);
  return { url, title };
}

/** Base do payload (texto, horário, destaque) compartilhada pelos degraus. */
export interface LinkedInDailyQueueBase {
  text: string;
  scheduled_at: string;
  destaque: string;
  /**
   * #12661 — chave idempotente do post (`linkedInDailyIdempotencyKey`). A
   * MESMA nos três degraus: o retry do `postToWorkerQueue` depois de uma
   * resposta perdida cai na mesma entry do Worker (#10906), e um degrau
   * seguinte por cima de uma entry gravada sem resposta a SUBSTITUI na mesma
   * key (conteúdo mudou, #10917) em vez de criar um 2º post.
   */
  idempotency_key: string;
}

/**
 * #12661 — chave idempotente do post principal do destaque na fila do Worker:
 * `linkedin-daily:{AAMMDD}:{d}:main` (`linkedin-daily-test:` em `--test`, pra
 * um teste nunca reaproveitar nem substituir a entry de produção). Fixa por
 * edição e destaque, então rodar a Etapa 5 de novo (retry de entry `failed`)
 * também cai na mesma entry. Formato aceito pelo Worker:
 * `[A-Za-z0-9._:-]{1,128}` (`IDEMPOTENCY_KEY_RE`).
 *
 * Uma chave só para documento, carrossel e imagem única, e não um sufixo por
 * degrau (a issue sugeria `:carousel`): com chaves distintas, o documento
 * gravado com a resposta perdida (tentativa 1 expira, a 2 recebe 4xx) e o
 * carrossel enfileirado em seguida seriam duas entries, dois posts. Com a
 * mesma chave o Worker troca o conteúdo da entry e sai um post só.
 */
export function linkedInDailyIdempotencyKey(edition: string, destaque: string, opts: { isTest?: boolean } = {}): string {
  const key = `${opts.isTest ? "linkedin-daily-test" : "linkedin-daily"}:${edition}:${destaque}:main`;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new Error(`idempotency_key inválida para o Worker: ${JSON.stringify(key)}`);
  return key;
}

export type LinkedInDailyRichResult =
  | {
      /** Enfileirado como documento ou carrossel. */
      queued: true;
      key: string;
      format: "document" | "carousel";
      document_url?: string;
      document_fallback_reason?: string;
    }
  | {
      /** Documento e carrossel recusados (4xx): o chamador segue na imagem única. */
      queued: false;
      document_fallback_reason?: string;
      carousel_fallback_reason: string;
    };

/**
 * 4xx que prova que NADA foi gravado para este pedido. 409 fica de fora
 * (#12661): com `idempotency_key`, é o Worker dizendo que a entry desta chave
 * já disparou ou está disparando (`idempotentConflict`), ou seja, o post
 * existe e descer um degrau publicaria outro.
 */
function isDefinitiveRejection(e: unknown): e is WorkerQueueError {
  return e instanceof WorkerQueueError && e.status >= 400 && e.status < 500 && e.status !== 409;
}

/**
 * #12661 — 409 do enqueue idempotente. `already_fired`/`fire_in_progress`: o
 * post desta chave já saiu ou está saindo, então é sucesso (nada a
 * enfileirar). `send_unknown` (disparo ambíguo, foi pra DLQ) e 409 ilegível
 * PROPAGAM: o post pode ou não ter saído, e nenhum degrau publica por cima.
 */
function idempotentConflictKey(e: unknown): string | null {
  if (!(e instanceof WorkerQueueError) || e.status !== 409) return null;
  let parsed: { error?: unknown; key?: unknown };
  try {
    parsed = JSON.parse(e.body) as { error?: unknown; key?: unknown };
  } catch {
    return null;
  }
  if (parsed.error !== "already_fired" && parsed.error !== "fire_in_progress") return null;
  return typeof parsed.key === "string" && parsed.key !== "" ? parsed.key : null;
}

/**
 * Degraus 1 e 2 (documento → carrossel) na fila do Worker. Devolve
 * `queued: false` quando os dois foram recusados de forma definitiva (4xx),
 * pro chamador cair na imagem única. Erro ambíguo (5xx, timeout, rede, resposta
 * inválida) PROPAGA: a entry pode ter sido gravada e enfileirar outro formato
 * por cima publicaria duas vezes (#11106).
 */
export async function enqueueLinkedInDocumentOrCarousel(
  workerUrl: string,
  workerToken: string,
  base: LinkedInDailyQueueBase,
  opts: {
    carouselImageUrls: string[];
    prepareDocument: () => Promise<LinkedInDocument>;
    post?: typeof postToWorkerQueue;
    log?: (msg: string) => void;
  },
): Promise<LinkedInDailyRichResult> {
  const post = opts.post ?? postToWorkerQueue;
  const log = opts.log ?? ((m: string) => console.log(m));
  const common: Omit<WorkerQueuePayload, "image_urls"> = {
    text: base.text,
    image_url: null,
    scheduled_at: base.scheduled_at,
    destaque: base.destaque,
    channel: "linkedin",
    idempotency_key: base.idempotency_key,
  };

  let documentFallbackReason: string | undefined;
  let doc: LinkedInDocument | null = null;
  try {
    doc = await opts.prepareDocument();
  } catch (e) {
    documentFallbackReason = `pdf_failed:${(e as Error).message}`;
  }
  if (doc) {
    try {
      const response = await post(
        workerUrl,
        workerToken,
        {
          ...common,
          // Fallback do próprio Worker: se o documento falhar no disparo antes
          // de o post existir, ele publica este carrossel (fireLinkedInDocument).
          image_urls: opts.carouselImageUrls,
          document_url: doc.url,
          document_title: doc.title,
        },
        2,
        "publish-linkedin",
      );
      return { queued: true, key: response.key, format: "document", document_url: doc.url };
    } catch (e) {
      const firedKey = idempotentConflictKey(e);
      if (firedKey !== null) {
        log(`WARN linkedin/${base.destaque} — a fila do Worker já tem este post disparado ou disparando (${base.idempotency_key}); nada novo enfileirado (#12661).`);
        return { queued: true, key: firedKey, format: "document", document_url: doc.url };
      }
      if (!isDefinitiveRejection(e)) throw e;
      documentFallbackReason = `document_rejected:${e.code ?? e.status}`;
    }
  }
  log(`WARN linkedin/${base.destaque} — documento PDF indisponível (${documentFallbackReason}); fallback: carrossel de imagens.`);

  const fallbackTag = documentFallbackReason ? { document_fallback_reason: documentFallbackReason } : {};
  try {
    const response = await post(
      workerUrl,
      workerToken,
      { ...common, image_urls: opts.carouselImageUrls },
      2,
      "publish-linkedin",
    );
    return { queued: true, key: response.key, format: "carousel", ...fallbackTag };
  } catch (e) {
    const firedKey = idempotentConflictKey(e);
    if (firedKey !== null) {
      log(`WARN linkedin/${base.destaque} — a fila do Worker já tem este post disparado ou disparando (${base.idempotency_key}); nada novo enfileirado (#12661).`);
      return { queued: true, key: firedKey, format: "carousel", ...fallbackTag };
    }
    if (!isDefinitiveRejection(e)) throw e;
    const carouselFallbackReason = `carousel_rejected:${e.code ?? e.status}`;
    log(`WARN linkedin/${base.destaque} — carrossel recusado (${carouselFallbackReason}); fallback: imagem única.`);
    return { queued: false, ...fallbackTag, carousel_fallback_reason: carouselFallbackReason };
  }
}

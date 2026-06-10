/**
 * upload-html-public.ts (#1178, #1239)
 *
 * Faz PUT de `_internal/newsletter-final.html` pro Worker draft Cloudflare,
 * onde fica acessível via GET por uma URL única por edição. Substitui o
 * fluxo chunk-html-base64 + javascript_tool push (consome ~80K tokens
 * por edição — Stage 4 newsletter playbook).
 *
 * Fluxo:
 *   1. Worker grava HTML em KV (key=html:{edition}, TTL 90d — #1782)
 *   2. Stage 4 playbook usa `fetch('https://draft.diaria.workers.dev/{edition}')`
 *      direto do browser
 *   3. Insert via `editor.commands.insertContent({type:'text', text: html})`
 *   → ~5K tokens total (vs ~80K antes)
 *
 * URL retornada (campo `url` no stdout) também serve pra editor revisar o
 * HTML online antes do paste — botões A/B do poll funcionam, imagens
 * carregam. Não substitui test email do Beehiiv (CSS final não está lá).
 *
 * Uso:
 *   npx tsx scripts/upload-html-public.ts --edition 260514
 *   npx tsx scripts/upload-html-public.ts --edition 260514 --dry-run
 *
 * Env:
 *   ADMIN_SECRET ou POLL_ADMIN_SECRET — HMAC pra autenticar o PUT
 *   DRAFT_WORKER_URL (default: https://draft.diaria.workers.dev)
 *
 * Output stdout (JSON):
 *   {
 *     "edition": "260514",
 *     "url": "https://draft.diaria.workers.dev/260514",
 *     "bytes": 28341,
 *     "ttl_seconds": 7776000
 *   }
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { readFileSync, statSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac, createHash } from "node:crypto";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRAFT_WORKER_URL =
  process.env.DRAFT_WORKER_URL ?? "https://draft.diaria.workers.dev";

/** HMAC(ADMIN_SECRET, "html:{key}") — Worker valida com hmacVerify mesmo input. */
export function htmlPutSig(secret: string, key: string): string {
  return createHmac("sha256", secret).update(`html:${key}`).digest("hex");
}

export interface UploadHtmlResult {
  edition: string;
  url: string;
  bytes: number;
  ttl_seconds?: number;
  dry_run?: boolean;
}

/** Constrói URL pro draft Worker (root path /{edition}). */
export function buildDraftUrl(workerBaseUrl: string, edition: string): string {
  const base = workerBaseUrl.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(edition)}`;
}

/**
 * Pure (#1734): mescla `{ [field]: value }` num objeto JSON existente,
 * preservando as demais chaves. `existing` null/inválido → começa de `{}`.
 * Sobrescreve se a chave já existir (idempotente em re-upload).
 */
export function mergeFieldIntoJson(
  existing: Record<string, unknown> | null | undefined,
  field: string,
  value: string,
): Record<string, unknown> {
  // #1734 review: fail-loud em chaves perigosas. `base["__proto__"] = v` setaria
  // o prototype (não uma own-key) e o JSON sairia vazio — perda silenciosa da URL.
  if (field === "__proto__" || field === "constructor" || field === "prototype") {
    throw new Error(`mergeFieldIntoJson: campo inválido "${field}"`);
  }
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};
  base[field] = value;
  return base;
}

/**
 * #1734: persiste a URL do upload num arquivo JSON dedicado (ex:
 * `_internal/05-social-preview.json`), mesclando com conteúdo existente via
 * `mergeFieldIntoJson` + write atômico. Resolve o gap onde a URL do preview
 * social só era `console.log`ada e nunca registrada — com TTL 12h no KV, a
 * URL morria irrecuperável (a da newsletter persiste em `draft_preview_url`,
 * a do social não persistia em lugar nenhum).
 *
 * Arquivo dedicado (não `05-published.json`) porque este último exige
 * `draft_url` (Beehiiv, só existe pós-dispatch) e é reescrito pelo publisher
 * — escrever ali no prep seria clobbered.
 */
export function persistFieldToJsonFile(
  filePath: string,
  field: string,
  value: string,
): void {
  let existing: Record<string, unknown> | null = null;
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // JSON corrompido → recomeça de {} (fail-open, não trava o upload).
      existing = null;
    }
  }
  const merged = mergeFieldIntoJson(existing, field, value);
  // #1734 review: writeFileAtomic não cria dir; garante o pai (ex: _internal/).
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileAtomic(filePath, JSON.stringify(merged, null, 2) + "\n");
}

/**
 * Pure (#1277): valida que HTML não tem placeholders {{IMG:...}} não-resolvidas.
 * Retorna lista de placeholders únicos encontrados (vazia = ok).
 *
 * Bug #1277: Stage 4 do orchestrator pulava `substitute-image-urls.ts` antes
 * de chamar este script — placeholders chegavam intactos no Cloudflare draft,
 * editor via HTML quebrado com alt="" no lugar das imagens. Fail-loud aqui
 * impede o upload silencioso.
 */
export function findUnresolvedImgPlaceholders(html: string): string[] {
  const matches = html.match(/\{\{IMG:[^}]+\}\}/g) ?? [];
  return Array.from(new Set(matches));
}

/**
 * Pure (#2012): verifica que `draftHtmlPath` (render output, antes do substitute)
 * não é mais antigo que `reviewedMdPath` (02-reviewed.md), e que `finalHtmlPath`
 * (output do substitute-image-urls) não é mais antigo que `draftHtmlPath` quando
 * ambos existirem.
 *
 * Cadeia de freshness esperada:
 *   02-reviewed.md ≤ newsletter-draft.html ≤ newsletter-final.html
 *
 * Nota: comparar apenas final.html vs 02-reviewed.md é ineficaz porque
 * substitute-image-urls sempre reescreve final.html (mtime fresco), então o
 * final.html sempre pareceria ok mesmo quando draft.html está stale.
 *
 * Retorna `null` quando tudo está ok, ou uma string de erro quando stale.
 * Caller deve lançar/logar conforme necessário.
 *
 * Casos especiais:
 * - `reviewedMdPath` ausente: retorna `null` (re-render fora de uma edição
 *   completa; não bloquear nesses casos).
 * - arquivo ausente: retorna `null` (tratado como ENOENT via try/catch).
 *
 * @param finalHtmlPath  Path do newsletter-final.html (output do substitute).
 * @param reviewedMdPath Path do 02-reviewed.md.
 * @param draftHtmlPath  Path do newsletter-draft.html (output do render, antes
 *                       do substitute). Quando ausente, usa `finalHtmlPath` como
 *                       proxy (compatibilidade com chamadas externas sem draft).
 * @param editionDir     Diretório da edição (para mensagem de erro copy-pasteable).
 */
export function checkHtmlFreshness(
  finalHtmlPath: string,
  reviewedMdPath: string,
  draftHtmlPath?: string,
  editionDir?: string,
): string | null {
  // Lê mtime via try/catch — ENOENT → tratar como ausente (TOCTOU-safe).
  function mtimeMs(p: string): number | null {
    try {
      return statSync(p).mtimeMs;
    } catch {
      return null;
    }
  }

  const mdMtime = mtimeMs(reviewedMdPath);
  if (mdMtime === null) return null; // 02-reviewed.md ausente — sem verificação.

  // Interpola paths reais na mensagem de erro (P3: sem {edition_dir} literal).
  const edDir = editionDir ?? dirname(dirname(finalHtmlPath));
  const draftCanonical = `${edDir}/_internal/newsletter-draft.html`;
  const renderCmd =
    `npx tsx scripts/render-newsletter-html.ts ${edDir} --format html --out ${draftCanonical}`;
  const subCmd =
    `npx tsx scripts/substitute-image-urls.ts --html ${draftCanonical} ` +
    `--images ${edDir}/06-public-images.json --out ${edDir}/_internal/newsletter-final.html`;

  // Verificação primária: draft deve ser mais novo que 02-reviewed.md.
  // Se draftHtmlPath foi passado e existe, usa-o (cadeia de freshness real da
  // pipeline). Se não existe (draft em /tmp/ ou não gerado), cai em final vs
  // reviewed como proxy.
  const draftMtime = draftHtmlPath !== undefined ? mtimeMs(draftHtmlPath) : null;
  const primaryPath = draftMtime !== null ? draftHtmlPath! : finalHtmlPath;
  const primaryMtime = draftMtime !== null ? draftMtime : mtimeMs(finalHtmlPath);
  if (primaryMtime === null) return null; // arquivo ausente — sem verificação.

  if (primaryMtime < mdMtime) {
    const checkLabel = draftMtime !== null ? "newsletter-draft.html" : "newsletter-final.html";
    return (
      `${checkLabel} está desatualizado: ` +
      `mtime(${checkLabel})=${new Date(primaryMtime).toISOString()} < ` +
      `mtime(02-reviewed.md)=${new Date(mdMtime).toISOString()}. ` +
      `Re-render o HTML antes de fazer upload: ` +
      `${renderCmd} && ${subCmd}`
    );
  }

  // Verificação secundária: se draft existe, final também deve ser mais novo que draft.
  if (draftMtime !== null) {
    const finalMtime = mtimeMs(finalHtmlPath);
    if (finalMtime !== null && finalMtime < draftMtime) {
      return (
        `newsletter-final.html está desatualizado em relação a newsletter-draft.html: ` +
        `mtime(final)=${new Date(finalMtime).toISOString()} < ` +
        `mtime(draft)=${new Date(draftMtime).toISOString()}. ` +
        `Re-rode substitute-image-urls antes de fazer upload: ${subCmd}`
      );
    }
  }

  return null;
}

export function wrapForPreview(body: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Newsletter Preview</title>
<style>
  body {
    margin: 0;
    padding: 12px;
    background: #ffffff;
    font-size: 16px;
  }
  .preview-wrapper {
    max-width: 620px;
    margin: 0 auto;
    background: #ffffff;
    border-radius: 0;
    padding: 16px;
    box-shadow: none;
  }
  .preview-wrapper img {
    max-width: 100%;
    height: auto !important;
  }
  .preview-wrapper table {
    max-width: 100% !important;
  }
  .preview-wrapper td {
    word-break: break-word;
  }
  @media (max-width: 480px) {
    body { padding: 6px; }
    .preview-wrapper { padding: 10px; border-radius: 0; }
    .preview-wrapper p,
    .preview-wrapper td { font-size: 16px !important; line-height: 1.55 !important; }
    .preview-wrapper .mob-stack {
      display: block !important;
      width: 100% !important;
      padding: 0 0 12px 0 !important;
    }
  }
</style>
</head>
<body>
<div class="preview-wrapper">
${body}
</div>
</body>
</html>`;
}

export async function uploadHtml(args: {
  edition: string;
  htmlPath: string;
  secret: string;
  workerUrl?: string;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  /**
   * #1914: por padrão envolve o HTML em `wrapForPreview` (a daily sobe um
   * FRAGMENTO de body). A mensal já gera um documento HTML completo
   * (`<!DOCTYPE html>...`), então passa `wrap: false` pra evitar aninhar um doc
   * dentro de outro.
   */
  wrap?: boolean;
  /**
   * #2012: path pro `02-reviewed.md` da edição. Quando fornecido, verifica que
   * o HTML foi gerado DEPOIS da última edição do MD (freshness guard). Ausente
   * = sem verificação (mantém compatibilidade com chamadas externas e previews
   * mensais que não têm um 02-reviewed.md correspondente).
   */
  reviewedMdPath?: string;
}): Promise<UploadHtmlResult> {
  const workerUrl = (args.workerUrl ?? DRAFT_WORKER_URL).replace(/\/+$/, "");
  const rawHtml = readFileSync(args.htmlPath, "utf8");
  const html = args.wrap === false ? rawHtml : wrapForPreview(rawHtml);

  // #1494: content-hash versioning — each different content gets a unique URL.
  // Eliminates browser/edge cache issues when re-uploading updated HTML.
  const contentHash = createHash("md5").update(html).digest("hex").slice(0, 6);
  const versionedEdition = `${args.edition}-${contentHash}`;
  const url = buildDraftUrl(workerUrl, versionedEdition);

  // #1277: fail-loud se HTML ainda tem placeholders {{IMG:...}} não-substituídas.
  // Editor já viu draft com imagens quebradas em 260515 — invariant defensivo
  // garante que o passo `substitute-image-urls.ts` rodou antes do upload.
  const unresolved = findUnresolvedImgPlaceholders(html);
  if (unresolved.length > 0) {
    throw new Error(
      `HTML tem ${unresolved.length} placeholder(s) {{IMG:...}} não-resolvida(s): ${unresolved.slice(0, 5).join(", ")}${unresolved.length > 5 ? ` (+${unresolved.length - 5} mais)` : ""}. Rode 'npx tsx scripts/substitute-image-urls.ts --html ${args.htmlPath} --images data/editions/${args.edition}/06-public-images.json --out ${args.htmlPath}' antes de re-upload. Se o cache de imagens não está populado, rode primeiro 'npx tsx scripts/upload-images-public.ts --edition-dir data/editions/${args.edition}/ --mode all'.`,
    );
  }

  // #2012: freshness guard — HTML stale (render rodou antes da última edição
  // de 02-reviewed.md) sobe conteúdo desatualizado pro Worker silenciosamente.
  // dry-run: emite warning mas não aborta (dry-run é operação segura/diagnóstico).
  if (args.reviewedMdPath) {
    const editionDir = args.reviewedMdPath
      ? dirname(args.reviewedMdPath)
      : undefined;
    const draftHtmlPath = editionDir
      ? resolve(editionDir, "_internal", "newsletter-draft.html")
      : undefined;
    const stalenessError = checkHtmlFreshness(
      args.htmlPath,
      args.reviewedMdPath,
      draftHtmlPath,
      editionDir,
    );
    if (stalenessError) {
      if (args.dryRun) {
        process.stderr.write(`[upload-html-public] WARN (dry-run): ${stalenessError}\n`);
      } else {
        throw new Error(stalenessError);
      }
    }
  }

  if (args.dryRun) {
    return {
      edition: args.edition,
      url,
      bytes: Buffer.byteLength(html, "utf8"),
      dry_run: true,
    };
  }

  const sig = htmlPutSig(args.secret, versionedEdition);
  const fetchFn = args.fetchImpl ?? fetch;
  const res = await fetchFn(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${sig}`,
      "Content-Type": "text/html; charset=utf-8",
    },
    body: html,
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 500);
    throw new Error(`Worker PUT ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { bytes: number; ttl_seconds: number };
  return {
    edition: args.edition,
    url,
    bytes: data.bytes,
    ttl_seconds: data.ttl_seconds,
  };
}

async function main(): Promise<void> {
  const { values, flags } = parseCliArgs(process.argv.slice(2));
  const edition = values["edition"];
  const dryRun = flags.has("dry-run");
  const noWrap = flags.has("no-wrap"); // #1914: HTML já é doc completo
  const htmlPathOverride = values["html"];
  // #1734: --persist-to grava a URL resultante num JSON dedicado (merge).
  // --field nomeia a chave (default "url"). Usado pelo Stage 4 pro preview
  // social: --persist-to .../05-social-preview.json --field social_preview_url.
  const persistTo = values["persist-to"];
  const persistField = values["field"] ?? "url";

  if (!edition) {
    console.error(
      "Uso: upload-html-public.ts --edition AAMMDD [--dry-run] [--no-wrap] [--html <path>] " +
        "[--persist-to <json> --field <nome>]",
    );
    process.exit(2);
  }

  const secret =
    process.env.ADMIN_SECRET ?? process.env.POLL_ADMIN_SECRET ?? "";
  if (!secret && !dryRun) {
    console.error("[upload-html-public] ADMIN_SECRET ausente no env — abortando");
    process.exit(1);
  }

  const htmlPath = htmlPathOverride
    ? resolve(ROOT, htmlPathOverride)
    : resolve(ROOT, "data", "editions", edition, "_internal", "newsletter-final.html");

  if (!existsSync(htmlPath)) {
    console.error(`[upload-html-public] HTML não encontrado: ${htmlPath}`);
    process.exit(1);
  }

  // #2012: freshness guard — só ativa quando usando o path padrão da pipeline
  // (newsletter diária). Com --html override o caller conhece o contexto e
  // pode não ter 02-reviewed.md associado (preview mensal, re-render manual).
  const reviewedMdPath = htmlPathOverride
    ? undefined
    : resolve(ROOT, "data", "editions", edition, "02-reviewed.md");

  const result = await uploadHtml({
    edition,
    htmlPath,
    secret,
    dryRun,
    wrap: !noWrap,
    reviewedMdPath,
  });

  // #1734: persiste a URL só após upload REAL — dry-run não sobe nada, então
  // gravar a URL seria registrar um link que dá 404.
  // Review: persist é SECUNDÁRIO. Se falhar (EPERM/disco), só warn — o upload
  // (job principal) já sucedeu. Lançar aqui faria o playbook tratar exit≠0 como
  // falha do Worker e cair no fallback chunked de 80K tokens, em vão.
  if (persistTo && !result.dry_run) {
    try {
      const persistPath = resolve(ROOT, persistTo);
      persistFieldToJsonFile(persistPath, persistField, result.url);
    } catch (e) {
      console.error(
        `[upload-html-public] WARN: upload OK mas persist falhou (${(e as Error).message}). ` +
          `URL não registrada em ${persistTo}, mas está live: ${result.url}`,
      );
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((e) => {
    console.error(`[upload-html-public] ${(e as Error).message}`);
    process.exit(1);
  });
}

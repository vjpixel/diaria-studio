#!/usr/bin/env tsx
/**
 * lint-test-email-image-freshness.ts (#1212)
 *
 * Verifica se as imagens referenciadas no email de teste batem com os
 * arquivos locais correspondentes (bytes/hash). Capturaria o caso da
 * edição 260514: editor regenerou D1 sem texto, re-uploadou no Worker
 * KV com mesmo key, mas Gmail Image Proxy + Beehiiv cache serviam a
 * versão antiga. Reviewer "passou" sem detectar.
 *
 * Estratégia:
 * 1. Extrai URLs de imagem do conteúdo do email (HTML ou plain).
 * 2. Pra cada URL que aparenta vir do Worker (img-{AAMMDD}-*.jpg) ou
 *    do Drive (drive.google.com/uc?id=...), faz GET via fetch.
 * 3. Compara SHA-256 do conteúdo baixado com o arquivo local
 *    correspondente em data/editions/{AAMMDD}/.
 * 4. Reporta mismatch como issue type `image_stale` — bytes diferem
 *    do esperado. Geralmente significa cache stale ou regeneração
 *    sem cache-bust.
 *
 * Uso:
 *   npx tsx scripts/lint-test-email-image-freshness.ts \
 *     --email-file /tmp/email-260514.txt \
 *     --edition-dir data/editions/260514/ \
 *     --out /tmp/lint-image-freshness.json
 *
 * Exit codes:
 *   0 = sem mismatch detectado (incluindo casos onde nenhuma imagem
 *       referenciada bate com arquivo local — agent ignora as outras).
 *   1 = pelo menos 1 mismatch detectado (cache stale provavel).
 *   2 = erro de uso (arquivos faltando, args malformados).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";

export interface ImageFreshnessIssue {
  type: "image_stale" | "image_unreachable";
  url: string;
  /** Nome do arquivo local que se esperava bater (ex: "04-d1-2x1.jpg"). */
  expected_local_file: string;
  /** Hash do conteúdo remoto (null se unreachable). */
  remote_hash: string | null;
  /** Hash do conteúdo local esperado. */
  expected_hash: string;
  details: string;
}

export interface ImageFreshnessResult {
  edition_dir: string;
  total_urls_extracted: number;
  total_urls_checked: number;
  issues: ImageFreshnessIssue[];
  passed: number;
  skipped: number;
}

/**
 * Extrai URLs de imagem (.jpg/.png/.webp) do conteúdo do email.
 * Aceita HTML ou plain text. Detecta hrefs em `<img src="..."/>` e
 * também links nus.
 */
export function extractImageUrls(emailContent: string): string[] {
  const urls = new Set<string>();
  // <img src="...">
  const srcRe = /<img[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = srcRe.exec(emailContent)) !== null) {
    urls.add(m[1]);
  }
  // URL nua: capture até espaço/aspas/<>
  const bareRe = /https?:\/\/[^\s"'<>)]+\.(?:jpg|jpeg|png|webp)/gi;
  while ((m = bareRe.exec(emailContent)) !== null) {
    urls.add(m[0]);
  }
  return [...urls];
}

/**
 * Tenta resolver URL → arquivo local esperado em edition-dir.
 *
 * Casos suportados:
 * - Worker URL: `https://...workers.dev/img/img-260514-04-d1-2x1.jpg`
 *   → `04-d1-2x1.jpg` (strip prefix `img-{AAMMDD}-`)
 * - Worker URL com cache-bust suffix: `...img-260514-04-d1-2x1-v2.jpg`
 *   → `04-d1-2x1.jpg` (strip `-v\d+` antes do .jpg)
 * - Direct file URL: `.../04-d1-2x1.jpg`
 *   → `04-d1-2x1.jpg`
 *
 * Retorna null se a URL não bate com nenhum padrão conhecido (ex:
 * Google Drive UC URLs precisam fetch separado pra extrair nome — fora
 * do escopo aqui).
 */
export function resolveExpectedLocalFile(url: string): string | null {
  // Worker /img/ pattern: capture o último segmento, strip img-{AAMMDD}-, strip -v\d+
  const workerMatch = url.match(/\/img\/(.+?\.(?:jpg|jpeg|png|webp))$/i);
  if (workerMatch) {
    let name = workerMatch[1];
    // strip img-{AAMMDD}- prefix
    name = name.replace(/^img-\d{6}-/, "");
    // strip cache-bust suffix -v{N} before extension
    name = name.replace(/-v\d+(\.[^.]+)$/i, "$1");
    return name;
  }
  // Direct path: capture last segment if matches 04-d{N}-{spec}.jpg or 01-eia-{A|B}.jpg
  const segments = url.split("/");
  const last = segments[segments.length - 1].split("?")[0];
  if (/^(04-d\d-(?:2x1|1x1)|01-eia-[AB])\.(jpg|jpeg|png|webp)$/i.test(last)) {
    return last;
  }
  return null;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Fetch URL via global fetch. Retorna Buffer ou null em erro.
 */
async function fetchImage(url: string, timeoutMs = 15000): Promise<Buffer | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function checkImageFreshness(
  emailContent: string,
  editionDir: string,
): Promise<ImageFreshnessResult> {
  const urls = extractImageUrls(emailContent);
  const issues: ImageFreshnessIssue[] = [];
  let passed = 0;
  let skipped = 0;

  for (const url of urls) {
    const expectedFile = resolveExpectedLocalFile(url);
    if (!expectedFile) {
      skipped++;
      continue;
    }
    const localPath = resolve(editionDir, expectedFile);
    if (!existsSync(localPath)) {
      skipped++;
      continue;
    }
    const localBuf = readFileSync(localPath);
    const expectedHash = sha256(localBuf);
    const remoteBuf = await fetchImage(url);
    if (!remoteBuf) {
      issues.push({
        type: "image_unreachable",
        url,
        expected_local_file: expectedFile,
        remote_hash: null,
        expected_hash: expectedHash,
        details: `GET ${url} falhou (timeout ou non-2xx).`,
      });
      continue;
    }
    const remoteHash = sha256(remoteBuf);
    if (remoteHash !== expectedHash) {
      issues.push({
        type: "image_stale",
        url,
        expected_local_file: expectedFile,
        remote_hash: remoteHash,
        expected_hash: expectedHash,
        details:
          `Bytes diferem do esperado (local: ${expectedFile} = ${expectedHash.slice(0, 12)}…, ` +
          `remoto: ${remoteHash.slice(0, 12)}…). Provavel cache stale — Gmail Image Proxy / Beehiiv preview ` +
          `pode estar servindo versao antiga. Se imagem foi regenerada recentemente, ` +
          `considere cache-bust via novo key (ex: -v2 suffix) ate TTL expirar.`,
      });
    } else {
      passed++;
    }
  }

  return {
    edition_dir: editionDir,
    total_urls_extracted: urls.length,
    total_urls_checked: urls.length - skipped,
    issues,
    passed,
    skipped,
  };
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

async function mainCli(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args["email-file"] || !args["edition-dir"]) {
    console.error(
      "Uso: lint-test-email-image-freshness.ts --email-file <file> --edition-dir <dir> [--out <json>]",
    );
    return 2;
  }
  const emailFile = String(args["email-file"]);
  const editionDir = String(args["edition-dir"]);
  if (!existsSync(emailFile)) {
    console.error(`email-file não existe: ${emailFile}`);
    return 2;
  }
  if (!existsSync(editionDir)) {
    console.error(`edition-dir não existe: ${editionDir}`);
    return 2;
  }

  const content = readFileSync(emailFile, "utf8");
  const result = await checkImageFreshness(content, editionDir);

  if (args.out) {
    writeFileSync(String(args.out), JSON.stringify(result, null, 2), "utf8");
  }

  console.log(JSON.stringify(result, null, 2));

  if (result.issues.length > 0) {
    console.error(
      `[lint-test-email-image-freshness] ${result.issues.length} issue(s) detectada(s):`,
    );
    for (const issue of result.issues) {
      console.error(`  - [${issue.type}] ${basename(issue.expected_local_file)}: ${issue.details}`);
    }
    return 1;
  }
  return 0;
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/lint-test-email-image-freshness\.ts$/.test(_argv1)) {
  mainCli().then((code) => process.exit(code));
}

#!/usr/bin/env npx tsx
/**
 * capture-livros-promo.ts (#2071)
 *
 * Captura screenshot da página de livros (livros.diaria.workers.dev) e grava
 * como `04-livros-promo.jpg` no diretório da edição. Idempotente: só grava
 * se o md5 do screenshot novo difere do cache (`{editionDir}/04-livros-promo.jpg`).
 *
 * Integrado no pré-render do Stage 4 (§4a-pre-gate) — roda antes do
 * upload-images-public.ts, que então sobe `04-livros-promo.jpg` ao KV se
 * estiver presente.
 *
 * Usa puppeteer (já dependência do repo via verify-accessibility.ts).
 * Viewport 1200×720 @2x (deviceScaleFactor=2) → JPEG qualidade 90.
 *
 * Uso:
 *   npx tsx scripts/capture-livros-promo.ts --edition-dir data/editions/260612/
 *   npx tsx scripts/capture-livros-promo.ts --edition-dir data/editions/260612/ --force
 *   npx tsx scripts/capture-livros-promo.ts --edition-dir data/editions/260612/ --dry-run
 *
 * Flags:
 *   --force    Re-captura mesmo que o md5 não tenha mudado.
 *   --dry-run  Faz a captura em temp, compara md5, mas NÃO grava em editionDir.
 *              Útil em CI pra garantir que o script roda sem network reais (mock).
 *
 * Exit codes:
 *   0  Imagem gravada (nova ou forçada).
 *   2  Md5 igual ao existente — nada a fazer (idempotente, não é erro).
 *   1  Erro fatal (puppeteer falhou, sem --edition-dir, etc.).
 *
 * GUARD DE PUBLICAÇÃO: este script SÓ captura e grava localmente (JPEG).
 * O upload pro KV acontece separadamente em upload-images-public.ts.
 * Nunca executar upload direto aqui.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";

// Injetável nos testes (default = puppeteer real).
export type CaptureFn = (url: string, outPath: string) => Promise<void>;

/** URL canônica da página de livros. */
export const LIVROS_URL = "https://livros.diaria.workers.dev";
/** Filename dentro de editionDir. */
export const LIVROS_PROMO_FILENAME = "04-livros-promo.jpg";

/** md5 hex de um Buffer. Puro. */
export function md5Hex(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

/**
 * Captura real com puppeteer. Não chamar em testes de CI (mock via captureFn).
 * viewport 1200×720 @2x, clip full-width × viewport-height.
 */
export async function captureWithPuppeteer(
  url: string,
  outPath: string,
): Promise<void> {
  // Importação dinâmica para evitar que o módulo inteiro falhe quando puppeteer
  // não está disponível no ambiente de testes (os testes mockam captureFn).
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 720, deviceScaleFactor: 2 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    // Aguarda o conteúdo principal estar visível (cards de livros).
    await page.waitForSelector("body", { timeout: 5_000 }).catch(() => null);
    await page.screenshot({
      path: outPath as `${string}.jpg`,
      type: "jpeg",
      quality: 90,
      clip: { x: 0, y: 0, width: 1200, height: 720 },
    });
  } finally {
    await browser.close();
  }
}

export interface CaptureResult {
  /** "captured" = imagem nova gravada. "dry_run" = dry-run com mudança (não gravado). "skipped" = md5 igual, sem mudança. */
  status: "captured" | "dry_run" | "skipped";
  outPath: string;
  md5New: string;
  md5Old: string | null;
}

/**
 * Captura o screenshot e grava em `editionDir/04-livros-promo.jpg` se o md5
 * diferir do arquivo existente (ou se force=true). Retorna CaptureResult.
 *
 * @param editionDir  Diretório da edição (ex: data/editions/260612/).
 * @param opts.force    Re-captura incondicionalmente.
 * @param opts.dryRun   Captura em temp, compara, mas NÃO grava em editionDir.
 * @param opts.captureFn Substituição do puppeteer real (para testes).
 */
export async function captureLivrosPromo(
  editionDir: string,
  opts: {
    force?: boolean;
    dryRun?: boolean;
    captureFn?: CaptureFn;
  } = {},
): Promise<CaptureResult> {
  const { force = false, dryRun = false, captureFn = captureWithPuppeteer } =
    opts;

  const outPath = resolve(editionDir, LIVROS_PROMO_FILENAME);
  const md5Old = existsSync(outPath) ? md5Hex(readFileSync(outPath)) : null;

  // Captura em temp para comparar md5 antes de gravar.
  const tmpPath = join(tmpdir(), `livros-promo-${Date.now()}.jpg`);
  try {
    await captureFn(LIVROS_URL, tmpPath);

    if (!existsSync(tmpPath)) {
      throw new Error(`capture-livros-promo: captureFn não gerou o arquivo ${tmpPath}`);
    }

    const newBuf = readFileSync(tmpPath);
    const md5New = md5Hex(newBuf);

    // Idempotência: se o md5 não mudou E não estamos forçando → skip.
    if (!force && md5Old !== null && md5Old === md5New) {
      return { status: "skipped", outPath, md5New, md5Old };
    }

    // Grava (exceto --dry-run).
    if (!dryRun) {
      writeFileSync(outPath, newBuf);
      return { status: "captured", outPath, md5New, md5Old };
    }
    // #2104: dry-run com mudança detectada — NÃO gravado; status distinto de "captured"
    // para não enganar o caller (arquivo out_path não existe / não foi atualizado).
    return { status: "dry_run", outPath, md5New, md5Old };
  } finally {
    // Limpa o temp file (ignore erros).
    try {
      if (existsSync(tmpPath)) {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(tmpPath);
      }
    } catch {
      // Ignorar falha de cleanup (arquivo pode não existir se captureFn falhou)
    }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const editionDirIdx = args.indexOf("--edition-dir");
  if (editionDirIdx === -1 || !args[editionDirIdx + 1]) {
    console.error(
      "Uso: npx tsx scripts/capture-livros-promo.ts --edition-dir <path> [--force] [--dry-run]",
    );
    process.exit(1);
  }
  const editionDir = resolve(args[editionDirIdx + 1]);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  if (!existsSync(editionDir)) {
    console.error(`capture-livros-promo: edition-dir não existe: ${editionDir}`);
    process.exit(1);
  }

  console.error(
    `capture-livros-promo: capturando ${LIVROS_URL} → ${editionDir}/${LIVROS_PROMO_FILENAME}`,
  );

  const result = await captureLivrosPromo(editionDir, { force, dryRun });

  if (result.status === "skipped") {
    console.error(
      `capture-livros-promo: md5 igual (${result.md5New.slice(0, 8)}) — sem mudança`,
    );
    process.exit(2);
  }

  const action = dryRun ? "capturado (dry-run, não gravado)" : "gravado";
  console.error(
    `capture-livros-promo: ${action} — md5 ${result.md5Old ? `${result.md5Old.slice(0, 8)} → ` : ""}${result.md5New.slice(0, 8)}`,
  );
  console.log(JSON.stringify({ out_path: result.outPath, md5: result.md5New, status: result.status }));
  process.exit(0);
}

// Guard: só executa como CLI (não ao ser importado por testes).
if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("capture-livros-promo FATAL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

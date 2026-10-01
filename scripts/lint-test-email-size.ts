#!/usr/bin/env npx tsx
/**
 * lint-test-email-size.ts (#9277)
 *
 * Mede o tamanho do e-mail de teste como ENTREGUE (o que o Gmail recebeu),
 * separado do HTML local. Motivo: o invariante `kit-html-too-large` (Stage 4)
 * só mede `_internal/newsletter-final-kit.html` — na 261001 esse arquivo tinha
 * ~43 KB enquanto o e-mail entregue pelo Kit chegou com `sizeEstimate`
 * 106.488 bytes, acima do corte de ~102 KB do Gmail. A diferença é o que o
 * Kit acrescenta (wrapper do template, parte text/plain, headers, pixel de
 * abertura no FIM — que some quando o Gmail corta).
 *
 * Fonte do tamanho, em ordem de preferência:
 *   1. `--size-estimate N` — `sizeEstimate` da mensagem no Gmail (get_thread).
 *   2. `--email-file` — bytes do dump materializado (aproximação; o dump é o
 *      corpo, sem headers, então tende a SUBestimar).
 *
 * Uso:
 *   npx tsx scripts/lint-test-email-size.ts \
 *     [--size-estimate 106488] [--email-file .../_internal/test-email-{AAMMDD}.txt] \
 *     [--local-html .../_internal/newsletter-final-kit.html] \
 *     [--out .../_internal/lint-size-{AAMMDD}.json]
 *
 * Exit: 0 = dentro do limite (ou sem medida); 1 = acima do corte; 2 = uso.
 * Nunca bloqueia sozinho — o resultado é exibido no gate 6 (parada única).
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";

/** Corte de clipping do Gmail — mesmo valor de `KIT_HTML_SIZE_ERROR_BYTES` (#6506). */
export const GMAIL_CLIP_BYTES = 102 * 1024;

export type SizeSource = "gmail_size_estimate" | "email_file" | "none";

export interface DeliveredSizeIssue {
  type: "warning" | "info";
  category: "delivered_size_over_clip" | "delivered_size_unmeasured";
  detail: string;
}

export interface DeliveredSizeResult {
  delivered_bytes: number | null;
  delivered_source: SizeSource;
  local_html_bytes: number | null;
  limit_bytes: number;
  over_limit: boolean;
  issues: DeliveredSizeIssue[];
}

const kb = (n: number) => (n / 1024).toFixed(1);

/** Lógica pura: decide o achado a partir das medidas já obtidas. */
export function evaluateDeliveredSize(input: {
  sizeEstimate?: number | null;
  emailFileBytes?: number | null;
  localHtmlBytes?: number | null;
  limitBytes?: number;
}): DeliveredSizeResult {
  const limit = input.limitBytes ?? GMAIL_CLIP_BYTES;
  const local = input.localHtmlBytes ?? null;
  let delivered: number | null = null;
  let source: SizeSource = "none";
  if (typeof input.sizeEstimate === "number" && input.sizeEstimate > 0) {
    delivered = input.sizeEstimate;
    source = "gmail_size_estimate";
  } else if (typeof input.emailFileBytes === "number" && input.emailFileBytes > 0) {
    delivered = input.emailFileBytes;
    source = "email_file";
  }
  const issues: DeliveredSizeIssue[] = [];
  if (delivered === null) {
    issues.push({
      type: "info",
      category: "delivered_size_unmeasured",
      detail: "tamanho do e-mail entregue não medido (sem sizeEstimate nem dump) — o guard local não cobre o que o ESP acrescenta",
    });
    return { delivered_bytes: null, delivered_source: source, local_html_bytes: local, limit_bytes: limit, over_limit: false, issues };
  }
  const over = delivered > limit;
  if (over) {
    const localPart = local !== null ? ` (HTML local: ${kb(local)} KB — a diferença é o que o ESP acrescenta)` : "";
    issues.push({
      type: "warning",
      category: "delivered_size_over_clip",
      detail:
        `e-mail ENTREGUE tem ${delivered} bytes (${kb(delivered)} KB, fonte ${source}), acima do corte do Gmail ` +
        `(${kb(limit)} KB)${localPart}. O Gmail vai cortar ("Mensagem cortada") e o pixel de abertura no fim some — ` +
        `abertura Gmail subcontada. Cortar conteúdo é decisão editorial.`,
    });
  }
  return { delivered_bytes: delivered, delivered_source: source, local_html_bytes: local, limit_bytes: limit, over_limit: over, issues };
}

function fileBytes(p: string | undefined): number | null {
  if (!p || !existsSync(p)) return null;
  return statSync(p).size;
}

function main(): void {
  const { values } = parseCliArgs(process.argv.slice(2));
  const rawEstimate = values["size-estimate"];
  let sizeEstimate: number | null = null;
  if (typeof rawEstimate === "string" && rawEstimate !== "") {
    sizeEstimate = Number(rawEstimate);
    if (!Number.isFinite(sizeEstimate)) {
      console.error(`--size-estimate inválido: ${rawEstimate}`);
      process.exit(2);
    }
  }
  const emailFile = typeof values["email-file"] === "string" ? values["email-file"] : undefined;
  const localHtml = typeof values["local-html"] === "string" ? values["local-html"] : undefined;
  const result = evaluateDeliveredSize({
    sizeEstimate,
    emailFileBytes: fileBytes(emailFile),
    localHtmlBytes: fileBytes(localHtml),
  });
  const json = JSON.stringify(result, null, 2);
  const out = values["out"];
  if (typeof out === "string") writeFileSync(out, json + "\n");
  console.log(json);
  process.exit(result.over_limit ? 1 : 0);
}

if (isMainModule(import.meta.url)) main();

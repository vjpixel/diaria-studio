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
 *   1. `--html-bytes N` — tamanho da parte `text/html` da mensagem entregue
 *      (quando o payload do Gmail expõe as partes MIME). É o que o corte do
 *      Gmail mede de fato (#9311) → veredito DEFINITIVO.
 *   2. `--size-estimate N` — `sizeEstimate` da mensagem no Gmail (get_thread).
 *      Mede a mensagem MIME INTEIRA (parte text/plain + headers + inflação de
 *      quoted-printable/base64), então é um TETO da parte HTML, não a medida
 *      dela (#9311). Abaixo do corte → OK com certeza; acima → só "PODE
 *      cortar" (`delivered_size_may_clip`, informativo, sem exit 1). Ex. real:
 *      261001 tinha 43 KB de HTML local e 106 KB de estimate.
 *   3. `--email-file` — bytes do dump materializado (aproximação; o dump é o
 *      corpo, sem headers, então tende a SUBestimar).
 *
 * Uso:
 *   npx tsx scripts/lint-test-email-size.ts \
 *     [--html-bytes 61000] [--size-estimate 106488] \
 *     [--email-file .../_internal/test-email-{AAMMDD}.txt] \
 *     [--local-html .../_internal/newsletter-final-kit.html] \
 *     [--out .../_internal/lint-size-{AAMMDD}.json]
 *
 * #9823: entre `GMAIL_NEAR_CLIP_BYTES` (95 KB) e o corte sai o alarme
 * `delivered_size_near_clip` (warning com parte HTML/dump; info com sizeEstimate,
 * que é teto) — sem mudar o exit code.
 *
 * Exit: 0 = dentro do limite, só "pode cortar", ou sem medida; 1 = acima do
 * corte com medida da parte HTML (ou do dump); 2 = uso.
 * Nunca bloqueia sozinho — o resultado é exibido no gate 6 (parada única).
 * Cortar conteúdo é decisão editorial: o `review-test-email` reporta TODOS os
 * achados daqui com prefixo `info:`, nunca `email:` (que é blocker e
 * despacharia o fix loop do Stage 5 com um problema que ele não pode
 * resolver — #9311).
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts";

/** Corte de clipping do Gmail — mesmo valor de `KIT_HTML_SIZE_ERROR_BYTES` (#6506). */
export const GMAIL_CLIP_BYTES = 102 * 1024;

/**
 * #9823 — alarme ANTES do corte: a 261007 chegou com 98,8 KB, a ~3% do limite,
 * e nada avisou (só o corte em si acusava). Acima deste piso e até o corte, o
 * achado `delivered_size_near_clip` sai no gate 6 — informativo, nunca blocker.
 */
export const GMAIL_NEAR_CLIP_BYTES = 95 * 1024;

export type SizeSource = "gmail_html_part" | "gmail_size_estimate" | "email_file" | "none";

export interface DeliveredSizeIssue {
  type: "warning" | "info";
  category:
    | "delivered_size_over_clip"
    | "delivered_size_may_clip"
    | "delivered_size_near_clip"
    | "delivered_size_unmeasured";
  detail: string;
}

export interface DeliveredSizeResult {
  delivered_bytes: number | null;
  delivered_source: SizeSource;
  local_html_bytes: number | null;
  limit_bytes: number;
  /** Acima do corte com medida que representa a parte HTML (ou o dump). */
  over_limit: boolean;
  /** #9311: só o `sizeEstimate` (MIME inteiro, teto) passou do corte — inconclusivo. */
  may_clip: boolean;
  /** #9823: medida entre `GMAIL_NEAR_CLIP_BYTES` e o corte — perto de cortar. */
  near_clip: boolean;
  issues: DeliveredSizeIssue[];
}

const kb = (n: number) => (n / 1024).toFixed(1);

const positive = (n: number | null | undefined): n is number => typeof n === "number" && n > 0;

/** Lógica pura: decide o achado a partir das medidas já obtidas. */
export function evaluateDeliveredSize(input: {
  htmlPartBytes?: number | null;
  sizeEstimate?: number | null;
  emailFileBytes?: number | null;
  localHtmlBytes?: number | null;
  limitBytes?: number;
  nearClipBytes?: number;
}): DeliveredSizeResult {
  const limit = input.limitBytes ?? GMAIL_CLIP_BYTES;
  const nearClip = input.nearClipBytes ?? GMAIL_NEAR_CLIP_BYTES;
  const local = input.localHtmlBytes ?? null;
  let delivered: number | null = null;
  let source: SizeSource = "none";
  if (positive(input.htmlPartBytes)) {
    delivered = input.htmlPartBytes;
    source = "gmail_html_part";
  } else if (positive(input.sizeEstimate)) {
    delivered = input.sizeEstimate;
    source = "gmail_size_estimate";
  } else if (positive(input.emailFileBytes)) {
    delivered = input.emailFileBytes;
    source = "email_file";
  }
  const base = { delivered_bytes: delivered, delivered_source: source, local_html_bytes: local, limit_bytes: limit };
  const issues: DeliveredSizeIssue[] = [];
  if (delivered === null) {
    issues.push({
      type: "info",
      category: "delivered_size_unmeasured",
      detail: "tamanho do e-mail entregue não medido (sem parte HTML, sizeEstimate nem dump) — o guard local não cobre o que o ESP acrescenta",
    });
    return { ...base, over_limit: false, may_clip: false, near_clip: false, issues };
  }
  if (source === "email_file") {
    issues.push({
      type: "info",
      category: "delivered_size_unmeasured",
      detail: "sem medida do Gmail — tamanho veio do dump (corpo extraído, sem headers/MIME): estimativa por BAIXO",
    });
  }
  const localPart = local !== null ? ` (HTML local: ${kb(local)} KB — a diferença é o que o ESP acrescenta)` : "";
  if (delivered <= limit) {
    if (delivered <= nearClip) return { ...base, over_limit: false, may_clip: false, near_clip: false, issues };
    issues.push({
      // sizeEstimate é teto (MIME inteiro) — perto do corte vira info; parte
      // HTML/dump perto do corte é o sinal real de que falta pouco pro Gmail cortar.
      type: source === "gmail_size_estimate" ? "info" : "warning",
      category: "delivered_size_near_clip",
      detail:
        `e-mail entregue com ${delivered} bytes (${kb(delivered)} KB, fonte ${source}) — acima do alarme de ` +
        `${kb(nearClip)} KB e a ${(((limit - delivered) / limit) * 100).toFixed(1)}% do corte do Gmail ` +
        `(${kb(limit)} KB)${localPart}. Uma edição um pouco mais longa corta ("Mensagem cortada") e some o pixel de ` +
        `abertura. Cortar conteúdo é decisão editorial.`,
    });
    return { ...base, over_limit: false, may_clip: false, near_clip: true, issues };
  }

  if (source === "gmail_size_estimate") {
    // #9311: sizeEstimate é a mensagem MIME inteira — passar do corte não
    // prova que a parte HTML passou. Informativo, nunca over_limit.
    issues.push({
      type: "info",
      category: "delivered_size_may_clip",
      detail:
        `sizeEstimate do Gmail é ${delivered} bytes (${kb(delivered)} KB), acima do corte (${kb(limit)} KB)${localPart} — ` +
        `mas mede a mensagem MIME inteira (text/plain + headers + inflação de quoted-printable/base64), não só a parte HTML ` +
        `que o Gmail corta. PODE cortar: conferir no e-mail de teste se aparece "Mensagem cortada". Cortar conteúdo é decisão editorial.`,
    });
    return { ...base, over_limit: false, may_clip: true, near_clip: false, issues };
  }
  issues.push({
    type: "warning",
    category: "delivered_size_over_clip",
    detail:
      `e-mail ENTREGUE tem ${delivered} bytes (${kb(delivered)} KB, fonte ${source}), acima do corte do Gmail ` +
      `(${kb(limit)} KB)${localPart}. O Gmail vai cortar ("Mensagem cortada") e o pixel de abertura no fim some — ` +
      `abertura Gmail subcontada. Cortar conteúdo é decisão editorial.`,
  });
  return { ...base, over_limit: true, may_clip: false, near_clip: false, issues };
}

function fileBytes(p: string | undefined): number | null {
  if (!p || !existsSync(p)) return null;
  return statSync(p).size;
}

function main(): void {
  const { values } = parseCliArgs(process.argv.slice(2));
  const positiveArg = (flag: string): number | null => {
    const raw = values[flag];
    if (typeof raw !== "string" || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`--${flag} inválido: ${raw}`);
      process.exit(2);
    }
    return n;
  };
  const htmlPartBytes = positiveArg("html-bytes");
  const sizeEstimate = positiveArg("size-estimate");
  const emailFile = typeof values["email-file"] === "string" ? values["email-file"] : undefined;
  const localHtml = typeof values["local-html"] === "string" ? values["local-html"] : undefined;
  const result = evaluateDeliveredSize({
    htmlPartBytes,
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

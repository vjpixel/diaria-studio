/**
 * verify-clarice-coupons.ts (#1982)
 *
 * O bloco de divulgação CLARICE (midCallout daily `**📣 …**` #1938 + PARA
 * ENCERRAR) passa por 2 passos LLM (Clarice `correct_text` + humanizer) antes do
 * render. Os cupons `NEWS25`/`NEWS50` e o link de afiliado
 * `clarice.ai/precos-planos?via=diaria` NÃO têm guard — `verify-clarice-url-
 * stability.ts` só checa URLs de list-items em LANÇAMENTOS. Um rewrite silencioso
 * quebraria o tracking de afiliado (`?via=diaria`) ou o cupom — sem ninguém
 * perceber até o parceiro reclamar.
 *
 * Este check compara pré-Clarice vs pós-Clarice (reviewed.md) e garante que cada
 * literal patrocinado **sobrevive** (contagem pós ≥ pré). Se o bloco não existia
 * no pré (sem patrocínio), não há o que proteger → ok.
 *
 * Uso:
 *   npx tsx scripts/verify-clarice-coupons.ts \
 *     --pre data/editions/AAMMDD/_internal/02-pre-clarice.md \
 *     --post data/editions/AAMMDD/02-reviewed.md
 *
 * Exit: 0 = cupons/link preservados (ou ausentes no pré). 1 = algum sumiu/mudou
 * (warn no gate — editor restaura). 2 = erro de uso.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";

/** Literais patrocinados que NÃO podem ser reescritos pela Clarice/humanizer. */
export const SPONSORED_LITERALS = [
  "NEWS25",
  "NEWS50",
  "clarice.ai/precos-planos?via=diaria",
] as const;

export interface CouponSurvivalResult {
  status: "ok" | "error";
  dropped: Array<{ literal: string; pre_count: number; post_count: number }>;
}

function countOccurrences(text: string, literal: string): number {
  // literal pode conter `?`/`.` — escapar pra contar como substring exata.
  const esc = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (text.match(new RegExp(esc, "g")) || []).length;
}

/**
 * Pure (#1982): pra cada literal patrocinado, se existia no pré-Clarice e a
 * contagem pós caiu, é drop (Clarice/humanizer reescreveu). Literal ausente no
 * pré não é protegido (edição sem patrocínio).
 */
export function checkCouponSurvival(preText: string, postText: string): CouponSurvivalResult {
  const dropped: CouponSurvivalResult["dropped"] = [];
  for (const literal of SPONSORED_LITERALS) {
    const pre = countOccurrences(preText, literal);
    if (pre === 0) continue; // não havia o que proteger
    const post = countOccurrences(postText, literal);
    if (post < pre) dropped.push({ literal, pre_count: pre, post_count: post });
  }
  return { status: dropped.length === 0 ? "ok" : "error", dropped };
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
  const preArg = values["pre"];
  const postArg = values["post"];
  if (!preArg || !postArg) {
    console.error("Uso: verify-clarice-coupons.ts --pre <pre-clarice.md> --post <reviewed.md>");
    process.exit(2);
  }
  const prePath = resolve(ROOT, preArg);
  const postPath = resolve(ROOT, postArg);
  // Pré ausente (ex: §2a pulado em rerun) → no-op silencioso, não bloqueia.
  if (!existsSync(prePath) || !existsSync(postPath)) {
    console.log(JSON.stringify({ status: "ok", dropped: [], skipped: "arquivo ausente" }, null, 2));
    return;
  }
  const result = checkCouponSurvival(readFileSync(prePath, "utf8"), readFileSync(postPath, "utf8"));
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "error") {
    console.error(
      `\n❌ ${result.dropped.length} literal(is) patrocinado(s) CLARICE sumiram/mudaram pós-Clarice (#1982):`,
    );
    for (const d of result.dropped) {
      console.error(`  "${d.literal}": pré=${d.pre_count} → pós=${d.post_count}`);
    }
    console.error(
      "\nA Clarice/humanizer reescreveu cupom ou link de afiliado. Restaure o literal exato em 02-reviewed.md antes de publicar (quebra tracking via=diaria / cupom do parceiro).",
    );
    process.exit(1);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (/\/scripts\/verify-clarice-coupons\.ts$/.test(_argv1)) {
  main();
}

export { main };

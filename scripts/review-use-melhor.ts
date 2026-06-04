/**
 * review-use-melhor.ts (#1798)
 *
 * Guard determinístico contra item mal-bucketado no `use_melhor` — newsletter/
 * análise/cobertura entrando no lugar de tutorial. Em 260604 dois posts da
 * `latent.space` (newsletter/podcast, EN) caíram no bucket; o editor teve que
 * corrigir na mão. As regras de julgamento ficam em `context/editorial-rules.md`
 * (#1798), mas dependem da memória do agente — este guard fecha o loop surfando
 * os suspeitos no gate da Etapa 1, de forma determinística.
 *
 * WARN-ONLY: nunca bloqueia (o editor cura `use_melhor` no gate, 0-1 item).
 * Só lista os suspeitos com o motivo, pra não embarcar silenciosamente.
 *
 * Uso:
 *   npx tsx scripts/review-use-melhor.ts --approved data/editions/AAMMDD/_internal/01-approved.json
 *
 * Output JSON: { total, suspicious: [{ url, title?, reasons[] }] }
 * Exit code: sempre 0 (warn-only). O orchestrator surfaça `suspicious[]` no gate.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { isAggregator } from "./lib/aggregators.ts";

/**
 * Domínios primariamente newsletter/podcast/análise — só PARTE do conteúdo é
 * tutorial, então no bucket use_melhor merecem revisão. `latent.space` está aqui
 * (e NÃO globalmente como aggregator, pra não quebrar o categorize que aceita
 * tutoriais reais de lá). `*.substack.com`/`*.beehiiv.com` cobertos por sufixo.
 */
export const NEWSLETTER_LIKE_HOSTS = new Set<string>([
  "latent.space",
  "stratechery.com",
  "newsletter.pragmaticengineer.com",
  "oneusefulthing.org",
  "importai.net",
]);

/**
 * Hosts que são tutoriais de verdade — não flagar por "sem sinal de slug" (o
 * slug do cookbook/learn raramente tem verbo). Espelha (parcialmente) os
 * TUTORIAL_DOMAINS do categorize.ts.
 */
export const TUTORIAL_HOSTS = new Set<string>([
  "cookbook.openai.com",
  "fast.ai",
  "huggingface.co",
  "kaggle.com",
  "pinecone.io",
  "realpython.com",
  "deeplearning.ai",
  "learn.microsoft.com",
  "developers.googleblog.com",
]);

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Domínio newsletter/agregador (cobertura/análise, não tutorial). */
export function isNewsletterLike(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (NEWSLETTER_LIKE_HOSTS.has(host)) return true;
  if (/\.substack\.com$/.test(host) || /\.beehiiv\.com$/.test(host)) return true;
  return isAggregator(url);
}

/** Verbo imperativo / padrão how-to no título ou no slug. */
const TUTORIAL_SIGNAL_RE =
  /\b(como|guia|passo[- ]?a[- ]?passo|tutorial|cookbook|how[- ]?to|walkthrough|hands[- ]?on|step[- ]?by[- ]?step|build (?:your|a|an)|crash course|getting started|comece|aprenda|construa|criando|fa[çc]a)\b/i;

export function hasTutorialSignal(url: string, title: string): boolean {
  const host = hostOf(url);
  if (host && TUTORIAL_HOSTS.has(host)) return true;
  let slug = "";
  try {
    slug = decodeURIComponent(new URL(url).pathname).replace(/[-_/]+/g, " ");
  } catch {
    // url inválida — sem slug; cai no teste de título só.
  }
  return TUTORIAL_SIGNAL_RE.test(title) || TUTORIAL_SIGNAL_RE.test(slug);
}

export interface UseMelhorItem {
  url?: string;
  title?: string;
  [k: string]: unknown;
}

export interface SuspiciousItem {
  url: string;
  title?: string;
  reasons: string[];
}

export interface ReviewResult {
  total: number;
  suspicious: SuspiciousItem[];
}

/**
 * Flag suspeito = domínio newsletter/agregador OU sem sinal de tutorial
 * (issue #1798). Pura e testável.
 */
export function reviewUseMelhor(items: UseMelhorItem[]): ReviewResult {
  const suspicious: SuspiciousItem[] = [];
  for (const item of items) {
    const url = typeof item.url === "string" ? item.url : "";
    if (!url) continue;
    const title = typeof item.title === "string" ? item.title : "";
    const reasons: string[] = [];
    if (isNewsletterLike(url)) {
      reasons.push("domínio newsletter/agregador (cobertura/análise, não tutorial)");
    }
    if (!hasTutorialSignal(url, title)) {
      reasons.push("sem sinal de tutorial no título/slug (como/guia/how-to/cookbook/...)");
    }
    if (reasons.length > 0) {
      suspicious.push({ url, title: title || undefined, reasons });
    }
  }
  return { total: items.length, suspicious };
}

interface ApprovedShape {
  use_melhor?: UseMelhorItem[];
  [k: string]: unknown;
}

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { values } = parseCliArgs(process.argv.slice(2));
  const approvedArg = values["approved"];
  if (!approvedArg) {
    console.error("Uso: review-use-melhor.ts --approved <01-approved.json>");
    process.exit(2);
  }
  const approvedPath = resolve(ROOT, approvedArg);
  if (!existsSync(approvedPath)) {
    console.error(`Arquivo não existe: ${approvedPath}`);
    process.exit(2);
  }
  let approved: ApprovedShape;
  try {
    approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedShape;
  } catch (err) {
    console.error(`Falha ao parsear ${approvedPath}: ${(err as Error).message}`);
    process.exit(2);
  }

  const items = Array.isArray(approved.use_melhor) ? approved.use_melhor : [];
  const result = reviewUseMelhor(items);
  console.log(JSON.stringify(result, null, 2));

  if (result.suspicious.length > 0) {
    console.error(
      `\n⚠️ ${result.suspicious.length} de ${result.total} item(ns) de USE MELHOR suspeito(s) de não-tutorial:`,
    );
    for (const s of result.suspicious) {
      const titleHint = s.title ? ` ("${s.title.slice(0, 60)}")` : "";
      console.error(`  ${s.url}${titleHint}`);
      for (const r of s.reasons) console.error(`     → ${r}`);
    }
    console.error(
      "Revise no gate: USE MELHOR é tutorial de verdade, não cobertura/análise (#1798).",
    );
  }
  // Warn-only: nunca bloqueia (exit 0).
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}

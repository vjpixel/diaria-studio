/**
 * measure-paywall-discards.ts (#12537, Etapa 1 item 2)
 *
 * Mede quantas histórias o veredito `paywall` do `verify-accessibility.ts`
 * tirou do pool nas edições recentes (o Stage 1 remove todo item `paywall`,
 * `stage-1-run.ts` `isRemovableVerdict`) e, com `--fetch`, quantas tinham o
 * texto legível de verdade (artigo inteiro, não prévia, pelo detector de
 * `lib/diaria/paywall-preview.ts`). É o dado que o #12537 pede antes de mudar
 * a regra: se o descarte for raro, a mudança quase não muda as edições.
 *
 * Fonte: `data/editions/{AAMM}/{AAMMDD}/_internal/link-verify-all.json` de
 * cada edição da janela. Separa o veredito por origem:
 *   - `domain`  — lista fixa de domínios (`known-paywall domain`);
 *   - `marker`  — frase achada no HTML (`marker: ...` / `browser marker: ...`).
 *
 * Uso:
 *   npx tsx scripts/measure-paywall-discards.ts [--days 60] [--editions-dir data/editions]
 *     [--fetch] [--fetch-limit 80] [--json]
 *
 * Só leitura: nunca escreve em `data/`. `--fetch` faz GET das URLs (sem
 * login), em série, e imprime o resultado por URL.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { fetchSourceText } from "./fetch-source-text.ts";

export type PaywallOrigin = "domain" | "marker";

export interface PaywallDiscard {
  edition: string;
  url: string;
  host: string;
  origin: PaywallOrigin;
  note: string;
}

export interface PaywallDiscardSummary {
  editions: number;
  editions_with_file: number;
  total: number;
  unique_urls: number;
  by_origin: Record<PaywallOrigin, number>;
  by_host: Array<{ host: string; count: number; origin: PaywallOrigin }>;
  by_note: Array<{ note: string; count: number }>;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Itens `paywall` de um `link-verify-all.json` já parseado. @pure */
export function extractPaywallDiscards(edition: string, verifyAll: unknown): PaywallDiscard[] {
  if (!Array.isArray(verifyAll)) return [];
  const out: PaywallDiscard[] = [];
  for (const r of verifyAll) {
    if (!r || typeof r !== "object") continue;
    const { verdict, url, note } = r as { verdict?: unknown; url?: unknown; note?: unknown };
    if (verdict !== "paywall" || typeof url !== "string") continue;
    const n = typeof note === "string" ? note : "";
    out.push({
      edition,
      url,
      host: hostOf(url),
      origin: /known-paywall domain/i.test(n) ? "domain" : "marker",
      note: n || "(sem nota)",
    });
  }
  return out;
}

/** Agrega os descartes. @pure */
export function summarizePaywallDiscards(
  discards: PaywallDiscard[],
  editions: number,
  editionsWithFile: number,
): PaywallDiscardSummary {
  const by_origin: Record<PaywallOrigin, number> = { domain: 0, marker: 0 };
  const hosts = new Map<string, { count: number; origin: PaywallOrigin }>();
  const notes = new Map<string, number>();
  for (const d of discards) {
    by_origin[d.origin]++;
    const h = hosts.get(d.host) ?? { count: 0, origin: d.origin };
    h.count++;
    hosts.set(d.host, h);
    const key = d.note.replace(/^browser marker:/, "marker:");
    notes.set(key, (notes.get(key) ?? 0) + 1);
  }
  return {
    editions,
    editions_with_file: editionsWithFile,
    total: discards.length,
    unique_urls: new Set(discards.map((d) => d.url)).size,
    by_origin,
    by_host: [...hosts.entries()]
      .map(([host, v]) => ({ host, ...v }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
    by_note: [...notes.entries()]
      .map(([note, count]) => ({ note, count }))
      .sort((a, b) => b.count - a.count || a.note.localeCompare(b.note)),
  };
}

/** AAMMDD → Date (UTC, meia-noite). @pure */
function editionDate(aammdd: string): Date {
  return new Date(Date.UTC(2000 + Number(aammdd.slice(0, 2)), Number(aammdd.slice(2, 4)) - 1, Number(aammdd.slice(4, 6))));
}

/** Edições dentro de `days` dias antes de `now`, mais antiga primeiro. @pure */
export function editionsInWindow(aammdds: string[], days: number, now: Date): string[] {
  const cutoff = now.getTime() - days * 86_400_000;
  return aammdds.filter((e) => /^\d{6}$/.test(e) && editionDate(e).getTime() >= cutoff).sort();
}

async function main(): Promise<number | void> {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const days = Number(values.days ?? 60);
  const root = values["editions-dir"] ?? join("data", "editions");
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days precisa ser número positivo");
    return 1;
  }
  const dirs = enumerateEditionDirs(root);
  const window = editionsInWindow([...dirs.keys()], days, new Date());
  const discards: PaywallDiscard[] = [];
  let withFile = 0;
  for (const ed of window) {
    const p = join(dirs.get(ed)!, "_internal", "link-verify-all.json");
    if (!existsSync(p)) continue;
    try {
      discards.push(...extractPaywallDiscards(ed, JSON.parse(readFileSync(p, "utf8"))));
      withFile++;
    } catch (e) {
      console.error(`[measure-paywall-discards] ${p} ilegível: ${(e as Error).message}`);
    }
  }
  const summary = summarizePaywallDiscards(discards, window.length, withFile);

  const fetched: Array<{ url: string; host: string; origin: PaywallOrigin; result: string; words?: number; signals?: string[] }> = [];
  if (flags.has("fetch")) {
    const limit = Number(values["fetch-limit"] ?? 80);
    const seen = new Set<string>();
    for (const d of discards) {
      if (seen.has(d.url) || seen.size >= limit) continue;
      seen.add(d.url);
      const r = await fetchSourceText(d.url);
      fetched.push(
        r.ok
          ? { url: d.url, host: d.host, origin: d.origin, result: r.paywall.completeness, words: r.paywall.words, signals: r.paywall.signals }
          : { url: d.url, host: d.host, origin: d.origin, result: r.kind },
      );
    }
  }

  if (flags.has("json")) {
    console.log(JSON.stringify({ days, summary, fetched, discards }, null, 2));
    return;
  }
  console.log(`Janela: ${days} dias · ${summary.editions} edições (${summary.editions_with_file} com link-verify-all.json)`);
  console.log(`Vereditos paywall: ${summary.total} (${summary.unique_urls} URLs únicas) · domínio ${summary.by_origin.domain} · marcador ${summary.by_origin.marker}`);
  console.log("\nPor host:");
  for (const h of summary.by_host.slice(0, 30)) console.log(`  ${String(h.count).padStart(4)}  ${h.host}  [${h.origin}]`);
  console.log("\nPor nota:");
  for (const n of summary.by_note) console.log(`  ${String(n.count).padStart(4)}  ${n.note}`);
  if (fetched.length > 0) {
    const tally = new Map<string, number>();
    for (const f of fetched) tally.set(`${f.origin}/${f.result}`, (tally.get(`${f.origin}/${f.result}`) ?? 0) + 1);
    console.log(`\nFetch (${fetched.length} URLs): ${[...tally.entries()].map(([k, v]) => `${k}=${v}`).join(" · ")}`);
    for (const f of fetched) {
      console.log(`  ${f.result.padEnd(8)} ${f.origin.padEnd(6)} ${f.words ?? "-"}w ${(f.signals ?? []).join(",")}  ${f.url}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("[measure-paywall-discards] ERRO:", e) });
}

/** #12188: deterministic intake ledger, complete link scores and gate report.
 * --edition AAMMDD [--edition-dir path] [--require-scores]
 * --sender email --from AAMMDD --to AAMMDD: read-only ledger query.
 * --decisions batch.json: persist explicit editor decisions in the versioned registry.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { processThreads, type CapturedThread } from "./capture-newsletter-urls.ts";
import { parseDestaques } from "./extract-destaques.ts";
import { parseSections } from "./lib/newsletter-parse.ts";
import { canonicalize } from "./lib/url-utils.ts";
import { classifySender, loadSenderRegistry, senderKey, type SenderRegistry, type SenderDecision } from "./lib/newsletter-senders.ts";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";

export interface IntakeThread extends CapturedThread { capture_error?: string }
type Item = Record<string, unknown>;
export interface LinkAudit {
  url: string; title: string; score: number | null; score_status: "pontuado" | "pendente";
  thread_id: string; newsletter: string; destino: string;
}
export function urlKey(url: string): string { return canonicalize(url).toLowerCase(); }
/** Accept pool, chunk, fallback and approved shapes without selecting only finalists. */
export function collectItems(value: unknown): Item[] {
  if (Array.isArray(value)) return value.flatMap(collectItems);
  if (!value || typeof value !== "object") return [];
  const obj = value as Item;
  const article = obj.article && typeof obj.article === "object" ? obj.article as Item : undefined;
  const normalized = article && typeof article.url === "string" ? {...article, ...obj, url: article.url} : obj;
  return [...(typeof normalized.url === "string" ? [normalized] : []), ...Object.entries(obj).filter(([key]) => key !== "article").flatMap(([, child]) => collectItems(child))];
}
export function buildIntake(threads: IntakeThread[], registry: SenderRegistry, scores: unknown[], pool: unknown, final: unknown,
  alwaysConsiderSenders: string[] = [], metadata: unknown[] = []) {
  const scored = new Map<string, Item>();
  for (const item of scores.flatMap(collectItems)) {
    if (typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > 100) continue;
    for (const alias of [item.url, item.resolvedFrom, item.original_url]) {
      if (typeof alias === "string") scored.set(urlKey(alias), item);
    }
  }
  // Join redirects resolved by enrichment back to the captured URL.
  const metadataItems = [...metadata, pool, final].flatMap(collectItems);
  for (let pass = 0; pass < 3; pass++) for (const item of metadataItems) {
    const aliases = [item.url, item.resolvedFrom, item.original_url].filter((u): u is string => typeof u === "string").map(urlKey);
    const match = aliases.map((k) => scored.get(k)).find(Boolean);
    if (match) for (const key of aliases) scored.set(key, match);
  }
  const titles = new Map<string, string>();
  for (const item of [...scores, ...metadata, pool, final].flatMap(collectItems)) {
    if (typeof item.title === "string" && !item.title.startsWith("(newsletter:")) {
      for (const alias of [item.url, item.resolvedFrom, item.original_url]) if (typeof alias === "string") titles.set(urlKey(alias), item.title);
    }
  }
  const poolKeys = new Set(collectItems(pool).flatMap((i) => [i.url, i.resolvedFrom, i.original_url])
    .filter((u): u is string => typeof u === "string").map(urlKey));
  const destinations = new Map<string, string>();
  function visit(value: unknown, section = "seção") {
    if (Array.isArray(value)) { value.forEach((v) => visit(v, section)); return; }
    if (!value || typeof value !== "object") return;
    const item = value as Item;
    if (typeof item.url === "string") destinations.set(urlKey(item.url), typeof item.destination === "string" ? item.destination : section);
    for (const [key, child] of Object.entries(item)) visit(child, /^(highlights|destaques)$/.test(key) ? "destaque" : ["radar", "lancamento", "use_melhor", "video"].includes(key) ? key : section);
  }
  visit(final);
  const links: LinkAudit[] = [];
  const rows = threads.map((thread) => {
    const classification = classifySender(thread.sender, registry);
    const extraction = processThreads([thread], {processed_thread_ids: []}, {alwaysConsiderSenders});
    const articles = extraction.articles;
    if (classification.classificacao === "IA") for (const article of articles) {
      const key = urlKey(article.url);
      const match = scored.get(key);
      const destination = destinations.get(key) ?? (typeof match?.url === "string" ? destinations.get(urlKey(match.url)) : undefined);
      links.push({url: article.url, title: titles.get(key) ?? (typeof match?.title === "string" ? match.title : article.title),
        score: typeof match?.score === "number" ? match.score : null, score_status: match ? "pontuado" : "pendente",
        thread_id: thread.thread_id, newsletter: thread.sender, destino: destination ?? "fora da edição"});
    }
    const threadLinks = links.filter((l) => l.thread_id === thread.thread_id);
    const pending = threadLinks.filter((l) => l.score === null).length;
    const untitled = threadLinks.filter((l) => !l.title.trim() || l.title.startsWith("(newsletter:")).length;
    return {thread_id: thread.thread_id, remetente: thread.sender, assunto: thread.subject, data: thread.date,
      ...classification, links_extraidos: extraction.result.urls_extracted,
      links_capturados: articles.length, links_no_pool: articles.filter((a) => poolKeys.has(urlKey(a.url))).length,
      links_pontuados: classification.classificacao === "IA" ? articles.length - pending : 0,
      estado: thread.capture_error ? "falhou" : classification.classificacao !== "IA" ? "ignorada" : pending || untitled ? "falhou" : "lida",
      estado_motivo: thread.capture_error ?? (classification.classificacao !== "IA" ? classification.classificacao_motivo : pending || untitled ? `${pending} links aguardam pontuação; ${untitled} aguardam título` : "Links extraídos e pontuados; sem resumo"),
    };
  });
  links.sort((a,b) => (b.score ?? -1) - (a.score ?? -1) || a.url.localeCompare(b.url) || a.thread_id.localeCompare(b.thread_id));
  return {rows, links, pending_senders: [...new Set(rows.filter((r) => r.remetente_status === "novo-pendente" && r.remetente).map((r) => senderKey(r.remetente)))].sort()};
}
function json(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function optional(path: string): unknown { return existsSync(path) ? json(path) : undefined; }
function cache(path: string): unknown { try { return optional(path); } catch { return undefined; } }
export function appendSnapshots(path: string, edition: string, rows: unknown[]): number {
  mkdirSync(dirname(path), {recursive: true});
  const previous = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const hashes = new Map(previous.map((r) => [r.thread_id, r.snapshot_hash]));
  let added = 0;
  for (const row of rows) {
    const hash = createHash("sha256").update(JSON.stringify(row)).digest("hex");
    const id = (row as {thread_id: string}).thread_id;
    if (hashes.get(id) === hash) continue;
    appendFileSync(path, JSON.stringify({edition, at: new Date().toISOString(), snapshot_hash: hash, ...row as object}) + "\n");
    hashes.set(id, hash); added++;
  }
  return added;
}
export function applyDecisions(path: string, batch: Record<string, SenderDecision>): void {
  const registry = loadSenderRegistry(path);
  if (!batch || typeof batch !== "object" || Array.isArray(batch) || !Object.keys(batch).length) throw new Error("Lote de decisões vazio/inválido");
  for (const [sender, decision] of Object.entries(batch)) registry.senders[senderKey(sender)] = decision;
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(registry, null, 2) + "\n");
  try { loadSenderRegistry(tmp); renameSync(tmp, path); }
  catch (error) { throw new Error(`Lote inválido; registro preservado: ${error}`); }
}
export function main(argv = process.argv.slice(2)): void {
  const {values, flags} = parseArgs(argv);
  const dataDir = resolve(values["data-dir"] ?? "data");
  const registryPath = resolve(values.registry ?? "seed/newsletter-senders.json");
  if (values.decisions) { applyDecisions(registryPath, json(values.decisions) as Record<string, SenderDecision>); return; }
  if (!values.edition) {
    const ledger = resolve(dataDir, "newsletter-intake");
    const entries = existsSync(ledger) ? readdirSync(ledger).filter((f) => /^\d{6}\.jsonl$/.test(f)).sort().flatMap((f) => {
      const edition = basename(f, ".jsonl");
      if (values.from && edition < values.from || values.to && edition > values.to) return [];
      return readFileSync(resolve(ledger, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    }).filter((r) => !values.sender || senderKey(r.remetente) === senderKey(values.sender)) : [];
    console.log(JSON.stringify(entries, null, 2)); return;
  }
  if (!/^\d{6}$/.test(values.edition)) throw new Error("--edition deve ser AAMMDD");
  const editionDir = resolve(values["edition-dir"] ?? `${dataDir}/editions/${values.edition}`);
  const internal = resolve(editionDir, "_internal");
  mkdirSync(internal, {recursive: true});
  const capturedPath = resolve(internal, "captured-newsletters.json");
  const threads = (optional(capturedPath) ?? []) as IntakeThread[];
  if (!Array.isArray(threads)) throw new Error("captured-newsletters deve ser array");
  const scores = ["tmp-allscored.json", "tmp-scored.json", "newsletter-extra-scores.json", "01-approved.json"].map((f) => optional(resolve(internal, f)));
  const pool = optional(resolve(internal, "tmp-articles-raw.json"));
  const metadata = ["tmp-dates-reviewed.json", "captured-newsletter-articles.json"].map((f) => optional(resolve(internal, f)));
  metadata.push(cache(resolve(internal, "newsletter-link-scores.json")), cache(resolve(internal, "newsletter-unscored.json")));
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const reviewed = existsSync(reviewedPath) ? readFileSync(reviewedPath, "utf8") : undefined;
  const final = reviewed === undefined ? optional(resolve(internal, "01-approved.json")) : [
    ...parseDestaques(reviewed).map((d) => ({url: d.url, title: d.title, destination: "destaque"})),
    ...parseSections(reviewed).flatMap((s) => s.items.map((i) => ({...i, destination: s.name}))),
  ];
  const config = optional(resolve("platform.config.json")) as {newsletter_auto_capture?: {always_consider_senders?: string[]}} | undefined;
  const result = buildIntake(threads, loadSenderRegistry(registryPath), scores, pool, final, config?.newsletter_auto_capture?.always_consider_senders, metadata);
  const ledger = resolve(dataDir, `newsletter-intake/${values.edition}.jsonl`);
  appendSnapshots(ledger, values.edition, result.rows);
  const manifestPath = resolve(internal, "captured-newsletters.json.fetch.jsonl");
  const warnings: string[] = [];
  if (!existsSync(capturedPath)) warnings.push("Captura indisponível: captured-newsletters.json ausente");
  if (existsSync(manifestPath)) {
    const events = readFileSync(manifestPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const ids = new Set<string>(events.flatMap((e) => e.thread_ids));
    const latest = new Map(events.map((e) => [e.scope ?? e.query, e]));
    for (const event of latest.values()) if (event.failed) warnings.push(`capture_failed: ${event.error}`);
    const recorded = new Set(result.rows.map((r) => r.thread_id));
    if (ids.size !== recorded.size || [...ids].some((id) => !recorded.has(id))) warnings.push(`total no inbox na janela (${ids.size}) != total registrado (${recorded.size})`);
  } else warnings.push("Total no inbox na janela indisponível: manifesto da captura ausente");
  if (existsSync(resolve(internal, ".capture-newsletter-failed.json"))) warnings.push("capture_failed: captura Gmail falhou");
  if (result.rows.some((r) => r.estado === "falhou")) warnings.push("Há newsletters com estado falhou; conferir motivos no intake");
  const missing = [...new Map(result.links.filter((l) => l.score === null || !l.title.trim() || l.title.startsWith("(newsletter:")).map((l) => [urlKey(l.url), l])).values()];
  // Same input contract as scorer-chunk. Supplemental scores never change selection.
  const metadataItems = [...metadata, pool].flatMap(collectItems);
  const supplemental = missing.map((link) => ({...metadataItems.find((i) => typeof i.url === "string" && urlKey(i.url) === urlKey(link.url)), ...link, flag: "newsletter_extracted"}));
  writeFileSync(resolve(internal, "newsletter-unscored.json"), JSON.stringify({articles: supplemental, categorized: {radar: supplemental, lancamento: [], use_melhor: [], video: []}}, null, 2) + "\n");
  writeFileSync(resolve(internal, "newsletter-link-scores.json"), JSON.stringify({...result, warnings}, null, 2) + "\n");
  const cell = (value: unknown) => String(value).replace(/[\r\n|]/g, " ");
  const report = ["## Intake de newsletters de IA", ...warnings.map((w) => `⚠️ ${w}`),
    `Remetentes novos pendentes (decidir em um lote): ${result.pending_senders.join(", ") || "nenhum"}`,
    "", "| Score | Título | Newsletter | Destino | URL |", "| --- | --- | --- | --- | --- |",
    ...result.links.map((l) => `| ${l.score ?? "PENDENTE"} | ${cell(l.title)} | ${cell(l.newsletter)} | ${cell(l.destino)} | ${cell(l.url)} |`)];
  writeFileSync(resolve(internal, "newsletter-intake-gate.md"), report.join("\n") + "\n");
  console.log(JSON.stringify({threads: result.rows.length, links: result.links.length, missing_scores: result.links.filter((l) => l.score === null).length, missing_titles: result.links.filter((l) => !l.title.trim() || l.title.startsWith("(newsletter:")).length, pending_senders: result.pending_senders, warnings}));
  if (flags.has("require-scores") && missing.length) process.exitCode = 1;
}
if (isMainModule(import.meta.url)) {
  try { main(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}

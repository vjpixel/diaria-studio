#!/usr/bin/env node
/**
 * monthly-relink-to-diaria.ts
 *
 * Gera uma VARIANTE do HTML da edição mensal em que os links das MATÉRIAS
 * CITADAS NOS DESTAQUES apontam para a EDIÇÃO DIÁRIA da Diar.ia de onde aquele
 * item veio, em vez de apontar direto pro veículo original.
 *
 * Motivação (análise 260726): no ciclo 2606-07 a mensal mandou 253 cliques pra
 * veículos de terceiros e 81 pra diar.ia. Redirecionar a manchete pra edição
 * diária onde ela apareceu transforma o clique de conteúdo em visita ao
 * produto, sem tirar o conteúdo do leitor (a edição diária tem a matéria e o
 * link original).
 *
 * ESCOPO (decisão do editor, 260726): **só os destaques**. Use Melhor e Radar
 * ficam apontando pra fonte original — são seções de serviço, onde o leitor
 * quer o tutorial/link em si, não a edição que o citou.
 *
 * UTMs dos links reescritos:
 *   utm_source=clarice   (igual ao resto da peça)
 *   utm_medium=email     (igual ao resto da peça)
 *   utm_campaign=<o mesmo do HTML base>  — envios são monitorados por envio,
 *                        então não faz sentido um campaign próprio pro relink.
 *   utm_term=<slug do TEXTO ÂNCORA>  — a edição de destino já está na própria
 *                        URL (`/p/{slug}`); o que o utm_term precisa dizer é
 *                        QUAL TRECHO puxou o clique.
 *
 * Também normaliza TODO link `diaria.beehiiv.com` → `diar.ia.br` (href
 * canônico desde 260723, #2613/#3970 — o redirect no Cloudflare preserva a
 * query string).
 *
 * Uso:
 *   npx tsx scripts/monthly-relink-to-diaria.ts --cycle 2606-07
 *   npx tsx scripts/monthly-relink-to-diaria.ts --cycle 2606-07 --in <html> --out <html>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple as parseArgs } from "./lib/cli-args.ts";

const args = parseArgs(process.argv.slice(2));
const CYCLE = String(args.cycle ?? "2606-07");
const ROOT = process.cwd();
const MDIR = resolve(ROOT, "data/monthly", CYCLE);

const IN = String(args.in ?? resolve(MDIR, "_internal/cta-ab/envio9-a.html"));
const OUT = String(args.out ?? resolve(MDIR, "_internal/relink-diaria.html"));

/** Hosts que nunca são reescritos para edição diária. */
const KEEP = [
  "diar.ia.br", "diaria.beehiiv.com", "workers.dev",
  "clarice.ai", "apoia.se",
  "linkedin.com", "facebook.com", "instagram.com",
  "commons.wikimedia.org", "creativecommons.org",
  "link.amazon",
];

/** Identidade de artigo — ignora querystring de tracking e www/barra final. */
export function normUrl(u: string): string {
  try {
    const x = new URL(u.replace(/&amp;/g, "&"));
    x.hash = "";
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^ref$|^via$/i.test(k)) x.searchParams.delete(k);
    return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "") + (x.search || "")).toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

/** Slug curto e estável a partir do texto âncora — vira o `utm_term`. */
export function slugifyAnchor(text: string, maxWords = 6, maxLen = 44): string {
  const clean = text
    .normalize("NFD").replace(/[̀-ͯ]/g, "")   // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!clean) return "";
  let slug = clean.split(/\s+/).slice(0, maxWords).join("-");
  if (slug.length > maxLen) slug = slug.slice(0, maxLen).replace(/-[^-]*$/, "");
  return slug;
}

// ---------------------------------------------------------------- mapeamentos
const rawPath = resolve(MDIR, "_internal/raw-destaques.json");
const clicksPath = resolve(MDIR, "_internal/monthly-clicks.json");
if (!existsSync(rawPath)) throw new Error(`não achei ${rawPath}`);

const raw = JSON.parse(readFileSync(rawPath, "utf8"));
const urlToEdition = new Map<string, string>();
const editionToPostId = new Map<string, string>();
for (const d of raw.destaques ?? []) {
  if (d.url && d.edition && !urlToEdition.has(normUrl(d.url))) urlToEdition.set(normUrl(d.url), d.edition);
  if (d.edition && d.beehiiv_post_id && !editionToPostId.has(d.edition)) editionToPostId.set(d.edition, d.beehiiv_post_id);
}

/** URLs de Use Melhor e Radar — seções de serviço, NUNCA reescritas (editor, 260726). */
const servicoUrls = new Set<string>();
if (existsSync(clicksPath)) {
  const cl = JSON.parse(readFileSync(clicksPath, "utf8"));
  for (const bucket of ["use_melhor", "radar"]) {
    for (const it of cl[bucket] ?? []) if (it.url) servicoUrls.add(normUrl(it.url));
  }
}

const idx = JSON.parse(readFileSync(resolve(ROOT, "data/beehiiv-cache/posts/index.json"), "utf8")) as any[];
const byIdPrefix = new Map<string, any>();
const byDate = new Map<string, any>();
for (const p of idx) {
  byIdPrefix.set(String(p.id).replace(/^post_/, "").slice(0, 8), p);
  if (p.publish_date) {
    const dt = new Date(Number(p.publish_date) * 1000 - 3 * 3600 * 1000);
    const key = `${String(dt.getUTCFullYear()).slice(2)}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`;
    if (!byDate.has(key)) byDate.set(key, p);
  }
}

function editionUrl(edition: string): string | null {
  const pid = editionToPostId.get(edition);
  const p = (pid && byIdPrefix.get(pid)) || byDate.get(edition);
  if (!p?.web_url) return null;
  return String(p.web_url).replace(/^https:\/\/diaria\.beehiiv\.com/, "https://diar.ia.br");
}

// ---------------------------------------------------------------- reescrita
let html = readFileSync(IN, "utf8");

// utm_campaign: o do HTML base, SEM o sufixo de braço do experimento CTA-01
// (decisão do editor 260726 — envios são monitorados por envio, o braço não
// precisa viver no campaign). `clarice-2606-07-cta-a` → `clarice-2606-07`.
const campaign = String(
  args.campaign ??
    ((html.match(/utm_campaign=([a-z0-9\-]+)/i) ?? [])[1] ?? `clarice-${CYCLE}`).replace(/-cta-[ab]$/i, ""),
);

let relinked = 0, servico = 0, naoMapeado = 0;
const termsUsed = new Set<string>();
const log: string[] = [];
const skipped: string[] = [];

html = html.replace(/<a\s([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g,
  (full, pre: string, hrefRaw: string, post: string, inner: string) => {
    const href = String(hrefRaw);
    if (href.includes("{{")) return full;
    let host = "";
    try { host = new URL(href.replace(/&amp;/g, "&")).host; } catch { return full; }
    if (KEEP.some((k) => host.endsWith(k) || host.includes(k))) return full;

    const key = normUrl(href);

    // Use Melhor / Radar: fonte original, sempre (decisão do editor 260726).
    if (servicoUrls.has(key)) { servico++; skipped.push(`serviço  ${host}`); return full; }

    const ed = urlToEdition.get(key);
    const base = ed ? editionUrl(ed) : null;
    if (!base) { naoMapeado++; skipped.push(`sem mapa ${host}`); return full; }

    const anchor = inner.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
    let term = slugifyAnchor(anchor) || `ed-${ed}`;
    // Textos âncora repetidos existem de verdade (ex: "pediu abertura de capital
    // confidencial nos EUA" aparece para Anthropic e para OpenAI, em edições
    // diferentes). Sem desambiguar, os dois virariam a MESMA linha no relatório
    // de utm_term — sufixa com a edição, que é o que de fato os separa.
    if (termsUsed.has(term)) term = `${term}-${ed}`;
    termsUsed.add(term);
    const url = `${base}?utm_source=clarice&utm_medium=email&utm_campaign=${campaign}&utm_term=${term}`;

    relinked++;
    log.push(`  ${term.padEnd(46)} ← "${anchor.slice(0, 40)}…"  (ed ${ed})`);
    return `<a ${pre}href="${url.replace(/&/g, "&amp;")}"${post}>${inner}</a>`;
  });

// #12 (editor 260726): TODO link do domínio antigo passa pro canônico.
const beehiivAntes = (html.match(/diaria\.beehiiv\.com/g) ?? []).length;
html = html.replace(/https:\/\/diaria\.beehiiv\.com/g, "https://diar.ia.br");

// #15 (editor 260726): links do "É IA?" passam pro domínio de marca.
// `eia.diar.ia.br` é Workers Custom Domain apontando pro MESMO worker `poll`
// (workers/poll/wrangler.toml) — o brand vem do query param `?brand=`, nunca
// do hostname, então voto/leaderboard funcionam idênticos. O host antigo segue
// vivo (workers_dev = true) só pros links já embutidos em edições ENVIADAS.
const pollAntes = (html.match(/poll\.diaria\.workers\.dev/g) ?? []).length;
html = html.replace(/https:\/\/poll\.diaria\.workers\.dev/g, "https://eia.diar.ia.br");

// Sufixo de braço também sai dos links que já estavam no HTML base (CTAs).
const ctaAntes = (html.match(/utm_campaign=clarice-[0-9-]+-cta-[ab]/gi) ?? []).length;
html = html.replace(/(utm_campaign=clarice-[0-9-]+)-cta-[ab]/gi, "$1");

writeFileSync(OUT, html, "utf8");

console.log(`entrada : ${IN}`);
console.log(`saída   : ${OUT}`);
console.log(`campaign: ${campaign}\n`);
console.log(`destaques reescritos para a edição diária: ${relinked}`);
for (const l of log) console.log(l);
console.log(`\nmantidos na fonte original: ${servico} (Use Melhor / Radar)${naoMapeado ? ` + ${naoMapeado} sem mapeamento` : ""}`);
for (const s of skipped) console.log(`  ${s}`);
console.log(`\ndiaria.beehiiv.com → diar.ia.br      : ${beehiivAntes} ocorrências`);
console.log(`poll.diaria.workers.dev → eia.diar.ia.br : ${pollAntes} ocorrências`);
console.log(`sufixo -cta-a/-cta-b removido do campaign: ${ctaAntes} ocorrências`);

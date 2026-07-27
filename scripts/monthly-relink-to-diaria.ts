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
 *   utm_campaign=<o do HTML base, SEM sufixo de braço>  — envios são
 *                        monitorados por envio, então nem o relink nem o braço
 *                        do A/B precisam viver no campaign.
 *   utm_term=<slug do TEXTO ÂNCORA>  — a edição de destino já está na própria
 *                        URL (`/p/{slug}`); o que o utm_term precisa dizer é
 *                        QUAL TRECHO puxou o clique.
 *
 * Também normaliza `diaria.beehiiv.com` → `diar.ia.br` (href canônico desde
 * 260723, #2613/#3970) e `poll.diaria.workers.dev` → `eia.diar.ia.br` (domínio
 * de marca do "É IA?", #3701 — mesmo worker, brand vem do query param).
 *
 * ESTRUTURA: toda a lógica pura fica exportada e livre de I/O (`normUrl`,
 * `slugifyAnchor`, `buildUrlToEdition`, `buildRelink`, `makeEditionUrlResolver`);
 * leitura e escrita de arquivo ficam em `main()`, atrás de `isMainModule`. Sem
 * essa separação, um `import` deste módulo num teste executaria o script
 * inteiro e sobrescreveria o HTML de saída — achado do review da PR #4066.
 *
 * Uso (CLI standalone — reanálise ad-hoc de HTML já gerado):
 *   npx tsx scripts/monthly-relink-to-diaria.ts --cycle 2606-07
 *   npx tsx scripts/monthly-relink-to-diaria.ts --cycle 2606-07 --in <html> --out <html>
 *
 * #4048: desde este PR, esta transformação também roda AUTOMATICAMENTE em toda
 * edição — `relinkMonthlyEditionHtml` (abaixo) é chamada por
 * `scripts/monthly-preview-cloudflare.ts` logo após `draftToEmail` produzir o
 * HTML, ANTES de gravar `_internal/cloudflare-preview.html` (o HTML que
 * efetivamente vira campanha Brevo — ver `clarice-schedule-sends.ts
 * --update-html`). O CLI acima segue existindo pra reanálise pontual de HTML
 * histórico (ex.: ciclos publicados antes do #4048) — não é mais o único jeito
 * de aplicar o relink, só o modo manual.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";

/** Hosts que nunca são reescritos para edição diária. */
export const KEEP_HOSTS = [
  "diar.ia.br", "diaria.beehiiv.com", "workers.dev",
  "clarice.ai", "apoia.se",
  "linkedin.com", "facebook.com", "instagram.com",
  "commons.wikimedia.org", "creativecommons.org",
  "link.amazon",
] as const;

/** Identidade de artigo — ignora querystring de tracking, `www.` e barra final. */
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

export interface DestaqueRef { url?: string; edition?: string; beehiiv_post_id?: string }

/**
 * Monta `url normalizada → edição`. Vence a PRIMEIRA ocorrência do mês.
 *
 * Quando a MESMA url aparece em destaques de edições diferentes (desdobramento
 * da mesma notícia — a regra editorial só proíbe repetir link nas últimas 3
 * edições), a escolha da primeira é arbitrária e pode mandar o clique pra
 * edição errada. Não dá pra resolver automaticamente sem saber qual menção o
 * texto da mensal está citando, então o caso é DEVOLVIDO em `ambiguous` para
 * virar aviso visível em vez de erro silencioso (review da PR #4066).
 */
export function buildUrlToEdition(destaques: DestaqueRef[]): {
  urlToEdition: Map<string, string>;
  editionToPostId: Map<string, string>;
  ambiguous: { url: string; editions: string[] }[];
} {
  const urlToEdition = new Map<string, string>();
  const editionToPostId = new Map<string, string>();
  const seen = new Map<string, Set<string>>();

  for (const d of destaques ?? []) {
    if (d.url && d.edition) {
      const key = normUrl(d.url);
      if (!urlToEdition.has(key)) urlToEdition.set(key, d.edition);
      const set = seen.get(key) ?? new Set<string>();
      set.add(d.edition);
      seen.set(key, set);
    }
    if (d.edition && d.beehiiv_post_id && !editionToPostId.has(d.edition)) {
      editionToPostId.set(d.edition, d.beehiiv_post_id);
    }
  }

  const ambiguous = [...seen.entries()]
    .filter(([, eds]) => eds.size > 1)
    .map(([url, eds]) => ({ url, editions: [...eds].sort() }));

  return { urlToEdition, editionToPostId, ambiguous };
}

export interface RelinkMaps {
  urlToEdition: Map<string, string>;
  /** URLs de Use Melhor/Radar — seções de serviço, nunca reescritas. */
  servicoUrls: Set<string>;
  /** edição AAMMDD → URL canônica do post diário (ou null se não achou). */
  editionUrl: (edition: string) => string | null;
}

export interface RelinkResult {
  html: string;
  relinked: number;
  servico: number;
  naoMapeado: number;
  campaign: string;
  log: string[];
  skipped: string[];
  beehiivNormalizados: number;
  pollNormalizados: number;
  ctaSuffixRemovidos: number;
}

/** Reescreve o HTML. Pura: não lê nem escreve arquivo. */
export function buildRelink(htmlIn: string, maps: RelinkMaps, campaignOverride?: string): RelinkResult {
  const campaign =
    campaignOverride ??
    ((htmlIn.match(/utm_campaign=([a-z0-9\-]+)/i) ?? [])[1] ?? "clarice").replace(/-cta-[ab]$/i, "");

  let relinked = 0, servico = 0, naoMapeado = 0;
  const termsUsed = new Set<string>();
  const log: string[] = [];
  const skipped: string[] = [];

  let html = htmlIn.replace(/<a\s([^>]*?)href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g,
    (full, pre: string, hrefRaw: string, post: string, inner: string) => {
      const href = String(hrefRaw);
      if (href.includes("{{")) return full;
      let host = "";
      try { host = new URL(href.replace(/&amp;/g, "&")).host; } catch { return full; }
      if (KEEP_HOSTS.some((k) => host.endsWith(k) || host.includes(k))) return full;

      const key = normUrl(href);
      if (maps.servicoUrls.has(key)) { servico++; skipped.push(`serviço  ${host}`); return full; }

      const ed = maps.urlToEdition.get(key);
      const base = ed ? maps.editionUrl(ed) : null;
      if (!ed || !base) { naoMapeado++; skipped.push(`sem mapa ${host}`); return full; }

      const anchor = inner.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
      let term = slugifyAnchor(anchor) || `ed-${ed}`;
      // Textos âncora repetidos existem de verdade (ex: "pediu abertura de
      // capital confidencial nos EUA" aparece para Anthropic e para OpenAI, em
      // edições diferentes). Sem desambiguar, os dois virariam a MESMA linha no
      // relatório de utm_term — sufixa com a edição, que é o que os separa.
      if (termsUsed.has(term)) term = `${term}-${ed}`;
      termsUsed.add(term);

      const url = `${base}?utm_source=clarice&utm_medium=email&utm_campaign=${campaign}&utm_term=${term}`;
      relinked++;
      log.push(`  ${term.padEnd(46)} ← "${anchor.slice(0, 40)}…"  (ed ${ed})`);
      return `<a ${pre}href="${url.replace(/&/g, "&amp;")}"${post}>${inner}</a>`;
    });

  const beehiivNormalizados = (html.match(/diaria\.beehiiv\.com/g) ?? []).length;
  html = html.replace(/https:\/\/diaria\.beehiiv\.com/g, "https://diar.ia.br");

  const pollNormalizados = (html.match(/poll\.diaria\.workers\.dev/g) ?? []).length;
  html = html.replace(/https:\/\/poll\.diaria\.workers\.dev/g, "https://eia.diar.ia.br");

  const ctaSuffixRemovidos = (html.match(/utm_campaign=clarice-[0-9-]+-cta-[ab]/gi) ?? []).length;
  html = html.replace(/(utm_campaign=clarice-[0-9-]+)-cta-[ab]/gi, "$1");

  return { html, relinked, servico, naoMapeado, campaign, log, skipped, beehiivNormalizados, pollNormalizados, ctaSuffixRemovidos };
}

/** edição AAMMDD → URL canônica, a partir do índice de posts do Beehiiv. */
export function makeEditionUrlResolver(
  postsIndex: { id: string; web_url: string; publish_date?: number }[],
  editionToPostId: Map<string, string>,
): (edition: string) => string | null {
  const byIdPrefix = new Map<string, { web_url: string }>();
  const byDate = new Map<string, { web_url: string }>();
  for (const p of postsIndex) {
    byIdPrefix.set(String(p.id).replace(/^post_/, "").slice(0, 8), p);
    if (p.publish_date) {
      const dt = new Date(Number(p.publish_date) * 1000 - 3 * 3600 * 1000);
      const key = `${String(dt.getUTCFullYear()).slice(2)}${String(dt.getUTCMonth() + 1).padStart(2, "0")}${String(dt.getUTCDate()).padStart(2, "0")}`;
      if (!byDate.has(key)) byDate.set(key, p);
    }
  }
  return (edition: string) => {
    const pid = editionToPostId.get(edition);
    const p = (pid && byIdPrefix.get(pid)) || byDate.get(edition);
    if (!p?.web_url) return null;
    return String(p.web_url).replace(/^https:\/\/diaria\.beehiiv\.com/, "https://diar.ia.br");
  };
}

/**
 * #4048: monta os maps de relink (raw-destaques.json + monthly-clicks.json +
 * índice de posts do Beehiiv) e aplica `buildRelink` — MESMA lógica exposta
 * pelo CLI (`main()` abaixo), extraída pra função importável. Ponto único
 * chamado tanto pelo CLI standalone (reanálise ad-hoc de HTML histórico)
 * quanto pelo pipeline real (`scripts/monthly-preview-cloudflare.ts`, que
 * gera `_internal/cloudflare-preview.html` — o HTML que efetivamente vira
 * campanha Brevo via `clarice-schedule-sends.ts --update-html`). Lança se
 * `raw-destaques.json` não existir — caller decide se isso é fatal (CLI) ou
 * fail-soft com HTML original preservado (pipeline, ver
 * `monthly-preview-cloudflare.ts`).
 */
export function relinkMonthlyEditionHtml(
  html: string,
  monthlyDir: string,
  root: string,
  campaignOverride?: string,
): RelinkResult & { ambiguous: { url: string; editions: string[] }[] } {
  const rawPath = resolve(monthlyDir, "_internal/raw-destaques.json");
  if (!existsSync(rawPath)) throw new Error(`não achei ${rawPath}`);
  const raw = JSON.parse(readFileSync(rawPath, "utf8"));
  const { urlToEdition, editionToPostId, ambiguous } = buildUrlToEdition(raw.destaques ?? []);

  const servicoUrls = new Set<string>();
  const clicksPath = resolve(monthlyDir, "_internal/monthly-clicks.json");
  if (existsSync(clicksPath)) {
    const cl = JSON.parse(readFileSync(clicksPath, "utf8"));
    for (const bucket of ["use_melhor", "radar"]) {
      for (const it of cl[bucket] ?? []) if (it.url) servicoUrls.add(normUrl(it.url));
    }
  }

  const idx = JSON.parse(readFileSync(resolve(root, "data/beehiiv-cache/posts/index.json"), "utf8"));
  const editionUrl = makeEditionUrlResolver(idx, editionToPostId);

  const r = buildRelink(html, { urlToEdition, servicoUrls, editionUrl }, campaignOverride);
  return { ...r, ambiguous };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function main(argv: string[] = process.argv.slice(2)): void {
  const args = parseArgs(argv);
  const CYCLE = String(args.cycle ?? "2606-07");
  const ROOT = process.cwd();
  const MDIR = resolve(ROOT, "data/monthly", CYCLE);
  const IN = String(args.in ?? resolve(MDIR, "_internal/cta-ab/envio9-a.html"));
  const OUT = String(args.out ?? resolve(MDIR, "_internal/relink-diaria.html"));

  const r = relinkMonthlyEditionHtml(
    readFileSync(IN, "utf8"),
    MDIR,
    ROOT,
    args.campaign ? String(args.campaign) : undefined,
  );
  const ambiguous = r.ambiguous;
  writeFileSync(OUT, r.html, "utf8");

  console.log(`entrada : ${IN}`);
  console.log(`saída   : ${OUT}`);
  console.log(`campaign: ${r.campaign}\n`);
  console.log(`destaques reescritos para a edição diária: ${r.relinked}`);
  for (const l of r.log) console.log(l);
  console.log(`\nmantidos na fonte original: ${r.servico} (Use Melhor / Radar)${r.naoMapeado ? ` + ${r.naoMapeado} sem mapeamento` : ""}`);
  for (const s of r.skipped) console.log(`  ${s}`);
  console.log(`\ndiaria.beehiiv.com → diar.ia.br          : ${r.beehiivNormalizados} ocorrências`);
  console.log(`poll.diaria.workers.dev → eia.diar.ia.br : ${r.pollNormalizados} ocorrências`);
  console.log(`sufixo -cta-a/-cta-b removido do campaign: ${r.ctaSuffixRemovidos} ocorrências`);

  if (ambiguous.length) {
    console.log(`\n⚠️  ${ambiguous.length} URL(s) aparecem em MAIS DE UMA edição — o relink usou a primeira; confira se é a citada no texto:`);
    for (const a of ambiguous) console.log(`  ${a.url.slice(0, 80)}  → edições ${a.editions.join(", ")} (usada: ${a.editions[0]})`);
  }
}

if (isMainModule(import.meta.url)) main();

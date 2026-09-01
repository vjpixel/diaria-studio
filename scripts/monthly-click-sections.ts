#!/usr/bin/env tsx
/**
 * monthly-click-sections.ts
 *
 * Computa as seções "Use Melhor" (top 3) e "Radar" (top 7) do digest mensal,
 * ranqueadas por CLIQUES (Beehiiv per-link click data), a partir das edições
 * diárias publicadas no mês.
 *
 * Resolve #1901 (Outras Notícias → Radar; 7 mais clicados, excluindo links já
 * usados nos Destaques e no Use Melhor) e #1902 (Use Melhor: 3 mais clicados do
 * bucket use_melhor das edições diárias).
 *
 * Fontes:
 *  - Cliques (Beehiiv): data/beehiiv-cache/posts/post_{prefix}*.json (stats.clicks[]).
 *    Só links com ≥1 clique aparecem (dados esparsos) — o que não tiver clique
 *    registrado entra com 0.
 *  - Cliques (Kit, #6186): data/kit-cache/posts/kit_{prefix}.json (stats.clicks[],
 *    `unique_clicks` direto por URL — via mcp__kit__get_link_clicks_for_a_broadcast
 *    + scripts/apply-mcp-kit-clicks.ts, agent .claude/agents/kit-clicks-enricher.md).
 *    `loadClicks` tenta o cache Beehiiv primeiro; se o arquivo não existir, cai
 *    pro cache Kit com o MESMO prefixo. **Não presumir qual backend está ativo
 *    "hoje"** (a diária trocou pro Kit em 26/08/2026 #6114 e voltou pro Beehiiv
 *    no mesmo dia, #6491 — `platform.config.json` é a fonte de verdade do
 *    backend corrente, nunca este comentário): o fallback existe porque
 *    qualquer edição publicada durante uma janela Kit (mesmo curta) só tem
 *    cache Kit, e o mês pode legitimamente misturar os dois backends.
 *  - Seção + título de cada link: data/editions/{AAMMDD}/02-reviewed.md
 *    (texto final publicado).
 *  - Exclusão de Destaques: URLs de suporte dos 3 temas em
 *    data/monthly/{yymm}/prioritized.md.
 *  - Mapeamento edição→prefixo: nomes dos arquivos em
 *    data/monthly/{yymm}/raw-posts/post_{prefix}_{AAMMDD}.txt — o nome do
 *    arquivo NÃO distingue backend (#6184 já unificou a nomenclatura antes
 *    deste script existir: `prefix` é o UUID-8 do Beehiiv OU o ID numérico
 *    completo do Kit, dependendo de qual backend publicou aquela edição).
 *    A distinção de backend acontece só na hora de carregar cliques, por
 *    qual dos dois caches tem o arquivo.
 *
 * Métrica: cliques únicos somados por URL (de-dup por baseUrl). Beehiiv:
 * `email.unique_clicks` + `web.total_unique_clicked` (web é resíduo, mas conta).
 * Kit: `unique_clicks` direto (o shape do Kit já vem sem split email/web).
 * Decisão de produto (#1901/#1902): "mais clicados" = cliques únicos absolutos.
 * CTR exigiria aberturas por edição e favoreceria/penalizaria por tamanho de
 * lista variável.
 *
 * Saídas:
 *  - data/monthly/{yymm}/_internal/monthly-clicks.json (dados completos).
 *  - patch cirúrgico em prioritized.md: troca a seção "## Outras Notícias" por
 *    "## Use Melhor" + "## Radar".
 *
 * Uso: npx tsx scripts/monthly-click-sections.ts <YYMM>
 *
 * Tamanho do Use Melhor é configurável (#2792):
 *  - --use-melhor-count N: top-N fixo (default 3).
 *  - --use-melhor-min-clicks N: threshold — TODO tutorial com clicks >= N,
 *    empate na fronteira incluído. Tem precedência sobre --use-melhor-count
 *    (se ambos forem passados, count é ignorado com warning).
 *
 * Tamanho do Radar também é configurável, mesmo padrão do Use Melhor:
 *  - --radar-count N: top-N fixo (default 7).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isEditorial } from "./build-link-ctr.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import {
  extractBoxDivulgacao0,
  extractBoxDivulgacao1,
  extractBoxDivulgacao2,
  extractBoxDivulgacao3,
} from "./lib/newsletter-parse.ts";
import {
  parseMonthlyCycleArg,
  monthlyDir as resolveMonthlyDir,
} from "./lib/mensal/monthly-paths.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EDITIONS_ROOT_DIR = join(ROOT, "data/editions");

const USE_MELHOR_COUNT = 3;
const RADAR_COUNT = 7;

// ── Normalização de URL ─────────────────────────────────────────────
// Strip de query/hash/barra final pra casar a URL clicada (com utm) contra a
// URL limpa do 02-reviewed.md.
export function baseUrl(raw: string): string {
  // Só o host é case-insensitive; o path é case-sensitive na maioria dos
  // servidores. Lowercase só o host evita (a) merge falso de URLs distintas
  // que diferem só no case do path e (b) renderizar um link quebrado em
  // minúsculas no digest. Strip de query/hash/`.`,`,` finais + barra final,
  // pra casar a URL clicada (com utm) contra a URL limpa do 02-reviewed.
  try {
    const u = new URL(raw.trim());
    u.hostname = u.hostname.toLowerCase();
    u.search = "";
    u.hash = "";
    return u.toString().replace(/[.,]+$/, "").replace(/\/$/, "");
  } catch {
    return raw.trim().replace(/[.,]+$/, "").replace(/\/$/, "");
  }
}

// ── Seções do 02-reviewed.md ────────────────────────────────────────
// Classifica cada link por seção: "destaque", "use_melhor", ou "outro".
type Section = "destaque" | "use_melhor" | "outro";

// Exportado (#2791) para reuso por `collect-monthly.ts` no modo local — a
// mesma normalização (strip bold/emoji + uppercase) serve pra extrair a
// categoria do header `**DESTAQUE N | EMOJI CATEGORIA**` do 02-reviewed.md.
export function normalizeHeader(line: string): string {
  return line
    .replace(/\*/g, "")
    .replace(/[\p{Extended_Pictographic}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}‍]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// Headers de seção conhecidos (novo formato bold+emoji e antigo plain).
// Ancorado à LINHA INTEIRA (`$`, com sufixo opcional ` DO MÊS`/`:`) — um header
// é uma linha curta de rótulo, não uma frase de prosa. Sem isso, uma descrição
// como "Acesse o tutorial..." ou "Vídeos da conferência..." casaria com o
// prefixo e flipava `current`, mis-bucketando os links seguintes.
const HEADER_SUFFIX = `( DO M[EÊ]S)?:?$`;
function sectionOfHeader(h: string): Section | null {
  if (/^DESTAQUE\s*\d+\b/.test(h)) return "destaque";
  if (new RegExp(`^USE MELHOR${HEADER_SUFFIX}`).test(h)) return "use_melhor";
  if (
    new RegExp(
      `^(LAN[ÇC]AMENTOS?|RADAR|OUTRAS NOT[IÍ]CIAS|NOT[IÍ]CIAS|PESQUISAS?|V[IÍ]DEOS?|SORTEIO|PARA ENCERRAR|[ÉE] IA\\?|ERRO INTENCIONAL|T[IÍ]TULO|SUBT[IÍ]TULO|ACESSE)${HEADER_SUFFIX}`,
    ).test(h)
  )
    return "outro";
  return null;
}

export interface LinkItem {
  url: string;
  baseUrl: string;
  title: string;
  desc: string;
  section: Section;
  edition: string;
}

const LINK_RE = /\[([^\]]*?)\]\((https?:\/\/[^)\s]+)\)/g;

// Infra própria da diar.ia.br que aparece em TODA edição (Divulgação/Para
// encerrar — ver `boxes_divulgacao` e `para_encerrar` em platform.config.json,
// e os snippets rotativos em data/snippets/*-divulgacao.md): apoio,
// curadoria de livros/cursos, afiliado/vitrine Amazon, referrals fixos da
// assinatura. `isEditorial()` (build-link-ctr.ts) não filtra isso — lá o
// propósito é medir clique em TUDO (CTR table), aqui é achar as NOTÍCIAS
// mais clicadas do mês. Sem esse filtro, achado ao vivo no ciclo 2607-08:
// esses links (clicados em quase toda edição, então acumulam alto no mês)
// varreram a maioria das vagas do Radar, sobrando pouca notícia real.
// Inclui tanto domínio legado (`*.diaria.workers.dev`) quanto o rebrand
// `diar.ia.br` (#3577-ish) — ambos coexistem em ciclos/cache antigos.
// `amazon.com.br` inteiro entra porque, nesta newsletter, só aparece em
// caixa de divulgação (livro recomendado ou vitrine `/shop/{usuário}`) —
// nunca como fonte de notícia.
// `wa.me` (#6867, achado ciclo 2608-09): domínio fixo do bloco "Convide um
// amigo a assinar" (`buildConviteAmigoLink`/`buildWhatsappEditionUrl` em
// newsletter-render-html.ts) e de qualquer CTA de compartilhamento por
// WhatsApp injetado como box — nunca notícia, sempre infra própria.
const OWN_PROMO_HOSTS_RE =
  /^(apoia\.se|livros\.(diaria\.workers\.dev|diar\.ia\.br)|cursos\.(diaria\.workers\.dev|diar\.ia\.br)|link\.amazon|amazon\.com\.br|wa\.me|api\.whatsapp\.com)$/i;
function isOwnPromoLink(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (OWN_PROMO_HOSTS_RE.test(host)) return true;
    // Referral fixo da assinatura "Nessa edição da diar.ia.br, usei..." (mesmo
    // texto em toda edição, ver platform.config.json → para_encerrar.slot_a).
    if (host === "clarice.ai" && u.pathname.startsWith("/precos-planos")) return true;
    if (host === "wisprflow.ai") return true;
    return false;
  } catch {
    return false;
  }
}

// #6867: boxes de divulgação/CTA rotativos (data/snippets/*.md, injetados por
// stitchNewsletter nos slots 0-3 — intro, gaps D1/D2 e D2/D3, e pós-último-
// destaque) têm host VARIÁVEL por natureza (evento de terceiro, votação
// comunitária, patrocínio pontual) — `OWN_PROMO_HOSTS_RE` acima só cobre infra
// PRÓPRIA e ESTÁTICA, nunca cobriria todo box possível. Em vez de uma lista de
// hosts que nunca fecha, reusamos a MESMA detecção estrutural marcador-
// agnóstica que `stitch-newsletter.ts`/`newsletter-render-html.ts` já usam
// pra localizar esses blocos (`extractBoxDivulgacao{0,1,2,3}` — por posição
// entre `**DESTAQUE N` markers, não por conteúdo) e extraímos os links de
// dentro deles pra excluir do pool do Radar/Use Melhor, independente de host.
// Puramente textual sobre o `02-reviewed.md` já lido — não depende de
// `data/snippets/` existir neste processo (o conteúdo do box já foi
// materializado no markdown pelo stitch antes deste script rodar).
function extractBoxUrls(md: string): Set<string> {
  const urls = new Set<string>();
  const boxTexts = [
    extractBoxDivulgacao0(md),
    extractBoxDivulgacao1(md),
    extractBoxDivulgacao2(md),
    extractBoxDivulgacao3(md),
  ];
  for (const boxText of boxTexts) {
    if (!boxText) continue;
    const re = new RegExp(LINK_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(boxText)) !== null) {
      urls.add(baseUrl(m[2].trim()));
    }
  }
  return urls;
}

export function parseEdition(edition: string, md: string): LinkItem[] {
  const lines = md.split(/\r?\n/);
  const items: LinkItem[] = [];
  let current: Section = "outro";
  // #6867: links dentro de um box de divulgação/CTA (qualquer slot 0-3) nunca
  // são notícia, independente do host — ver `extractBoxUrls`.
  const boxUrls = extractBoxUrls(md);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    // É header de seção?
    const h = normalizeHeader(trimmed);
    // Linhas-header são curtas e não contêm link markdown.
    if (!/\]\(/.test(trimmed)) {
      const sec = sectionOfHeader(h);
      if (sec) {
        current = sec;
        continue;
      }
    }

    // Extrai links da linha.
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let firstLinkOnLine: { title: string; url: string } | null = null;
    while ((m = LINK_RE.exec(line)) !== null) {
      const text = m[1].replace(/\*/g, "").trim();
      const url = m[2].trim();
      if (/^https?:\/\//i.test(text) || text === "") {
        // formato antigo [url](url): título vem da linha não-vazia anterior
        if (!firstLinkOnLine) firstLinkOnLine = { title: "", url };
      } else {
        if (!firstLinkOnLine) firstLinkOnLine = { title: text, url };
      }
    }
    if (!firstLinkOnLine) continue;

    // Só consideramos links editoriais (filtra beehiiv/poll/social/etc).
    if (!isEditorial(firstLinkOnLine.url)) continue;
    // Filtra infra promocional própria (apoia.se, livros/cursos, afiliado
    // Amazon, referrals fixos, WhatsApp) — não é notícia, não deve competir no Radar.
    if (isOwnPromoLink(firstLinkOnLine.url)) continue;
    // #6867: filtra qualquer link que vive DENTRO de um box de divulgação/CTA
    // (host variável — evento de terceiro, votação comunitária, etc.), achado
    // ao vivo no ciclo 2608-09 quando conteúdo de box vazou pro Radar.
    if (boxUrls.has(baseUrl(firstLinkOnLine.url))) continue;

    let title = firstLinkOnLine.title;
    if (!title) {
      // título antigo: primeira linha não-vazia acima que NÃO seja header de
      // seção (senão um link logo abaixo de "OUTRAS NOTÍCIAS" herdaria o rótulo).
      for (let j = i - 1; j >= 0; j--) {
        const t = lines[j].trim();
        if (!t) continue;
        if (sectionOfHeader(normalizeHeader(t)) || /\]\(/.test(t)) break;
        title = t.replace(/\*/g, "").trim();
        break;
      }
    }
    // descrição: próxima linha não-vazia sem link
    let desc = "";
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (/\]\(/.test(t) || sectionOfHeader(normalizeHeader(t))) break;
      desc = t.replace(/\*/g, "").trim();
      break;
    }

    items.push({
      url: firstLinkOnLine.url,
      baseUrl: baseUrl(firstLinkOnLine.url),
      title,
      desc,
      section: current,
      edition,
    });
  }

  return items;
}

// ── Cliques por post ────────────────────────────────────────────────
//
// Nota de arquitetura (#6642 review): existe um leitor unificado
// Beehiiv+Kit em `scripts/lib/shared/edition-cache-reader.ts` (#6187 item
// 3), com `normalizeKitClick` fazendo mapeamento equivalente. Este arquivo
// NÃO o reusa de propósito — aquele módulo lê `data/kit-cache/broadcasts/`
// (todo o corpus de edições, metadata completa via um `kit-sync.ts` que
// ainda não existe) para consumidores de varredura tipo hub/dedup/arquivo;
// este script só precisa de um lookup pontual de cliques por prefixo pra
// ranquear o digest mensal, sem depender daquele escritor futuro. A
// duplicação de mapeamento (Beehiiv `email.unique_clicks`+`web` / Kit
// `unique_clicks` direto) é reconhecida como dívida — candidata a
// consolidação quando `kit-sync.ts` existir, não bloqueio deste PR.

export const DEFAULT_BEEHIIV_POSTS_DIR = join(ROOT, "data/beehiiv-cache/posts");
export const DEFAULT_KIT_POSTS_DIR = join(ROOT, "data/kit-cache/posts");

/** Cache Beehiiv: `data/beehiiv-cache/posts/post_{uuid}.json`, shape
 * `stats.clicks[].{email.unique_clicks, web.total_unique_clicked}`.
 * Exportada com `dir` injetável pra teste (#6642 review — antes só existia
 * a versão hardcoded em `ROOT`, sem cobertura direta). */
export function loadBeehiivClicks(prefix: string, dir: string = DEFAULT_BEEHIIV_POSTS_DIR): Map<string, number> | null {
  if (!existsSync(dir)) return null;
  // O prefixo é o 1º segmento do UUID (8 hex), sempre seguido de `-` no nome do
  // cache `post_{uuid}.json`. Exigir a fronteira `-` evita casar o post errado
  // quando um prefixo é prefixo-string de outro (`startsWith` cru é ambíguo).
  const matches = readdirSync(dir).filter((f) => f.startsWith(`post_${prefix}-`));
  const file = matches[0];
  if (!file) return null;
  const d = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const clicks = d?.stats?.clicks;
  const map = new Map<string, number>();
  if (!Array.isArray(clicks)) return map;
  for (const c of clicks) {
    if (!c?.url) continue;
    const uc = c?.email?.unique_clicks ?? 0;
    const web = c?.web?.total_unique_clicked ?? 0;
    const total = uc + web;
    const b = baseUrl(c.url);
    map.set(b, (map.get(b) ?? 0) + total);
  }
  return map;
}

/** Cache Kit (#6186): `data/kit-cache/posts/kit_{id8}.json`, shape
 * `stats.clicks[].unique_clicks` — já vem sem split email/web. `prefix` aqui
 * é o MESMO valor extraído do nome do raw-post (ver header do arquivo).
 * `dir` injetável pra teste, mesmo padrão de `loadBeehiivClicks`. */
export function loadKitClicks(prefix: string, dir: string = DEFAULT_KIT_POSTS_DIR): Map<string, number> | null {
  const file = join(dir, `kit_${prefix}.json`);
  if (!existsSync(file)) return null;
  const d = JSON.parse(readFileSync(file, "utf8"));
  const clicks = d?.stats?.clicks;
  const map = new Map<string, number>();
  if (!Array.isArray(clicks)) return map;
  for (const c of clicks) {
    if (!c?.url) continue;
    const b = baseUrl(c.url);
    map.set(b, (map.get(b) ?? 0) + (c?.unique_clicks ?? 0));
  }
  return map;
}

export type ClickSource = "beehiiv" | "kit" | "none";

export interface LoadClicksResult {
  clicks: Map<string, number>;
  /** Qual cache respondeu — "none" quando nenhum arquivo existe pro
   * prefixo (não confundir com "arquivo existe mas array vazio", que
   * retorna o source correto com um Map vazio). Usado só pra reportar a
   * proveniência real da métrica no digest (#6642 review — o campo
   * `metric` do retorno de `compute()` não pode presumir Beehiiv-only). */
  source: ClickSource;
}

/** Tenta o cache Beehiiv primeiro (comportamento histórico); se o ARQUIVO
 * não existir (não o conteúdo — um cache Beehiiv presente com
 * `stats.clicks` vazio/ausente ainda conta como "respondeu Beehiiv", não
 * cai pro Kit), cai pro cache Kit com o mesmo prefixo. Necessário porque
 * qualquer edição publicada durante uma janela em que o backend era Kit
 * (a diária trocou pro Kit em 26/08/2026 #6114 e reverteu pro Beehiiv no
 * mesmo dia, #6491 — não presumir qual backend está ativo "hoje" a partir
 * deste comentário) só tem cache Kit; o mês pode legitimamente misturar
 * os dois backends. */
export function loadClicksWithSource(
  prefix: string,
  beehiivDir: string = DEFAULT_BEEHIIV_POSTS_DIR,
  kitDir: string = DEFAULT_KIT_POSTS_DIR,
): LoadClicksResult {
  const beehiiv = loadBeehiivClicks(prefix, beehiivDir);
  if (beehiiv !== null) return { clicks: beehiiv, source: "beehiiv" };
  const kit = loadKitClicks(prefix, kitDir);
  if (kit !== null) return { clicks: kit, source: "kit" };
  return { clicks: new Map<string, number>(), source: "none" };
}

/** Wrapper compat — só o Map, sem a proveniência (usado onde a fonte não
 * importa pro chamador). */
export function loadClicks(prefix: string): Map<string, number> {
  return loadClicksWithSource(prefix).clicks;
}

/** Descreve a métrica de cliques no retorno de `compute()` de acordo com
 * QUAIS backends realmente contribuíram neste mês (#6642 review — a string
 * fixa antiga presumia sempre Beehiiv, o que fica incorreto/enganoso pro
 * editor num mês só-Kit ou misto). `"none"` sozinho no set (nenhuma edição
 * teve cache de nenhum backend) cai no texto genérico, sem mencionar
 * origem nenhuma — não há o que descrever. */
function describeClickMetric(sources: ReadonlySet<ClickSource>): string {
  const hasBeehiiv = sources.has("beehiiv");
  const hasKit = sources.has("kit");
  if (hasBeehiiv && hasKit) {
    return "Beehiiv: email.unique_clicks (+ web unique); Kit: unique_clicks — somados por URL, mês com edições dos dois backends";
  }
  if (hasKit) return "Kit: unique_clicks somados por URL";
  if (hasBeehiiv) return "Beehiiv: email.unique_clicks (+ web unique) somados por URL";
  return "cliques somados por URL (nenhuma edição do mês tinha cache de clique)";
}

// ── Edições do mês (a partir dos raw-posts) ─────────────────────────
/**
 * Lista edições a partir do diretório mensal (aceita ciclo ou yymm via
 * monthlyDir). Exposto como `listEditions(yymm)` para compat com `compute()`.
 */
function listEditions(yymm: string): { edition: string; prefix: string }[] {
  // monthlyDir resolve ciclo ou yymm, com fallback pra pasta legada
  const dir = join(resolveMonthlyDir(yymm), "raw-posts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => n.match(/^post_([a-f0-9]+)_(\d{6})\.txt$/i))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ prefix: m[1], edition: m[2] }))
    .sort((a, b) => a.edition.localeCompare(b.edition));
}

// ── URLs de Destaque (temas) do prioritized.md ──────────────────────
function themeUrls(yymm: string): Set<string> {
  const p = join(resolveMonthlyDir(yymm), "prioritized.md");
  const set = new Set<string>();
  if (!existsSync(p)) return set;
  const md = readFileSync(p, "utf8");
  // Bloco entre "## Destaques" e o próximo "## "
  const start = md.indexOf("## Destaques");
  if (start === -1) return set;
  const rest = md.slice(start + "## Destaques".length);
  const end = rest.search(/\n##\s/);
  const block = end === -1 ? rest : rest.slice(0, end);
  for (const m of block.matchAll(/https?:\/\/[^\s)]+/g)) {
    set.add(baseUrl(m[0]));
  }
  return set;
}

interface RankedLink {
  url: string;
  title: string;
  desc: string;
  clicks: number;
  editions: string[];
  sections: Section[];
}

function rank(
  pool: Map<string, { title: string; desc: string; editions: Set<string>; sections: Set<Section> }>,
  clicksByUrl: Map<string, number>,
): RankedLink[] {
  const out: RankedLink[] = [];
  for (const [b, meta] of pool) {
    out.push({
      url: b,
      title: meta.title,
      desc: meta.desc,
      clicks: clicksByUrl.get(b) ?? 0,
      editions: [...meta.editions].sort(),
      sections: [...meta.sections],
    });
  }
  // ordena por cliques desc, depois por edição mais recente (desempate), depois título
  out.sort(
    (a, b) =>
      b.clicks - a.clicks ||
      (b.editions.at(-1) ?? "").localeCompare(a.editions.at(-1) ?? "") ||
      a.title.localeCompare(b.title),
  );
  return out;
}

export interface ComputeOpts {
  // Edições FORA do mês usadas só para popular o Use Melhor (#1902), quando as
  // edições diárias do próprio mês são anteriores à criação da seção Use Melhor
  // (#1568). Ex.: digest de maio/2605 empresta a 1ª semana de junho. Essas
  // edições NÃO entram no pool do Radar.
  useMelhorSource?: { edition: string; prefix: string }[];
  // Override do nº de tutoriais no Use Melhor (default USE_MELHOR_COUNT = 3).
  // Editor pode pedir mais no gate da Etapa 1 (ex.: 5) via --use-melhor-count.
  useMelhorCount?: number;
  // Threshold: inclui TODO tutorial com clicks >= N (empate na fronteira
  // incluído), em vez de um top-N fixo. Editor pediu isso no gate 2606-07
  // ("todos com ≥6 cliques") — via --use-melhor-min-clicks. Tem PRECEDÊNCIA
  // sobre useMelhorCount quando ambos são passados (count é ignorado, com
  // warning).
  useMelhorMinClicks?: number;
  // Override do nº de links no Radar (default RADAR_COUNT = 7), mesmo padrão
  // do useMelhorCount — editor pode pedir outro número no gate da Etapa 1.
  radarCount?: number;
}

export function compute(yymm: string, opts: ComputeOpts = {}) {
  const editions = listEditions(yymm);
  if (editions.length === 0) {
    const dir = resolveMonthlyDir(yymm);
    throw new Error(
      `Nenhum raw-post em ${dir}/raw-posts/. Rode a coleta (Etapa 1a) antes.`,
    );
  }

  const themes = themeUrls(yymm);
  const clicksByUrl = new Map<string, number>();
  const warnings: string[] = [];
  // Proveniência real dos cliques usados neste mês (#6642 review — o campo
  // `metric` do retorno não pode presumir Beehiiv-only; um mês pode
  // legitimamente misturar os dois backends).
  const clickSourcesUsed = new Set<ClickSource>();

  // Coleta itens editoriais (com seção + edição) das edições do mês.
  const monthItems: LinkItem[] = [];
  for (const { edition, prefix } of editions) {
    // #2463/#3025: edição pode estar em disco no layout FLAT (recente) ou
    // NESTED (arquivada, data/editions/{AAMM}/{AAMMDD}/) — resolveEditionDir
    // já resolve os dois; um join direto (como era antes) perde toda edição
    // arquivada silenciosamente, como "sem 02-reviewed.md" (achado ao vivo:
    // 21 das 24 edições de julho/2026 já estavam no layout nested).
    const revPath = join(resolveEditionDir(EDITIONS_ROOT_DIR, edition), "02-reviewed.md");
    if (!existsSync(revPath)) {
      warnings.push(`${edition}: 02-reviewed.md ausente — pulada`);
      continue;
    }
    monthItems.push(...parseEdition(edition, readFileSync(revPath, "utf8")));
    const { clicks, source } = loadClicksWithSource(prefix);
    clickSourcesUsed.add(source);
    if (clicks.size === 0) warnings.push(`${edition}: sem per-link clicks no cache (contribui 0)`);
    for (const [b, n] of clicks) clicksByUrl.set(b, (clicksByUrl.get(b) ?? 0) + n);
  }

  // Use Melhor de fonte externa (#1902): edições emprestadas (ex.: 1ª semana de
  // junho para o digest de maio). Só a seção use_melhor entra; nada vai pro Radar.
  const useMelhorBorrowedFrom: string[] = [];
  const sourceItems: LinkItem[] = [];
  for (const { edition, prefix } of opts.useMelhorSource ?? []) {
    const revPath = join(resolveEditionDir(EDITIONS_ROOT_DIR, edition), "02-reviewed.md");
    if (!existsSync(revPath)) {
      warnings.push(`use-melhor-source ${edition}: 02-reviewed.md ausente — pulada`);
      continue;
    }
    useMelhorBorrowedFrom.push(edition);
    sourceItems.push(
      ...parseEdition(edition, readFileSync(revPath, "utf8")).filter((it) => it.section === "use_melhor"),
    );
    const { clicks, source } = loadClicksWithSource(prefix);
    clickSourcesUsed.add(source);
    if (clicks.size === 0)
      warnings.push(`use-melhor-source ${edition}: sem per-link clicks no cache (contribui 0)`);
    for (const [b, n] of clicks) clicksByUrl.set(b, (clicksByUrl.get(b) ?? 0) + n);
  }

  const precedenceWarning = useMelhorPrecedenceWarning(opts.useMelhorCount, opts.useMelhorMinClicks);
  if (precedenceWarning) warnings.push(precedenceWarning);

  const selected = selectSections(
    monthItems,
    sourceItems,
    clicksByUrl,
    themes,
    opts.useMelhorCount,
    opts.useMelhorMinClicks,
    opts.radarCount,
  );
  warnings.push(...selected.warnings);

  return {
    yymm,
    editions_count: editions.length,
    metric: describeClickMetric(clickSourcesUsed),
    use_melhor_borrowed_from: useMelhorBorrowedFrom,
    use_melhor: selected.use_melhor,
    use_melhor_candidates: selected.use_melhor_candidates,
    radar: selected.radar,
    radar_candidates_count: selected.radar_candidates_count,
    warnings,
  };
}

// ── Seleção pura (testável) ─────────────────────────────────────────

/**
 * Precedência entre --use-melhor-count e --use-melhor-min-clicks (#2792):
 * min-clicks vence quando ambos são passados; count é ignorado (não erro —
 * mantém o pipeline não-bloqueante). Retorna a mensagem de warning, ou
 * undefined se não houver conflito (só um dos dois, ou nenhum, foi passado).
 */
export function useMelhorPrecedenceWarning(
  useMelhorCount: number | undefined,
  useMelhorMinClicks: number | undefined,
): string | undefined {
  if (useMelhorMinClicks === undefined || useMelhorCount === undefined) return undefined;
  return `--use-melhor-count (${useMelhorCount}) ignorado — --use-melhor-min-clicks (${useMelhorMinClicks}) tem precedência.`;
}

type Meta = { title: string; desc: string; editions: Set<string>; sections: Set<Section> };

function addToPool(pool: Map<string, Meta>, it: LinkItem) {
  const cur = pool.get(it.baseUrl);
  if (cur) {
    cur.editions.add(it.edition);
    cur.sections.add(it.section);
    if (!cur.title && it.title) cur.title = it.title;
    if (!cur.desc && it.desc) cur.desc = it.desc;
  } else {
    pool.set(it.baseUrl, {
      title: it.title,
      desc: it.desc,
      editions: new Set([it.edition]),
      sections: new Set([it.section]),
    });
  }
}

/**
 * Dado os itens editoriais do mês (com seção/edição), itens de Use Melhor
 * emprestados de fora, o mapa de cliques (baseUrl→clicks) e o conjunto de URLs
 * dos Destaques (temas), seleciona Use Melhor e Radar (top 7).
 * Radar exclui Destaques + qualquer URL da seção Use Melhor. Função pura.
 *
 * Use Melhor: por padrão top-N fixo (`useMelhorCount`, default 3). Se
 * `useMelhorMinClicks` for passado, ignora `useMelhorCount` e inclui TODO
 * candidato com clicks >= useMelhorMinClicks (empate na fronteira incluído —
 * é a motivação da flag: "todos com ≥N cliques" em vez de um corte arbitrário
 * de posição que quebra empates ao acaso).
 */
export function selectSections(
  monthItems: LinkItem[],
  sourceItems: LinkItem[],
  clicksByUrl: Map<string, number>,
  themeUrls: Set<string>,
  useMelhorCount: number = USE_MELHOR_COUNT,
  useMelhorMinClicks?: number,
  radarCount: number = RADAR_COUNT,
) {
  const allPool = new Map<string, Meta>();
  const useMelhorPool = new Map<string, Meta>();
  const useMelhorBaseUrls = new Set<string>();

  for (const it of monthItems) {
    addToPool(allPool, it);
    if (it.section === "use_melhor") {
      addToPool(useMelhorPool, it);
      useMelhorBaseUrls.add(it.baseUrl);
    }
  }
  for (const it of sourceItems) {
    addToPool(useMelhorPool, it);
    useMelhorBaseUrls.add(it.baseUrl);
  }

  const useMelhorRanked = rank(useMelhorPool, clicksByUrl);
  // rank() ordena desc por clicks primeiro, então todo item com
  // clicks >= useMelhorMinClicks forma um prefixo contíguo do array —
  // filter() é seguro (não deixa "buracos" no meio da seleção).
  const useMelhorTop =
    useMelhorMinClicks !== undefined
      ? useMelhorRanked.filter((x) => x.clicks >= useMelhorMinClicks)
      : useMelhorRanked.slice(0, useMelhorCount);
  const useMelhorTopUrls = new Set(useMelhorTop.map((x) => x.url));

  const radarPool = new Map<string, Meta>();
  for (const [b, meta] of allPool) {
    if (themeUrls.has(b)) continue;
    if (useMelhorBaseUrls.has(b)) continue;
    if (useMelhorTopUrls.has(b)) continue;
    radarPool.set(b, meta);
  }
  const radarRanked = rank(radarPool, clicksByUrl);
  const radarTop = radarRanked.slice(0, radarCount);

  const warnings: string[] = [];
  if (useMelhorMinClicks !== undefined) {
    if (useMelhorTop.length === 0)
      warnings.push(`Use Melhor: nenhum candidato com ≥${useMelhorMinClicks} cliques`);
  } else if (useMelhorTop.length < useMelhorCount) {
    warnings.push(
      `Use Melhor: só ${useMelhorTop.length} candidatos com seção use_melhor (esperado ${useMelhorCount})`,
    );
  }
  if (radarTop.length < radarCount)
    warnings.push(`Radar: só ${radarTop.length} candidatos elegíveis (esperado ${radarCount})`);

  return {
    use_melhor: useMelhorTop,
    use_melhor_candidates: useMelhorRanked,
    radar: radarTop,
    radar_candidates_count: radarRanked.length,
    warnings,
  };
}

// ── Patch prioritized.md ────────────────────────────────────────────
function renderItems(items: RankedLink[], withEdition: boolean): string {
  if (items.length === 0) return "_(sem candidatos com cliques registrados)_\n";
  return items
    .map((it) => {
      const ed = withEdition && it.editions.length ? `${it.editions.at(-1)} — ` : "";
      const clk = `(${it.clicks} clique${it.clicks === 1 ? "" : "s"})`;
      return `- ${ed}${it.title} — ${it.url} ${clk}`;
    })
    .join("\n");
}

export function buildSectionsBlock(result: {
  use_melhor: RankedLink[];
  radar: RankedLink[];
}): string {
  return (
    `## Use Melhor\n\n` +
    `Os ${result.use_melhor.length} tutoriais mais clicados do mês (seção Use Melhor das edições diárias):\n\n` +
    `${renderItems(result.use_melhor, false)}\n\n` +
    `## Radar\n\n` +
    `Os ${result.radar.length} links mais clicados do mês (excluindo os já cobertos nos Destaques e no Use Melhor):\n\n` +
    `${renderItems(result.radar, true)}\n`
  );
}

/**
 * Substitui (puro) o bloco "## Outras Notícias" — ou, em re-run, o par
 * "## Use Melhor"+"## Radar" — por `newBlock`, cortando SÓ até a próxima
 * fronteira de seção (`\n## ` ou `\n---`). Preserva seções subsequentes como
 * `## Warnings` e `## Apêndice` (#1903 review). Retorna o novo md, ou `null`
 * se nenhuma âncora foi encontrada.
 */
export function replaceSectionsBlock(md: string, newBlock: string): string | null {
  const nextBoundary = (from: number): number => {
    const m = md.slice(from).match(/\n(?:## |---)/);
    return m ? from + (m.index ?? 0) : md.length;
  };
  const splice = (start: number, end: number): string =>
    md.slice(0, start) + newBlock.trimEnd() + "\n\n" + md.slice(end).replace(/^\n+/, "");

  const outrasIdx = md.indexOf("## Outras Notícias");
  if (outrasIdx !== -1) {
    return splice(outrasIdx, nextBoundary(outrasIdx + "## Outras Notícias".length));
  }
  // re-run: arquivo já tem ## Use Melhor + ## Radar — substitui o par inteiro.
  const useMelhorIdx = md.indexOf("## Use Melhor");
  if (useMelhorIdx !== -1) {
    const radarIdx = md.indexOf("## Radar", useMelhorIdx);
    if (radarIdx === -1) return null;
    return splice(useMelhorIdx, nextBoundary(radarIdx + "## Radar".length));
  }
  return null;
}

function patchPrioritized(yymm: string, result: ReturnType<typeof compute>): boolean {
  const p = join(resolveMonthlyDir(yymm), "prioritized.md");
  if (!existsSync(p)) return false;
  const md = readFileSync(p, "utf8");
  const next = replaceSectionsBlock(md, buildSectionsBlock(result));
  if (next === null || next === md) return false;
  writeFileSync(p, next, "utf8");
  return true;
}

export function parseUseMelhorSource(argv: string[]): { edition: string; prefix: string }[] {
  const flag = argv.find((a) => a.startsWith("--use-melhor-source="));
  const raw = flag
    ? flag.split("=").slice(1).join("=")
    : (() => {
        const i = argv.indexOf("--use-melhor-source");
        return i !== -1 ? argv[i + 1] : "";
      })();
  if (!raw) return [];
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [edition, prefix] = p.split(":");
      return { edition, prefix };
    })
    .filter((x) => /^\d{6}$/.test(x.edition) && /^[a-f0-9]+$/i.test(x.prefix ?? ""));
}

/** Lê `--use-melhor-count N` (ou `--use-melhor-count=N`). Retorna undefined se
 *  ausente/inválido, deixando o default USE_MELHOR_COUNT valer. */
export function parseUseMelhorCount(argv: string[]): number | undefined {
  const eq = argv.find((a) => a.startsWith("--use-melhor-count="));
  const raw = eq
    ? eq.split("=")[1]
    : (() => {
        const i = argv.indexOf("--use-melhor-count");
        return i !== -1 ? argv[i + 1] : "";
      })();
  const n = parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Lê `--use-melhor-min-clicks N` (ou `--use-melhor-min-clicks=N`). Retorna
 *  undefined se ausente/inválido. Quando presente, tem precedência sobre
 *  `--use-melhor-count` (ver `selectSections`). 0 é um valor válido (inclui
 *  todo candidato, mesmo com 0 cliques) — só rejeita negativo/NaN. */
export function parseUseMelhorMinClicks(argv: string[]): number | undefined {
  const eq = argv.find((a) => a.startsWith("--use-melhor-min-clicks="));
  const raw = eq
    ? eq.split("=")[1]
    : (() => {
        const i = argv.indexOf("--use-melhor-min-clicks");
        return i !== -1 ? argv[i + 1] : "";
      })();
  const n = parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Lê `--radar-count N` (ou `--radar-count=N`). Retorna undefined se
 *  ausente/inválido, deixando o default RADAR_COUNT valer. Mesmo padrão de
 *  `parseUseMelhorCount` — editor pode pedir outro número no gate da Etapa 1. */
export function parseRadarCount(argv: string[]): number | undefined {
  const eq = argv.find((a) => a.startsWith("--radar-count="));
  const raw = eq
    ? eq.split("=")[1]
    : (() => {
        const i = argv.indexOf("--radar-count");
        return i !== -1 ? argv[i + 1] : "";
      })();
  const n = parseInt(raw ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function main() {
  // Aceita --cycle 2605-06 (novo) ou argumento posicional 2604 (legado compat).
  const cycle = parseMonthlyCycleArg(process.argv.slice(2));
  if (!cycle) {
    console.error(
      "Usage: npx tsx scripts/monthly-click-sections.ts --cycle YYMM-MM [--use-melhor-source AAMMDD:prefix,...]\n" +
      "  [--use-melhor-count N | --use-melhor-min-clicks N] [--radar-count N]\n" +
      "Compat: npx tsx scripts/monthly-click-sections.ts <YYMM>",
    );
    process.exit(2);
  }
  // compute() e helpers internos ainda usam yymm como chave de coleção
  // (via monthlyDir que aceita yymm com fallback). Passamos o ciclo completo
  // para que monthlyDir resolva corretamente o path {conteúdo}-{envio}.
  const useMelhorSource = parseUseMelhorSource(process.argv.slice(2));
  const useMelhorCount = parseUseMelhorCount(process.argv.slice(2));
  const useMelhorMinClicks = parseUseMelhorMinClicks(process.argv.slice(2));
  const radarCount = parseRadarCount(process.argv.slice(2));
  const result = compute(cycle, { useMelhorSource, useMelhorCount, useMelhorMinClicks, radarCount });
  if (useMelhorSource.length)
    console.log(`Use Melhor emprestado de: ${useMelhorSource.map((x) => x.edition).join(", ")}`);

  const outDir = join(resolveMonthlyDir(cycle), "_internal");
  const outPath = join(outDir, "monthly-clicks.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");

  const patched = patchPrioritized(cycle, result);

  console.log(`OK: Use Melhor ${result.use_melhor.length} | Radar ${result.radar.length} → ${outPath}`);
  console.log(`prioritized.md ${patched ? "atualizado (Outras Notícias → Use Melhor + Radar)" : "NÃO atualizado (seção não encontrada)"}`);
  console.log(`\nUse Melhor (top ${result.use_melhor.length} por cliques):`);
  for (const x of result.use_melhor) console.log(`  ${x.clicks}  ${x.title} [${x.editions.join(",")}]`);
  console.log(`\nRadar (top ${result.radar.length} por cliques):`);
  for (const x of result.radar) console.log(`  ${x.clicks}  ${x.title} [${x.editions.join(",")}]`);
  if (result.warnings.length) {
    console.log("\nWarnings:");
    for (const w of result.warnings) console.log("  - " + w);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

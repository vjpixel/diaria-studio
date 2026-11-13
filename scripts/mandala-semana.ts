/**
 * scripts/mandala-semana.ts (#12347)
 *
 * Monta os dados do formulário semanal do Desafio Mandala Mão na Massa, para a
 * skill `/diaria-mandala-semana` revisar com o editor e preencher no Tally.
 * Não preenche nem envia nada: só lê e grava o plano em `data/`.
 *
 * Fontes (nesta ordem):
 *   1. Formulário: GET simples na URL do Tally (o HTML traz o JSON do
 *      formulário inteiro). Daí saem o nº da semana, as perguntas "Link do
 *      conteúdo do dia N (DD/MM)" e o período "de DD/MM até DD/MM".
 *   2. Posts do @diar.ia.br: Graph API oficial `GET /{ig-user-id}/media`
 *      (INSTAGRAM_BUSINESS_ACCOUNT_ID + INSTAGRAM_ACCESS_TOKEN). Se ela falhar,
 *      cai nos registros locais de publicação
 *      (`data/editions/**\/_internal/06-*published*.json`), que não têm a URL
 *      dos carrosséis agendados pelo Worker: nenhum link de dia sai como
 *      resposta (`daily[].verified: false`, link achado em `candidate`) e o
 *      script sai com exit 3.
 *   3. Reels em collab do @vjpixel: a API não devolve; entram por
 *      `--collab URL@AAAA-MM-DDTHH:MM` (horário de Brasília, dito pelo editor).
 *   4. Novos seguidores IG (bruto): `data/metrics/instagram-follows-daily.jsonl`
 *      (#12348); faltando dia, saldo líquido de `social-followers.jsonl`.
 *      Inscritos YouTube: `data/youtube-analytics/channel-daily.jsonl`.
 *   5. Contato (e-mail do Fluxer, telefone do grupo): arquivo FORA do repo,
 *      `~/.config/diaria/mandala-contato.json` (ou `--contato-file`). O plano
 *      grava só se cada campo existe, nunca o valor: `data/` sincroniza no
 *      Drive. A skill lê os valores do arquivo na hora de preencher.
 *   6. Prints de Insights: `--print arquivo` (repetível) ou os arquivos em
 *      `{out-dir}/semana{N}-prints/`.
 *
 * Saída: `{out-dir}/semana{N}.csv` (planilha da semana) e
 * `{out-dir}/semana{N}.json` (plano completo, com `missing[]` listando o que
 * faltou). Nada é inventado: fonte ausente vira item de `missing`.
 *
 * Uso:
 *   npx tsx scripts/mandala-semana.ts --tally-url https://tally.so/r/XXXX \
 *     [--collab URL@2026-10-29T07:17 ...] [--print caminho.jpg ...] \
 *     [--semana N] [--source auto|graph|local] [--out-dir data/desafio-mandala]
 *
 * Exit:
 *   0 plano gravado com a lista de posts da Graph API (mesmo com `missing`);
 *   3 plano gravado com a lista dos registros locais: os links de dia NÃO são
 *     resposta, o editor confirma cada um antes do preenchimento;
 *   2 formulário sem perguntas de dia (o Tally mudou o formato): ler as
 *     perguntas pelo navegador, sem responder nada, e parar;
 *   1 erro de uso, de rede no Tally, de formulário inconsistente ou de
 *     `--source graph` com a Graph API falhando (no `auto` a falha da Graph
 *     cai nos registros locais, exit 3).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import {
  IG_FOLLOWS_DAILY_PATH,
  parseInstagramFollowsJsonl,
  summarizeInstagramNewFollowers,
  type NewFollowersSummary,
} from "./lib/instagram-follower-insights.ts";
import {
  checkFormConsistency,
  combineNewFollowers,
  dailyLinks,
  mergePosts,
  parseCollabArg,
  parseTallyForm,
  postsFromGraphMedia,
  postsFromLocalRecord,
  readGraphPage,
  resolveDdmm,
  selectWeek,
  summarizeYoutubeSubs,
  weekCsv,
  youtubeSubsUnavailable,
  type DailyLink,
  type MandalaPost,
  type NewFollowersTotal,
  type PlannedDay,
  type WeekSelection,
  type YoutubeSubsSummary,
} from "./lib/mandala-semana.ts";
import { parseSocialFollowersJsonl } from "./lib/social-followers.ts";

const GRAPH_API = "https://graph.facebook.com/v25.0"; // mesma versão de social-followers-collect.ts
const GRAPH_MAX_PAGES = 20;
const SOCIAL_FOLLOWERS_PATH = "data/metrics/social-followers.jsonl";
const YOUTUBE_DAILY_PATH = "data/youtube-analytics/channel-daily.jsonl";
export const DEFAULT_CONTATO_FILE = join(homedir(), ".config", "diaria", "mandala-contato.json");
/** Exit do plano montado com a lista local: links de dia a confirmar. */
export const EXIT_LOCAL_UNVERIFIED = 3;

export interface CliOptions {
  tallyUrl: string | null;
  tallyHtmlFile: string | null;
  semana: number | null;
  collabs: string[];
  prints: string[];
  source: "auto" | "graph" | "local";
  outDir: string;
  contatoFile: string;
}

/** Parse de argv com flags repetíveis (`--collab`, `--print`). @pure */
export function parseCli(argv: string[]): CliOptions {
  const o: CliOptions = {
    tallyUrl: null,
    tallyHtmlFile: null,
    semana: null,
    collabs: [],
    prints: [],
    source: "auto",
    outDir: "data/desafio-mandala",
    contatoFile: DEFAULT_CONTATO_FILE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf("=");
    const key = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    const inline = a.startsWith("--") && eq > 0 ? a.slice(eq + 1) : null;
    const next = (): string => {
      if (inline !== null) return inline;
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${key} pede um valor`);
      return v;
    };
    switch (key) {
      case "--tally-url": o.tallyUrl = next(); break;
      case "--tally-html": o.tallyHtmlFile = next(); break;
      case "--semana": {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1) throw new Error("--semana pede um inteiro positivo");
        o.semana = n;
        break;
      }
      case "--collab": o.collabs.push(next()); break;
      case "--print": o.prints.push(next()); break;
      case "--source": {
        const v = next();
        if (v !== "auto" && v !== "graph" && v !== "local") throw new Error("--source: auto|graph|local");
        o.source = v;
        break;
      }
      case "--out-dir": o.outDir = next(); break;
      case "--contato-file": o.contatoFile = next(); break;
      default:
        if (!a.startsWith("--") && !o.tallyUrl && /^https?:\/\//.test(a)) o.tallyUrl = a;
        else throw new Error(`argumento desconhecido: ${a}`);
    }
  }
  if (!o.tallyUrl && !o.tallyHtmlFile) throw new Error("falta --tally-url (a URL do formulário muda toda semana)");
  return o;
}

async function fetchTallyHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Tally HTTP ${res.status} em ${url}`);
  }
  return res.text();
}

export interface GraphFetchResult {
  posts: MandalaPost[];
  /** Itens de `/media` sem permalink/timestamp legível. */
  skipped: number;
  /** Parou no teto de páginas com página seguinte ainda disponível. */
  truncated: boolean;
  error: string | null;
}

/** Graph API paginada até passar do início do período. Token no header (#7779). */
export async function fetchGraphPosts(
  fromIso: string,
  env: { id?: string; token?: string } = {
    id: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
    token: process.env.INSTAGRAM_ACCESS_TOKEN,
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GraphFetchResult> {
  const result: GraphFetchResult = { posts: [], skipped: 0, truncated: false, error: null };
  if (!env.id || !env.token) {
    result.error = "credencial ausente (INSTAGRAM_BUSINESS_ACCOUNT_ID, INSTAGRAM_ACCESS_TOKEN)";
    return result;
  }
  const fromMs = Date.parse(fromIso);
  let url: string | null =
    `${GRAPH_API}/${env.id}/media?fields=id,permalink,timestamp,media_type,media_product_type,caption&limit=100`;
  let page = 0;
  for (; url && page < GRAPH_MAX_PAGES; page++) {
    let body: unknown;
    try {
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${env.token}` } });
      body = await res.json().catch(() => null);
      if (!res.ok) {
        const e = (body as { error?: { message?: string; code?: number } } | null)?.error;
        result.error = `Graph API HTTP ${res.status}${e ? ` (#${e.code}) ${e.message}` : ""}`;
        return result;
      }
    } catch (e) {
      result.error = `falha de rede na Graph API: ${(e as Error).message}`;
      return result;
    }
    const pg = readGraphPage(body);
    if (!pg.ok) {
      result.error = pg.error;
      return result;
    }
    const { posts: pagePosts, skipped } = postsFromGraphMedia(pg.data);
    result.posts.push(...pagePosts);
    result.skipped += skipped;
    const oldest = pagePosts.reduce((min, p) => Math.min(min, Date.parse(p.timestamp)), Infinity);
    url = pg.next;
    if (pg.rawCount === 0 || oldest < fromMs) {
      url = null;
      break;
    }
  }
  result.truncated = url !== null && page >= GRAPH_MAX_PAGES;
  return result;
}

/** Nome de registro local de publicação; cópia de backup (`.bkp`, `.bak`) fica de fora. @pure */
export function isLocalRecordFile(name: string): boolean {
  return /^06-.*published.*\.json$/.test(name) && !/bkp|bak/i.test(name);
}

/** Registros locais de publicação das edições (até 2 níveis: plano `AAMMDD/` e aninhado `AAMM/AAMMDD/`). */
function readLocalPosts(root: string): { posts: MandalaPost[]; unreadable: string[] } {
  const editions = join(root, "data", "editions");
  if (!existsSync(editions)) return { posts: [], unreadable: [] };
  const internals: string[] = [];
  const visit = (dir: string, depth: number): void => {
    for (const name of readdirSync(dir)) {
      if (!/^\d{4,6}$/.test(name)) continue;
      const p = join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      const internal = join(p, "_internal");
      if (existsSync(internal)) internals.push(internal);
      if (depth < 1) visit(p, depth + 1);
    }
  };
  visit(editions, 0);
  const posts: MandalaPost[] = [];
  const unreadable: string[] = [];
  for (const dir of internals) {
    for (const f of readdirSync(dir)) {
      if (!isLocalRecordFile(f)) continue;
      const path = join(dir, f);
      try {
        posts.push(...postsFromLocalRecord(JSON.parse(readFileSync(path, "utf8"))));
      } catch {
        unreadable.push(path);
      }
    }
  }
  return { posts, unreadable };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Lê o arquivo de contato. Ausente = campos nulos; JSON ilegível ou sem permissão = erro. */
function readContato(file: string): { email: string | null; telefone: string | null } {
  let txt: string;
  try {
    txt = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { email: null, telefone: null };
    throw new Error(`não consegui ler ${file}: ${(e as Error).message}`);
  }
  let c: { email?: unknown; telefone?: unknown };
  try {
    c = JSON.parse(txt) as typeof c;
  } catch (e) {
    throw new Error(`${file} não é JSON válido: ${(e as Error).message}`);
  }
  return {
    email: typeof c.email === "string" && c.email.trim() ? c.email.trim() : null,
    telefone: typeof c.telefone === "string" && c.telefone.trim() ? c.telefone.trim() : null,
  };
}

export interface MandalaPlan {
  generatedAt: string;
  tallyUrl: string | null;
  semana: number;
  title: string | null;
  period: { from: string; to: string };
  rede: "Ambos";
  /** Só a presença de cada campo: os valores ficam no arquivo, fora de `data/`. */
  contato: { file: string; email_ok: boolean; telefone_ok: boolean };
  postsSource: "graph" | "local";
  postsSourceNote: string | null;
  /** `false` com `postsSource: local`: nenhum `daily[].url` é resposta até o editor confirmar. */
  dailyVerified: boolean;
  daily: DailyLink[];
  extras: string[];
  totalPosts: number;
  newFollowers: { instagram: NewFollowersSummary; youtube: YoutubeSubsSummary } & NewFollowersTotal;
  prints: string[];
  csvPath: string;
  missing: string[];
}

export interface PlanInput {
  generatedAt: string;
  tallyUrl: string | null;
  semana: number;
  title: string | null;
  period: { from: string; to: string };
  contatoFile: string;
  contato: { email: string | null; telefone: string | null };
  postsSource: "graph" | "local";
  postsSourceNote: string | null;
  selection: WeekSelection;
  instagram: NewFollowersSummary;
  youtube: YoutubeSubsSummary;
  prints: string[];
  csvPath: string;
  /** Faltas já apuradas na coleta (posts, prints, arquivos). */
  missing: string[];
}

/**
 * Monta o plano gravado em `semana{N}.json` e acrescenta as faltas que dependem
 * dele (links de dia, contato, total de seguidores). O contato entra só como
 * presença. @pure
 */
export function buildPlan(input: PlanInput): MandalaPlan {
  const missing = [...input.missing];
  const daily = dailyLinks(input.selection.daily, input.postsSource);
  for (const d of daily) {
    if (!d.verified) {
      missing.push(
        `link do dia ${d.dayNum} (${d.ddmm}): NÃO VERIFICADO (lista local incompleta)` +
          (d.candidate ? `; candidato ${d.candidate}` : "; nenhum candidato"),
      );
    } else if (!d.url) {
      const nextDate = new Date(Date.parse(`${d.date}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
      const reel = input.selection.rows.find((r) => r.date === nextDate && r.format === "reel");
      missing.push(`link do dia ${d.dayNum} (${d.ddmm}): nenhum post do Instagram nesse dia` +
        (reel ? `; candidato = reel do dia seguinte ${reel.url}; usar no dia ${d.dayNum} e tirar dos extras ao confirmar` : "; nenhum reel candidato no dia seguinte"));
    }
  }
  const email_ok = input.contato.email !== null;
  const telefone_ok = input.contato.telefone !== null;
  if (!email_ok) missing.push(`e-mail do Fluxer (gravar em ${input.contatoFile})`);
  if (!telefone_ok) missing.push(`telefone do grupo (gravar em ${input.contatoFile})`);
  if (!input.youtube.complete) {
    missing.push(`YouTube: faltam ${input.youtube.missingDays.join(", ")}; atualizar com npx tsx scripts/youtube-analytics-snapshot.ts --since ${input.period.from} e rodar mandala-semana.ts novamente (a API pode ter atraso)`);
  }
  const totals = combineNewFollowers(input.instagram, input.youtube);
  if (!totals.totalComplete) {
    missing.push(
      totals.total === null
        ? "total de novos seguidores (pergunta 12): falta Instagram ou YouTube, não somar só a parte que existe"
        : `total de novos seguidores (pergunta 12): ${totals.total} é parcial, confirmar com o editor`,
    );
  }
  return {
    generatedAt: input.generatedAt,
    tallyUrl: input.tallyUrl,
    semana: input.semana,
    title: input.title,
    period: input.period,
    rede: "Ambos",
    contato: { file: input.contatoFile, email_ok, telefone_ok },
    postsSource: input.postsSource,
    postsSourceNote: input.postsSourceNote,
    dailyVerified: input.postsSource === "graph",
    daily,
    extras: input.selection.extras,
    totalPosts: input.selection.rows.length,
    newFollowers: { instagram: input.instagram, youtube: input.youtube, ...totals },
    prints: input.prints,
    csvPath: input.csvPath,
    missing,
  };
}

async function main(): Promise<void> {
  const root = process.cwd();
  loadProjectEnv(root); // .env e data/ do mesmo checkout (o de onde a skill roda)
  const opts = parseCli(process.argv.slice(2));
  const now = new Date();

  const html = opts.tallyHtmlFile ? readFileSync(opts.tallyHtmlFile, "utf8") : await fetchTallyHtml(opts.tallyUrl!);
  const form = parseTallyForm(html);
  if (form.days.length === 0) {
    console.error(
      "ERRO: não achei as perguntas \"Link do conteúdo do dia N (DD/MM)\" no HTML do Tally. " +
        "O formato mudou: ler as perguntas pelo navegador, sem responder nada, e parar.",
    );
    process.exitCode = 2;
    return;
  }
  const semana = checkFormConsistency(form, opts.semana);

  const days: PlannedDay[] = form.days.map((d) => ({ ...d, date: resolveDdmm(d.ddmm, now) }));
  const from = form.period ? resolveDdmm(form.period.from, now) : days[0].date;
  const to = form.period ? resolveDdmm(form.period.to, now) : days[days.length - 1].date;
  const missing: string[] = [];
  // Validar os --collab antes de qualquer rede: horário impossível é erro de uso.
  const collabs = opts.collabs.map(parseCollabArg);

  // Posts
  let postsSource: "graph" | "local" = "graph";
  let postsSourceNote: string | null = null;
  let own: MandalaPost[] = [];
  if (opts.source !== "local") {
    const g = await fetchGraphPosts(`${from}T00:00:00-03:00`);
    if (g.error) {
      if (opts.source === "graph") throw new Error(g.error);
      postsSource = "local";
      postsSourceNote = `Graph API indisponível (${g.error}); lista montada dos registros locais de publicação, sem a URL dos carrosséis agendados pelo Worker: INCOMPLETA`;
    } else {
      own = g.posts;
      if (g.skipped > 0) {
        missing.push(`${g.skipped} item(ns) da Graph API sem permalink ou horário legível: a lista pode estar incompleta`);
      }
      if (g.truncated) {
        missing.push(`a Graph API parou no teto de ${GRAPH_MAX_PAGES} páginas sem chegar ao início do período: a lista pode estar incompleta`);
      }
    }
  } else {
    postsSource = "local";
    postsSourceNote = "--source local: registros locais de publicação, sem a URL dos carrosséis agendados pelo Worker: INCOMPLETA";
  }
  if (postsSource === "local") {
    const local = readLocalPosts(root);
    own = local.posts;
    for (const p of local.unreadable) missing.push(`registro local de publicação ilegível: ${p}`);
  }
  const selection = selectWeek(mergePosts(collabs, own), days);

  // Seguidores
  const grossTxt = readIfExists(join(root, IG_FOLLOWS_DAILY_PATH));
  const netTxt = readIfExists(join(root, SOCIAL_FOLLOWERS_PATH));
  const ig = summarizeInstagramNewFollowers(
    grossTxt ? parseInstagramFollowsJsonl(grossTxt).days : [],
    netTxt ? parseSocialFollowersJsonl(netTxt).samples : [],
    from,
    to,
  );
  if (ig.source === "net-balance") {
    missing.push(
      ig.value === null
        ? `novos seguidores do Instagram (sem série bruta nem saldo para ${from}..${to})`
        : `novos seguidores BRUTOS do Instagram (faltam ${ig.missingDays.length} dia(s) na série de insights; ${ig.value} é saldo líquido)`,
    );
  }
  const ytTxt = readIfExists(join(root, YOUTUBE_DAILY_PATH));
  const yt: YoutubeSubsSummary = ytTxt ? summarizeYoutubeSubs(ytTxt, from, to) : youtubeSubsUnavailable(from, to);
  if (!ytTxt) missing.push(`inscritos do YouTube (${YOUTUBE_DAILY_PATH} ausente)`);
  else if (yt.missingDays.length) missing.push(`inscritos do YouTube: faltam os dias ${yt.missingDays.join(", ")}`);

  // Contato (fora do repo)
  const contato = readContato(opts.contatoFile);

  // Prints
  const outDir = resolve(root, opts.outDir);
  const printsDir = join(outDir, `semana${semana}-prints`);
  const prints = [
    ...opts.prints.map((p) => resolve(root, p)),
    ...(existsSync(printsDir) ? readdirSync(printsDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).map((f) => join(printsDir, f)) : []),
  ].filter((p, i, a) => a.indexOf(p) === i);
  const absent = prints.filter((p) => !existsSync(p));
  for (const p of absent) missing.push(`print não encontrado: ${p}`);
  if (prints.length - absent.length === 0) missing.push("print da aba Insights do Instagram no período (obrigatório)");

  mkdirSync(outDir, { recursive: true });
  const csvPath = join(outDir, `semana${semana}.csv`);
  writeFileSync(csvPath, weekCsv(selection.rows), "utf8");
  const plan = buildPlan({
    generatedAt: now.toISOString(),
    tallyUrl: opts.tallyUrl,
    semana,
    title: form.title,
    period: { from, to },
    contatoFile: opts.contatoFile,
    contato,
    postsSource,
    postsSourceNote,
    selection,
    instagram: ig,
    youtube: yt,
    prints: prints.filter((p) => existsSync(p)),
    csvPath,
    missing,
  });
  const jsonPath = join(outDir, `semana${semana}.json`);
  writeFileSync(jsonPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

  console.log(`Semana ${semana} — período ${from} a ${to} (BRT); posts: ${postsSource}`);
  if (postsSourceNote) console.log(`  aviso: ${postsSourceNote}`);
  for (const d of plan.daily) {
    const shown = d.verified ? (d.url ?? "FALTANDO") : `NÃO VERIFICADO (candidato: ${d.candidate ?? "nenhum"})`;
    console.log(`  dia ${d.dayNum} (${d.ddmm}): ${shown}`);
  }
  console.log(`  extras: ${selection.extras.length}; total de posts no período: ${selection.rows.length}`);
  const nf = plan.newFollowers;
  console.log(
    `  novos seguidores: IG ${ig.value ?? "?"} (${ig.source === "insights" ? "bruto" : "saldo líquido"}) + YouTube ${yt.value ?? "?"} = ${nf.total ?? "?"}${nf.totalComplete ? "" : " (INCOMPLETO: confirmar)"}`,
  );
  console.log(`  prints: ${plan.prints.length}; contato: ${plan.contato.email_ok && plan.contato.telefone_ok ? "ok" : "incompleto"}`);
  console.log(`  planilha: ${csvPath}`);
  console.log(`  plano: ${jsonPath}`);
  if (plan.missing.length) {
    console.log("FALTA:");
    for (const m of plan.missing) console.log(`  - ${m}`);
  }
  if (!plan.dailyVerified) {
    console.log("Links de dia NÃO verificados: o editor confirma cada um antes do preenchimento (exit 3).");
    process.exitCode = EXIT_LOCAL_UNVERIFIED;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERRO: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}

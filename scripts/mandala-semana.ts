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
 *      dos carrosséis agendados pelo Worker: o plano avisa que a lista está
 *      incompleta.
 *   3. Reels em collab do @vjpixel: a API não devolve; entram por
 *      `--collab URL@AAAA-MM-DDTHH:MM` (horário de Brasília, dito pelo editor).
 *   4. Novos seguidores IG (bruto): `data/metrics/instagram-follows-daily.jsonl`
 *      (#12348); faltando dia, saldo líquido de `social-followers.jsonl`.
 *      Inscritos YouTube: `data/youtube-analytics/channel-daily.jsonl`.
 *   5. Contato (e-mail do Fluxer, telefone do grupo): arquivo FORA do repo,
 *      `~/.config/diaria/mandala-contato.json` (ou `--contato-file`).
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
 * Exit: 0 plano gravado (mesmo com `missing`); 2 formulário sem perguntas de
 * dia (Tally mudou o formato: preencher pelo navegador, lendo as perguntas);
 * 1 erro de uso/rede.
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
  mergePosts,
  parseCollabArg,
  parseTallyForm,
  postsFromGraphMedia,
  postsFromLocalRecord,
  resolveDdmm,
  selectWeek,
  summarizeYoutubeSubs,
  weekCsv,
  type MandalaPost,
  type PlannedDay,
  type WeekSelection,
  type YoutubeSubsSummary,
} from "./lib/mandala-semana.ts";
import { parseSocialFollowersJsonl } from "./lib/social-followers.ts";

const GRAPH_API = "https://graph.facebook.com/v25.0"; // mesma versão de social-followers-collect.ts
const SOCIAL_FOLLOWERS_PATH = "data/metrics/social-followers.jsonl";
const YOUTUBE_DAILY_PATH = "data/youtube-analytics/channel-daily.jsonl";
export const DEFAULT_CONTATO_FILE = join(homedir(), ".config", "diaria", "mandala-contato.json");

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
  if (!res.ok) throw new Error(`Tally HTTP ${res.status} em ${url}`);
  return res.text();
}

/** Graph API paginada até passar do início do período. Token no header (#7779). */
async function fetchGraphPosts(fromIso: string): Promise<{ posts: MandalaPost[]; error: string | null }> {
  const id = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;
  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!id || !token) return { posts: [], error: "credencial ausente (INSTAGRAM_BUSINESS_ACCOUNT_ID, INSTAGRAM_ACCESS_TOKEN)" };
  const fromMs = Date.parse(fromIso);
  let url: string | undefined =
    `${GRAPH_API}/${id}/media?fields=id,permalink,timestamp,media_type,media_product_type,caption&limit=100`;
  const posts: MandalaPost[] = [];
  for (let page = 0; url && page < 20; page++) {
    let body: { data?: unknown; paging?: { next?: string }; error?: { message?: string; code?: number } } | null;
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      body = (await res.json().catch(() => null)) as typeof body;
      if (!res.ok) {
        const e = body?.error;
        return { posts, error: `Graph API HTTP ${res.status}${e ? ` (#${e.code}) ${e.message}` : ""}` };
      }
    } catch (e) {
      return { posts, error: `falha de rede na Graph API: ${(e as Error).message}` };
    }
    const { posts: pagePosts } = postsFromGraphMedia(body?.data);
    posts.push(...pagePosts);
    const oldest = pagePosts.reduce((min, p) => Math.min(min, Date.parse(p.timestamp)), Infinity);
    if (pagePosts.length === 0 || oldest < fromMs) break;
    url = body?.paging?.next;
  }
  return { posts, error: null };
}

/** Registros locais de publicação das edições (até 2 níveis: plano `AAMMDD/` e aninhado `AAMM/AAMMDD/`). */
function readLocalPosts(root: string): MandalaPost[] {
  const editions = join(root, "data", "editions");
  if (!existsSync(editions)) return [];
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
  const out: MandalaPost[] = [];
  for (const dir of internals) {
    for (const f of readdirSync(dir)) {
      if (!/^06-.*published.*\.json$/.test(f)) continue;
      try {
        out.push(...postsFromLocalRecord(JSON.parse(readFileSync(join(dir, f), "utf8"))));
      } catch {
        // arquivo malformado não derruba a coleta; a lista local já é a reserva incompleta
      }
    }
  }
  return out;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export interface MandalaPlan {
  generatedAt: string;
  tallyUrl: string | null;
  semana: number;
  title: string | null;
  period: { from: string; to: string };
  rede: "Ambos";
  contato: { email: string | null; telefone: string | null; file: string };
  postsSource: "graph" | "local";
  postsSourceNote: string | null;
  daily: WeekSelection["daily"];
  extras: string[];
  totalPosts: number;
  newFollowers: { instagram: NewFollowersSummary; youtube: YoutubeSubsSummary; total: number | null };
  prints: string[];
  csvPath: string;
  missing: string[];
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
        "O formato mudou: ler as perguntas pelo navegador, sem responder nada.",
    );
    process.exitCode = 2;
    return;
  }
  const semana = opts.semana ?? form.semana;
  if (!semana) throw new Error("o título do formulário não traz \"Semana N\": passe --semana N");

  const days: PlannedDay[] = form.days.map((d) => ({ ...d, date: resolveDdmm(d.ddmm, now) }));
  const from = form.period ? resolveDdmm(form.period.from, now) : days[0].date;
  const to = form.period ? resolveDdmm(form.period.to, now) : days[days.length - 1].date;
  const missing: string[] = [];

  // Posts
  let postsSource: "graph" | "local" = "graph";
  let postsSourceNote: string | null = null;
  let own: MandalaPost[] = [];
  if (opts.source !== "local") {
    const g = await fetchGraphPosts(`${from}T00:00:00-03:00`);
    if (g.error) {
      if (opts.source === "graph") throw new Error(g.error);
      postsSourceNote = `Graph API indisponível (${g.error}); lista montada dos registros locais de publicação, sem a URL dos carrosséis agendados pelo Worker: INCOMPLETA`;
      missing.push(
        "lista completa de posts do Instagram (a Graph API falhou; os registros locais não têm todos os links, então o 1º de cada dia pode estar ERRADO)",
      );
    } else {
      own = g.posts;
    }
  }
  if (opts.source === "local" || postsSourceNote) {
    postsSource = "local";
    own = readLocalPosts(root);
    if (opts.source === "local") {
      postsSourceNote = "registros locais de publicação (sem a URL dos carrosséis agendados pelo Worker): pode estar incompleta";
      missing.push("lista completa de posts do Instagram (--source local: o 1º de cada dia pode estar ERRADO)");
    }
  }
  const collabs = opts.collabs.map(parseCollabArg);
  const selection = selectWeek(mergePosts(collabs, own), days);
  for (const d of selection.daily) {
    if (!d.url) missing.push(`link do dia ${d.dayNum} (${d.ddmm}): nenhum post do Instagram nesse dia`);
  }

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
  const yt: YoutubeSubsSummary = ytTxt
    ? summarizeYoutubeSubs(ytTxt, from, to)
    : { value: null, from, to, missingDays: [from] };
  if (!ytTxt) missing.push(`inscritos do YouTube (${YOUTUBE_DAILY_PATH} ausente)`);
  else if (yt.missingDays.length) missing.push(`inscritos do YouTube: faltam os dias ${yt.missingDays.join(", ")}`);
  const total = ig.value === null && yt.value === null ? null : (ig.value ?? 0) + (yt.value ?? 0);

  // Contato (fora do repo)
  let contato: { email: string | null; telefone: string | null } = { email: null, telefone: null };
  try {
    const c = JSON.parse(readFileSync(opts.contatoFile, "utf8")) as { email?: unknown; telefone?: unknown };
    contato = {
      email: typeof c.email === "string" && c.email.trim() ? c.email.trim() : null,
      telefone: typeof c.telefone === "string" && c.telefone.trim() ? c.telefone.trim() : null,
    };
  } catch {
    // ausente na 1ª vez: a skill pergunta e grava
  }
  if (!contato.email) missing.push(`e-mail do Fluxer (gravar em ${opts.contatoFile})`);
  if (!contato.telefone) missing.push(`telefone do grupo (gravar em ${opts.contatoFile})`);

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
  const plan: MandalaPlan = {
    generatedAt: now.toISOString(),
    tallyUrl: opts.tallyUrl,
    semana,
    title: form.title,
    period: { from, to },
    rede: "Ambos",
    contato: { ...contato, file: opts.contatoFile },
    postsSource,
    postsSourceNote,
    daily: selection.daily,
    extras: selection.extras,
    totalPosts: selection.rows.length,
    newFollowers: { instagram: ig, youtube: yt, total },
    prints: prints.filter((p) => existsSync(p)),
    csvPath,
    missing,
  };
  const jsonPath = join(outDir, `semana${semana}.json`);
  writeFileSync(jsonPath, JSON.stringify(plan, null, 2) + "\n", "utf8");

  console.log(`Semana ${semana} — período ${from} a ${to} (BRT); posts: ${postsSource}`);
  if (postsSourceNote) console.log(`  aviso: ${postsSourceNote}`);
  for (const d of selection.daily) console.log(`  dia ${d.dayNum} (${d.ddmm}): ${d.url ?? "FALTANDO"}`);
  console.log(`  extras: ${selection.extras.length}; total de posts no período: ${selection.rows.length}`);
  console.log(
    `  novos seguidores: IG ${ig.value ?? "?"} (${ig.source === "insights" ? "bruto" : "saldo líquido"}) + YouTube ${yt.value ?? "?"} = ${total ?? "?"}`,
  );
  console.log(`  prints: ${plan.prints.length}; contato: ${contato.email && contato.telefone ? "ok" : "incompleto"}`);
  console.log(`  planilha: ${csvPath}`);
  console.log(`  plano: ${jsonPath}`);
  if (missing.length) {
    console.log("FALTA:");
    for (const m of missing) console.log(`  - ${m}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERRO: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}

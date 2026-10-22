#!/usr/bin/env tsx
/**
 * publish-circle-stack.ts (#10904)
 *
 * Publica a edição semanal da diar.ia.br no espaço "Radar de Notícias Stack"
 * da comunidade Circle da Stack (`plataforma.stack.com.br/c/radar-de-noticias-stack`),
 * toda segunda, como a conta diar.ia.br — com curadoria voltada aos alunos
 * da Stack (quem constrói produto com IA: Lovable, n8n, Claude Code, Cursor,
 * Replit, agentes, automação).
 *
 * Passos:
 *   1. Lê o `02-reviewed.md` das 5 edições da semana de conteúdo (segunda a
 *      sexta anteriores à segunda de publicação).
 *   2. Seleciona por interesse (`circle-stack-select.ts`) e grava
 *      `data/weekly/{cycle}/_internal/circle-stack-selection.json`. Se o
 *      arquivo já existe, é REUSADO (preserva ajustes manuais e `stackNote`
 *      escritos depois) — `--reselect` refaz do zero.
 *   3. Renderiza `data/weekly/{cycle}/circle-stack-{cycle}.html`.
 *   4. Só com `--publish`: envia ao webhook n8n da Stack
 *      (`scripts/lib/stack-webhook.ts`), que
 *      publica NA HORA — não há rascunho. Idempotente por ciclo via
 *      `_internal/circle-stack-published.json` (`--force` sobrepõe).
 *
 * `--hello` envia um post curto de teste ("Olá, mundo") — também publicado
 * na hora; combine com a Stack antes, eles acompanham o 1º envio.
 *
 * Doppler/.env: `STACK_WEBHOOK_URL` (URL do webhook n8n — fora do repo, que é
 * público) e `STACK_WEBHOOK_KEY` (enviado em `X-Webhook-Key`).
 *
 * Uso:
 *   npx tsx scripts/publish-circle-stack.ts --publish-monday 261026
 *   npx tsx scripts/publish-circle-stack.ts --publish-monday 261026 --publish
 *   npx tsx scripts/publish-circle-stack.ts --hello   (post de teste "Olá, mundo")
 *   (opcionais: --reselect, --opening-file <path>, --closing-file <path>, --force, --data-root <dir>)
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolveWeeklyLinkedinCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { deriveEditionUrl } from "./lib/edition-url.ts";
import { extractWeeklyCandidates, type WeeklyRawCandidate } from "./lib/weekly-linkedin-parse.ts";
import { parseDestaques } from "./extract-destaques.ts";
import { buildStackPostPayload, sendStackPost, STACK_WEBHOOK_KEY_ENV, STACK_WEBHOOK_URL_ENV } from "./lib/stack-webhook.ts";
import {
  selectCircleStack,
  parseInterestProfile,
  STACK_INTEREST_PROFILE,
  type InterestTerm,
  type StackScoredCandidate,
} from "./lib/circle-stack-select.ts";
import {
  renderCircleStackPost,
  type CircleStackEdition,
  type CircleStackItem,
  type CircleStackSelection,
} from "./lib/circle-stack-render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface CircleStackConfig {
  enabled: boolean;
  subscribeUrl: string | null;
  interests: InterestTerm[];
}

/** Pure: lê o bloco `circle_stack` do config. */
export function resolveCircleStackConfig(platformConfig: Record<string, unknown>): CircleStackConfig {
  const raw = (platformConfig.circle_stack ?? {}) as Record<string, unknown>;
  return {
    enabled: raw.enabled !== false,
    subscribeUrl: typeof raw.subscribe_url === "string" && raw.subscribe_url ? raw.subscribe_url : null,
    interests: parseInterestProfile(raw.interests) ?? STACK_INTEREST_PROFILE,
  };
}

/** Pure: post curto de teste combinado com a Stack (1º envio). */
export const HELLO_POST = { titulo: "Olá, mundo", corpo: "Olá, mundo. Teste de publicação da **diar.ia.br** no Radar de Notícias Stack." };

interface EditionRead {
  date: string;
  d1Title?: string;
  destaqueTitles: string[];
  candidates: WeeklyRawCandidate[];
}

function readEdition(editionsRootDir: string, date: string): EditionRead | null {
  const mdPath = join(resolveEditionDir(editionsRootDir, date), "02-reviewed.md");
  if (!existsSync(mdPath)) return null;
  const md = readFileSync(mdPath, "utf8");
  const destaques = parseDestaques(md)
    .filter((d) => d.n >= 1 && d.n <= 3)
    .sort((a, b) => a.n - b.n);
  return {
    date,
    d1Title: destaques.find((d) => d.n === 1)?.title,
    destaqueTitles: destaques.map((d) => d.title),
    candidates: extractWeeklyCandidates(md, date),
  };
}

function toItem(c: StackScoredCandidate): CircleStackItem & { score: number; matchedTerms: string[] } {
  return { editionDate: c.editionDate, url: c.url, title: c.title, body: c.body, why: c.why, score: c.score, matchedTerms: c.matchedTerms };
}

/** Lê as edições da semana e monta a seleção (sem gravar). */
export function buildCircleStackSelection(
  dataRoot: string,
  publishMonday: string,
  interests: InterestTerm[],
): CircleStackSelection & { publishMonday: string; editionsFound: string[]; editionsMissing: string[]; warnings: string[]; generatedAt: string } {
  const r = resolveWeeklyLinkedinCycle(publishMonday);
  if (!r) throw new Error(`--publish-monday inválido: ${publishMonday} (esperado AAMMDD)`);
  const editionsRoot = join(dataRoot, "data", "editions");
  const reads = r.contentWindow.map((d) => ({ date: d, read: readEdition(editionsRoot, d) }));
  const found = reads.filter((x): x is { date: string; read: EditionRead } => x.read !== null).map((x) => x.read);
  const missing = reads.filter((x) => x.read === null).map((x) => x.date);
  if (found.length === 0) throw new Error(`Nenhuma edição da semana ${r.cycle} tem 02-reviewed.md em ${editionsRoot}`);

  const picks = selectCircleStack(found.flatMap((e) => e.candidates), { profile: interests });
  const warnings: string[] = [];
  if (missing.length > 0) warnings.push(`Edições sem 02-reviewed.md: ${missing.join(", ")}`);
  const weakDestaques = picks.destaques.filter((d) => d.score === 0).length;
  if (weakDestaques > 0) warnings.push(`${weakDestaques} destaque(s) sem nenhum termo de interesse da Stack — revisar a seleção`);

  const weeklyEditions: CircleStackEdition[] = found
    .filter((e) => e.d1Title)
    .map((e) => ({ editionDate: e.date, url: deriveEditionUrl(e.d1Title as string), destaques: e.destaqueTitles }));

  return {
    cycle: r.cycle,
    publishMonday,
    contentWindow: r.contentWindow,
    editionsFound: found.map((e) => e.date),
    editionsMissing: missing,
    destaques: picks.destaques.map(toItem),
    lancamentos: picks.lancamentos.map(toItem),
    useMelhor: picks.useMelhor.map(toItem),
    radar: picks.radar.map(toItem),
    weeklyEditions,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}

function readTextArg(argv: string[], key: string): string | undefined {
  const p = getStringArg(argv, key, { example: "caminho/arquivo.txt" });
  return p ? readFileSync(resolve(p), "utf8") : undefined;
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const platformConfig = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
  const cfg = resolveCircleStackConfig(platformConfig);
  const key = process.env[STACK_WEBHOOK_KEY_ENV] ?? "";
  const webhookUrl = process.env[STACK_WEBHOOK_URL_ENV] ?? "";

  if (hasFlag(argv, "hello")) {
    if (!cfg.enabled) throw new Error("circle_stack.enabled = false — publicação desligada no config");
    await sendStackPost(webhookUrl, key, buildStackPostPayload(HELLO_POST.titulo, HELLO_POST.corpo));
    console.log(`Post de teste publicado no Radar de Notícias Stack: "${HELLO_POST.titulo}"`);
    return;
  }

  const publishMonday = getStringArg(argv, "publish-monday", { example: "261026" });
  if (!publishMonday) throw new Error("Passe --publish-monday AAMMDD (segunda de publicação)");
  const resolution = resolveWeeklyLinkedinCycle(publishMonday);
  if (!resolution) throw new Error(`--publish-monday inválido: ${publishMonday}`);
  const cycle = resolution.cycle;
  const dataRoot = resolve(getStringArg(argv, "data-root") ?? ROOT);
  const cycleDir = join(dataRoot, weeklyLinkedinRelDir(cycle));
  mkdirSync(join(cycleDir, "_internal"), { recursive: true });

  const selectionPath = join(cycleDir, "_internal", "circle-stack-selection.json");
  let selection: CircleStackSelection;
  if (existsSync(selectionPath) && !hasFlag(argv, "reselect")) {
    selection = JSON.parse(readFileSync(selectionPath, "utf8"));
    console.log(`Reusando seleção existente: ${selectionPath} (--reselect refaz)`);
  } else {
    const built = buildCircleStackSelection(dataRoot, publishMonday, cfg.interests);
    writeFileAtomic(selectionPath, JSON.stringify(built, null, 2));
    for (const w of built.warnings) console.warn(`⚠ ${w}`);
    selection = built;
  }

  const rendered = renderCircleStackPost(selection, {
    opening: readTextArg(argv, "opening-file"),
    closing: readTextArg(argv, "closing-file"),
    subscribeUrl: cfg.subscribeUrl ?? undefined,
  });

  const mdPath = join(cycleDir, `circle-stack-${cycle}.md`);
  writeFileAtomic(mdPath, `# ${rendered.title}

${rendered.markdown}
`);
  const payload = buildStackPostPayload(rendered.title, rendered.markdown);

  if (!hasFlag(argv, "publish")) {
    writeFileAtomic(join(cycleDir, "_internal", "circle-stack-payload.json"), JSON.stringify(payload, null, 2));
    console.log(`[dry-run] ${rendered.title}`);
    console.log(`[dry-run] Seleção: ${selectionPath}`);
    console.log(`[dry-run] Prévia: ${mdPath}`);
    console.log("[dry-run] Passe --publish para enviar (o post sai PUBLICADO na hora).");
    return;
  }

  if (!cfg.enabled) throw new Error("circle_stack.enabled = false — publicação desligada no config");
  const statePath = join(cycleDir, "_internal", "circle-stack-published.json");
  if (existsSync(statePath) && !hasFlag(argv, "force")) {
    throw new Error(`Ciclo ${cycle} já publicado na Stack (${statePath}). Use --force para publicar de novo.`);
  }

  await sendStackPost(webhookUrl, key, payload);
  writeFileAtomic(statePath, JSON.stringify({ cycle, title: rendered.title, published_at: new Date().toISOString() }, null, 2));
  console.log(`Publicado no Radar de Notícias Stack: ${rendered.title}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

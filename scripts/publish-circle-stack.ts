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
 *   4. Só com `--publish`: cria o post via Admin API v2, com o status de
 *      `circle_stack.status` (default `draft`) ou `--status`. Idempotente por
 *      ciclo via `_internal/circle-stack-published.json` (`--force` sobrepõe).
 *
 * `--list-spaces` lista os espaços visíveis ao token — use uma vez pra achar
 * o `space_id` do Radar e gravar em `circle_stack.space_id`.
 *
 * Token: `CIRCLE_STACK_API_TOKEN` (Doppler/.env).
 *
 * Uso:
 *   npx tsx scripts/publish-circle-stack.ts --publish-monday 261026
 *   npx tsx scripts/publish-circle-stack.ts --publish-monday 261026 --publish [--status published]
 *   npx tsx scripts/publish-circle-stack.ts --list-spaces
 *   npx tsx scripts/publish-circle-stack.ts --hello [--status published]   (post de teste "Olá, mundo")
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
import {
  createCirclePost,
  listCircleSpaces,
  buildCreatePostPayload,
  type CircleAuthScheme,
  type CirclePostStatus,
} from "./lib/circle-api.ts";
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

export const CIRCLE_STACK_TOKEN_ENV = "CIRCLE_STACK_API_TOKEN";

export interface CircleStackConfig {
  enabled: boolean;
  baseUrl?: string;
  authScheme: CircleAuthScheme;
  spaceId: number | null;
  authorEmail: string | null;
  status: CirclePostStatus;
  isCommentsEnabled: boolean;
  skipNotifications: boolean;
  subscribeUrl: string | null;
  interests: InterestTerm[];
}

const VALID_STATUS: CirclePostStatus[] = ["draft", "published"];

/** Pure: lê o bloco `circle_stack` do config, com defaults conservadores (rascunho). */
export function resolveCircleStackConfig(platformConfig: Record<string, unknown>): CircleStackConfig {
  const raw = (platformConfig.circle_stack ?? {}) as Record<string, unknown>;
  const status = (raw.status ?? "draft") as CirclePostStatus;
  if (!VALID_STATUS.includes(status)) throw new Error(`circle_stack.status inválido: ${String(raw.status)}`);
  const scheme = (raw.auth_scheme ?? "auto") as CircleAuthScheme;
  if (!["auto", "Token", "Bearer"].includes(scheme)) throw new Error(`circle_stack.auth_scheme inválido: ${String(raw.auth_scheme)}`);
  return {
    enabled: raw.enabled !== false,
    baseUrl: typeof raw.base_url === "string" ? raw.base_url : undefined,
    authScheme: scheme,
    spaceId: typeof raw.space_id === "number" ? raw.space_id : null,
    authorEmail: typeof raw.author_email === "string" && raw.author_email ? raw.author_email : null,
    status,
    isCommentsEnabled: raw.is_comments_enabled !== false,
    skipNotifications: raw.skip_notifications === true,
    subscribeUrl: typeof raw.subscribe_url === "string" && raw.subscribe_url ? raw.subscribe_url : null,
    interests: parseInterestProfile(raw.interests) ?? STACK_INTEREST_PROFILE,
  };
}

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
  const token = process.env[CIRCLE_STACK_TOKEN_ENV] ?? "";
  const client = { token, baseUrl: cfg.baseUrl, authScheme: cfg.authScheme };

  if (hasFlag(argv, "list-spaces")) {
    if (!token) throw new Error(`${CIRCLE_STACK_TOKEN_ENV} ausente`);
    const spaces = await listCircleSpaces(client);
    for (const s of spaces) console.log(`${s.id}\t${s.slug}\t${s.name}`);
    if (spaces.length === 0) console.log("Nenhum espaço visível para este token.");
    return;
  }

  if (hasFlag(argv, "hello")) {
    // Teste de conectividade (#10904): um post "Olá, mundo" no espaço, sem notificar os membros.
    if (!token) throw new Error(`${CIRCLE_STACK_TOKEN_ENV} ausente (Doppler/.env)`);
    if (!cfg.spaceId) throw new Error("circle_stack.space_id não configurado — rode --list-spaces e grave o id no platform.config.json");
    const statusArg = getStringArg(argv, "status") as CirclePostStatus | undefined;
    if (statusArg && !VALID_STATUS.includes(statusArg)) throw new Error(`--status inválido: ${statusArg}`);
    const result = await createCirclePost(client, {
      spaceId: cfg.spaceId,
      name: "Olá, mundo",
      html: "<p>Olá, mundo. Teste de publicação da diar.ia.br.</p>",
      status: statusArg ?? cfg.status,
      userEmail: cfg.authorEmail ?? undefined,
      skipNotifications: true,
    });
    console.log(`Post de teste criado: id=${result.id ?? "?"} status=${result.status ?? "?"} ${result.url ?? ""}`);
    console.log(JSON.stringify(result.raw, null, 2).slice(0, 2000));
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

  const statusArg = getStringArg(argv, "status") as CirclePostStatus | undefined;
  if (statusArg && !VALID_STATUS.includes(statusArg)) throw new Error(`--status inválido: ${statusArg}`);
  const status = statusArg ?? cfg.status;

  const htmlPath = join(cycleDir, `circle-stack-${cycle}.html`);
  writeFileAtomic(htmlPath, rendered.html);

  const postInput = {
    spaceId: cfg.spaceId ?? 0,
    name: rendered.title,
    html: rendered.html,
    status,
    userEmail: cfg.authorEmail ?? undefined,
    isCommentsEnabled: cfg.isCommentsEnabled,
    skipNotifications: cfg.skipNotifications,
  };

  if (!hasFlag(argv, "publish")) {
    const preview = cfg.spaceId ? buildCreatePostPayload(postInput) : { ...postInput, spaceId: "(circle_stack.space_id não configurado)" };
    writeFileAtomic(join(cycleDir, "_internal", "circle-stack-payload.json"), JSON.stringify(preview, null, 2));
    console.log(`[dry-run] ${rendered.title}`);
    console.log(`[dry-run] Seleção: ${selectionPath}`);
    console.log(`[dry-run] HTML: ${htmlPath}`);
    console.log(`[dry-run] status que seria usado: ${status}. Passe --publish para criar o post.`);
    return;
  }

  if (!cfg.enabled) throw new Error("circle_stack.enabled = false — publicação desligada no config");
  if (!token) throw new Error(`${CIRCLE_STACK_TOKEN_ENV} ausente (Doppler/.env)`);
  if (!cfg.spaceId) throw new Error("circle_stack.space_id não configurado — rode --list-spaces e grave o id no platform.config.json");

  const statePath = join(cycleDir, "_internal", "circle-stack-published.json");
  if (existsSync(statePath) && !hasFlag(argv, "force")) {
    throw new Error(`Ciclo ${cycle} já publicado no Circle (${statePath}). Use --force para publicar de novo.`);
  }

  const result = await createCirclePost(client, postInput);
  writeFileAtomic(
    statePath,
    JSON.stringify(
      { cycle, post_id: result.id, url: result.url, status: result.status ?? status, title: rendered.title, created_at: new Date().toISOString() },
      null,
      2,
    ),
  );
  console.log(`Post criado no Circle: id=${result.id ?? "?"} status=${result.status ?? status} ${result.url ?? ""}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

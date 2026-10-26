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
 *      escritos depois) — `--reselect` refaz do zero. Seleção nova passa pelo
 *      agente `stack-title-translator` (#11005, `lib/circle-stack-translate.ts`):
 *      título sem sinal de português é traduzido e gravado em `title`, o da
 *      fonte fica em `titleOriginal`, e cada tradução vira aviso para o editor
 *      revisar. `--no-translate` pula; `--translate-titles` roda sobre uma
 *      seleção já gravada. `--publish` que montou a seleção agora com título
 *      sem sinal de português (traduzido ou não) recusa até o editor revisar.
 *      Seleção já gravada também recusa título sem sinal de português (tradução
 *      que falhou na prévia, `--no-translate`) até o editor reescrever, rodar
 *      `--translate-titles` ou marcar `"titleReviewed": true` no item (#11161).
 *   3. Renderiza a prévia em Markdown `data/weekly/{cycle}/circle-stack-{cycle}.md`.
 *   4. Só com `--publish`: envia ao webhook n8n da Stack
 *      (`scripts/lib/stack-webhook.ts`), que
 *      publica NA HORA — não há rascunho. Idempotente por ciclo via
 *      `_internal/circle-stack-published.json`, lido pelo resolver
 *      determinístico `resolveCircleStackState` (`lib/publish-state.ts`, #573):
 *      só "draft" (nada enviado) libera; "published"/"unknown" exigem `--force`.
 *      A tentativa é gravada ANTES do envio e confirmada (`published_at`) só
 *      depois do `{"ok": true}` — envio que rejeita ou estoura o timeout deixa
 *      o ciclo "unknown" (o post pode ter saído), nunca "draft".
 *      Após publicar, fecha a issue de aviso do ciclo (fail-soft).
 *
 * Task semanal `Diaria-Circle-Stack-Weekly-Preview` (segunda 07:30 BRT,
 * `scripts/lib/scheduled-tasks.ts`): roda em DRY-RUN com `--notify` — gera a
 * seleção + prévia do ciclo e abre/reusa uma issue `bloqueio-execucao` avisando
 * o editor. NUNCA publica sozinha: o post sai publicado na hora numa
 * comunidade de terceiro, então `--publish` fica manual até o editor decidir
 * automatizar. Sem `--publish-monday`, assume a segunda de hoje ou a anterior
 * (≤ hoje): o timer tem `Persistent=true`, e um catch-up numa terça precisa
 * cair no ciclo cuja semana de conteúdo já fechou. Com estado "unknown" o aviso
 * é outro ("estado ambíguo, conferir no Radar antes de --publish"); com
 * `circle_stack.enabled = false` o aviso é pulado (e isso é logado). O mesmo
 * `--notify` fecha os avisos de ciclos ANTERIORES ainda abertos (#10965):
 * semana não publicada ("draft") ou já publicada fecha; estado ambíguo fica.
 *
 * `--hello` envia um post curto de teste ("Olá, mundo") — também publicado
 * na hora; combine com a Stack antes, eles acompanham o 1º envio. Sai uma vez
 * só: o marcador `data/weekly/_internal/circle-stack-hello.json` recusa o 2º
 * envio sem `--force` (#10977). O `--publish` do ciclo pega um lock exclusivo
 * (`circle-stack-published.json.lock`) antes de ler o estado (#10977), e recusa
 * seleção com link não oficial em Lançamentos/Use melhor (#11004) ou título em
 * inglês (#11005) — no dry-run essas linhas saem como avisos.
 *
 * Doppler/.env: `STACK_WEBHOOK_URL` (URL do webhook n8n — fora do repo, que é
 * público) e `STACK_WEBHOOK_KEY` (enviado em `X-Webhook-Key`).
 *
 * Uso:
 *   npx tsx scripts/publish-circle-stack.ts --publish-monday 261026
 *   npx tsx scripts/publish-circle-stack.ts --publish-monday 261026 --publish
 *   npx tsx scripts/publish-circle-stack.ts --hello   (post de teste "Olá, mundo")
 *   npx tsx scripts/publish-circle-stack.ts --notify   (task semanal: dry-run + aviso ao editor;
 *                                                       ignorado junto com --publish)
 *   (opcionais: --reselect, --opening-file <path>, --closing-file <path>, --force, --data-root <dir>)
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import {
  currentOrPreviousMondayAAMMDD,
  isValidWeeklyCycle,
  resolveWeeklyLinkedinCycle,
  weeklyLinkedinRelDir,
} from "./lib/weekly-linkedin-cycle.ts";
import {
  resolveCircleStackState,
  type CircleStackPublishedLike,
  type CircleStackPublishedState,
  type PublishState,
} from "./lib/publish-state.ts";
import { notifyEditor, type NotifyEditorFinding } from "./lib/editor-notify.ts";
import {
  ALARM_LABEL,
  defaultAlarmGhRun,
  extractAlarmFingerprintForCheck,
  findExistingAlarmIssue,
  type GhRunFn,
} from "./lib/alarm-issues.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { deriveEditionUrl } from "./lib/edition-url.ts";
import { extractWeeklyCandidates, type WeeklyRawCandidate } from "./lib/weekly-linkedin-parse.ts";
import { parseDestaques } from "./extract-destaques.ts";
import {
  assertStackWebhookConfig,
  buildStackPostPayload,
  sendStackPost,
  STACK_WEBHOOK_KEY_ENV,
  STACK_WEBHOOK_URL_ENV,
  type StackPostPayload,
} from "./lib/stack-webhook.ts";
import {
  circleStackSelectionViolations,
  circleStackUnreviewedTitles,
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
import {
  stackTitleTranslationCandidates,
  translateCircleStackTitles,
  type TranslateStackTitlesOptions,
} from "./lib/circle-stack-translate.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface CircleStackConfig {
  enabled: boolean;
  subscribeUrl: string | null;
  interests: readonly InterestTerm[];
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

/**
 * Lê o state local de idempotência do ciclo. `null` = arquivo ausente;
 * JSON ilegível vira `{}` (o resolver o classifica "unknown", nunca "draft").
 */
export function readCircleStackPublishedState(statePath: string): CircleStackPublishedLike | null {
  if (!existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object") return parsed as CircleStackPublishedLike;
    console.warn(`⚠ State de publicação da Stack sem objeto JSON (${statePath}) — tratado como estado ambíguo`);
    return {};
  } catch (err) {
    console.warn(
      `⚠ State de publicação da Stack ilegível (${statePath}): ${err instanceof Error ? err.message : String(err)} — tratado como estado ambíguo`,
    );
    return {};
  }
}

/**
 * Pure: decide se o `--publish` pode enviar, a partir do estado normalizado
 * (`resolveCircleStackState`, #573). Só "draft" (nada enviado) libera sem
 * `--force`; "published" e "unknown" bloqueiam — o webhook publica na hora e
 * não há como apagar um post duplicado pela API.
 */
export function circleStackPublishBlockReason(state: PublishState, cycle: string, statePath: string): string | null {
  if (state === "draft") return null;
  if (state === "published") {
    return `Ciclo ${cycle} já publicado na Stack (${statePath}). Use --force para publicar de novo.`;
  }
  return `State de publicação do ciclo ${cycle} existe mas não confirma o envio (${statePath}) — ` +
    "conferir no Radar de Notícias Stack antes; --force publica mesmo assim.";
}

/**
 * Pure (#11005): `--publish` que acabou de montar a seleção não envia se ela tem
 * título sem sinal de português — traduzido pela LLM agora, ou deixado como na
 * fonte porque a tradução falhou/foi pulada. Nos dois casos o editor ainda não
 * revisou (decisão do briefing 261025b), e o guard de inglês sozinho não pega
 * título sem palavra funcional ("Codex Launch Notes"). Na seleção já gravada
 * (prévia da task), o título traduzido conta como revisado; o que segue sem
 * sinal de português é barrado por `circleStackUnreviewedTitles` (#11161).
 */
export function circleStackFreshTranslationBlockReason(pendingReview: number, selectionPath: string): string | null {
  if (pendingReview <= 0) return null;
  return (
    `${pendingReview} título(s) sem sinal de português entraram numa seleção montada agora e ainda não foram revisados — ` +
    `confira o campo title em ${selectionPath} (original em titleOriginal) e rode o --publish de novo.`
  );
}

export const CIRCLE_STACK_NOTIFY_CHECK = "circle-stack-weekly";

/** Fingerprint do aviso de estado ambíguo — distinto do "prévia pronta" do mesmo ciclo. */
export function circleStackAmbiguousFingerprint(cycle: string): string {
  return `${cycle}-ambiguo`;
}

function warningsSection(warnings: readonly string[]): string[] {
  if (warnings.length === 0) return [];
  return ["", "Avisos da seleção (revisar antes de publicar):", "", ...warnings.map((w) => `- ${w}`)];
}

/** O que o `--notify` faz com o estado normalizado do ciclo. */
export type CircleStackNotifyDecision = "ready" | "ambiguous" | "skip-published" | "skip-disabled";

/**
 * Pure: decisão do aviso ao editor na task semanal (dry-run). Publicação
 * desligada no config pula; ciclo já publicado pula; "draft" avisa que a
 * prévia está pronta; "unknown" (tentativa sem confirmação, state ilegível ou
 * de outro ciclo) gera aviso DIFERENTE — conferir no Radar antes de publicar.
 */
export function decideCircleStackNotify(state: PublishState, enabled: boolean): CircleStackNotifyDecision {
  if (!enabled) return "skip-disabled";
  if (state === "published") return "skip-published";
  if (state === "draft") return "ready";
  return "ambiguous";
}

/** Pure: aviso de estado ambíguo — o state do ciclo existe mas não confirma o envio. */
export function buildCircleStackAmbiguousFinding(
  cycle: string,
  title: string,
  statePath: string,
  publishMonday: string,
  warnings: readonly string[] = [],
): NotifyEditorFinding {
  return {
    check: CIRCLE_STACK_NOTIFY_CHECK,
    fingerprint: circleStackAmbiguousFingerprint(cycle),
    severity: "acao",
    family: "estado",
    subject: `Radar de Notícias Stack ${cycle}: estado ambíguo, conferir no Radar antes de --publish`,
    body: [
      `O state de publicação do ciclo existe mas não confirma o envio de **${title}** — uma tentativa pode ter saído sem confirmação (timeout, erro do webhook) ou o arquivo está ilegível.`,
      "",
      `- State: \`${statePath}\``,
      "",
      "Conferir no Radar de Notícias Stack se o post do ciclo já está lá ANTES de publicar:",
      "",
      "- se está: regravar o state com `published_at` (ou só fechar esta issue);",
      "- se não está: publicar com `--force`:",
      "",
      "```",
      `npx tsx scripts/publish-circle-stack.ts --publish-monday ${publishMonday} --publish --force`,
      "```",
      ...warningsSection(warnings),
      "",
      "Ação manual do editor — publicar é guard de execução, rodadas autônomas não executam.",
    ].join("\n"),
    labels: ["bloqueio-execucao"],
    priority: "P2",
    legacyResendIntent: "dedupe-new-occurrences-only",
  };
}

/** Pure: aviso ao editor de que a prévia semanal está pronta (task de segunda, dry-run). */
export function buildCircleStackReadyFinding(
  cycle: string,
  title: string,
  mdPath: string,
  publishMonday: string,
  warnings: readonly string[] = [],
): NotifyEditorFinding {
  return {
    check: CIRCLE_STACK_NOTIFY_CHECK,
    fingerprint: cycle,
    severity: "acao",
    // "estado": a condição ("ciclo ainda não publicado") é re-checável.
    family: "estado",
    subject: `Radar de Notícias Stack ${cycle}: prévia pronta para revisar e publicar`,
    body: [
      `A task semanal gerou a prévia do post da Stack (dry-run, nada foi enviado): **${title}**.`,
      "",
      `- Prévia: \`${mdPath}\``,
      `- Seleção editável: \`data/weekly/${cycle}/_internal/circle-stack-selection.json\``,
      "",
      "Para publicar (sai PUBLICADO na hora, sem rascunho):",
      "",
      "```",
      `npx tsx scripts/publish-circle-stack.ts --publish-monday ${publishMonday} --publish`,
      "```",
      ...warningsSection(warnings),
      "",
      "Ação manual do editor — publicar é guard de execução, rodadas autônomas não executam.",
    ].join("\n"),
    labels: ["bloqueio-execucao"],
    priority: "P2",
    legacyResendIntent: "dedupe-new-occurrences-only",
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

function toItem(c: StackScoredCandidate): CircleStackItem & { titleOriginal: string; score: number; matchedTerms: string[] } {
  // `titleOriginal` (#11005): o título como veio da edição, para auditoria — o
  // editor reescreve `title` em português na seleção quando a fonte é em inglês.
  return {
    editionDate: c.editionDate,
    url: c.url,
    title: c.title,
    titleOriginal: c.title,
    body: c.body,
    why: c.why,
    // #11003: só destaques carregam a posição; vira a âncora #dN do link da edição.
    ...(c.kind === "destaque" && c.destaqueN !== undefined ? { destaqueN: c.destaqueN } : {}),
    score: c.score,
    matchedTerms: c.matchedTerms,
  };
}

/** Lê as edições da semana e monta a seleção (sem gravar). */
export function buildCircleStackSelection(
  dataRoot: string,
  publishMonday: string,
  interests: readonly InterestTerm[],
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

const ITEM_STRING_FIELDS = ["editionDate", "url", "title", "body", "why"] as const;
const ITEM_SECTIONS = ["destaques", "lancamentos", "useMelhor", "radar"] as const;

/**
 * Pure: lê e valida a seleção editável (`circle-stack-selection.json`). O
 * arquivo é editado à mão, então erro de sintaxe/shape vira mensagem com o
 * caminho e a saída (`--reselect`), nunca um TypeError no render. Também
 * recusa seleção de outro ciclo (arquivo copiado de outra semana).
 */
export function parseStoredCircleStackSelection(
  raw: string,
  selectionPath: string,
  cycle: string,
): { selection: CircleStackSelection; warnings: string[] } {
  const fail = (why: string): never => {
    throw new Error(`Seleção editável inválida (${selectionPath}): ${why}. Corrija o arquivo ou rode com --reselect para refazê-la.`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(`JSON ilegível — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("esperado um objeto JSON");
  const sel = parsed as Record<string, unknown>;
  if (sel.cycle !== cycle) return fail(`ciclo ${JSON.stringify(sel.cycle)} diferente do esperado ${cycle}`);
  if (!Array.isArray(sel.contentWindow)) return fail("campo contentWindow ausente");
  if (!Array.isArray(sel.weeklyEditions)) return fail("campo weeklyEditions ausente");
  for (const section of ITEM_SECTIONS) {
    const items = sel[section];
    if (!Array.isArray(items)) return fail(`seção ${section} ausente (esperada uma lista)`);
    items.forEach((it: unknown, i: number) => {
      if (!it || typeof it !== "object") fail(`${section}[${i}] não é um objeto`);
      const rec = it as Record<string, unknown>;
      for (const f of ITEM_STRING_FIELDS) {
        if (typeof rec[f] !== "string") fail(`${section}[${i}].${f} ausente ou não é texto`);
      }
      if (rec.stackNote !== undefined && typeof rec.stackNote !== "string") fail(`${section}[${i}].stackNote não é texto`);
      if (rec.titleOriginal !== undefined && typeof rec.titleOriginal !== "string") fail(`${section}[${i}].titleOriginal não é texto`);
      if (rec.titleReviewed !== undefined && typeof rec.titleReviewed !== "boolean") fail(`${section}[${i}].titleReviewed precisa ser true ou false`);
      if (rec.destaqueN !== undefined && !(Number.isInteger(rec.destaqueN) && (rec.destaqueN as number) >= 1 && (rec.destaqueN as number) <= 3)) {
        fail(`${section}[${i}].destaqueN precisa ser 1, 2 ou 3`);
      }
    });
  }
  const warnings = Array.isArray(sel.warnings) ? sel.warnings.filter((w): w is string => typeof w === "string") : [];
  return { selection: parsed as CircleStackSelection, warnings };
}

export interface PublishCircleStackCycleInput {
  statePath: string;
  cycle: string;
  title: string;
  payload: StackPostPayload;
  force: boolean;
  /** Envio injetável (produção: `sendStackPost` com URL/chave já validadas). */
  send: (payload: StackPostPayload) => Promise<void>;
  now?: () => Date;
}

/**
 * Publica o ciclo com idempotência em dois tempos (#10904):
 *   1. resolve o estado normalizado — "published"/"unknown" bloqueiam sem `force`;
 *   2. grava `{cycle, title, attempted_at}` ANTES do envio;
 *   3. envia; só depois do `{ok:true}` regrava com `published_at`.
 * Se o envio rejeitar (erro HTTP, timeout, processo morto no meio), o state
 * fica sem `published_at` → "unknown" → a próxima execução bloqueia sem
 * `--force`. O post pode ter saído; preferimos exigir conferência humana a
 * duplicar um post numa comunidade de terceiro.
 */
export async function publishCircleStackCycle(input: PublishCircleStackCycleInput): Promise<{ publishedAt: string; forced: boolean }> {
  const { statePath, cycle, title, payload, force, send } = input;
  const now = input.now ?? (() => new Date());
  // #10977: o lock vem ANTES da leitura do estado — dois --publish simultâneos
  // não podem ver "draft" ao mesmo tempo. O estado é lido já com o lock na mão.
  const release = acquireCircleStackPublishLock(circleStackPublishLockPath(statePath));
  try {
    const state = resolveCircleStackState(readCircleStackPublishedState(statePath), cycle);
    const blockReason = circleStackPublishBlockReason(state, cycle, statePath);
    if (blockReason && !force) throw new Error(blockReason);

    const attempt: CircleStackPublishedState = { cycle, title, attempted_at: now().toISOString() };
    writeFileAtomic(statePath, JSON.stringify(attempt, null, 2));
    await send(payload);
    const publishedAt = now().toISOString();
    const confirmed: CircleStackPublishedState = { ...attempt, published_at: publishedAt };
    writeFileAtomic(statePath, JSON.stringify(confirmed, null, 2));
    return { publishedAt, forced: blockReason !== null };
  } finally {
    release();
  }
}

/** Lock do `--publish` do ciclo, ao lado do state (#10977). */
export function circleStackPublishLockPath(statePath: string): string {
  return `${statePath}.lock`;
}

/**
 * Lock exclusivo (`O_CREAT | O_EXCL`, flag `wx`) contra `--publish`
 * concorrente na mesma máquina (#10977). Devolve a função que o libera.
 *
 * Lock já existente recusa SEMPRE — sem tomada automática de lock antigo: dois
 * processos que achassem o lock velho ao mesmo tempo poderiam apagar um o do
 * outro. Um lock que sobrou de processo morto só custa apagar o arquivo à mão,
 * e o state continua protegendo contra duplicata (tentativa sem confirmação →
 * "unknown"). Limite conhecido: entre máquinas (Windows e `300` pelo
 * OneDrive) o lock só vale depois que o arquivo replica.
 */
export function acquireCircleStackPublishLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    let age = "";
    try {
      age = `, criado há ${Math.max(0, Math.round((Date.now() - statSync(lockPath).mtimeMs) / 1000))}s`;
    } catch {
      // sumiu entre o open e o stat: outro processo acabou de liberar.
    }
    throw new Error(
      `Outro --publish da Stack está em andamento (lock ${lockPath}${age}). ` +
        "Se nenhum está rodando (processo morto), confira o Radar e apague o arquivo antes de tentar de novo.",
    );
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  return () => rmSync(lockPath, { force: true });
}

/** Marcador do `--hello` (#10977) — fora dos ciclos, em `data/weekly/_internal/`. */
export function circleStackHelloMarkerPath(dataRoot: string): string {
  return join(dataRoot, "data", "weekly", "_internal", "circle-stack-hello.json");
}

/**
 * Envia o post de teste "Olá, mundo" uma vez só (#10977). Todo `--hello`
 * publica na hora numa comunidade de terceiro, então um 2º envio sem querer
 * vira post duplicado. O marcador é gravado ANTES do envio (`attempted_at`) e
 * confirmado (`sent_at`) depois — marcador presente, confirmado ou não,
 * recusa sem `force`.
 */
export async function publishCircleStackHello(input: {
  markerPath: string;
  force: boolean;
  send: () => Promise<void>;
  now?: () => Date;
}): Promise<{ sentAt: string; forced: boolean }> {
  const now = input.now ?? (() => new Date());
  const exists = existsSync(input.markerPath);
  if (exists && !input.force) {
    let prev = "";
    try {
      prev = ` (${readFileSync(input.markerPath, "utf8").replace(/\s+/g, " ").trim().slice(0, 200)})`;
    } catch {
      // ilegível: a recusa vale do mesmo jeito.
    }
    throw new Error(
      `O --hello já foi enviado ou tentado${prev} — marcador ${input.markerPath}. ` +
        'Ele publica "Olá, mundo" na hora; use --force para enviar de novo.',
    );
  }
  mkdirSync(dirname(input.markerPath), { recursive: true });
  const attempt = { attempted_at: now().toISOString() };
  writeFileAtomic(input.markerPath, JSON.stringify(attempt, null, 2));
  await input.send();
  const sentAt = now().toISOString();
  writeFileAtomic(input.markerPath, JSON.stringify({ ...attempt, sent_at: sentAt }, null, 2));
  return { sentAt, forced: exists };
}

/**
 * Fecha as issues de aviso do ciclo (prévia pronta + estado ambíguo) depois de
 * um publish confirmado — a condição que elas sinalizavam deixou de valer.
 * Fail-soft: falha de `gh` só vira aviso no log; o post já saiu.
 */
export function closeCircleStackNotifyIssues(
  cycle: string,
  publishedAt: string,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): { closed: number[]; failed: string[] } {
  const closed: number[] = [];
  const failed: string[] = [];
  for (const fingerprint of [cycle, circleStackAmbiguousFingerprint(cycle)]) {
    const existing = findExistingAlarmIssue(CIRCLE_STACK_NOTIFY_CHECK, fingerprint, cwd, run);
    if (!existing || existing.state !== "OPEN") continue;
    const comment = `Ciclo ${cycle} publicado no Radar de Notícias Stack em ${publishedAt} (state confirmado pelo webhook).`;
    const res = run(["issue", "close", String(existing.issueNumber), "--comment", comment, "--reason", "completed"], cwd);
    if (res.status === 0) closed.push(existing.issueNumber);
    else failed.push(`#${existing.issueNumber}`);
  }
  return { closed, failed };
}

/** Ciclo (`26w42`) a que o fingerprint de um aviso se refere (prévia ou ambíguo). */
export function circleStackCycleFromFingerprint(fingerprint: string): string | null {
  const cycle = fingerprint.endsWith("-ambiguo") ? fingerprint.slice(0, -"-ambiguo".length) : fingerprint;
  return isValidWeeklyCycle(cycle) ? cycle.toLowerCase() : null;
}

export interface StaleCircleStackNotifyPlan {
  /** Avisos de ciclos anteriores a fechar, com o motivo. */
  close: { issueNumber: number; cycle: string; kind: "unpublished" | "published" }[];
  /** Avisos de ciclos anteriores mantidos abertos (estado ambíguo — exige conferência humana). */
  keep: { issueNumber: number; cycle: string }[];
}

/**
 * Pure (#10965): decide o destino dos avisos abertos de ciclos ANTERIORES ao
 * `currentCycle`. Sem isso, a semana que o editor pula deixa a issue
 * `bloqueio-execucao` do ciclo aberta para sempre (só o `--publish` do próprio
 * ciclo a fechava). Por estado do ciclo antigo:
 *   - "draft" (nada enviado) → fecha como "semana não publicada";
 *   - "published" (o close pós-publish falhou) → fecha como publicado;
 *   - "unknown" → MANTÉM: o post pode ter saído sem confirmação, e só o
 *     editor confere no Radar (mesmo critério do `--publish`, #573).
 * Avisos do ciclo atual ou de ciclo posterior (relógio torto, `--publish-monday`
 * de uma semana antiga) nunca entram no plano.
 */
export function planStaleCircleStackNotifyCloses(
  issues: readonly { number: number; body?: string | null }[],
  currentCycle: string,
  stateOfCycle: (cycle: string) => PublishState,
): StaleCircleStackNotifyPlan {
  const plan: StaleCircleStackNotifyPlan = { close: [], keep: [] };
  const current = currentCycle.toLowerCase();
  for (const issue of issues) {
    const fp = extractAlarmFingerprintForCheck(issue.body ?? "", CIRCLE_STACK_NOTIFY_CHECK);
    const cycle = fp === null ? null : circleStackCycleFromFingerprint(fp);
    if (cycle === null || cycle >= current) continue;
    const state = stateOfCycle(cycle);
    if (state === "draft") plan.close.push({ issueNumber: issue.number, cycle, kind: "unpublished" });
    else if (state === "published") plan.close.push({ issueNumber: issue.number, cycle, kind: "published" });
    else plan.keep.push({ issueNumber: issue.number, cycle });
  }
  return plan;
}

/**
 * Fecha os avisos de ciclos anteriores conforme `planStaleCircleStackNotifyCloses`
 * (#10965). Roda no `--notify` da task semanal. Fail-soft: falha de listagem ou
 * de fechamento só volta no resultado (a próxima segunda tenta de novo).
 */
export function closeStaleCircleStackNotifyIssues(
  currentCycle: string,
  stateOfCycle: (cycle: string) => PublishState,
  cwd: string,
  run: GhRunFn = defaultAlarmGhRun,
): { closed: number[]; failed: number[]; kept: number[]; listed: boolean } {
  const res = run(
    ["issue", "list", "--label", ALARM_LABEL, "--state", "open", "--json", "number,body", "--limit", "200"],
    cwd,
  );
  if (res.status !== 0) return { closed: [], failed: [], kept: [], listed: false };
  let issues: { number: number; body?: string | null }[];
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (!Array.isArray(parsed)) return { closed: [], failed: [], kept: [], listed: false };
    issues = parsed as { number: number; body?: string | null }[];
  } catch {
    return { closed: [], failed: [], kept: [], listed: false };
  }
  const plan = planStaleCircleStackNotifyCloses(issues, currentCycle, stateOfCycle);
  const closed: number[] = [];
  const failed: number[] = [];
  for (const item of plan.close) {
    const args =
      item.kind === "unpublished"
        ? [
            "issue", "close", String(item.issueNumber),
            "--comment", `Semana não publicada: o ciclo ${item.cycle} não foi enviado ao Radar de Notícias Stack e a prévia do ciclo ${currentCycle} já substituiu esta (fechada automaticamente, #10965).`,
            "--reason", "not planned",
          ]
        : [
            "issue", "close", String(item.issueNumber),
            "--comment", `Ciclo ${item.cycle} consta como publicado no state local — fechada automaticamente pela task do ciclo ${currentCycle} (#10965).`,
            "--reason", "completed",
          ];
    (run(args, cwd).status === 0 ? closed : failed).push(item.issueNumber);
  }
  return { closed, failed, kept: plan.keep.map((k) => k.issueNumber), listed: true };
}

/**
 * Estado de publicação de um ciclo pelo state local. Diretório do ciclo
 * ausente vira "unknown" (nunca "draft"): todo ciclo que gerou aviso criou o
 * diretório, então a ausência indica `data/` não sincronizado nesta máquina —
 * fechar como "não publicada" seria afirmar algo que não se sabe.
 */
export function circleStackCycleStateFromDisk(dataRoot: string, cycle: string): PublishState {
  const cycleDir = join(dataRoot, weeklyLinkedinRelDir(cycle));
  if (!existsSync(cycleDir)) return "unknown";
  return resolveCircleStackState(readCircleStackPublishedState(join(cycleDir, "_internal", "circle-stack-published.json")), cycle);
}

function readTextArg(argv: string[], key: string): string | undefined {
  const p = getStringArg(argv, key, { example: "caminho/arquivo.txt" });
  return p ? readFileSync(resolve(p), "utf8") : undefined;
}

export interface RunCircleStackDeps {
  /** Raiz do repo: `.claude/agents/`, cwd do `gh`/`claude`, e data-root default. */
  rootDir: string;
  platformConfig: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  /** Chamada da tradução (#11005); default `callClaudeCli`. */
  translateCall?: TranslateStackTitlesOptions["call"];
  /** Envio ao webhook; default `sendStackPost`. */
  send?: (webhookUrl: string, key: string, payload: StackPostPayload) => Promise<void>;
  /** `gh` injetável (fechamento de avisos); default `defaultAlarmGhRun`. */
  ghRun?: GhRunFn;
}

/** CLI inteira com dependências injetáveis (#11005: teste de integração do caminho de `main()`). */
export async function runCircleStack(argv: string[], deps: RunCircleStackDeps): Promise<void> {
  const ROOT = deps.rootDir;
  const sendPost = deps.send ?? sendStackPost;
  const ghRun = deps.ghRun ?? defaultAlarmGhRun;
  const translateOpts: TranslateStackTitlesOptions = { rootDir: ROOT, call: deps.translateCall };
  const cfg = resolveCircleStackConfig(deps.platformConfig);
  const key = deps.env[STACK_WEBHOOK_KEY_ENV] ?? "";
  const webhookUrl = deps.env[STACK_WEBHOOK_URL_ENV] ?? "";

  if (hasFlag(argv, "hello")) {
    if (!cfg.enabled) throw new Error("circle_stack.enabled = false — publicação desligada no config");
    assertStackWebhookConfig(webhookUrl, key);
    const helloPayload = buildStackPostPayload(HELLO_POST.titulo, HELLO_POST.corpo);
    await publishCircleStackHello({
      markerPath: circleStackHelloMarkerPath(resolve(getStringArg(argv, "data-root") ?? ROOT)),
      force: hasFlag(argv, "force"),
      send: () => sendPost(webhookUrl, key, helloPayload),
    });
    console.log(`Post de teste publicado no Radar de Notícias Stack: "${HELLO_POST.titulo}"`);
    return;
  }

  let publishMonday = getStringArg(argv, "publish-monday", { example: "261026" });
  if (!publishMonday) {
    // Default da task semanal de segunda (#10904): a segunda de hoje ou a
    // anterior — o timer tem Persistent=true, e um catch-up numa terça não
    // pode cair na segunda seguinte (semana de conteúdo ainda incompleta).
    publishMonday = currentOrPreviousMondayAAMMDD(new Date());
    console.log(`--publish-monday não informado — assumindo ${publishMonday} (segunda de hoje ou a anterior).`);
  }
  const resolution = resolveWeeklyLinkedinCycle(publishMonday);
  if (!resolution) throw new Error(`--publish-monday inválido: ${publishMonday}`);
  const cycle = resolution.cycle;
  const dataRoot = resolve(getStringArg(argv, "data-root") ?? ROOT);
  const cycleDir = join(dataRoot, weeklyLinkedinRelDir(cycle));
  mkdirSync(join(cycleDir, "_internal"), { recursive: true });

  const selectionPath = join(cycleDir, "_internal", "circle-stack-selection.json");
  let selection: CircleStackSelection;
  let warnings: string[];
  // Títulos sem sinal de português em seleção montada NESTA execução (#11005).
  let pendingReviewThisRun = 0;
  if (existsSync(selectionPath) && !hasFlag(argv, "reselect")) {
    ({ selection, warnings } = parseStoredCircleStackSelection(readFileSync(selectionPath, "utf8"), selectionPath, cycle));
    console.log(`Reusando seleção existente: ${selectionPath} (--reselect refaz)`);
    // #11005: --translate-titles traduz numa seleção já gravada (só o que segue sem
    // sinal de português; título reescrito à mão fica) e regrava o arquivo.
    if (hasFlag(argv, "translate-titles") && hasFlag(argv, "publish")) {
      console.warn("⚠ --translate-titles ignorado junto com --publish: a tradução precisa da revisão do editor antes do envio — rode sem --publish primeiro.");
    } else if (hasFlag(argv, "translate-titles")) {
      const stored = JSON.parse(readFileSync(selectionPath, "utf8")) as CircleStackSelection & { warnings?: string[] };
      const tr = translateCircleStackTitles(stored, translateOpts);
      const merged = [...warnings, ...tr.warnings.filter((w) => !warnings.includes(w))];
      writeFileAtomic(selectionPath, JSON.stringify({ ...tr.selection, warnings: merged }, null, 2));
      selection = tr.selection;
      warnings = merged;
      console.log(`Títulos traduzidos: ${tr.translated}${tr.failed ? " (tradução falhou — ver avisos)" : ""}`);
    }
  } else {
    let built = buildCircleStackSelection(dataRoot, publishMonday, cfg.interests);
    // Títulos sem sinal de português montados agora ainda não passaram pela revisão
    // do editor — traduzidos ou não (tradução falha, --no-translate).
    pendingReviewThisRun = stackTitleTranslationCandidates(built).length;
    // #11005 (decisão do editor, 261025b): o agente traduz os títulos e grava na
    // seleção; o editor revisa (os traduzidos entram nos avisos). --no-translate pula.
    if (!hasFlag(argv, "no-translate")) {
      const tr = translateCircleStackTitles(built, translateOpts);
      built = { ...tr.selection, warnings: [...tr.selection.warnings, ...tr.warnings] };
      console.log(`Títulos traduzidos: ${tr.translated}${tr.failed ? " (tradução falhou — ver avisos)" : ""}`);
    }
    writeFileAtomic(selectionPath, JSON.stringify(built, null, 2));
    selection = built;
    warnings = built.warnings;
  }
  // #11004/#11005: checagem sobre a seleção que vai SAIR (inclusive editada à
  // mão e reaproveitada). Dry-run avisa; --publish recusa antes de qualquer envio.
  const violations = circleStackSelectionViolations(selection);
  // #11161: título sem sinal de português e sem `titleReviewed` — vale também
  // para a seleção já gravada (tradução que falhou, --no-translate), que o
  // `looksEnglishTitle` acima não pega quando não há palavra funcional do inglês.
  const unreviewedTitles = circleStackUnreviewedTitles(selection);
  warnings = [...warnings, ...[...violations, ...unreviewedTitles].filter((v) => !warnings.includes(v))];
  for (const w of warnings) console.warn(`⚠ ${w}`);

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
  const statePath = join(cycleDir, "_internal", "circle-stack-published.json");
  const publishState = resolveCircleStackState(readCircleStackPublishedState(statePath), cycle);

  if (!hasFlag(argv, "publish")) {
    writeFileAtomic(join(cycleDir, "_internal", "circle-stack-payload.json"), JSON.stringify(payload, null, 2));
    console.log(`[dry-run] ${rendered.title}`);
    console.log(`[dry-run] Estado do ciclo ${cycle} na Stack: ${publishState}`);
    console.log(`[dry-run] Seleção: ${selectionPath}`);
    console.log(`[dry-run] Prévia: ${mdPath}`);
    console.log("[dry-run] Passe --publish para enviar (o post sai PUBLICADO na hora).");
    // --notify (task semanal de segunda): avisa o editor conforme o estado do ciclo.
    if (hasFlag(argv, "notify")) {
      // #10965: avisos de semanas anteriores não publicadas se auto-resolvem aqui
      // (antes ficavam abertos para sempre). Fail-soft — nunca impede o aviso do ciclo atual.
      const stale = closeStaleCircleStackNotifyIssues(cycle, (c) => circleStackCycleStateFromDisk(dataRoot, c), ROOT, ghRun);
      if (!stale.listed) console.warn("⚠ Não consegui listar os avisos de ciclos anteriores — limpeza adiada para a próxima execução.");
      if (stale.closed.length > 0) console.log(`[dry-run] Aviso(s) de ciclos anteriores fechado(s): ${stale.closed.map((n) => `#${n}`).join(", ")}`);
      if (stale.failed.length > 0) console.warn(`⚠ Não consegui fechar o(s) aviso(s) de ciclos anteriores ${stale.failed.map((n) => `#${n}`).join(", ")}.`);
      if (stale.kept.length > 0) console.log(`[dry-run] Aviso(s) de ciclos anteriores mantido(s) — estado ambíguo, conferir no Radar: ${stale.kept.map((n) => `#${n}`).join(", ")}`);
      const decision = decideCircleStackNotify(publishState, cfg.enabled);
      if (decision === "skip-disabled") {
        console.log("[dry-run] Aviso ao editor pulado: circle_stack.enabled = false no config.");
      } else if (decision === "skip-published") {
        console.log(`[dry-run] Aviso ao editor pulado: ciclo ${cycle} já publicado.`);
      } else {
        const relDir = weeklyLinkedinRelDir(cycle);
        const finding =
          decision === "ready"
            ? buildCircleStackReadyFinding(cycle, rendered.title, `${relDir}/circle-stack-${cycle}.md`, publishMonday, warnings)
            : buildCircleStackAmbiguousFinding(cycle, rendered.title, `${relDir}/_internal/circle-stack-published.json`, publishMonday, warnings);
        const res = await notifyEditor(finding, { cwd: ROOT });
        if (res.issue?.action === "failed") throw new Error(`Aviso ao editor falhou: ${res.issue.error ?? "erro desconhecido"}`);
        if (res.emailError) console.warn(`⚠ Issue de aviso ok, mas o e-mail ao editor falhou: ${res.emailError}`);
        console.log(`[dry-run] Editor avisado (${decision})${res.issue?.url ? `: ${res.issue.url}` : ""}`);
      }
    }
    return;
  }

  if (hasFlag(argv, "notify")) console.log("--notify ignorado junto com --publish.");
  if (!cfg.enabled) throw new Error("circle_stack.enabled = false — publicação desligada no config");
  if (violations.length > 0) {
    throw new Error(
      `Seleção ${selectionPath} fora das regras do canal — corrija e rode de novo:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    );
  }
  const reviewBlock = circleStackFreshTranslationBlockReason(pendingReviewThisRun, selectionPath);
  if (reviewBlock) throw new Error(reviewBlock);
  if (unreviewedTitles.length > 0) {
    throw new Error(
      `Seleção ${selectionPath} com título(s) sem sinal de português ainda não revisado(s) — corrija e rode de novo:\n` +
        unreviewedTitles.map((v) => `  - ${v}`).join("\n"),
    );
  }
  // Config validada ANTES de gravar a tentativa: erro de config nunca chegou à
  // rede e não pode deixar o ciclo em "unknown".
  assertStackWebhookConfig(webhookUrl, key);

  const { publishedAt } = await publishCircleStackCycle({
    statePath,
    cycle,
    title: rendered.title,
    payload,
    force: hasFlag(argv, "force"),
    send: (p) => sendPost(webhookUrl, key, p),
  });
  console.log(`Publicado no Radar de Notícias Stack: ${rendered.title}`);

  const closeRes = closeCircleStackNotifyIssues(cycle, publishedAt, ROOT, ghRun);
  if (closeRes.closed.length > 0) console.log(`Issue(s) de aviso do ciclo fechada(s): ${closeRes.closed.map((n) => `#${n}`).join(", ")}`);
  if (closeRes.failed.length > 0) console.warn(`⚠ Não consegui fechar a(s) issue(s) de aviso ${closeRes.failed.join(", ")} — fechar à mão.`);
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  await runCircleStack(process.argv.slice(2), {
    rootDir: ROOT,
    platformConfig: JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8")),
    env: process.env,
  });
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

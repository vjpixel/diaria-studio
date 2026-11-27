#!/usr/bin/env node
/**
 * scripts/publish-claude-semanal-kit.ts (#14329)
 *
 * Envio do e-mail semanal "Claude na semana" pelo Kit, à audiência da tag
 * `platform.config.json` → `kit_claude_semanal.audience_tag` (fase de teste:
 * Núcleo). Lê o rascunho do writer (`data/claude-semanal/{AAMMDD}/_internal/02-draft.json`),
 * renderiza com `lib/claude-semanal.ts` e cria o broadcast AGENDADO para o
 * horário configurado (default domingo 08:00 BRT). Chamado só pelo Passo 6 de
 * `/diaria-claude-semanal`, depois da aprovação do editor no gate.
 *
 * Modos:
 *   - sem flag: dry-run — valida, grava a prévia (HTML + texto) e NÃO chama o Kit;
 *   - `--check-audience`: dry-run + leitura (só GET) da tag no Kit, para o gate
 *     mostrar a contagem real de destinatários;
 *   - `--send`: cria o broadcast agendado (`--force` passa por cima do registro).
 *
 * Guards (mesmos do canal da Stack, `publish-circle-stack-email-kit.ts`):
 *   - tag configurada, existente e não-vazia (`resolveVerifiedAudience`) —
 *     filtro não resolvido no Kit é a BASE INTEIRA (#6126);
 *   - `public: false` sempre: o e-mail é recompensa de apoio na fase de teste e
 *     `public_url` o publicaria no Kit;
 *   - releitura do broadcast: filtro igual ao enviado (#6582) E agendado. Sem as
 *     duas confirmações, apaga e confere a exclusão (404);
 *   - rascunho com problema (fonte não oficial, item já enviado em outra
 *     semana, volume fora de 8 a 15, cópia com seta/markdown/URL) não sai;
 *   - lock `wx` por semana; registro gravado como `pending` ANTES do POST.
 *     Registro que não seja `sent` é ambíguo: recusa até alguém conferir o Kit
 *     e passar `--force`.
 *
 * O registro `sent` guarda os itens: é dele que o dedup entre semanas lê
 * (`lib/claude-semanal-store.ts`).
 *
 * Exit codes: 0 ok/já enviado · 1 incidente ou erro · 2 guard.
 *
 * Uso:
 *   npx tsx scripts/publish-claude-semanal-kit.ts --week 261129                     # dry-run
 *   npx tsx scripts/publish-claude-semanal-kit.ts --week 261129 --check-audience
 *   npx tsx scripts/publish-claude-semanal-kit.ts --week 261129 --send [--force]
 *   (opcional: --data-root <dir>)
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import {
  buildTagFilter,
  countKitTagMembers,
  createBroadcast,
  deleteBroadcast,
  findTagIdByName,
  type CreateBroadcastInput,
} from "./lib/kit-broadcasts.ts";
import { getBroadcast, KitApiError } from "./lib/kit-client.ts";
import { resolveVerifiedAudience, type ResolvedAudience } from "./lib/shared/kit-apoio-tag.ts";
import {
  CLAUDE_SEMANAL_CONFIG_KEY,
  CLAUDE_SEMANAL_TAG_SYNC_COMMAND,
  ClaudeSemanalGuardError,
  ClaudeSemanalIncidentError,
  claudeSemanalDraftProblems,
  draftItems,
  parseClaudeSemanalDraft,
  renderClaudeSemanalEmail,
  resolveClaudeSemanalSendAt,
  resolveClaudeSemanalWeek,
  type ClaudeSemanalSentItem,
  type RenderedClaudeSemanalEmail,
} from "./lib/claude-semanal.ts";
import { claudeSemanalPaths, loadClaudeSemanalConfig, loadClaudeSemanalSent, type ClaudeSemanalPaths } from "./lib/claude-semanal-store.ts";
import { formatStackEmailBrt as formatBrt } from "./lib/circle-stack-email-render.ts";
import {
  toPersistedVerification,
  verifyAudienceFilter,
  type AudienceVerification,
  type PersistedAudienceVerification,
} from "./publish-artigo-especial-kit.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[publish-claude-semanal-kit]";
const REREAD_RETRY_MS = 2_000;

export interface ClaudeSemanalSent {
  status: "sent";
  week: string;
  broadcastId: number;
  subject: string;
  sendAt: string;
  late: boolean;
  audienceTag: string;
  audienceTagId: number;
  audienceMemberCount: number;
  audienceVerification: PersistedAudienceVerification;
  items: ClaudeSemanalSentItem[];
  createdAt: string;
}

type ClaudeSemanalRecord =
  | ClaudeSemanalSent
  | { status: "pending"; week: string; attemptedAt: string; previous?: string }
  | { status: "cancel-failed"; week: string; broadcastId: number; sendAt: string; reason: string; at: string; previous?: string };

type RecordRead = { kind: "none" } | { kind: "sent"; record: ClaudeSemanalSent } | { kind: "ambiguous"; reason: string };

/** Arquivo existente mas ilegível NUNCA vira "nunca enviado": o efeito do erro seria mandar duas vezes. */
export function readClaudeSemanalRecord(path: string): RecordRead {
  if (!existsSync(path)) return { kind: "none" };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { kind: "ambiguous", reason: `${path} existe mas está ilegível (${(e as Error).message})` };
  }
  if (parsed?.status === "sent" && typeof parsed.broadcastId === "number" && typeof parsed.sendAt === "string") {
    return { kind: "sent", record: parsed as unknown as ClaudeSemanalSent };
  }
  if (parsed?.status === "pending") {
    return {
      kind: "ambiguous",
      reason: `uma tentativa anterior (${String(parsed.attemptedAt)}) parou entre o pedido ao Kit e a confirmação — o broadcast pode ter sido criado`,
    };
  }
  if (parsed?.status === "cancel-failed") {
    return {
      kind: "ambiguous",
      reason: `o broadcast ${String(parsed.broadcastId)} teve a audiência não confirmada e o cancelamento automático falhou`,
    };
  }
  return { kind: "ambiguous", reason: `${path} existe mas não é um registro reconhecível` };
}

/** Pura: nome interno do broadcast no painel do Kit (único por semana, serve pra achar órfão). */
export function buildClaudeSemanalDescription(week: string): string {
  return `diar.ia.br Claude na semana — ${week}`;
}

/**
 * Pura: payload de `POST /v4/broadcasts`. Exige `ResolvedAudience` (só
 * `resolveVerifiedAudience` produz uma), nunca um id cru. `public: false`
 * sempre.
 *
 * @pure
 */
export function buildClaudeSemanalBroadcastInput(
  email: RenderedClaudeSemanalEmail,
  week: string,
  audience: ResolvedAudience,
  sendAt: string,
): CreateBroadcastInput {
  return {
    subject: email.subject,
    content: email.html,
    preview_text: email.previewText,
    description: buildClaudeSemanalDescription(week),
    send_at: sendAt,
    subscriber_filter: buildTagFilter(audience.tagId),
    public: false,
  };
}

/**
 * Pura: confere a releitura — filtro igual ao enviado, agendado E não
 * público. O Kit já foi visto zerando `send_at` em silêncio (`kit-client.ts`).
 *
 * @pure
 */
export function verifyClaudeSemanalReread(
  reread: { subscriber_filter?: unknown; status?: string; send_at?: string | null; public?: unknown },
  expectedTagId: number,
): AudienceVerification {
  const filter = verifyAudienceFilter(reread.subscriber_filter, buildTagFilter(expectedTagId));
  if (filter.verified !== true) return filter;
  if (reread.status !== "scheduled" || typeof reread.send_at !== "string" || Number.isNaN(Date.parse(reread.send_at))) {
    return {
      verified: null,
      reason: `a releitura não mostra o broadcast agendado (status ${String(reread.status)}, send_at ${String(reread.send_at)}).`,
    };
  }
  if (reread.public === true) {
    return { verified: false, reason: "a releitura mostra o broadcast PÚBLICO (public: true) — o pedido foi public: false." };
  }
  return { verified: true };
}

export interface ClaudeSemanalDeps {
  writeFile: (path: string, contents: string) => void;
  removeFile: (path: string) => void;
  acquireLock: (path: string) => () => void;
  findTagId: (name: string, config?: KitConfig) => Promise<number | null>;
  countTagMembers: (tagId: number, config?: KitConfig) => Promise<number>;
  createBroadcast: (input: CreateBroadcastInput, config?: KitConfig) => Promise<{ id: number }>;
  getBroadcast: (
    id: number,
    config?: KitConfig,
  ) => Promise<{ subscriber_filter?: unknown; status?: string; send_at?: string | null; public?: unknown }>;
  deleteBroadcast: (id: number, config?: KitConfig) => Promise<void>;
  resolveKitConfig: () => ReturnType<typeof resolveKitConfig>;
  sleep: (ms: number) => Promise<void>;
}

function acquireExclusiveLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    throw new ClaudeSemanalIncidentError(
      `outro envio do Claude na semana está em andamento ou morreu no meio (lock ${lockPath}). Se nenhum está ` +
        "rodando, confira Broadcasts no Kit (um broadcast desta semana pode ter sido criado) e só então apague o arquivo.",
    );
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  return () => rmSync(lockPath, { force: true });
}

const defaultDeps: ClaudeSemanalDeps = {
  writeFile: (p, c) => writeFileAtomic(p, c),
  removeFile: (p) => rmSync(p, { force: true }),
  acquireLock: acquireExclusiveLock,
  findTagId: findTagIdByName,
  countTagMembers: countKitTagMembers,
  createBroadcast,
  getBroadcast,
  deleteBroadcast,
  resolveKitConfig,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface ClaudeSemanalRunOptions {
  rootDir: string;
  dataRoot: string;
  week: string;
  mode: { kind: "dry-run"; checkAudience: boolean } | { kind: "send"; force: boolean };
  log: (msg: string) => void;
  now?: () => Date;
  deps?: Partial<ClaudeSemanalDeps>;
}

export type ClaudeSemanalResult =
  | {
      kind: "dry-run";
      previewHtmlPath: string;
      previewTextPath: string;
      subject: string;
      itemCount: number;
      sendAt: string;
      late: boolean;
      audienceTag: string;
      /** Só com `--check-audience`: membros da tag lidos no Kit. */
      audienceMemberCount?: number;
      problems: string[];
    }
  | { kind: "enviado"; record: ClaudeSemanalSent }
  | { kind: "ja-enviado"; record: ClaudeSemanalSent };

async function resolveAudience(
  rawTag: unknown,
  niveis: Parameters<typeof resolveVerifiedAudience>[4],
  deps: ClaudeSemanalDeps,
  kitConfig: KitConfig,
): Promise<ResolvedAudience> {
  let r: Awaited<ReturnType<typeof resolveVerifiedAudience>>;
  try {
    r = await resolveVerifiedAudience(
      rawTag,
      `${CLAUDE_SEMANAL_CONFIG_KEY}.audience_tag`,
      CLAUDE_SEMANAL_TAG_SYNC_COMMAND,
      async (name) => {
        const tagId = await deps.findTagId(name, kitConfig);
        return { tagId, memberCount: tagId === null ? 0 : await deps.countTagMembers(tagId, kitConfig) };
      },
      niveis,
    );
  } catch (e) {
    throw new ClaudeSemanalGuardError(`não foi possível conferir a audiência no Kit (${(e as Error).message}).`);
  }
  if (!r.ok) throw new ClaudeSemanalGuardError(r.reason);
  return r.audience;
}

/**
 * Devolve o resultado; lança `ClaudeSemanalGuardError` (nada criado nesta
 * execução) ou `ClaudeSemanalIncidentError` (um broadcast pode existir no Kit).
 */
export async function runClaudeSemanal(options: ClaudeSemanalRunOptions): Promise<ClaudeSemanalResult> {
  const { rootDir, dataRoot, mode, log } = options;
  const deps: ClaudeSemanalDeps = { ...defaultDeps, ...options.deps };
  const now = options.now ?? (() => new Date());

  const { config, raw } = loadClaudeSemanalConfig(rootDir);
  const week = resolveClaudeSemanalWeek(options.week, config.sendWeekday);
  const paths = claudeSemanalPaths(dataRoot, week.week);

  if (mode.kind === "send" && !mode.force) {
    const prior = readClaudeSemanalRecord(paths.publishedPath);
    if (prior.kind === "sent") {
      log(`semana ${week.week} já enviada (broadcast ${prior.record.broadcastId}, ${formatBrt(prior.record.sendAt)}) — nada a fazer.`);
      return { kind: "ja-enviado", record: prior.record };
    }
  }

  if (!existsSync(paths.draftPath)) {
    throw new ClaudeSemanalGuardError(`rascunho da semana ${week.week} não existe (${paths.draftPath}) — rode /diaria-claude-semanal antes.`);
  }
  let draftRaw: unknown;
  try {
    draftRaw = JSON.parse(readFileSync(paths.draftPath, "utf8"));
  } catch (e) {
    throw new ClaudeSemanalGuardError(`${paths.draftPath} não é JSON válido: ${(e as Error).message}`);
  }
  const draft = parseClaudeSemanalDraft(draftRaw, week.week);
  const { sent, unreadable } = loadClaudeSemanalSent(dataRoot, week.week);
  if (unreadable.length > 0) log(`AVISO: registro de envio ilegível nas semanas ${unreadable.join(", ")} — o dedup não os considera.`);
  const problems = claudeSemanalDraftProblems(draft, { minItems: config.minItems, maxItems: config.maxItems, sent });
  const email = renderClaudeSemanalEmail(draft, week, { previewText: config.previewText, footerNote: config.footerNote });
  const { sendAt, late } = resolveClaudeSemanalSendAt(week.week, config.sendTimeBrt, now());

  if (mode.kind === "dry-run") {
    deps.writeFile(paths.previewHtmlPath, email.html);
    deps.writeFile(paths.previewTextPath, email.text);
    let audienceMemberCount: number | undefined;
    if (mode.checkAudience) {
      const kit = deps.resolveKitConfig();
      if (!kit.ok) throw new ClaudeSemanalGuardError(kit.reason);
      const audience = await resolveAudience(raw.audience_tag, config.audienceNiveis, deps, kit.config);
      audienceMemberCount = audience.memberCount;
      log(`[DRY RUN] audiência: tag "${audience.tagName}" id=${audience.tagId}, ${audience.memberCount} membro(s).`);
    }
    log(`[DRY RUN] assunto: ${email.subject}`);
    log(`[DRY RUN] ${draftItems(draft).length} item(ns) · prévia em ${paths.previewHtmlPath}`);
    log(
      `[DRY RUN] broadcast que SERIA criado: tag "${config.audienceTag}", envio ${formatBrt(sendAt)}${late ? " (horário configurado já passou: agendado para daqui a pouco)" : ""}, public: false.`,
    );
    for (const p of problems) log(`[DRY RUN] o envio seria RECUSADO: ${p}`);
    return {
      kind: "dry-run",
      previewHtmlPath: paths.previewHtmlPath,
      previewTextPath: paths.previewTextPath,
      subject: email.subject,
      itemCount: draftItems(draft).length,
      sendAt,
      late,
      audienceTag: config.audienceTag,
      ...(audienceMemberCount !== undefined ? { audienceMemberCount } : {}),
      problems,
    };
  }

  if (problems.length > 0) {
    throw new ClaudeSemanalGuardError(
      `rascunho da semana ${week.week} não pode sair:\n` + problems.map((p) => `  - ${p}`).join("\n"),
    );
  }

  const release = deps.acquireLock(paths.lockPath);
  try {
    return await sendLocked({
      paths,
      week: week.week,
      email,
      items: draftItems(draft).map(({ url, title, section }) => ({ url, title, section })),
      rawTag: raw.audience_tag,
      niveis: config.audienceNiveis,
      sendAt,
      late,
      force: mode.force,
      deps,
      log,
      now,
    });
  } finally {
    release();
  }
}

interface SendArgs {
  paths: ClaudeSemanalPaths;
  week: string;
  email: RenderedClaudeSemanalEmail;
  items: ClaudeSemanalSentItem[];
  rawTag: unknown;
  niveis: Parameters<typeof resolveVerifiedAudience>[4];
  sendAt: string;
  late: boolean;
  force: boolean;
  deps: ClaudeSemanalDeps;
  log: (m: string) => void;
  now: () => Date;
}

async function sendLocked(a: SendArgs): Promise<ClaudeSemanalResult> {
  const { paths, week, deps, log, now } = a;
  const prior = readClaudeSemanalRecord(paths.publishedPath);
  if (prior.kind === "sent" && !a.force) {
    log(`semana ${week} já enviada (broadcast ${prior.record.broadcastId}) — nada a fazer.`);
    return { kind: "ja-enviado", record: prior.record };
  }
  if (prior.kind === "ambiguous" && !a.force) {
    throw new ClaudeSemanalIncidentError(
      `estado ambíguo do e-mail da semana ${week}: ${prior.reason}. Confira no Kit (Broadcasts → Scheduled e Sent, ` +
        `descrição "${buildClaudeSemanalDescription(week)}") e só então rode com --force (que cria um broadcast NOVO: ` +
        "se o anterior saiu, a audiência recebe duas vezes).",
    );
  }
  if (prior.kind !== "none") log(`AVISO: --force passando por cima do registro anterior (${prior.kind}).`);
  const priorRaw = prior.kind === "none" ? null : readFileSync(paths.publishedPath, "utf8");

  const kitConfigResult = deps.resolveKitConfig();
  if (!kitConfigResult.ok) throw new ClaudeSemanalGuardError(kitConfigResult.reason);
  const kitConfig = kitConfigResult.config;
  const audience = await resolveAudience(a.rawTag, a.niveis, deps, kitConfig);

  const writeRecord = (r: ClaudeSemanalRecord) => deps.writeFile(paths.publishedPath, JSON.stringify(r, null, 2) + "\n");
  try {
    writeRecord({ status: "pending", week, attemptedAt: now().toISOString(), previous: priorRaw ?? undefined });
  } catch (e) {
    throw new ClaudeSemanalGuardError(
      `não foi possível gravar o registro antes do envio (${(e as Error).message}) — sem ele não há proteção contra ` +
        "envio duplicado, então nada foi enviado.",
    );
  }

  let created: { id: number };
  try {
    created = await deps.createBroadcast(buildClaudeSemanalBroadcastInput(a.email, week, audience, a.sendAt), kitConfig);
  } catch (e) {
    throw new ClaudeSemanalIncidentError(
      `o pedido de criação do broadcast falhou (${(e as Error).message}), mas o Kit PODE tê-lo aceitado. Confira AGORA ` +
        `em Broadcasts → Scheduled um broadcast com a descrição "${buildClaudeSemanalDescription(week)}" (sairia ` +
        `${formatBrt(a.sendAt)}): se existir e a audiência não for a tag "${audience.tagName}", cancele. Reexecutar ` +
        "exige --force e só depois dessa conferência.",
    );
  }
  log(
    `broadcast criado: id=${created.id}, envio ${formatBrt(a.sendAt)}, audiência = tag "${audience.tagName}" ` +
      `id=${audience.tagId} (${audience.memberCount} membro(s)), public: false.`,
  );

  let verification: AudienceVerification = { verified: null, reason: "releitura não tentada." };
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      verification = verifyClaudeSemanalReread(await deps.getBroadcast(created.id, kitConfig), audience.tagId);
      break;
    } catch (e) {
      verification = { verified: null, reason: `a releitura do broadcast falhou em ${tentativa} tentativa(s) (${(e as Error).message}).` };
      if (tentativa === 1) await deps.sleep(REREAD_RETRY_MS);
    }
  }
  if (verification.verified !== true) {
    await cancelUnverified(a, created.id, verification, kitConfig, writeRecord, priorRaw);
  }

  const record: ClaudeSemanalSent = {
    status: "sent",
    week,
    broadcastId: created.id,
    subject: a.email.subject,
    sendAt: a.sendAt,
    late: a.late,
    audienceTag: audience.tagName,
    audienceTagId: audience.tagId,
    audienceMemberCount: audience.memberCount,
    audienceVerification: toPersistedVerification(verification),
    items: a.items,
    createdAt: now().toISOString(),
  };
  try {
    writeRecord(record);
  } catch (e) {
    throw new ClaudeSemanalIncidentError(
      `o broadcast Kit id=${created.id} FOI CRIADO e conferido (envio ${formatBrt(a.sendAt)}), mas o registro final ` +
        `não foi gravado (${(e as Error).message}). O e-mail VAI sair; não reexecute. Sem o registro, o dedup da ` +
        "próxima semana não conhece estes itens: confira a prévia com atenção.",
      created.id,
    );
  }
  return { kind: "enviado", record };
}

/** Audiência não confirmada: apaga o broadcast e confere a exclusão (404). Sempre lança. */
async function cancelUnverified(
  a: SendArgs,
  broadcastId: number,
  verification: Exclude<AudienceVerification, { verified: true }>,
  kitConfig: KitConfig,
  writeRecord: (r: ClaudeSemanalRecord) => void,
  priorRaw: string | null,
): Promise<never> {
  const { deps, paths, week, now } = a;
  const label = verification.verified === false ? "NÃO CONFERE" : "NÃO CONFIRMADA";
  let cancelError: string | null = null;
  try {
    await deps.deleteBroadcast(broadcastId, kitConfig);
    try {
      await deps.getBroadcast(broadcastId, kitConfig);
      cancelError = "o DELETE respondeu ok, mas o broadcast continua existindo na releitura";
    } catch (e) {
      if (!(e instanceof KitApiError && e.status === 404)) {
        cancelError = `o DELETE respondeu ok, mas a exclusão não pôde ser conferida (${(e as Error).message})`;
      }
    }
  } catch (e) {
    cancelError = `o DELETE falhou (${(e as Error).message})`;
  }

  if (cancelError === null) {
    try {
      if (priorRaw === null) deps.removeFile(paths.publishedPath);
      else deps.writeFile(paths.publishedPath, priorRaw);
    } catch {
      // Sobra um `pending`: a próxima execução pede --force, o que é seguro (o broadcast foi apagado).
    }
    throw new ClaudeSemanalIncidentError(
      `AUDIÊNCIA ${label}: ${verification.reason} O broadcast Kit id=${broadcastId} foi CANCELADO (exclusão ` +
        "conferida) antes do envio — nada saiu. Confira a tag no Kit e rode de novo.",
      broadcastId,
      true,
    );
  }

  let recordError = "";
  try {
    writeRecord({ status: "cancel-failed", week, broadcastId, sendAt: a.sendAt, reason: cancelError, at: now().toISOString(), previous: priorRaw ?? undefined });
  } catch (e) {
    recordError = ` O registro da semana também não foi gravado (${(e as Error).message}).`;
  }
  throw new ClaudeSemanalIncidentError(
    `AUDIÊNCIA ${label}: ${verification.reason} O broadcast Kit id=${broadcastId} está AGENDADO para ` +
      `${formatBrt(a.sendAt)} e o cancelamento automático não se confirmou: ${cancelError}. Cancele AGORA no painel ` +
      "do Kit (Broadcasts → Scheduled): no pior caso ele mira a base INTEIRA." +
      recordError,
    broadcastId,
  );
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const week = getStringArg(argv, "week", { example: "261129" });
  if (!week) {
    process.stderr.write(
      "Uso: npx tsx scripts/publish-claude-semanal-kit.ts --week AAMMDD [--check-audience | --send [--force]] [--data-root dir]\n",
    );
    process.exit(2);
  }
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
  try {
    const res = await runClaudeSemanal({
      rootDir: ROOT,
      dataRoot: resolve(getStringArg(argv, "data-root") ?? ROOT),
      week,
      mode: hasFlag(argv, "send")
        ? { kind: "send", force: hasFlag(argv, "force") }
        : { kind: "dry-run", checkAudience: hasFlag(argv, "check-audience") },
      log,
    });
    console.log(JSON.stringify(res));
  } catch (e) {
    log((e as Error).message);
    process.exit(e instanceof ClaudeSemanalGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

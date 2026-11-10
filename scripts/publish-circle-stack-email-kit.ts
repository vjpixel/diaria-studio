#!/usr/bin/env node
/**
 * scripts/publish-circle-stack-email-kit.ts (#12538)
 *
 * Canal e-mail do post semanal da Stack: envia pelo Kit, aos apoiadores Núcleo
 * (tag `kit_stack.audience_tag`), o mesmo post do ciclo que vai ao Radar de
 * Notícias Stack — lido da seleção do ciclo
 * (`data/weekly/{cycle}/_internal/circle-stack-selection.json`), render em
 * `lib/circle-stack-email-render.ts`.
 *
 * Quem chama:
 *   - a task de segunda 06:00 (`publish-circle-stack-scheduled.ts`), logo
 *     depois do envio ao Circle e SÓ com o ciclo aprovado no `/diaria-stack`;
 *   - o Passo 7 do `/diaria-stack` (`--publish`, envio na hora), depois da
 *     confirmação do editor.
 *
 * Sem `--send` é dry-run: renderiza, grava a prévia HTML em
 * `_internal/circle-stack-email-preview.html`, lista o que impediria o envio e
 * não chama o Kit.
 *
 * ## Conteúdo: as mesmas travas do Circle
 *
 * Antes de criar o broadcast, recusa o que o publicador do Circle recusaria:
 * `circle_stack.enabled = false` (desliga os DOIS canais), link fora das regras
 * do canal e título sem sinal de português não revisado. Sem isso o `--publish`
 * mandaria aos apoiadores um conteúdo que o Circle acabou de barrar.
 *
 * ## Envio
 *
 * Cria o broadcast já AGENDADO para daqui a `STACK_EMAIL_SEND_DELAY_MIN`
 * minutos (o Kit exige `send_at` no futuro; é o "enviar agora" da API). Nesse
 * intervalo o envio ainda é cancelável no painel do Kit. `public: false`: o
 * post é recompensa de apoio, sem página pública no Kit.
 *
 * ## Guards
 *
 *   - tag configurada, existente e não-vazia (`resolveVerifiedAudience`) —
 *     filtro não resolvido no Kit é a BASE INTEIRA (#6126);
 *   - releitura do broadcast: filtro igual ao enviado (#6582) E agendado
 *     (`status: scheduled` com `send_at`). Sem as duas confirmações, o
 *     broadcast é apagado e a exclusão é conferida por uma 2ª leitura (404);
 *   - lock `wx` por ciclo contra dois `--send` simultâneos;
 *   - registro por ciclo (`_internal/circle-stack-email-published.json`),
 *     gravado como `pending` ANTES do POST. Um registro que não seja `sent`
 *     (pendente, cancelamento falho, ilegível) é estado ambíguo: recusa até
 *     alguém conferir o Kit e passar `--force`. `sent` = já enviado, nada a
 *     fazer (resultado `ja-enviado`, não erro). O registro só é apagado quando
 *     o cancelamento automático foi confirmado.
 *
 * Erros: `StackEmailGuardError` = nada foi criado nem pode estar pendente (corrigir e
 * rodar de novo); `StackEmailIncidentError` = um broadcast PODE existir no Kit
 * (conferir antes de qualquer reexecução).
 *
 * Exit codes: 0 ok/já enviado · 1 incidente ou erro · 2 guard.
 *
 * Uso:
 *   npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday 261116            # dry-run
 *   npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday 261116 --send
 *   npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday 261116 --send --force
 *   (opcional: --data-root <dir>)
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import { resolveWeeklyLinkedinCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { resolveVerifiedAudience, type ResolvedAudience } from "./lib/shared/kit-apoio-tag.ts";
import { circleStackSelectionViolations, circleStackUnreviewedTitles } from "./lib/circle-stack-select.ts";
import {
  STACK_EMAIL_NIVEIS,
  STACK_EMAIL_TAG_SYNC_COMMAND,
  StackEmailGuardError,
  StackEmailIncidentError,
  readPlatformConfig,
  resolveStackEmailTagName,
} from "./lib/circle-stack-email-channel.ts";
import { formatStackEmailBrt, renderStackEmail, type RenderedStackEmail } from "./lib/circle-stack-email-render.ts";
import {
  toPersistedVerification,
  verifyAudienceFilter,
  type AudienceVerification,
  type PersistedAudienceVerification,
} from "./publish-artigo-especial-kit.ts";
import { parseStoredCircleStackSelection, resolveCircleStackConfig } from "./publish-circle-stack.ts";
import type { CircleStackSelection } from "./lib/circle-stack-render.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[publish-circle-stack-email-kit]";

/** Minutos entre a criação e o `send_at` — o "enviar agora" do Kit. */
export const STACK_EMAIL_SEND_DELAY_MIN = 5;
/** Espera entre as duas tentativas de releitura do broadcast. */
const REREAD_RETRY_MS = 2_000;

const PUBLISHED_FILE = "circle-stack-email-published.json";
const PREVIEW_FILE = "circle-stack-email-preview.html";
const LOCK_FILE = "circle-stack-email.lock";

/** Registro de um envio confirmado (filtro e agendamento conferidos na releitura). */
export interface StackEmailSent {
  status: "sent";
  cycle: string;
  broadcastId: number;
  subject: string;
  sendAt: string;
  audienceTag: string;
  audienceTagId: number;
  audienceMemberCount: number;
  audienceVerification: PersistedAudienceVerification;
  createdAt: string;
}

/** O que o arquivo de registro pode conter. Tudo que não é `sent` é ambíguo. */
type StackEmailRecord =
  | StackEmailSent
  | { status: "pending"; cycle: string; attemptedAt: string; previous?: string }
  | {
      status: "cancel-failed";
      cycle: string;
      broadcastId: number;
      sendAt: string;
      reason: string;
      at: string;
      previous?: string;
    };
// `previous`: conteúdo do registro que o --force sobrescreveu, guardado para
// não perder a evidência de um envio anterior quando este falha no meio.

type RecordRead = { kind: "none" } | { kind: "sent"; record: StackEmailSent } | { kind: "ambiguous"; reason: string };

export interface StackEmailPaths {
  cycle: string;
  selectionPath: string;
  publishedPath: string;
  previewPath: string;
  lockPath: string;
}

export function resolveStackEmailPaths(dataRoot: string, publishMonday: string): StackEmailPaths {
  const r = resolveWeeklyLinkedinCycle(publishMonday);
  if (!r) throw new StackEmailGuardError(`--publish-monday inválido: ${publishMonday} (esperado AAMMDD)`);
  const internal = join(dataRoot, weeklyLinkedinRelDir(r.cycle), "_internal");
  return {
    cycle: r.cycle,
    selectionPath: join(internal, "circle-stack-selection.json"),
    publishedPath: join(internal, PUBLISHED_FILE),
    previewPath: join(internal, PREVIEW_FILE),
    lockPath: join(internal, LOCK_FILE),
  };
}

/**
 * Lê o registro do ciclo. Ao contrário do Artigo Especial, arquivo existente
 * mas ilegível NUNCA vira "nunca enviado": aqui o efeito do erro é mandar o
 * e-mail duas vezes, então o ambíguo bloqueia.
 */
export function readStackEmailRecord(path: string): RecordRead {
  if (!existsSync(path)) return { kind: "none" };
  let parsed: Partial<StackEmailRecord> & Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { kind: "ambiguous", reason: `${path} existe mas está ilegível (${(e as Error).message})` };
  }
  if (
    parsed?.status === "sent" &&
    typeof parsed.broadcastId === "number" &&
    typeof parsed.sendAt === "string" &&
    typeof parsed.cycle === "string"
  ) {
    return { kind: "sent", record: parsed as StackEmailSent };
  }
  if (parsed?.status === "pending") {
    return {
      kind: "ambiguous",
      reason:
        `uma tentativa anterior (${String(parsed.attemptedAt)}) parou entre o pedido ao Kit e a confirmação — ` +
        "o broadcast pode ter sido criado",
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

/** Pura: nome interno do broadcast no painel do Kit (único por ciclo, serve pra achar órfão). */
export function buildStackEmailDescription(cycle: string): string {
  return `diar.ia.br Stack — ${cycle} (apoio Núcleo)`;
}

/**
 * Pura: payload de `POST /v4/broadcasts`. Exige `ResolvedAudience` (só
 * `resolveVerifiedAudience` produz uma), nunca um id cru.
 *
 * @pure
 */
export function buildStackEmailBroadcastInput(
  email: RenderedStackEmail,
  cycle: string,
  audience: ResolvedAudience,
  sendAt: string,
): CreateBroadcastInput {
  return {
    subject: email.subject,
    content: email.html,
    preview_text: email.previewText,
    description: buildStackEmailDescription(cycle),
    send_at: sendAt,
    subscriber_filter: buildTagFilter(audience.tagId),
    public: false,
  };
}

/**
 * Pura: confere a releitura — filtro igual ao enviado E broadcast agendado.
 * Kit já foi visto zerando `send_at` em silêncio (`kit-client.ts`); filtro
 * certo num rascunho reportaria "agendado" para um e-mail que nunca sai.
 *
 * @pure
 */
export function verifyStackEmailReread(
  reread: { subscriber_filter?: unknown; status?: string; send_at?: string | null },
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
  return { verified: true };
}

/** Pura: problemas de conteúdo que o Circle também recusaria. */
export function stackEmailContentProblems(
  selection: Parameters<typeof circleStackSelectionViolations>[0],
  platformConfig: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  if (!resolveCircleStackConfig(platformConfig).enabled) {
    out.push("circle_stack.enabled = false — o post semanal da Stack está desligado no config (vale para o e-mail também)");
  }
  out.push(...circleStackSelectionViolations(selection), ...circleStackUnreviewedTitles(selection));
  return out;
}

export interface StackEmailDeps {
  writeFile: (path: string, contents: string) => void;
  removeFile: (path: string) => void;
  /** Cria o lock exclusivo; lança se já existe. Devolve o release. */
  acquireLock: (path: string) => () => void;
  findTagId: (name: string, config?: KitConfig) => Promise<number | null>;
  countTagMembers: (tagId: number, config?: KitConfig) => Promise<number>;
  createBroadcast: (input: CreateBroadcastInput, config?: KitConfig) => Promise<{ id: number }>;
  getBroadcast: (
    id: number,
    config?: KitConfig,
  ) => Promise<{ subscriber_filter?: unknown; status?: string; send_at?: string | null }>;
  deleteBroadcast: (id: number, config?: KitConfig) => Promise<void>;
  resolveKitConfig: () => ReturnType<typeof resolveKitConfig>;
  sleep: (ms: number) => Promise<void>;
}

/** Lock `wx`: dois `--send` do mesmo ciclo ao mesmo tempo nunca passam juntos pelo guard. */
function acquireExclusiveLock(lockPath: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Incidente, não guard: um lock que sobrou é de um envio que morreu no
    // meio, e esse envio pode ter criado o broadcast.
    throw new StackEmailIncidentError(
      `outro envio do e-mail da Stack está em andamento ou morreu no meio (lock ${lockPath}). Se nenhum está ` +
        "rodando, confira Broadcasts no Kit (um broadcast deste ciclo pode ter sido criado) e só então apague o arquivo.",
    );
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } finally {
    closeSync(fd);
  }
  return () => rmSync(lockPath, { force: true });
}

const defaultDeps: StackEmailDeps = {
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

export interface StackEmailRunOptions {
  rootDir: string;
  dataRoot: string;
  publishMonday: string;
  /** `dry-run` nunca chama o Kit; `send` cria o broadcast (`force` passa por cima do registro). */
  mode: { kind: "dry-run" } | { kind: "send"; force: boolean };
  log: (msg: string) => void;
  now?: () => Date;
  deps?: Partial<StackEmailDeps>;
}

export type StackEmailResult =
  | { kind: "dry-run"; previewPath: string; subject: string; problems: string[] }
  | { kind: "enviado"; record: StackEmailSent }
  | { kind: "ja-enviado"; record: StackEmailSent };

/**
 * Devolve o resultado; lança `StackEmailGuardError` (nada criado nesta
 * execução) ou `StackEmailIncidentError` (um broadcast pode existir no Kit).
 */
export async function runCircleStackEmail(options: StackEmailRunOptions): Promise<StackEmailResult> {
  const { rootDir, dataRoot, publishMonday, mode, log } = options;
  const deps: StackEmailDeps = { ...defaultDeps, ...options.deps };
  const now = options.now ?? (() => new Date());

  const platformConfig = readPlatformConfig(rootDir);
  const tagNameResolution = resolveStackEmailTagName(platformConfig.kit_stack);
  if (!tagNameResolution.ok) throw new StackEmailGuardError(tagNameResolution.reason);

  const paths = resolveStackEmailPaths(dataRoot, publishMonday);
  if (!existsSync(paths.selectionPath)) {
    throw new StackEmailGuardError(
      `seleção do ciclo ${paths.cycle} não existe (${paths.selectionPath}) — rode /diaria-stack antes.`,
    );
  }
  let selection: CircleStackSelection;
  try {
    ({ selection } = parseStoredCircleStackSelection(readFileSync(paths.selectionPath, "utf8"), paths.selectionPath, paths.cycle));
  } catch (e) {
    throw new StackEmailGuardError((e as Error).message);
  }

  // Ciclo já enviado responde "já enviado" antes das travas de conteúdo: a
  // seleção editada (ou o canal desligado) depois do envio não pode fazer o
  // aviso dizer que o e-mail "não saiu". O lock reconfere em `sendLocked`.
  if (mode.kind === "send" && !mode.force) {
    const prior = readStackEmailRecord(paths.publishedPath);
    if (prior.kind === "sent") {
      log(`ciclo ${paths.cycle} já enviado (broadcast ${prior.record.broadcastId}, ${formatStackEmailBrt(prior.record.sendAt)}) — nada a fazer.`);
      return { kind: "ja-enviado", record: prior.record };
    }
  }

  const problems = stackEmailContentProblems(selection, platformConfig as Record<string, unknown>);
  const email = renderStackEmail(selection);

  if (mode.kind === "dry-run") {
    deps.writeFile(paths.previewPath, email.html);
    log(`[DRY RUN] assunto: ${email.subject}`);
    log(`[DRY RUN] ${email.html.length} bytes de HTML · prévia em ${paths.previewPath}`);
    log(`[DRY RUN] broadcast que SERIA criado: tag "${tagNameResolution.tagName}", envio em ${STACK_EMAIL_SEND_DELAY_MIN} min, public: false.`);
    for (const p of problems) log(`[DRY RUN] o envio seria RECUSADO: ${p}`);
    return { kind: "dry-run", previewPath: paths.previewPath, subject: email.subject, problems };
  }

  if (problems.length > 0) {
    throw new StackEmailGuardError(
      `seleção do ciclo ${paths.cycle} não pode sair (as mesmas travas do Circle):\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }

  const release = deps.acquireLock(paths.lockPath);
  try {
    return await sendLocked(paths, email, tagNameResolution.tagName, platformConfig.kit_stack?.audience_tag, mode.force, deps, log, now);
  } finally {
    release();
  }
}

async function sendLocked(
  paths: StackEmailPaths,
  email: RenderedStackEmail,
  tagName: string,
  rawTag: unknown,
  force: boolean,
  deps: StackEmailDeps,
  log: (m: string) => void,
  now: () => Date,
): Promise<StackEmailResult> {
  const prior = readStackEmailRecord(paths.publishedPath);
  if (prior.kind === "sent" && !force) {
    log(
      `ciclo ${paths.cycle} já enviado (broadcast ${prior.record.broadcastId}, ${formatStackEmailBrt(prior.record.sendAt)}) — nada a fazer.`,
    );
    return { kind: "ja-enviado", record: prior.record };
  }
  if (prior.kind === "ambiguous" && !force) {
    // Incidente, não guard: o registro ambíguo é justamente um broadcast que
    // PODE estar agendado ou ter saído — "nada saiu" seria a leitura errada.
    throw new StackEmailIncidentError(
      `estado ambíguo do e-mail do ciclo ${paths.cycle}: ${prior.reason}. Confira no Kit (Broadcasts → Scheduled ` +
        `e Sent, descrição "${buildStackEmailDescription(paths.cycle)}") e só então rode com --force (que cria um ` +
        "broadcast NOVO: se o anterior saiu, os apoiadores recebem duas vezes).",
    );
  }
  if (prior.kind !== "none") log(`AVISO: --force passando por cima do registro anterior (${prior.kind}).`);
  // Conteúdo anterior, para devolvê-lo se este envio for cancelado: o --force
  // por cima de um `sent` não pode apagar o registro do envio que já saiu.
  const priorRaw = prior.kind === "none" ? null : readFileSync(paths.publishedPath, "utf8");

  const kitConfigResult = deps.resolveKitConfig();
  if (!kitConfigResult.ok) throw new StackEmailGuardError(kitConfigResult.reason);
  const kitConfig = kitConfigResult.config;

  let audienceResolution: Awaited<ReturnType<typeof resolveVerifiedAudience>>;
  try {
    audienceResolution = await resolveVerifiedAudience(
      rawTag,
      "kit_stack.audience_tag",
      STACK_EMAIL_TAG_SYNC_COMMAND,
      async (name) => {
        const tagId = await deps.findTagId(name, kitConfig);
        return { tagId, memberCount: tagId === null ? 0 : await deps.countTagMembers(tagId, kitConfig) };
      },
      STACK_EMAIL_NIVEIS,
    );
  } catch (e) {
    // Erro de leitura da tag (Kit fora, rede): nada foi criado.
    throw new StackEmailGuardError(`não foi possível conferir a audiência no Kit (${(e as Error).message}).`);
  }
  if (!audienceResolution.ok) throw new StackEmailGuardError(audienceResolution.reason);
  const audience = audienceResolution.audience;

  // Registro ANTES do POST: se o processo morrer ou o POST falhar depois de o
  // Kit aceitar, a próxima execução cai no estado ambíguo em vez de duplicar.
  const writeRecord = (r: StackEmailRecord) => deps.writeFile(paths.publishedPath, JSON.stringify(r, null, 2) + "\n");
  try {
    writeRecord({ status: "pending", cycle: paths.cycle, attemptedAt: now().toISOString(), previous: priorRaw ?? undefined });
  } catch (e) {
    throw new StackEmailGuardError(
      `não foi possível gravar o registro antes do envio (${(e as Error).message}) — sem ele não há proteção contra ` +
        "envio duplicado, então nada foi enviado.",
    );
  }

  const sendAt = new Date(now().getTime() + STACK_EMAIL_SEND_DELAY_MIN * 60_000).toISOString();
  let created: { id: number };
  try {
    created = await deps.createBroadcast(buildStackEmailBroadcastInput(email, paths.cycle, audience, sendAt), kitConfig);
  } catch (e) {
    throw new StackEmailIncidentError(
      `o pedido de criação do broadcast falhou (${(e as Error).message}), mas o Kit PODE tê-lo aceitado. Confira ` +
        `AGORA em Broadcasts → Scheduled um broadcast com a descrição "${buildStackEmailDescription(paths.cycle)}" ` +
        `(sairia ${formatStackEmailBrt(sendAt)}): se existir e a audiência não for a tag "${audience.tagName}", ` +
        "cancele. Reexecutar exige --force e só depois dessa conferência.",
    );
  }
  log(
    `broadcast criado: id=${created.id}, envio ${formatStackEmailBrt(sendAt)}, audiência = tag "${audience.tagName}" ` +
      `id=${audience.tagId} (${audience.memberCount} membro(s)).`,
  );

  let verification: AudienceVerification = { verified: null, reason: "releitura não tentada." };
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      verification = verifyStackEmailReread(await deps.getBroadcast(created.id, kitConfig), audience.tagId);
      break;
    } catch (e) {
      verification = {
        verified: null,
        reason: `a releitura do broadcast falhou em ${tentativa} tentativa(s) (${(e as Error).message}).`,
      };
      if (tentativa === 1) await deps.sleep(REREAD_RETRY_MS);
    }
  }

  if (verification.verified !== true) {
    await cancelUnverified(paths, created.id, sendAt, verification, deps, kitConfig, writeRecord, now, priorRaw);
  }

  const record: StackEmailSent = {
    status: "sent",
    cycle: paths.cycle,
    broadcastId: created.id,
    subject: email.subject,
    sendAt,
    audienceTag: audience.tagName,
    audienceTagId: audience.tagId,
    audienceMemberCount: audience.memberCount,
    audienceVerification: toPersistedVerification(verification),
    createdAt: now().toISOString(),
  };
  try {
    writeRecord(record);
  } catch (e) {
    // O `pending` continua no disco: a reexecução cai no estado ambíguo, não duplica.
    throw new StackEmailIncidentError(
      `o broadcast Kit id=${created.id} FOI CRIADO e conferido (envio ${formatStackEmailBrt(sendAt)}), mas o registro ` +
        `final não foi gravado (${(e as Error).message}). O e-mail VAI sair; não reexecute.`,
      created.id,
    );
  }
  return { kind: "enviado", record };
}

/**
 * Audiência não confirmada: o broadcast já está AGENDADO, então apaga e
 * confere a exclusão (404 na releitura — um 2xx do DELETE sozinho não prova
 * nada). Sempre lança.
 */
async function cancelUnverified(
  paths: StackEmailPaths,
  broadcastId: number,
  sendAt: string,
  verification: Exclude<AudienceVerification, { verified: true }>,
  deps: StackEmailDeps,
  kitConfig: KitConfig,
  writeRecord: (r: StackEmailRecord) => void,
  now: () => Date,
  priorRaw: string | null,
): Promise<never> {
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
    let priorStatus: unknown = null;
    try {
      priorStatus = priorRaw === null ? null : JSON.parse(priorRaw)?.status;
    } catch {
      priorStatus = "ilegível";
    }
    const rerun =
      priorRaw === null || priorStatus === "sent"
        ? "Confira a tag no Kit e rode de novo."
        : "O registro ambíguo anterior foi mantido: confira a tag e o Kit e rode de novo com --force.";
    throw new StackEmailIncidentError(
      `AUDIÊNCIA ${label}: ${verification.reason} O broadcast Kit id=${broadcastId} foi CANCELADO (exclusão ` +
        `conferida) antes do envio — este broadcast não saiu. ${rerun}`,
      broadcastId,
      true,
    );
  }

  let recordError = "";
  try {
    writeRecord({
      status: "cancel-failed",
      cycle: paths.cycle,
      broadcastId,
      sendAt,
      reason: cancelError,
      at: now().toISOString(),
      previous: priorRaw ?? undefined,
    });
  } catch (e) {
    recordError = ` O registro do ciclo também não foi gravado (${(e as Error).message}).`;
  }
  throw new StackEmailIncidentError(
    `AUDIÊNCIA ${label}: ${verification.reason} O broadcast Kit id=${broadcastId} está AGENDADO para ` +
      `${formatStackEmailBrt(sendAt)} e o cancelamento automático não se confirmou: ${cancelError}. Cancele AGORA no ` +
      "painel do Kit (Broadcasts → Scheduled): no pior caso ele mira a base INTEIRA." +
      recordError,
    broadcastId,
  );
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const publishMonday = getStringArg(argv, "publish-monday", { example: "261116" });
  if (!publishMonday) {
    process.stderr.write(
      "Uso: npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday AAMMDD [--send] [--force] [--data-root dir]\n",
    );
    process.exit(2);
  }
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
  try {
    const res = await runCircleStackEmail({
      rootDir: ROOT,
      dataRoot: resolve(getStringArg(argv, "data-root") ?? ROOT),
      publishMonday,
      mode: hasFlag(argv, "send") ? { kind: "send", force: hasFlag(argv, "force") } : { kind: "dry-run" },
      log,
    });
    console.log(JSON.stringify(res));
  } catch (e) {
    log((e as Error).message);
    process.exit(e instanceof StackEmailGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

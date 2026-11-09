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
 *     depois do envio ao Circle e SÓ com o ciclo aprovado no `/diaria-stack`
 *     (a aprovação, com o sha256 da seleção, é o gate — este script não a
 *     relê);
 *   - o Passo 7 do `/diaria-stack` (`--publish`, envio na hora), depois da
 *     confirmação do editor.
 *
 * Sem `--send` é dry-run: renderiza, grava a prévia HTML em
 * `_internal/circle-stack-email-preview.html` e não chama o Kit.
 *
 * ## Envio
 *
 * Cria o broadcast já AGENDADO para daqui a `STACK_EMAIL_SEND_DELAY_MIN`
 * minutos (o Kit exige `send_at` no futuro; é o "enviar agora" da API). Nesse
 * intervalo o envio ainda é cancelável no painel do Kit. `public: false`: o
 * post é recompensa de apoio, sem página pública no Kit.
 *
 * ## Guards (mesma disciplina de `publish-artigo-especial-kit.ts`)
 *
 *   - tag configurada, existente e não-vazia (`resolveVerifiedAudience`) —
 *     filtro não resolvido no Kit é a BASE INTEIRA (#6126);
 *   - releitura do broadcast conferindo o `subscriber_filter` (#6582);
 *   - idempotência: `_internal/circle-stack-email-published.json` guarda o
 *     `broadcastId`; havendo um, recusa criar outro sem `--force`. É gravado
 *     ANTES de qualquer decisão de abortar, para a reexecução cair no guard.
 *
 * Exit codes: 0 ok · 1 erro (inclusive audiência divergente/não confirmada) ·
 * 2 guard (config, audiência, idempotência, seleção).
 *
 * Uso:
 *   npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday 261116            # dry-run
 *   npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday 261116 --send
 *   npx tsx scripts/publish-circle-stack-email-kit.ts --publish-monday 261116 --send --force
 *   (opcional: --data-root <dir>)
 */
import { existsSync, readFileSync } from "node:fs";
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
import { getBroadcast } from "./lib/kit-client.ts";
import { resolveWeeklyLinkedinCycle, weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { resolveVerifiedAudience, type ResolvedAudience } from "./lib/shared/kit-apoio-tag.ts";
import {
  STACK_EMAIL_NIVEIS,
  STACK_EMAIL_TAG_SYNC_COMMAND,
  StackEmailGuardError,
  readPlatformConfig,
  resolveStackEmailTagName,
} from "./lib/circle-stack-email-channel.ts";
import { renderStackEmail, type RenderedStackEmail } from "./lib/circle-stack-email-render.ts";
import {
  toPersistedVerification,
  verifyAudienceFilter,
  type AudienceVerification,
  type PersistedAudienceVerification,
} from "./publish-artigo-especial-kit.ts";
import { parseStoredCircleStackSelection } from "./publish-circle-stack.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[publish-circle-stack-email-kit]";

/** Minutos entre a criação e o `send_at` — o "enviar agora" do Kit. */
export const STACK_EMAIL_SEND_DELAY_MIN = 5;

export const STACK_EMAIL_PUBLISHED_FILE = "circle-stack-email-published.json";
export const STACK_EMAIL_PREVIEW_FILE = "circle-stack-email-preview.html";

export interface StackEmailPublished {
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

export interface StackEmailPaths {
  cycle: string;
  selectionPath: string;
  publishedPath: string;
  previewPath: string;
}

export function resolveStackEmailPaths(dataRoot: string, publishMonday: string): StackEmailPaths {
  const r = resolveWeeklyLinkedinCycle(publishMonday);
  if (!r) throw new StackEmailGuardError(`--publish-monday inválido: ${publishMonday} (esperado AAMMDD)`);
  const internal = join(dataRoot, weeklyLinkedinRelDir(r.cycle), "_internal");
  return {
    cycle: r.cycle,
    selectionPath: join(internal, "circle-stack-selection.json"),
    publishedPath: join(internal, STACK_EMAIL_PUBLISHED_FILE),
    previewPath: join(internal, STACK_EMAIL_PREVIEW_FILE),
  };
}

/**
 * Detalhe gravado; ausente → `null`. Corrompido ou sem `broadcastId` também
 * `null`, mas com aviso: perder o id é perder o guard de duplicata.
 */
export function readStackEmailPublished(path: string, log: (m: string) => void): StackEmailPublished | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StackEmailPublished>;
    if (typeof parsed.broadcastId === "number") return parsed as StackEmailPublished;
    log(`AVISO: ${path} existe mas não tem broadcastId numérico — tratando como "nunca enviado". Confira Broadcasts no Kit.`);
  } catch (e) {
    log(`AVISO: ${path} ilegível (${(e as Error).message}) — tratando como "nunca enviado". Confira Broadcasts no Kit.`);
  }
  return null;
}

/** Pura: nome interno do broadcast no painel do Kit. */
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

export interface StackEmailDeps {
  writeFile: (path: string, contents: string) => void;
  findTagId: (name: string, config?: KitConfig) => Promise<number | null>;
  countTagMembers: (tagId: number, config?: KitConfig) => Promise<number>;
  createBroadcast: (input: CreateBroadcastInput, config?: KitConfig) => Promise<{ id: number }>;
  getBroadcast: (id: number, config?: KitConfig) => Promise<{ subscriber_filter?: unknown }>;
  deleteBroadcast: (id: number, config?: KitConfig) => Promise<void>;
  resolveKitConfig: () => ReturnType<typeof resolveKitConfig>;
}

const defaultDeps: StackEmailDeps = {
  writeFile: (p, c) => writeFileAtomic(p, c),
  findTagId: findTagIdByName,
  countTagMembers: countKitTagMembers,
  createBroadcast,
  deleteBroadcast,
  getBroadcast,
  resolveKitConfig,
};

export interface StackEmailRunOptions {
  rootDir: string;
  dataRoot: string;
  publishMonday: string;
  send: boolean;
  force: boolean;
  log: (msg: string) => void;
  now?: () => Date;
  deps?: StackEmailDeps;
}

export type StackEmailResult =
  | { kind: "dry-run"; previewPath: string; subject: string }
  | { kind: "enviado"; detail: StackEmailPublished };

/** Lança `StackEmailGuardError` (guard) ou `Error` (falha, inclusive com broadcast já criado). */
export async function runCircleStackEmail(options: StackEmailRunOptions): Promise<StackEmailResult> {
  const { rootDir, dataRoot, publishMonday, send, force, log } = options;
  const deps = options.deps ?? defaultDeps;
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
  const { selection } = parseStoredCircleStackSelection(
    readFileSync(paths.selectionPath, "utf8"),
    paths.selectionPath,
    paths.cycle,
  );
  const email = renderStackEmail(selection);

  if (!send) {
    deps.writeFile(paths.previewPath, email.html);
    log(`[DRY RUN] assunto: ${email.subject}`);
    log(`[DRY RUN] preview: ${email.previewText}`);
    log(`[DRY RUN] ${email.html.length} bytes de HTML · prévia em ${paths.previewPath}`);
    log(`[DRY RUN] broadcast que SERIA criado: tag "${tagNameResolution.tagName}", envio em ${STACK_EMAIL_SEND_DELAY_MIN} min, public: false.`);
    return { kind: "dry-run", previewPath: paths.previewPath, subject: email.subject };
  }

  const already = readStackEmailPublished(paths.publishedPath, log);
  if (already && !force) {
    throw new StackEmailGuardError(
      `o e-mail do ciclo ${paths.cycle} já foi criado (broadcast id=${already.broadcastId}, envio ${already.sendAt}) — ` +
        "recusando um 2º envio. Use --force só se for intencional (os apoiadores recebem de novo).",
    );
  }
  if (already && force) {
    log(`AVISO: --force ignorando idempotência — o broadcast anterior id=${already.broadcastId} não é tocado.`);
  }

  const kitConfigResult = deps.resolveKitConfig();
  if (!kitConfigResult.ok) throw new StackEmailGuardError(kitConfigResult.reason);
  const kitConfig = kitConfigResult.config;

  const audienceResolution = await resolveVerifiedAudience(
    platformConfig.kit_stack?.audience_tag,
    "kit_stack.audience_tag",
    STACK_EMAIL_TAG_SYNC_COMMAND,
    async (name) => {
      const tagId = await deps.findTagId(name, kitConfig);
      return { tagId, memberCount: tagId === null ? 0 : await deps.countTagMembers(tagId, kitConfig) };
    },
    STACK_EMAIL_NIVEIS,
  );
  if (!audienceResolution.ok) throw new StackEmailGuardError(audienceResolution.reason);
  const audience = audienceResolution.audience;

  const sendAt = new Date(now().getTime() + STACK_EMAIL_SEND_DELAY_MIN * 60_000).toISOString();
  const created = await deps.createBroadcast(
    buildStackEmailBroadcastInput(email, paths.cycle, audience, sendAt),
    kitConfig,
  );
  log(
    `broadcast criado: id=${created.id}, envio ${sendAt}, audiência = tag "${audience.tagName}" ` +
      `id=${audience.tagId} (${audience.memberCount} membro(s)).`,
  );

  let verification: AudienceVerification = { verified: null, reason: "releitura não tentada." };
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const reread = await deps.getBroadcast(created.id, kitConfig);
      verification = verifyAudienceFilter(reread.subscriber_filter, buildTagFilter(audience.tagId));
      break;
    } catch (e) {
      verification = {
        verified: null,
        reason: `a releitura do broadcast falhou em ${tentativa} tentativa(s) (${(e as Error).message}).`,
      };
    }
  }

  // Audiência não confirmada: o broadcast já está AGENDADO (sairia em
  // minutos), então a resposta segura é cancelá-lo, não só avisar. Cancelado
  // com sucesso = nada saiu e nada é gravado (a reexecução pode tentar de novo).
  if (verification.verified !== true) {
    const label = verification.verified === false ? "NÃO CONFERE" : "NÃO CONFIRMADA";
    try {
      await deps.deleteBroadcast(created.id, kitConfig);
    } catch (e) {
      const detailOnFail = buildDetail(paths.cycle, created.id, email.subject, sendAt, audience, verification, now());
      try {
        deps.writeFile(paths.publishedPath, JSON.stringify(detailOnFail, null, 2) + "\n");
      } catch {
        /* o erro abaixo já manda conferir o Kit */
      }
      throw new Error(
        `AUDIÊNCIA ${label}: ${verification.reason} O broadcast Kit id=${created.id} está AGENDADO para ${sendAt} ` +
          `e o cancelamento automático FALHOU (${(e as Error).message}). Cancele AGORA no painel do Kit ` +
          "(Broadcasts → Scheduled): no pior caso ele mira a base INTEIRA.",
      );
    }
    throw new Error(
      `AUDIÊNCIA ${label}: ${verification.reason} O broadcast Kit id=${created.id} foi CANCELADO (apagado) antes ` +
        "do envio — nenhum e-mail saiu. Confira a tag no Kit e rode de novo.",
    );
  }

  const detail = buildDetail(paths.cycle, created.id, email.subject, sendAt, audience, verification, now());
  let persistError: string | undefined;
  try {
    deps.writeFile(paths.publishedPath, JSON.stringify(detail, null, 2) + "\n");
  } catch (e) {
    persistError = (e as Error).message;
  }
  if (persistError) {
    throw new Error(
      `o broadcast Kit id=${created.id} FOI CRIADO (envio ${sendAt}), mas o registro de idempotência não foi salvo ` +
        `(${persistError}). NÃO reexecute sem conferir Broadcasts no Kit.`,
    );
  }
  return { kind: "enviado", detail };
}

function buildDetail(
  cycle: string,
  broadcastId: number,
  subject: string,
  sendAt: string,
  audience: ResolvedAudience,
  verification: AudienceVerification,
  at: Date,
): StackEmailPublished {
  return {
    cycle,
    broadcastId,
    subject,
    sendAt,
    audienceTag: audience.tagName,
    audienceTagId: audience.tagId,
    audienceMemberCount: audience.memberCount,
    audienceVerification: toPersistedVerification(verification),
    createdAt: at.toISOString(),
  };
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
      send: hasFlag(argv, "send"),
      force: hasFlag(argv, "force"),
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

#!/usr/bin/env node
/**
 * scripts/publish-monthly-apoiadores-kit.ts (#7633, Passo 2 da skill
 * `/diaria-mensal-apoiadores`)
 *
 * Cria o broadcast do envio extra pros apoiadores Mantenedor/Patrono na base
 * própria (Kit), **sempre como rascunho**. Sucessor de
 * `publish-monthly-apoiadores-brevo.ts` (#4593) — que nunca criou uma
 * campanha real (a lista Brevo dedicada nunca foi populada e nada saiu de
 * `--dry-run`), e este por sua vez sucede o paste manual no Beehiiv do #4482.
 *
 * ## Pipeline
 *
 *   1. `renderMonthlyApoiadoresKitEmail(cycle)` (injetável) monta o HTML
 *      final a partir do MESMO `draft.md` do envio Clarice — filtro de seções
 *      Clarice-only, UTM próprio (`mensal-apoiadores-kit`), merge tag Liquid
 *      do Kit no voto do "É IA?", relink pra edição diária de origem.
 *   2. Guards de pré-condição fora de `--dry-run`: nome da tag configurado,
 *      credencial do Kit no ambiente, idempotência (state do ciclo).
 *   3. Audiência: resolve a tag POR NOME (`findTagIdByName`, que nunca cria) e
 *      recusa se ela não existir ou estiver vazia.
 *   4. Cria o broadcast (`POST /v4/broadcasts`) sem `send_at` — rascunho. O
 *      test-send, a conferência visual e o disparo continuam sendo ação
 *      humana no painel do Kit.
 *
 * ## Duas escolhas de payload que não são detalhe
 *
 * - **`subscriber_filter` sempre resolvido antes de montar o payload.** Filtro
 *   ausente/vazio no Kit significa **base INTEIRA** (#6126), não audiência
 *   nenhuma: o modo de falha deste canal é mandar o conteúdo exclusivo de
 *   apoiador pra todo mundo. Por isso a tag é resolvida, validada
 *   (`resolveApoiadoresTagId`) e conferida como não-vazia
 *   (`checkApoiadoresAudienceNotEmpty`) ANTES de qualquer criação.
 * - **`public: false`, ao contrário da anual e da diária.** Aquelas passam
 *   `public: true` justamente pra ganhar `public_url` com slug (#6323). Aqui
 *   isso seria publicar na web a recompensa que só quem apoia deveria
 *   receber. Sem `public_url`, o arquivo do envio não fica acessível fora da
 *   caixa de entrada de quem recebeu — que é o ponto.
 *
 * ## Por que NÃO checa `publishing.newsletter.backend`
 *
 * `publish-annual-kit.ts` recusa rodar quando o backend da newsletter não é
 * `"kit"` — faz sentido lá, porque a anual vai pra MESMA audiência da diária,
 * e um backend em `"beehiiv"` significaria a base estar do outro lado. Aqui
 * não: a audiência é uma tag de apoiadores no Kit, mantida por
 * `sync-apoio-mensal-tag-kit.ts`, e existe independente de qual ESP manda a
 * diária. Amarrar os dois faria uma reversão temporária do canal diário
 * bloquear um envio que não tem nada a ver com ela. O guard equivalente aqui
 * é a audiência: sem tag resolvida e não-vazia, nada é criado.
 *
 * ## Idempotência (Passo 1 ↔ Passo 2)
 *
 * Fora de `--dry-run`, lê `data/monthly/{ciclo}/_internal/beehiiv-apoiadores-state.json`
 * (nome do arquivo é resíduo histórico, conteúdo é channel-agnostic) ANTES de
 * criar: se já existe `kitBroadcastId` pro ciclo ou o ciclo está `sent`,
 * aborta (exit 2). `--force` ignora os dois. Depois de criar, grava o id de
 * volta. `--dry-run` nunca lê nem grava o state.
 *
 * Exit codes: 1 uso/erro fatal · 2 guard de config/audiência/idempotência.
 *
 * Uso:
 *   npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle 2607-08 --dry-run
 *   npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle 2607-08
 *   npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle 2607-08 --force
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { requireMonthlyCycleArg, monthlyDir } from "./lib/mensal/monthly-paths.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import {
  createBroadcast,
  findTagIdByName,
  countKitTagMembers,
  buildTagFilter,
  type CreateBroadcastInput,
} from "./lib/kit-broadcasts.ts";
import {
  renderMonthlyApoiadoresKitEmail,
  type RenderedMonthlyApoiadoresKitEmail,
} from "./render-monthly-apoiadores-kit.ts";
import {
  resolveApoiadoresTagName,
  resolveApoiadoresTagId,
  checkApoiadoresAudienceNotEmpty,
  type KitApoiadoresChannelConfig,
} from "./lib/mensal/apoiadores-kit-channel.ts";
import {
  readApoiadoresState,
  writeApoiadoresState,
  decidePublishKitAction,
  buildApoiadoresKitPublishedState,
  type ApoiadoresState,
} from "./lib/mensal/monthly-apoiadores-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[publish-monthly-apoiadores-kit]";

export type ApoiadoresKitEmailContent = Pick<RenderedMonthlyApoiadoresKitEmail, "subject" | "previewText" | "html">;

/**
 * Nome do broadcast no painel do Kit. O Kit não tem campo "nome" separado do
 * assunto (diferente da Brevo, onde `name` é interno) — o que identifica o
 * envio no painel é o próprio `subject`, então o ciclo entra na `description`,
 * que é interna e não vai pro e-mail.
 */
export function buildApoiadoresKitDescription(cycle: string): string {
  return `diar.ia.br mensal apoiadores — ${cycle}`;
}

/**
 * Pura — monta o payload de `POST /v4/broadcasts`. NUNCA inclui `send_at`
 * (rascunho sempre) e SEMPRE inclui um `subscriber_filter` de tag resolvida.
 * `public: false` de propósito — ver docstring do módulo.
 */
export function buildApoiadoresKitBroadcastInput(
  content: ApoiadoresKitEmailContent,
  cycle: string,
  tagId: number,
): CreateBroadcastInput {
  return {
    subject: content.subject,
    content: content.html,
    preview_text: content.previewText,
    description: buildApoiadoresKitDescription(cycle),
    send_at: null,
    subscriber_filter: buildTagFilter(tagId),
    public: false,
  };
}

export interface ApoiadoresKitDeps {
  /** Injetável pra teste — produção chama o render real (toca `data/monthly/`). */
  renderEmail: (cycle: string) => RenderedMonthlyApoiadoresKitEmail;
  readState: (monthlyDirPath: string) => ApoiadoresState | null;
  writeState: (monthlyDirPath: string, state: ApoiadoresState) => void;
  findTagId: (name: string, config?: KitConfig) => Promise<number | null>;
  countTagMembers: (tagId: number, config?: KitConfig) => Promise<number>;
  createBroadcast: (input: CreateBroadcastInput, config?: KitConfig) => Promise<{ id: number }>;
}

const defaultDeps: ApoiadoresKitDeps = {
  renderEmail: renderMonthlyApoiadoresKitEmail,
  readState: readApoiadoresState,
  writeState: writeApoiadoresState,
  findTagId: findTagIdByName,
  countTagMembers: countKitTagMembers,
  createBroadcast,
};

export async function main(rootDirOverride?: string, deps: ApoiadoresKitDeps = defaultDeps): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const force = hasFlag(argv, "force");
  const cycle = requireMonthlyCycleArg(argv);
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

  const platformConfigPath = resolve(rootDir, "platform.config.json");
  const platformConfig = existsSync(platformConfigPath)
    ? (JSON.parse(readFileSync(platformConfigPath, "utf8")) as { kit_apoiadores?: KitApoiadoresChannelConfig })
    : {};
  const tagNameResolution = resolveApoiadoresTagName(platformConfig.kit_apoiadores);
  if (!tagNameResolution.ok) {
    // Vale inclusive em --dry-run: sem nome de tag não há audiência possível,
    // e um preview que não diz isso convida a rodar o comando real depois.
    log(`ERRO: ${tagNameResolution.reason}`);
    process.exit(2);
    return;
  }
  const tagName = tagNameResolution.tagName;

  // Guard de idempotência (só fora de --dry-run — preview local é sempre
  // seguro de repetir e nunca toca o state).
  const dir = monthlyDir(cycle);
  const existingState = dryRun ? null : deps.readState(dir);
  if (!dryRun) {
    const decision = decidePublishKitAction(existingState, force);
    if (decision.action === "blocked") {
      log(`ERRO: ${decision.reason}`);
      process.exit(2);
      return;
    }
    if (force && existingState?.kitBroadcastId != null) {
      log(
        `AVISO: --force ignorando idempotência — broadcast anterior id=${existingState.kitBroadcastId} ` +
          `(criado em ${existingState.preparedAt}) NÃO será excluído automaticamente e ficará órfão como ` +
          "rascunho no Kit. Confira o painel (Broadcasts → Drafts) e exclua manualmente se não for mais necessário.",
      );
    }
  }

  const rendered = deps.renderEmail(cycle);
  const content: ApoiadoresKitEmailContent = {
    subject: rendered.subject,
    previewText: rendered.previewText,
    html: rendered.html,
  };

  if (dryRun) {
    log(`[DRY RUN] HTML já escrito em ${rendered.htmlPath}`);
    log(`  Assunto: ${content.subject}`);
    log(`  Preview: ${content.previewText}`);
    log(`  Broadcast que SERIA criado: tag de audiência="${tagName}", rascunho (send_at: null), public: false.`);
    return;
  }

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    log(`ERRO: ${kitConfigResult.reason}`);
    process.exit(2);
    return;
  }
  const kitConfig = kitConfigResult.config;

  const tagIdResolution = resolveApoiadoresTagId(tagName, await deps.findTagId(tagName, kitConfig));
  if (!tagIdResolution.ok) {
    log(`ERRO: ${tagIdResolution.reason}`);
    process.exit(2);
    return;
  }
  const tagId = tagIdResolution.tagId;

  const memberCheck = checkApoiadoresAudienceNotEmpty(tagName, await deps.countTagMembers(tagId, kitConfig));
  if (!memberCheck.ok) {
    log(`ERRO: ${memberCheck.reason}`);
    process.exit(2);
    return;
  }

  const created = await deps.createBroadcast(buildApoiadoresKitBroadcastInput(content, cycle, tagId), kitConfig);
  log(
    `broadcast criado: id=${created.id} (rascunho, audiência = tag "${tagName}" id=${tagId}) — test email, ` +
      "conferência visual e disparo continuam sendo ação manual no painel do Kit.",
  );

  // Mesma janela TOCTOU que o publisher Brevo fecha (#4572 fleet review): o
  // state foi lido ANTES da chamada de rede. Se `--mark-sent` (Passo 3) rodou
  // nesse intervalo, sobrescrever agora apagaria a confirmação de envio do
  // editor. Re-lê e aborta sem escrever nesse caso — não é um lock, é um
  // re-check adequado a um CLI manual de baixa frequência.
  const freshState = deps.readState(dir);
  if (freshState?.status === "sent" && existingState?.status !== "sent") {
    log(
      `ERRO CRÍTICO: o broadcast Kit id=${created.id} FOI CRIADO, mas o ciclo ${cycle} foi marcado como ` +
        `ENVIADO (--mark-sent, em ${freshState.sentAt}) por outra invocação concorrente enquanto esta criava ` +
        "o rascunho. NÃO sobrescrevendo o state 'sent' — confira o painel do Kit (Broadcasts → Drafts) e " +
        `decida manualmente se o broadcast id=${created.id} deve ser excluído.`,
    );
    throw new Error(
      `race de idempotência: ciclo ${cycle} marcado 'sent' concorrentemente enquanto o broadcast Kit ` +
        `id=${created.id} era criado — state NÃO foi sobrescrito.`,
    );
  }

  try {
    deps.writeState(
      dir,
      buildApoiadoresKitPublishedState(
        existingState,
        cycle,
        new Date().toISOString(),
        rendered.htmlPath,
        content.subject,
        created.id,
      ),
    );
  } catch (e) {
    log(
      `ERRO CRÍTICO: o broadcast Kit id=${created.id} FOI CRIADO, mas o registro de idempotência NÃO foi ` +
        `salvo (${(e as Error).message}). NÃO reexecute este comando sem antes conferir o painel do Kit ` +
        `(Broadcasts → Drafts) — reexecutar agora criaria um 2º rascunho duplicado, porque o guard não tem ` +
        `como saber que id=${created.id} já existe.`,
    );
    throw e;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`${LOG_PREFIX} erro fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * scripts/publish-artigo-especial-kit.ts (#7659)
 *
 * Canal `email` de `/diaria-artigo-especial`: cria no Kit o broadcast do
 * Artigo Especial pros apoiadores R$10+, **sempre como rascunho**.
 *
 * Fecha o buraco da #7659 — o Artigo Especial é vendido na apoia.se como
 * recompensa do tier Apoiador (R$10/mês) com "entrega por e-mail", e até aqui
 * nenhum e-mail existia: quem apoiava descobria o artigo por um post no
 * apoia.se ou pelo box da diária, ou não descobria.
 *
 * ## Pipeline
 *
 *   1. Lê os metadados do artigo JÁ deployado
 *      (`workers/artigos/public/{ano}/{slug}/index.html`) — mesmo extrator do
 *      Passo 0 da skill, nunca uma 2ª fonte.
 *   2. Lê a chamada de `data/artigo-especial/{ano}-{slug}/email.md` (gerada e
 *      aprovada no gate do Passo 2) e renderiza o e-mail.
 *   3. Guards fora de `--dry-run`: tag configurada, credencial, idempotência.
 *   4. Audiência: resolve a tag POR NOME (`findTagIdByName`, que nunca cria) e
 *      recusa se ela não existir ou estiver vazia.
 *   5. Cria o broadcast sem `send_at` — rascunho. Test-send, conferência
 *      visual e disparo continuam sendo ação humana no painel do Kit.
 *   6. **Relê o broadcast e confere o `subscriber_filter` aplicado** — o 2xx
 *      da criação não é prova de que o filtro pegou, e o erro que passaria
 *      batido aqui é o pior do domínio (rascunho mirando a base inteira).
 *      Mesma disciplina de `publish-monthly-apoiadores-kit.ts` (#7633) e
 *      `kit-diaria-stage5-dispatch.ts` (#6582).
 *
 * ## `public: false`, ao contrário da diária e da anual
 *
 * Aquelas passam `public: true` pra ganhar `public_url` com slug (#6323). Aqui
 * não faz diferença de acesso (o artigo em si é público e indexado de
 * propósito — ver a tabela de decisões da skill), mas criaria uma 2ª URL
 * canônica pro mesmo conteúdo, competindo com `especial.diar.ia.br` no índice.
 * A URL do artigo é a do artigo.
 *
 * ## Idempotência
 *
 * Duas camadas, e a 1ª é a que importa: `email-published.json` guarda o
 * `broadcastId` criado — havendo um, o script recusa criar outro sem
 * `--force`. `published.json` (canal `email`) é o status agregado que a skill
 * lê no Passo 0, gravado depois.
 *
 * Exit codes: 1 uso/erro fatal · 2 guard de config/audiência/idempotência.
 *
 * Uso:
 *   npx tsx scripts/publish-artigo-especial-kit.ts --ano 2026 --slug o-agente --dry-run
 *   npx tsx scripts/publish-artigo-especial-kit.ts --ano 2026 --slug o-agente
 *   npx tsx scripts/publish-artigo-especial-kit.ts --ano 2026 --slug o-agente --force
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule, getStringArg, parseArgs } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import {
  createBroadcast,
  findTagIdByName,
  countKitTagMembers,
  buildTagFilter,
  type CreateBroadcastInput,
  type KitSubscriberFilter,
} from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import { readArtigoMeta, type ArtigoEspecialMeta } from "./lib/artigo-especial-meta.ts";
import {
  ARTIGO_ESPECIAL_EMAIL_NIVEIS,
  ARTIGO_ESPECIAL_TAG_SYNC_COMMAND,
  ArtigoEspecialKitGuardError,
  readPlatformConfig,
  resolveArtigoEspecialTagName,
} from "./lib/artigo-especial-kit-channel.ts";
import {
  renderArtigoEspecialEmail,
  withArtigoEspecialEmailUtm,
  type RenderedArtigoEspecialEmail,
} from "./lib/artigo-especial-email-render.ts";
import { resolveVerifiedAudience, type ResolvedAudience } from "./lib/shared/kit-apoio-tag.ts";
import {
  artigoEspecialStatePath,
  readArtigoEspecialState,
  writeArtigoEspecialState,
  buildDoneChannelState,
  buildFailedChannelState,
  decideChannelAction,
  withChannelState,
} from "./lib/artigo-especial-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[publish-artigo-especial-kit]";

/**
 * Estado da conferência de audiência, como fica GRAVADO — mesma união de
 * `AudienceVerification`, incluindo a `reason`.
 *
 * A 1ª versão gravava `audienceVerified: boolean | null` e jogava a `reason`
 * fora (achado do type-design-analyzer, review da #7659). Isso quebrava
 * justamente o caso que o arquivo existe pra registrar: `diverged` significa
 * "existe um rascunho no Kit possivelmente mirando a base inteira", e quem
 * fosse auditar depois via só o booleano, sem QUAL filtro divergiu — a
 * informação estava no stderr daquela sessão e em lugar nenhum durável.
 *
 * Nomes em vez de `boolean | null` porque os 3 estados não são "sim/não/não
 * sei" de mesma gravidade: `diverged` é incidente acionável, `unconfirmed` é
 * ausência de confirmação. Um `if (!audienceVerified)` colapsava os dois.
 */
export type PersistedAudienceVerification =
  | { status: "confirmed" }
  | { status: "diverged"; reason: string }
  | { status: "unconfirmed"; reason: string };

/** Detalhe do envio — irmão de `linkedin-published.json`. */
export interface ArtigoEspecialEmailPublished {
  ano: string;
  slug: string;
  broadcastId: number;
  subject: string;
  audienceTag: string;
  audienceTagId: number;
  /** Quantos membros a tag tinha no momento da criação — o número que o
   *  editor confere contra o painel antes de disparar. */
  audienceMemberCount: number;
  audienceVerification: PersistedAudienceVerification;
  createdAt: string;
}

/** Pura: projeta a verificação em memória no shape gravado. @pure */
export function toPersistedVerification(v: AudienceVerification): PersistedAudienceVerification {
  if (v.verified === true) return { status: "confirmed" };
  if (v.verified === false) return { status: "diverged", reason: v.reason };
  return { status: "unconfirmed", reason: v.reason };
}

export function emailPublishedPath(dataDir: string, ano: string, slug: string): string {
  return resolve(dataDir, "artigo-especial", `${ano}-${slug}`, "email-published.json");
}

export function chamadaPath(dataDir: string, ano: string, slug: string): string {
  return resolve(dataDir, "artigo-especial", `${ano}-${slug}`, "email.md");
}

export function artigoHtmlPath(rootDir: string, ano: string, slug: string): string {
  return resolve(rootDir, "workers", "artigos", "public", ano, slug, "index.html");
}

/**
 * Fail-soft na leitura do detalhe: ausente/corrompido → `null` (tratado como
 * "nunca enviado"), mesma disciplina de `readArtigoEspecialState`. Um arquivo
 * corrompido NÃO pode virar exceção aqui — mas também não passa em silêncio,
 * porque perder o `broadcastId` é perder o guard de duplicata.
 */
export function readEmailPublished(path: string): ArtigoEspecialEmailPublished | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ArtigoEspecialEmailPublished>;
    if (typeof parsed.broadcastId !== "number") {
      process.stderr.write(
        `${LOG_PREFIX} AVISO: ${path} existe mas não tem broadcastId numérico — tratando como "nunca enviado". ` +
          "Confira Broadcasts → Drafts no Kit antes de seguir: pode existir um rascunho que este guard não enxerga.\n",
      );
      return null;
    }
    return parsed as ArtigoEspecialEmailPublished;
  } catch (e) {
    process.stderr.write(
      `${LOG_PREFIX} AVISO: ${path} não pôde ser lido/parseado (${(e as Error).message}) — tratando como ` +
        '"nunca enviado". Confira Broadcasts → Drafts no Kit antes de seguir.\n',
    );
    return null;
  }
}

/** Nome interno do broadcast no painel do Kit — o Kit não tem campo separado
 *  do assunto, então o identificador do artigo vai na `description`. */
export function buildArtigoEspecialKitDescription(ano: string, slug: string): string {
  return `diar.ia.br artigo especial — ${ano}/${slug}`;
}

/**
 * Pura — payload de `POST /v4/broadcasts`. NUNCA inclui `send_at` (rascunho
 * sempre) e SEMPRE inclui um `subscriber_filter` de tag resolvida.
 *
 * Recebe `ResolvedAudience`, não um `tagId: number` cru: um número solto tem o
 * mesmo tipo de um id inventado ou não resolvido, e a segurança do canal
 * passaria a depender de cada caller futuro chamar os 3 guards na ordem certa.
 * Com a audiência marcada, montar o payload sem passar por eles não compila.
 *
 * @pure
 */
export function buildArtigoEspecialKitBroadcastInput(
  email: RenderedArtigoEspecialEmail,
  ano: string,
  slug: string,
  audience: ResolvedAudience,
): CreateBroadcastInput {
  return {
    subject: email.subject,
    content: email.html,
    preview_text: email.previewText,
    description: buildArtigoEspecialKitDescription(ano, slug),
    send_at: null,
    subscriber_filter: buildTagFilter(audience.tagId),
    public: false,
  };
}

export type AudienceVerification =
  | { verified: true }
  | { verified: false; reason: string }
  | { verified: null; reason: string };

/**
 * Pura: compara o `subscriber_filter` relido contra o esperado. Três
 * resultados, e a distinção entre os dois últimos importa:
 *   - `true` — a API ecoou exatamente o filtro enviado.
 *   - `false` — ecoou algo DIFERENTE: existe um rascunho com audiência
 *     possivelmente ERRADA (no pior caso, a base inteira). É incidente.
 *   - `null` — não confirmável (o campo não veio). Registrar isso como `true`
 *     seria afirmar uma verificação que não aconteceu.
 *
 * @pure
 */
export function verifyAudienceFilter(rereadFilter: unknown, expected: KitSubscriberFilter): AudienceVerification {
  if (rereadFilter === undefined) {
    return {
      verified: null,
      reason: "a releitura do broadcast não trouxe 'subscriber_filter' — audiência NÃO confirmada por esta camada.",
    };
  }
  if (JSON.stringify(rereadFilter) === JSON.stringify(expected)) return { verified: true };
  return {
    verified: false,
    reason:
      "a releitura mostra subscriber_filter DIVERGENTE do enviado — o Kit respondeu 2xx sem aplicar o filtro " +
      `certo. Esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(rereadFilter)}.`,
  };
}

export interface ArtigoEspecialKitDeps {
  readMeta: (path: string) => ArtigoEspecialMeta;
  readChamada: (path: string) => string;
  writeJson: (path: string, contents: string) => void;
  findTagId: (name: string, config?: KitConfig) => Promise<number | null>;
  countTagMembers: (tagId: number, config?: KitConfig) => Promise<number>;
  createBroadcast: (input: CreateBroadcastInput, config?: KitConfig) => Promise<{ id: number }>;
  getBroadcast: (id: number, config?: KitConfig) => Promise<{ subscriber_filter?: unknown }>;
}

const defaultDeps: ArtigoEspecialKitDeps = {
  readMeta: (p) => readArtigoMeta(p),
  readChamada: (p) => readFileSync(p, "utf8"),
  writeJson: (p, c) => writeFileAtomic(p, c),
  findTagId: findTagIdByName,
  countTagMembers: countKitTagMembers,
  createBroadcast,
  getBroadcast,
};

export interface RunOptions {
  ano: string;
  slug: string;
  dataDir: string;
  rootDir: string;
  dryRun: boolean;
  force: boolean;
  log: (msg: string) => void;
  deps?: ArtigoEspecialKitDeps;
}

/**
 * Registra `failed` no status agregado quando o canal falha — o que os canais
 * irmãos (`publish-artigo-especial-linkedin.ts`, `update-artigo-especial-box.ts`)
 * já fazem e a 1ª versão deste script não fazia: toda falha saía sem tocar
 * `published.json`, então o resumo da skill e qualquer leitor daquele arquivo
 * viam o canal como "nunca tentado" em vez de "tentou e falhou" (achado do
 * code-reviewer, review da #7659).
 *
 * Nunca sobrescreve um `done` anterior: o caso "já foi criado, recusando o 2º
 * rascunho" é um guard funcionando, não uma falha do canal.
 *
 * Fail-soft de propósito — não pode substituir o erro real que está subindo.
 */
function recordChannelFailure(statePath: string, ano: string, slug: string, reason: string, log: (m: string) => void): void {
  try {
    const state = readArtigoEspecialState(statePath, ano, slug);
    if (state.channels.email?.status === "done") return;
    writeArtigoEspecialState(
      statePath,
      withChannelState(state, "email", buildFailedChannelState(new Date().toISOString(), reason)),
    );
  } catch (e) {
    log(`AVISO: não foi possível registrar a falha do canal "email" em ${statePath} (${(e as Error).message}).`);
  }
}

export async function runPublishArtigoEspecialKit(options: RunOptions): Promise<void> {
  // `--dry-run` nunca toca o state (preview local é sempre seguro de repetir).
  if (options.dryRun) return runPublishArtigoEspecialKitInner(options);
  try {
    await runPublishArtigoEspecialKitInner(options);
  } catch (e) {
    recordChannelFailure(
      artigoEspecialStatePath(options.dataDir, options.ano, options.slug),
      options.ano,
      options.slug,
      (e as Error).message,
      options.log,
    );
    throw e;
  }
}

async function runPublishArtigoEspecialKitInner(options: RunOptions): Promise<void> {
  const { ano, slug, dataDir, rootDir, dryRun, force, log } = options;
  const deps = options.deps ?? defaultDeps;

  const platformConfig = readPlatformConfig(rootDir);
  const tagNameResolution = resolveArtigoEspecialTagName(platformConfig.kit_artigo_especial);
  if (!tagNameResolution.ok) {
    // Vale inclusive em --dry-run: sem nome de tag não há audiência possível,
    // e um preview que não diz isso convida a rodar o comando real depois.
    throw new ArtigoEspecialKitGuardError(tagNameResolution.reason);
  }
  const tagName = tagNameResolution.tagName;

  const publishedPath = emailPublishedPath(dataDir, ano, slug);
  const already = dryRun ? null : readEmailPublished(publishedPath);
  const statePath = artigoEspecialStatePath(dataDir, ano, slug);

  if (!dryRun) {
    if (already && !force) {
      throw new ArtigoEspecialKitGuardError(
        `o broadcast deste artigo já foi criado (id=${already.broadcastId}, ${already.createdAt}) — ` +
          "recusando criar um 2º rascunho. Use --force se for intencional (o rascunho anterior NÃO é " +
          "excluído automaticamente e ficará órfão no Kit).",
      );
    }
    const decision = decideChannelAction(readArtigoEspecialState(statePath, ano, slug), "email", force);
    if (decision.action === "skip") throw new ArtigoEspecialKitGuardError(decision.reason);
    if (already && force) {
      log(
        `AVISO: --force ignorando idempotência — broadcast anterior id=${already.broadcastId} NÃO será ` +
          "excluído automaticamente e ficará órfão como rascunho no Kit. Confira Broadcasts → Drafts.",
      );
    }
  }

  const meta = deps.readMeta(artigoHtmlPath(rootDir, ano, slug));
  const chamadaFile = chamadaPath(dataDir, ano, slug);
  if (!existsSync(chamadaFile)) {
    throw new ArtigoEspecialKitGuardError(
      `${chamadaFile} ausente — o texto do e-mail é gerado no Passo 1 da skill /diaria-artigo-especial e ` +
        "aprovado no gate do Passo 2. Sem ele não há o que enviar.",
    );
  }
  const email = renderArtigoEspecialEmail({
    title: meta.h1 || meta.title,
    description: meta.description,
    url: meta.url,
    image: meta.image,
    chamadaMarkdown: deps.readChamada(chamadaFile),
    ano,
    slug,
  });
  // `withArtigoEspecialEmailUtm` devolve a URL inalterada quando ela não
  // parseia — decisão certa (e-mail sem UTM é perda de medição; e-mail que não
  // sai é perda de entrega), mas silenciosa: sem este aviso, a atribuição de um
  // envio inteiro sumia sem deixar rastro em log nenhum (achado do
  // silent-failure-hunter, review da #7659).
  if (withArtigoEspecialEmailUtm(meta.url, ano, slug) === meta.url) {
    log(
      `AVISO: UTM não aplicado ao link do artigo — "${meta.url}" (og:url) não é uma URL absoluta válida. ` +
        "O e-mail sai normalmente, mas os cliques deste envio não vão aparecer na atribuição.",
    );
  }

  if (dryRun) {
    log(`[DRY RUN] assunto: ${email.subject}`);
    log(`[DRY RUN] preview: ${email.previewText}`);
    log(`[DRY RUN] ${email.html.length} bytes de HTML · link: ${meta.url}`);
    log(`[DRY RUN] broadcast que SERIA criado: tag "${tagName}", rascunho (send_at: null), public: false.`);
    return;
  }

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) throw new ArtigoEspecialKitGuardError(kitConfigResult.reason);
  const kitConfig = kitConfigResult.config;

  const audienceResolution = await resolveVerifiedAudience(
    platformConfig.kit_artigo_especial?.audience_tag,
    "kit_artigo_especial.audience_tag",
    ARTIGO_ESPECIAL_TAG_SYNC_COMMAND,
    async (name) => {
      const tagId = await deps.findTagId(name, kitConfig);
      return { tagId, memberCount: tagId === null ? 0 : await deps.countTagMembers(tagId, kitConfig) };
    },
    ARTIGO_ESPECIAL_EMAIL_NIVEIS,
  );
  if (!audienceResolution.ok) throw new ArtigoEspecialKitGuardError(audienceResolution.reason);
  const audience = audienceResolution.audience;

  const created = await deps.createBroadcast(
    buildArtigoEspecialKitBroadcastInput(email, ano, slug, audience),
    kitConfig,
  );
  log(
    `broadcast criado: id=${created.id} (rascunho, audiência = tag "${audience.tagName}" id=${audience.tagId}, ` +
      `${audience.memberCount} membro(s)) — test email, conferência visual e disparo continuam sendo ação ` +
      "manual no painel do Kit.",
  );

  // Uma retentativa antes de desistir: a releitura é a única confirmação de que
  // o filtro pegou, e desistir dela num timeout transitório deixaria o operador
  // com "não sei" quando 1 chamada a mais responderia (achado do
  // silent-failure-hunter, review da #7659).
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
  if (verification.verified !== true) log(`AVISO: ${verification.reason}`);

  // O broadcast JÁ EXISTE — gravar o detalhe ANTES de decidir abortar é o que
  // faz a próxima invocação cair no guard de duplicata em vez de criar um 2º
  // rascunho por cima de um problema não resolvido.
  const detail: ArtigoEspecialEmailPublished = {
    ano,
    slug,
    broadcastId: created.id,
    subject: email.subject,
    audienceTag: audience.tagName,
    audienceTagId: audience.tagId,
    audienceMemberCount: audience.memberCount,
    audienceVerification: toPersistedVerification(verification),
    createdAt: new Date().toISOString(),
  };
  let persistError: string | undefined;
  try {
    deps.writeJson(publishedPath, JSON.stringify(detail, null, 2) + "\n");
  } catch (e) {
    persistError = (e as Error).message;
  }

  const persistSuffix = persistError
    ? ` ADICIONALMENTE, ${publishedPath} não pôde ser gravado (${persistError}) — o guard de duplicata NÃO vai ` +
      "reconhecer este broadcast e uma reexecução criaria um 2º rascunho."
    : ` O id ficou gravado (audienceVerification.status: "${detail.audienceVerification.status}") — uma ` +
      "reexecução é bloqueada pelo guard.";

  if (verification.verified === false) {
    throw new Error(
      `AUDIÊNCIA NÃO CONFERE: o broadcast Kit id=${created.id} FOI CRIADO, mas ${verification.reason} NÃO ` +
        "dispare esse rascunho sem antes conferir a audiência no painel do Kit — no pior caso ele está " +
        "mirando a base INTEIRA em vez da tag de apoiadores." +
        persistSuffix,
    );
  }

  // Audiência NÃO CONFIRMADA (a releitura não respondeu, ou não trouxe o
  // campo) também para aqui, e o canal NÃO é marcado `done`. A 1ª versão
  // seguia com um AVISO em stderr e exit 0 — na prática, tratar "não sei" como
  // "confirmado" no único ponto do fluxo que não tem gate humano depois
  // (achado do silent-failure-hunter, review da #7659). O rascunho existe e
  // está protegido pelo guard de duplicata; o que falta é olho humano no
  // painel, e é isso que o exit não-zero força.
  if (verification.verified === null) {
    throw new Error(
      `AUDIÊNCIA NÃO CONFIRMADA: o broadcast Kit id=${created.id} FOI CRIADO, mas ${verification.reason} ` +
        `Confira no painel do Kit que a audiência é a tag "${audience.tagName}" (${audience.memberCount} ` +
        "membro(s)) ANTES de disparar — no pior caso ele está mirando a base INTEIRA." +
        persistSuffix,
    );
  }

  if (persistError) {
    throw new Error(
      `o broadcast Kit id=${created.id} FOI CRIADO, mas o registro de idempotência NÃO foi salvo ` +
        `(${persistError}). NÃO reexecute este comando sem antes conferir Broadcasts → Drafts no Kit — ` +
        "reexecutar agora criaria um 2º rascunho duplicado.",
    );
  }

  // Status agregado — secundário: o guard de duplicata real é o
  // `email-published.json` acima, que já foi gravado. Falha aqui não muda o que
  // existe no Kit nem desprotege a reexecução, então vira aviso em vez de
  // exceção crua vinda de `main()` (achado do silent-failure-hunter).
  try {
    const state = readArtigoEspecialState(statePath, ano, slug);
    writeArtigoEspecialState(
      statePath,
      withChannelState(state, "email", buildDoneChannelState(detail.createdAt, null)),
    );
  } catch (e) {
    log(
      `AVISO: o broadcast id=${created.id} foi criado e registrado normalmente, mas o status agregado ` +
        `(${statePath}) não pôde ser gravado (${(e as Error).message}) — o canal "email" vai aparecer como ` +
        "pendente no resumo da skill. Nada a refazer no Kit.",
    );
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const { values } = parseArgs(argv);
  const ano = getStringArg(argv, "ano", { example: "2026" });
  const slug = getStringArg(argv, "slug", { example: "o-agente" });
  if (!ano || !slug) {
    process.stderr.write(
      "Uso: npx tsx scripts/publish-artigo-especial-kit.ts --ano AAAA --slug slug [--dry-run] [--force] [--data-dir path]\n",
    );
    process.exit(2);
  }

  try {
    await runPublishArtigoEspecialKit({
      ano,
      slug,
      dataDir: values["data-dir"] ? resolve(ROOT, values["data-dir"]) : resolve(ROOT, "data"),
      rootDir: ROOT,
      dryRun: hasFlag(argv, "dry-run"),
      force: hasFlag(argv, "force"),
      log: (msg) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`),
    });
  } catch (e) {
    process.stderr.write(`${LOG_PREFIX} ${(e as Error).message}\n`);
    process.exit(e instanceof ArtigoEspecialKitGuardError ? 2 : 1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

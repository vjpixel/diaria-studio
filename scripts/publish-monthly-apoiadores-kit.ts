#!/usr/bin/env node
/**
 * scripts/publish-monthly-apoiadores-kit.ts (#7633, Passo 2 da skill
 * `/diaria-mensal-apoiadores`)
 *
 * Cria o broadcast do envio extra pros apoiadores Mantenedor/Patrono na base
 * própria (Kit), **sempre como rascunho**. Sucessor de
 * `publish-monthly-apoiadores-brevo.ts` (#4593), que por sua vez sucede o
 * paste manual no Beehiiv do #4482.
 *
 * O canal Brevo **enviou uma edição de verdade** (ciclo 2607-08, 04/08/2026,
 * 10 entregues — #7655), ainda que a campanha tenha sido criada à mão no
 * painel, não por este script.
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
 *   4. Cria o broadcast (`POST /v4/broadcasts`). **Desde o #9473, agendado
 *      por padrão pela REGRA** — 1º sábado do mês de ENVIO, 06:00 BRT
 *      (`platform.config.json` → `monthly_send_schedule`, helper
 *      `lib/mensal/monthly-send-schedule.ts`). Se o instante da regra estiver
 *      a menos de 24h (#8205) ou já tiver passado, cai pra **rascunho** com
 *      aviso (nunca agenda em cima da hora). `--draft` força rascunho
 *      (`send_at: null`); `--schedule ISO` (#7867 item 1) força um horário
 *      explícito. Agendado (pela regra ou por `--schedule`), grava
 *      `status: "sent"` direto no state,
 *      dispensando `--mark-sent` (`send-monthly-apoiadores.ts`) no caminho
 *      automatizado — que continua existindo pro caminho manual. Sem guard
 *      de data (decisão explícita do editor, #7867): o script não checa
 *      `data/editions/` nem opina sobre colisão com a edição diária do dia —
 *      a escolha do horário é julgamento do editor.
 *   5. **Relê o broadcast e confere o `subscriber_filter` aplicado** — o 2xx
 *      da criação não é prova de que o filtro pegou, e o erro que passaria
 *      batido aqui é o pior do domínio (rascunho mirando a base inteira).
 *      Divergência aborta ALTO, depois de gravar o id no state pra que uma
 *      reexecução não crie um 2º rascunho por cima do problema; falha de rede
 *      na releitura é fail-soft (vira `kitAudienceVerified: null` + aviso).
 *      Mesma disciplina de `kit-diaria-stage5-dispatch.ts` (#6582).
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
 *   npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle 2607-08 --schedule "2026-09-15T10:00:00-03:00"
 *   npx tsx scripts/publish-monthly-apoiadores-kit.ts --cycle 2607-08 --draft
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { requireMonthlyCycleArg, monthlyDir } from "./lib/mensal/monthly-paths.ts";
import { APOIO_EXCLUSIVE_PREVIEW_TEXT } from "./lib/shared/apoio-preview-text.ts";
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
import {
  renderMonthlyApoiadoresKitEmail,
  type RenderedMonthlyApoiadoresKitEmail,
} from "./render-monthly-apoiadores-kit.ts";
import {
  resolveApoiadoresTagName,
  resolveApoiadoresTagId,
  checkApoiadoresAudienceNotEmpty,
  resolveApoiadoresAudience,
  type ResolvedAudienceTag,
  type KitApoiadoresChannelConfig,
} from "./lib/mensal/apoiadores-kit-channel.ts";
import {
  readApoiadoresState,
  writeApoiadoresState,
  decidePublishKitAction,
  buildApoiadoresKitPublishedState,
  buildApoiadoresKitScheduledState,
  type ApoiadoresState,
} from "./lib/mensal/monthly-apoiadores-state.ts";
import {
  decideMonthlySendAt,
  resolveMonthlySendSchedule,
  type MonthlySendScheduleConfig,
  type MonthlySendScheduleRule,
} from "./lib/mensal/monthly-send-schedule.ts";

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
 * Pura — monta o payload de `POST /v4/broadcasts`. `send_at` é `null`
 * (rascunho) quando `scheduleAt` é omitido; o `main()` passa o ISO da regra
 * (#9473) ou de `--schedule` (#7867 item 1) pra agendar via API — sem checagem de colisão com a edição diária, decisão
 * explícita do editor (ver docstring do módulo). SEMPRE inclui um
 * `subscriber_filter` de tag resolvida. `public: false` de propósito — ver
 * docstring do módulo.
 *
 * #7651: recebe `ResolvedAudienceTag`, não um `tagId: number` cru. O tipo é
 * construtível só por `resolveApoiadoresAudience`, que exige os três guards
 * de audiência — então "montei o payload sem ter conferido a audiência"
 * deixou de compilar, em vez de depender da ordem das chamadas no `main()`.
 */
export function buildApoiadoresKitBroadcastInput(
  content: ApoiadoresKitEmailContent,
  cycle: string,
  audience: ResolvedAudienceTag,
  /** ISO 8601, ou `null`/omitido = rascunho (#7867 item 1). */
  scheduleAt: string | null = null,
): CreateBroadcastInput {
  return {
    subject: content.subject,
    content: content.html,
    preview_text: content.previewText,
    description: buildApoiadoresKitDescription(cycle),
    send_at: scheduleAt,
    subscriber_filter: buildTagFilter(audience.tagId),
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
  /**
   * Releitura pós-criação (#7633) — o 2xx da criação NÃO é prova de que o
   * `subscriber_filter` pegou. Mesmo dep e mesma disciplina de
   * `kit-diaria-stage5-dispatch.ts` (#6582), o canal irmão de mesmo perfil de
   * risco. Tipado como `{ subscriber_filter?: unknown }` de propósito: só
   * este campo importa aqui, e a API pode não ecoá-lo.
   */
  getBroadcast: (id: number, config?: KitConfig) => Promise<{ subscriber_filter?: unknown }>;
  /** Relógio injetável (#9473) — a regra de envio compara contra "agora". */
  now?: () => Date;
}

/**
 * Resultado de `resolveApoiadoresSendAt` (#9473). `source` diz DE ONDE veio o
 * horário — o log e o PR body precisam distinguir "a regra agendou" de "o
 * editor passou --schedule" de "caiu pra rascunho porque era tarde demais".
 */
export type ApoiadoresSendAtResolution =
  | { source: "explicit"; scheduleAt: string; warning?: undefined }
  | { source: "rule"; scheduleAt: string; warning?: undefined }
  | { source: "draft_flag"; scheduleAt: null; warning?: undefined }
  | { source: "rule_too_late"; scheduleAt: null; ruleSendAt: string; warning: string };

/**
 * Pura (#9473): decide o `send_at` do broadcast.
 *
 *   - `--schedule ISO` → usa o ISO (comportamento #7867 item 1, sem guard).
 *   - `--draft` → rascunho (`send_at: null`), o default antigo.
 *   - nenhum dos dois → REGRA (`monthly_send_schedule`, 1º sábado do mês de
 *     ENVIO, 06:00 BRT). Se o instante da regra está a menos de
 *     `minLeadHours` (#8205, 24h) ou já passou → **cai pra RASCUNHO com
 *     aviso**, nunca agenda. Escolha segura: rascunho é inerte e reversível;
 *     agendar para dali a poucas horas (ou no passado, que o Kit dispara na
 *     hora) tiraria a janela de conferência. Falhar em vez de cair pra
 *     rascunho travaria o caminho manual que sempre funcionou.
 *
 * `--schedule` + `--draft` juntos é contraditório → lança.
 */
export function resolveApoiadoresSendAt(opts: {
  cycle: string;
  scheduleRaw: string | undefined;
  draft: boolean;
  now: Date;
  rule: MonthlySendScheduleRule;
}): ApoiadoresSendAtResolution {
  if (opts.scheduleRaw !== undefined && opts.draft) {
    throw new Error("--schedule e --draft são mutuamente exclusivos — passe só um.");
  }
  if (opts.scheduleRaw !== undefined) {
    if (Number.isNaN(Date.parse(opts.scheduleRaw))) {
      throw new Error(
        `--schedule "${opts.scheduleRaw}" não é uma data/hora ISO 8601 válida (ex: 2026-09-15T10:00:00-03:00).`,
      );
    }
    return { source: "explicit", scheduleAt: opts.scheduleRaw };
  }
  if (opts.draft) return { source: "draft_flag", scheduleAt: null };
  const decision = decideMonthlySendAt(opts.cycle, opts.now, opts.rule);
  if (decision.kind === "schedule") return { source: "rule", scheduleAt: decision.sendAt };
  return {
    source: "rule_too_late",
    scheduleAt: null,
    ruleSendAt: decision.sendAt,
    warning:
      `${decision.reason} — criando RASCUNHO (send_at: null) em vez de agendar. Escolha o horário no painel ` +
      "do Kit ou reexecute com --schedule ISO explícito.",
  };
}

/** Pura: linha humana de log pra a resolução. */
export function describeSendAtResolution(r: ApoiadoresSendAtResolution): string {
  switch (r.source) {
    case "explicit":
      return `${r.scheduleAt} (--schedule explícito)`;
    case "rule":
      return `${r.scheduleAt} (regra monthly_send_schedule — 1º sábado do mês de envio, #9473)`;
    case "draft_flag":
      return "rascunho (--draft)";
    case "rule_too_late":
      return `rascunho (regra daria ${r.ruleSendAt}, tarde demais para agendar)`;
  }
}

const defaultDeps: ApoiadoresKitDeps = {
  renderEmail: renderMonthlyApoiadoresKitEmail,
  readState: readApoiadoresState,
  writeState: writeApoiadoresState,
  findTagId: findTagIdByName,
  countTagMembers: countKitTagMembers,
  createBroadcast,
  getBroadcast,
};

export type AudienceVerification =
  | { verified: true }
  | { verified: false; reason: string }
  | { verified: null; reason: string };

/**
 * Pura: compara o `subscriber_filter` relido contra o esperado (#7633, achado
 * do silent-failure-hunter; espelha `kit-diaria-stage5-dispatch.ts` #6582).
 *
 * Três resultados, e a distinção entre os dois últimos importa:
 *   - `true` — a API ecoou exatamente o filtro enviado.
 *   - `false` — ecoou algo DIFERENTE: o Kit aceitou 2xx sem aplicar o filtro
 *     certo, e existe um rascunho com audiência possivelmente ERRADA (no pior
 *     caso, a base inteira). É incidente, não aviso.
 *   - `null` — não confirmável: a releitura não trouxe o campo. Não é
 *     divergência (não há confirmação ao vivo de que `GET /broadcasts/{id}`
 *     ecoa `subscriber_filter`), mas também não é confirmação — e registrar
 *     isso como `true` seria afirmar uma verificação que não aconteceu.
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
      `a releitura mostra subscriber_filter DIVERGENTE do enviado — o Kit respondeu 2xx sem aplicar o ` +
      `filtro certo. Esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(rereadFilter)}.`,
  };
}

export async function main(rootDirOverride?: string, deps: ApoiadoresKitDeps = defaultDeps): Promise<void> {
  const rootDir = rootDirOverride ?? ROOT;
  loadProjectEnv(rootDir);
  const argv = process.argv.slice(2);
  const dryRun = hasFlag(argv, "dry-run");
  const force = hasFlag(argv, "force");
  const cycle = requireMonthlyCycleArg(argv);
  const log = (msg: string) => process.stderr.write(`${LOG_PREFIX} ${msg}\n`);

  // #9473: o horário de envio vem da REGRA (1º sábado do mês de envio, 06:00
  // BRT — `platform.config.json` → `monthly_send_schedule`) por padrão.
  // Overrides explícitos: `--schedule ISO` (#7867 item 1, comportamento
  // inalterado — sem guard de data, decisão do editor) e `--draft` (rascunho,
  // o default antigo). Lido aqui só o argv; a regra é aplicada depois que a
  // config é carregada.
  let scheduleRaw: string | undefined;
  try {
    scheduleRaw = getStringArg(argv, "schedule", { example: "2026-09-15T10:00:00-03:00" });
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exit(1);
    return;
  }
  const draftFlag = hasFlag(argv, "draft");

  const platformConfigPath = resolve(rootDir, "platform.config.json");
  const platformConfig = existsSync(platformConfigPath)
    ? (JSON.parse(readFileSync(platformConfigPath, "utf8")) as {
        kit_apoiadores?: KitApoiadoresChannelConfig;
        monthly_send_schedule?: MonthlySendScheduleConfig;
      })
    : {};

  let sendAtResolution: ApoiadoresSendAtResolution;
  try {
    sendAtResolution = resolveApoiadoresSendAt({
      cycle,
      scheduleRaw,
      draft: draftFlag,
      now: (deps.now ?? (() => new Date()))(),
      rule: resolveMonthlySendSchedule(platformConfig.monthly_send_schedule),
    });
  } catch (e) {
    log(`ERRO: ${(e as Error).message}`);
    process.exit(1);
    return;
  }
  if (sendAtResolution.warning) log(`AVISO: ${sendAtResolution.warning}`);
  const scheduleAt = sendAtResolution.scheduleAt;
  log(`horário de envio: ${describeSendAtResolution(sendAtResolution)}`);
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
    // #7867 item 2: preview fixo — sinalização de exclusividade, não teaser
    // derivado do conteúdo (`rendered.previewText`, descartado aqui de
    // propósito).
    previewText: APOIO_EXCLUSIVE_PREVIEW_TEXT,
    html: rendered.html,
  };

  if (dryRun) {
    log(`[DRY RUN] HTML já escrito em ${rendered.htmlPath}`);
    log(`  Assunto: ${content.subject}`);
    log(`  Preview: ${content.previewText}`);
    log(
      `  Broadcast que SERIA criado: tag de audiência="${tagName}", ` +
        `${scheduleAt ? `AGENDADO para ${scheduleAt}` : "rascunho (send_at: null)"}, public: false.`,
    );
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

  // #7651: junta os três guards numa prova de tipo. `null` aqui é
  // inalcançável (os três já foram checados acima, cada um com sua própria
  // mensagem) — o guard existe pra que a prova nunca seja fabricada sem eles.
  const audience = resolveApoiadoresAudience(tagNameResolution, tagIdResolution, memberCheck);
  if (!audience) {
    log("ERRO: audiência não resolvida — os guards de tag/membros não passaram.");
    process.exit(2);
    return;
  }

  const created = await deps.createBroadcast(
    buildApoiadoresKitBroadcastInput(content, cycle, audience, scheduleAt),
    kitConfig,
  );
  log(
    scheduleAt
      ? `broadcast criado: id=${created.id} (AGENDADO para ${scheduleAt}, audiência = tag "${tagName}" id=${tagId}) — ` +
          "sem --mark-sent necessário no caminho automatizado."
      : `broadcast criado: id=${created.id} (rascunho, audiência = tag "${tagName}" id=${tagId}) — test email, ` +
          "conferência visual e disparo continuam sendo ação manual no painel do Kit.",
  );

  // #7633 (achado do silent-failure-hunter) — o 2xx da criação NÃO é prova de
  // que o `subscriber_filter` pegou, e aqui o erro que passaria batido é o
  // pior do domínio: rascunho com a base INTEIRA em vez da tag de apoiadores.
  // Mesma releitura que `kit-diaria-stage5-dispatch.ts` faz desde o #6582.
  // Fail-soft na REDE (a releitura é camada adicional; o broadcast já existe
  // de qualquer jeito), fail-loud na DIVERGÊNCIA.
  let verification: AudienceVerification;
  try {
    const reread = await deps.getBroadcast(created.id, kitConfig);
    verification = verifyAudienceFilter(reread.subscriber_filter, buildTagFilter(tagId));
  } catch (e) {
    verification = { verified: null, reason: `a releitura do broadcast falhou (${(e as Error).message}).` };
  }
  if (verification.verified !== true) log(`AVISO: ${verification.reason}`);

  // #7867 item 1: com --schedule, o caminho FELIZ grava status "sent" direto
  // (via buildApoiadoresKitScheduledState) — dispensa --mark-sent. A
  // divergência de audiência (abaixo) NUNCA marca "sent", agendado ou não:
  // um broadcast com audiência errada não é sucesso só porque foi agendado.
  const persistState = (audienceVerified: boolean | null, markSent: boolean): void => {
    const state = markSent
      ? buildApoiadoresKitScheduledState(
          existingState,
          cycle,
          new Date().toISOString(),
          rendered.htmlPath,
          content.subject,
          created.id,
          scheduleAt as string, // markSent só é true quando scheduleAt existe (ver chamada abaixo)
          audienceVerified,
        )
      : buildApoiadoresKitPublishedState(
          existingState,
          cycle,
          new Date().toISOString(),
          rendered.htmlPath,
          content.subject,
          created.id,
          audienceVerified,
        );
    deps.writeState(dir, state);
  };

  if (verification.verified === false) {
    // O broadcast JÁ EXISTE — gravar o id ANTES de abortar é o que faz a
    // próxima invocação cair no guard de idempotência em vez de criar um 2º
    // rascunho por cima de um problema não resolvido (mesma disciplina do
    // #6693 no canal diário). `kitAudienceVerified: false` deixa o incidente
    // registrado no arquivo, não só no terminal desta sessão. NUNCA markSent
    // aqui — mesmo com --schedule, audiência divergente não é sucesso.
    let persistError: string | undefined;
    try {
      persistState(false, false);
    } catch (e) {
      persistError = (e as Error).message;
    }
    // Com --schedule, o broadcast já está AGENDADO — não é mais um rascunho
    // inerte no painel, é um envio real na fila do Kit. A mensagem precisa
    // deixar isso explícito: o risco não é "não dispare", é "isto VAI disparar
    // sozinho pra possivelmente a base inteira se ninguém intervier".
    const acao = scheduleAt
      ? `este broadcast está AGENDADO para ${scheduleAt} e VAI DISPARAR SOZINHO — cancele/reagende AGORA no ` +
        "painel do Kit (Broadcasts) se a audiência estiver errada"
      : "NÃO dispare esse rascunho sem antes conferir a audiência no painel do Kit";
    throw new Error(
      `AUDIÊNCIA NÃO CONFERE: o broadcast Kit id=${created.id} FOI CRIADO, mas ${verification.reason} ` +
        `${acao} — no pior caso ele está mirando a base INTEIRA em vez da tag de apoiadores.` +
        (persistError
          ? ` ADICIONALMENTE, o state local não pôde ser gravado (${persistError}) — o guard de idempotência ` +
            "NÃO vai reconhecer este broadcast e uma reexecução criaria um 2º rascunho."
          : " O id ficou gravado no state com kitAudienceVerified:false — uma reexecução é bloqueada pelo guard."),
    );
  }

  // Mesma janela TOCTOU que o publisher Brevo fecha (#4572 fleet review): o
  // state foi lido ANTES da chamada de rede. Se `--mark-sent` (Passo 3) rodou
  // nesse intervalo, sobrescrever agora apagaria a confirmação de envio do
  // editor. Re-lê e aborta sem escrever nesse caso — não é um lock, é um
  // re-check adequado a um CLI manual de baixa frequência.
  const freshState = deps.readState(dir);

  // #7633 (2º achado do silent-failure-hunter): a corrida simétrica — duas
  // invocações passam pelo guard de idempotência lendo o MESMO state sem
  // `kitBroadcastId` e as duas criam um rascunho. Sem este check, o segundo
  // `writeState` sobrescreveria o id do primeiro em silêncio: um dos dois
  // rascunhos vira órfão, invisível pro guard, e nada acusa. Não é um lock
  // (não impede a 2ª criação), é o que garante que a duplicata seja RELATADA.
  if (
    freshState?.kitBroadcastId != null &&
    freshState.kitBroadcastId !== created.id &&
    existingState?.kitBroadcastId !== freshState.kitBroadcastId
  ) {
    throw new Error(
      `race de idempotência: o broadcast Kit id=${created.id} FOI CRIADO por esta invocação, mas outra ` +
        `invocação concorrente gravou o id=${freshState.kitBroadcastId} pro ciclo ${cycle} nesse meio-tempo — ` +
        "existem DOIS rascunhos no Kit. NÃO sobrescrevendo o registro do outro processo; confira o painel " +
        "(Broadcasts → Drafts), apague o duplicado e ajuste o state à mão.",
    );
  }

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

  if (scheduleAt && verification.verified !== true) {
    log(
      `AVISO: broadcast AGENDADO para ${scheduleAt}, mas a audiência não pôde ser CONFIRMADA (${verification.reason}) ` +
        "— o state fica em draft_prepared (não 'sent') de propósito, então confira a audiência no painel e rode " +
        "'send-monthly-apoiadores.ts --mark-sent' manualmente depois de confirmar.",
    );
  }

  try {
    // markSent = true só quando há horário agendado (regra #9473 ou
    // --schedule) E a audiência foi
    // CONFIRMADA (`verified === true`, estritamente — não `!== false`).
    // `verified === null` (releitura falhou/não ecoou o campo) chega até
    // aqui sem lançar, mas "não confirmável" não é "confirmado": marcar
    // "sent" nesse caso removeria o único checkpoint humano restante
    // (--mark-sent) sobre um broadcast cuja audiência ninguém verificou de
    // fato — achado do review da #7867 (PR #7882).
    persistState(verification.verified, scheduleAt !== null && verification.verified === true);
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

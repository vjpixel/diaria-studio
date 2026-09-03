#!/usr/bin/env node
/**
 * scripts/kit-diaria-stage5-dispatch.ts (#6126)
 *
 * Dispatch do canal **Kit paralelo** da edição diária DENTRO da Etapa 5
 * (`orchestrator-stage-5.md`), ao lado dos demais publicadores (Beehiiv,
 * LinkedIn, Facebook, Instagram, Threads, Brevo diária). Espelho estrutural de
 * `scripts/brevo-diaria-stage5-dispatch.ts` (#5772).
 *
 * **Não confundir com o branch por `publishing.newsletter.backend`** (#464):
 * aquele é EXCLUSIVO (backend `"kit"` pula o Beehiiv inteiro) e serve o
 * switchover final (#6114). Este roda EM PARALELO à Beehiiv, cada canal para
 * sua audiência — ver a docstring de `lib/kit-diaria-channel.ts` para a razão
 * de os dois coexistirem.
 *
 * ## Por que compõe em vez de spawnar `publish-newsletter-kit.ts`
 *
 * O canal Brevo spawna seus sub-scripts; aqui não. `publish-newsletter-kit.ts`
 * (a) é gated por `checkKitBackendEnabled`, que exige `backend === "kit"` — o
 * oposto do que este canal precisa (rodar COM o backend ainda em `"beehiiv"`),
 * e (b) escreve em `newsletter-kit-published.json` com
 * `subscriber_filter: buildAllSubscribersFilter()`. Reusá-lo exigiria
 * atravessar os dois comportamentos com flags, acoplando o caminho do
 * switchover a este. Compor a partir das funções JÁ EXPORTADAS
 * (`buildKitHtml`/`buildKitSubject`/`buildKitPreviewText`) deixa o caminho do
 * #6114 intocado e mantém o estado dos dois canais em arquivos separados.
 *
 * ## O guard que governa este script
 *
 * No Kit, `subscriber_filter` ausente/vazio = **audiência INTEIRA**. Uma tag
 * não resolvida aqui não degrada para "não envia": degrada para "envia pra
 * base toda", incluindo os 585 importados da Beehiiv — que receberiam a edição
 * EM DOBRO. Por isso a resolução da tag é validada (`resolveAudienceTagId`)
 * ANTES de qualquer chamada de criação, e falha => `skipped`, nunca fallback.
 *
 * Fail-soft (mesma disciplina do #5772): qualquer falha vira `skipped`/`failed`
 * no resultado e um warning no resumo da Etapa 5 — nunca derruba os demais
 * publicadores.
 *
 * Uso:
 *   npx tsx scripts/kit-diaria-stage5-dispatch.ts <edition-dir>
 *   npx tsx scripts/kit-diaria-stage5-dispatch.ts <edition-dir> --dry-run
 *   npx tsx scripts/kit-diaria-stage5-dispatch.ts <edition-dir> --send-test
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { extractContent } from "./lib/newsletter-parse.ts";
import { buildKitHtml, buildKitSubject, buildKitPreviewText, checkSubjectNotEmpty } from "./publish-newsletter-kit.ts";
import type { PublicImagesFile } from "./substitute-image-urls.ts";
import {
  createBroadcast,
  findTagIdByName,
  buildTagFilter,
  countKitTagMembers,
  listActiveSubscribersCreatedAfter,
  tagSubscriber,
  KIT_TEST_SEND_TAG_NAME,
} from "./lib/kit-broadcasts.ts";
import { getBroadcast } from "./lib/kit-client.ts";
import { KIT_NATIVE_SIGNUP_MARKER } from "./lib/shared/kit-signup-origin.ts";
import {
  decideKitChannelDispatch,
  resolveAudienceTagId,
  checkAudienceTagHasMembers,
  resolveCreatedAfterCutoff,
  subscribersNeedingBackfillTag,
  type KitDiariaChannelConfig,
  type KitDiariaPublished,
} from "./lib/kit-diaria-channel.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type Stage5KitResult =
  | { status: "already_done"; broadcastId: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; step: string; reason: string }
  | {
      status: "ok";
      broadcastId: number;
      audienceTag: string;
      audienceTagId: number;
      /** #6138 finding 4: warnings precisam chegar ao JSON (stdout), não só ao
       *  stderr — o orchestrator lê o JSON pra montar o resumo, então warning
       *  só logado é warning que o editor nunca vê num `status: "ok"`. */
      unresolvedImages: string[];
      renderWarnings: string[];
      /** #6195 — mesma lição do #6138 finding 4 aplicada ao crédito por canal. */
      creditoSubstituido?: boolean;
      residuoBeehiiv?: boolean;
      /**
       * #6582 — a verificação pós-dispatch NÃO confirmou o `subscriber_filter`
       * pela releitura do broadcast (campo ausente na resposta, ou API não
       * confirmada ao vivo pra ecoar esse campo — ver docstring de
       * `KitBroadcastDetail.subscriber_filter`). `true` = releitura confirmou
       * o filtro esperado batendo; `false`/ausente = não confirmável — não é
       * uma falha (por isso `status` continua `"ok"`), mas quem lê o resumo
       * deve saber que esta camada de verificação não pôde confirmar.
       */
      audienceFilterVerified?: boolean;
      /**
       * #7357 — quantos candidatos "criados on/after o corte de
       * `subscriber_filter_created_after`, ainda sem a tag" foram tagueados
       * NESTE dispatch antes de montar o `subscriber_filter`. `undefined`
       * quando o corte não está configurado (resgate por data desligado);
       * `0` é um resultado normal (ninguém preso desde o último dispatch).
       */
      backfillTaggedCount?: number;
      /** #7357 — falhas por assinante ao tagueá-lo (fail-soft: cada uma vira
       *  1 entrada aqui, nunca aborta o dispatch — a próxima rodada tenta de
       *  novo, mesmo assinante ainda aparecerá como candidato). */
      backfillErrors?: string[];
    };

export function resolveKitDiariaStatePath(editionDir: string): string {
  return resolve(editionDir, "_internal", "kit-diaria-published.json");
}

/** Estado local ilegível — distinto de ausente. Ver `readKitDiariaState`. */
export class KitDiariaStateCorruptError extends Error {}

/**
 * Lê o estado desta edição. **Ausente ⇒ `null`; presente-mas-ilegível ⇒ lança.**
 *
 * A distinção é o ponto todo (achado CRÍTICO do review da PR #6138). Uma versão
 * anterior deste código devolvia `null` nos dois casos, com o comentário de que
 * recriar o broadcast seria "recuperável, o Kit devolve um id novo". **Isso
 * descreve o bug, não a recuperação:** um segundo broadcast para a mesma edição
 * é uma newsletter entregue em DOBRO à mesma audiência, e envio não se desfaz.
 *
 * E o cenário não é hipotético neste projeto: `data/editions/` mora na junction
 * do OneDrive, que já produziu conflito de sync corrompendo arquivo de estado
 * (mesmo modo de falha registrado em `data/sessions/`, #6130). Truncamento por
 * crash no meio de `writeFileSync` tem o mesmo efeito.
 *
 * Lançar força o caller a decidir explicitamente — e ele traduz em `failed`,
 * preservando o fail-soft (não derruba os demais publicadores) sem arriscar
 * duplicidade.
 */
export function readKitDiariaState(editionDir: string): KitDiariaPublished | null {
  const p = resolveKitDiariaStatePath(editionDir);
  if (!existsSync(p)) return null;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    throw new KitDiariaStateCorruptError(
      `${p} existe mas não pôde ser lido: ${(e as Error).message}. ` +
        `Recusando tratar como "não despachado" — risco de broadcast duplicado.`,
    );
  }
  try {
    return JSON.parse(raw) as KitDiariaPublished;
  } catch (e) {
    throw new KitDiariaStateCorruptError(
      `${p} existe mas não é JSON válido (${(e as Error).message}). ` +
        `Recusando tratar como "não despachado" — risco de broadcast duplicado. ` +
        `Confira no Kit se já existe broadcast desta edição; corrija ou remova o arquivo antes de re-rodar.`,
    );
  }
}

export function writeKitDiariaState(editionDir: string, state: KitDiariaPublished): void {
  const p = resolveKitDiariaStatePath(editionDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export interface Stage5KitDeps {
  readPlatformConfig(): {
    kit_diaria?: KitDiariaChannelConfig;
    publishing?: { newsletter?: { backend?: string } };
    /** #6195 — link de afiliado do Kit; vazio ⇒ crédito neutro. */
    kit?: { affiliate_url?: string; affiliate_offer_text?: string };
  };
  readState(editionDir: string): KitDiariaPublished | null;
  writeState(editionDir: string, state: KitDiariaPublished): void;
  findTagId(name: string): Promise<number | null>;
  /**
   * #6582 — conta membros da tag JÁ resolvida (id válido). Chamada depois de
   * `resolveAudienceTagId` aceitar o id, antes de montar o payload — é o
   * guard que fecha a lacuna de `checkAudienceTagHasMembers` (tag resolvida
   * mas vazia deixou de ser normal desde a migração das ondas 0/1, #6504).
   */
  countTagMembers(tagId: number): Promise<number>;
  /**
   * #7357 — lista candidatos ao resgate por data: ativos, criados on/after o
   * corte configurado, com a tag membership já embutida (pra
   * `subscribersNeedingBackfillTag` decidir quem precisa ser tagueado sem
   * mais 1 chamada por assinante). Só é chamada quando `resolveCreatedAfterCutoff`
   * devolve uma data — ver a docstring de `listActiveSubscribersCreatedAfter`
   * (`kit-broadcasts.ts`) para a parede de plataforma que motiva este desenho.
   */
  listCreatedAfterCandidates(createdAfterDate: string): Promise<{ id: number; tagIds: number[] }[]>;
  /** #7357 — aplica `audience_tag` (a MESMA tag, resolvida em `tagCheck.tagId`)
   *  a UM assinante que ficou preso pelo corte de data. Idempotente do lado
   *  do Kit (reaplicar uma tag já presente é um no-op seguro), mas o caller
   *  só chama para quem `subscribersNeedingBackfillTag` já filtrou. */
  tagSubscriber(tagId: number, subscriberId: number): Promise<void>;
  /**
   * #6582 — releitura pós-`createBroadcast` (mesma disciplina do #573: 2xx
   * não implica efeito). Verifica que o `subscriber_filter` de fato pegou —
   * ver a ressalva de "não confirmado ao vivo" em
   * `KitBroadcastDetail.subscriber_filter`.
   */
  getBroadcast(id: number): Promise<{ subscriber_filter?: unknown }>;
  /**
   * Monta o payload da edição (HTML + subject + preview).
   *
   * É dependência injetada, e não chamada direta, por um motivo específico
   * (achado do review da PR #6138): sem isso, `runStage5KitDispatch` só seria
   * testável com uma edição real em disco — e o teste que mais importa aqui é
   * justamente o do caminho FELIZ, onde se verifica que o `subscriber_filter`
   * entregue a `createBroadcast` é o da tag e não o da base inteira.
   */
  buildPayload(editionDir: string): {
    html: string;
    subject: string;
    previewText: string;
    unresolvedImages: string[];
    renderWarnings: string[];
    /** #6195 — diagnóstico: achou crédito da Beehiiv pra trocar? */
    creditoSubstituido?: boolean;
    /**
     * #6195 — **o guard**: sobrou menção à concorrente no HTML do Kit?
     * Precisa chegar ao JSON de stdout, não só ao stderr — mesma lição do
     * #6138 finding 4: warning só logado é warning que o editor nunca vê.
     */
    residuoBeehiiv?: boolean;
  };
  createBroadcast(input: {
    subject: string;
    content: string;
    preview_text: string;
    send_at: string | null;
    subscriber_filter: ReturnType<typeof buildTagFilter>;
  }): Promise<{ id: number }>;
  log(line: string): void;
  /** Injetável pra o `--send-test` ter horário determinístico em teste. */
  now(): number;
}

export function productionDeps(rootDir: string = ROOT): Stage5KitDeps {
  const log = (line: string) => process.stderr.write(`[kit-diaria stage5] ${line}\n`);
  // Hoisted: `buildPayload` também consome (crédito por canal, #6195) — como
  // propriedade do literal não estaria em escopo lá dentro.
  const readPlatformConfig: Stage5KitDeps["readPlatformConfig"] = () =>
    JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as ReturnType<
      Stage5KitDeps["readPlatformConfig"]
    >;
  return {
    readPlatformConfig,
    readState: readKitDiariaState,
    writeState: writeKitDiariaState,
    findTagId: (name) => findTagIdByName(name),
    countTagMembers: (tagId) => countKitTagMembers(tagId),
    listCreatedAfterCandidates: (createdAfterDate) => listActiveSubscribersCreatedAfter(createdAfterDate),
    tagSubscriber: (tagId, subscriberId) => tagSubscriber(tagId, subscriberId),
    getBroadcast: (id) => getBroadcast(id),
    buildPayload: (editionDir) => {
      const content = extractContent(editionDir);
      const imagesPath = resolve(editionDir, "06-public-images.json");
      const publicImages: PublicImagesFile = existsSync(imagesPath)
        ? (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesFile)
        : {};
      // #6195 — o crédito do rodapé precisa refletir o Kit, não a Beehiiv.
      // Config vazia ⇒ texto neutro (sem link), nunca o crédito errado.
      // Reusa `readPlatformConfig` (injetada) em vez de um readFileSync
      // próprio — achado P2 do review #6207: ler cru aqui contraria o motivo
      // documentado da injeção e impedia testar sem tocar disco.
      const kitCfg = readPlatformConfig().kit;
      const { html, unresolvedImages, renderWarnings, creditoSubstituido, residuoBeehiiv } = buildKitHtml(
        content,
        publicImages,
        { kitAffiliateUrl: kitCfg?.affiliate_url, kitOfferText: kitCfg?.affiliate_offer_text },
      );
      if (creditoSubstituido === false) {
        log("warn: [#6195] nenhum crédito da Beehiiv achado no 'Para encerrar' — nada a trocar.");
      }
      if (unresolvedImages.length > 0) {
        log(`warn: ${unresolvedImages.length} placeholder(s) de imagem sem URL: ${unresolvedImages.join(", ")}`);
      }
      if (renderWarnings.length > 0) {
        log(`warn: ${renderWarnings.length} evento(s) de conteúdo perdido no render Kit.`);
      }
      return {
        html,
        creditoSubstituido,
        residuoBeehiiv,
        subject: buildKitSubject(content),
        previewText: buildKitPreviewText(content),
        unresolvedImages,
        renderWarnings: renderWarnings.map((w) => w.event),
      };
    },
    createBroadcast: (input) => createBroadcast(input),
    log,
    now: () => Date.now(),
  };
}

export async function runStage5KitDispatch(
  editionDir: string,
  deps: Stage5KitDeps,
  opts: { dryRun?: boolean; sendTest?: boolean } = {},
): Promise<Stage5KitResult> {
  // #6138 finding 3: config e estado são I/O local e podem lançar
  // (`platform.config.json` malformado; estado corrompido, que
  // `readKitDiariaState` agora lança de propósito em vez de mascarar). Sem
  // este try, a exceção sobe crua e quebra a promessa de fail-soft do módulo.
  let decision: ReturnType<typeof decideKitChannelDispatch>;
  try {
    decision = decideKitChannelDispatch({
        config: deps.readPlatformConfig().kit_diaria,
      newsletterBackend: deps.readPlatformConfig().publishing?.newsletter?.backend,
      existing: deps.readState(editionDir),
      defaultAudienceTag: KIT_NATIVE_SIGNUP_MARKER,
    });
  } catch (e) {
    return { status: "failed", step: "readState/readPlatformConfig", reason: (e as Error).message };
  }

  if (decision.action === "already_done") {
    deps.log(`broadcast desta edição já existe (broadcast_id=${decision.broadcastId}) — no-op.`);
    return { status: "already_done", broadcastId: decision.broadcastId };
  }
  if (decision.action === "skip") {
    deps.log(`pulado: ${decision.reason}`);
    return { status: "skipped", reason: decision.reason };
  }

  // #6181: `--send-test` troca a audiência pela tag de teste (1 destinatário)
  // SEM tocar no resto do fluxo — mesmo payload, mesmo guard de resolução.
  // Existe porque `publish-newsletter-kit.ts --send-test` é gated por
  // `checkKitBackendEnabled` (exige backend "kit"), o OPOSTO deste canal: não
  // havia forma suportada de testar o HTML daqui antes de agendar.
  const audienceTag = opts.sendTest ? KIT_TEST_SEND_TAG_NAME : decision.audienceTag;
  if (opts.sendTest) deps.log(`--send-test: audiência trocada para "${audienceTag}"`);

  // Guard central (#6126): resolver a tag ANTES de montar qualquer coisa.
  // `findTagIdByName` NÃO cria a tag se faltar — ver docstring lá.
  let rawTagId: number | null;
  try {
    rawTagId = await deps.findTagId(audienceTag);
  } catch (e) {
    return { status: "failed", step: "findTagIdByName", reason: (e as Error).message };
  }
  const tagCheck = resolveAudienceTagId(audienceTag, rawTagId);
  if (!tagCheck.ok) {
    deps.log(`pulado: ${tagCheck.reason}`);
    return { status: "skipped", reason: tagCheck.reason };
  }

  // #7357 — resgate por data: quem foi criado on/after o corte configurado
  // e ainda não tem a tag de audiência é tagueado AGORA, antes de contar
  // membros/montar o filtro — nunca em `--send-test` (a tag ali é a de teste,
  // sem relação com o resgate de produção). Fail-soft por assinante: um erro
  // isolado não aborta o dispatch, só fica pra próxima rodada resgatar.
  let backfillTaggedCount: number | undefined;
  let backfillErrors: string[] | undefined;
  // #7370 (achado do fleet review pré-merge, P1): `--dry-run` promete não
  // tocar em nada, mas o backfill abaixo é escrita real (`tagSubscriber`) na
  // API do Kit — sem o guard `!opts.dryRun`, rodar em preview ainda assim
  // taggeava assinantes reais com a tag de produção. `countTagMembers` (mais
  // abaixo) continua rodando incondicionalmente pois é só leitura.
  if (!opts.sendTest && !opts.dryRun) {
    const cutoff = resolveCreatedAfterCutoff(deps.readPlatformConfig().kit_diaria);
    if (cutoff) {
      let candidates: { id: number; tagIds: number[] }[];
      try {
        candidates = await deps.listCreatedAfterCandidates(cutoff);
      } catch (e) {
        // Fail-soft (mesma disciplina da releitura pós-dispatch abaixo): o
        // resgate por data é um passo ADICIONAL sobre o caminho tag-only já
        // funcional — falha dele não deve impedir o envio de hoje pra quem já
        // está na tag. Reporta como erro no resultado, segue o dispatch.
        backfillErrors = [`listCreatedAfterCandidates: ${(e as Error).message}`];
        deps.log(`aviso: resgate por data (corte ${cutoff}) falhou ao listar candidatos: ${(e as Error).message}`);
        candidates = [];
      }
      const toTag = subscribersNeedingBackfillTag(candidates, tagCheck.tagId);
      const errors: string[] = backfillErrors ?? [];
      let tagged = 0;
      for (const subscriberId of toTag) {
        try {
          await deps.tagSubscriber(tagCheck.tagId, subscriberId);
          tagged += 1;
        } catch (e) {
          errors.push(`tagSubscriber(${subscriberId}): ${(e as Error).message}`);
        }
      }
      backfillTaggedCount = tagged;
      if (errors.length > 0) backfillErrors = errors;
      if (tagged > 0) {
        deps.log(`resgate por data (corte ${cutoff}): ${tagged}/${toTag.length} assinante(s) tagueado(s).`);
      }
    }
  }

  // #6582 — guard de invariante: tag RESOLVIDA (id válido) mas VAZIA (0
  // membros) deixou de ser normal desde a migração das ondas 0/1 (#6504).
  // `failed`, não `skipped` — a severidade precisa ser alta o bastante pra
  // não ser lida como "estado normal" (era exatamente essa leitura, aplicada
  // a `skipped` genérico, que causou o incidente descrito na issue).
  let memberCount: number;
  try {
    memberCount = await deps.countTagMembers(tagCheck.tagId);
  } catch (e) {
    return { status: "failed", step: "countTagMembers", reason: (e as Error).message };
  }
  const membershipCheck = checkAudienceTagHasMembers(audienceTag, memberCount);
  if (!membershipCheck.ok) {
    // #6701: `checkAudienceTagHasMembers` só conhece o caminho de PRODUÇÃO —
    // sua mensagem fala das "92 pessoas das ondas 0/1" e "Kit é o único canal
    // alcançável", que é verdade para `decision.audienceTag` mas não faz
    // sentido para `KIT_TEST_SEND_TAG_NAME` (uma tag de teste, sem relação
    // com a migração das ondas 0/1). Sob `--send-test`, `audienceTag` já foi
    // trocado (linha acima) — a mensagem precisa acompanhar essa troca.
    const reason = opts.sendTest
      ? `tag de teste "${audienceTag}" (KIT_TEST_SEND_TAG_NAME) está VAZIA — 0 membros. Popule-a no ` +
        `Kit com ao menos 1 assinante de teste antes de rodar --send-test; sem membros o broadcast de ` +
        `teste não teria destinatário nenhum.`
      : membershipCheck.reason;
    return { status: "failed", step: "audienceTagEmpty", reason };
  }

  let html: string;
  let subject: string;
  let previewText: string;
  let unresolvedImages: string[];
  let renderWarnings: string[];
  let creditoSubstituido: boolean | undefined;
  let residuoBeehiiv: boolean | undefined;
  try {
    ({ html, subject, previewText, unresolvedImages, renderWarnings, creditoSubstituido, residuoBeehiiv } = deps.buildPayload(editionDir));
  } catch (e) {
    return { status: "failed", step: "buildPayload", reason: (e as Error).message };
  }
  // #6195 (achado P0 do review #6207) — guard de saída. Recusa criar o
  // broadcast se o HTML do Kit ainda mencionar a concorrente: significa que a
  // copy do rodapé foi reescrita (Clarice/humanizador, precedente #1982) e a
  // âncora não casou. `failed` mantém o fail-soft do canal — não derruba os
  // demais publicadores — mas nunca publica o link da Beehiiv numa edição Kit.
  if (residuoBeehiiv) {
    return {
      status: "failed",
      step: "creditoCanal",
      reason:
        "o HTML do Kit ainda menciona a Beehiiv — a copy do 'Para encerrar' provavelmente mudou " +
        "e a troca de crédito (#6195) não casou. Recusando publicar o link da concorrente.",
    };
  }
  const subjectCheck = checkSubjectNotEmpty(subject);
  if (!subjectCheck.ok) {
    return { status: "failed", step: "buildKitSubject", reason: subjectCheck.reason };
  }

  if (opts.dryRun) {
    deps.log(`[dry-run] audiência: tag "${audienceTag}" (id=${tagCheck.tagId})`);
    deps.log(`[dry-run] subject: "${subject}" · html: ${html.length} bytes`);
    return { status: "skipped", reason: "dry-run" };
  }

  let created: { id: number };
  try {
    created = await deps.createBroadcast({
      subject,
      content: html,
      preview_text: previewText,
      // Rascunho: a Etapa 6 é quem agenda, sob o MESMO gate do Schedule da
      // Beehiiv — mesma divisão 5/6 do canal Brevo (#5772).
      // Teste dispara sozinho em ~1 min; produção nasce rascunho (Etapa 6 agenda).
      send_at: opts.sendTest ? new Date(deps.now() + 60_000).toISOString() : null,
      subscriber_filter: buildTagFilter(tagCheck.tagId),
    });
  } catch (e) {
    return { status: "failed", step: "createBroadcast", reason: (e as Error).message };
  }

  // #6582 (item 2 da issue) — verificação pós-dispatch: o broadcast JÁ EXISTE
  // no Kit a partir daqui (mesma disciplina de "2xx não implica efeito" do
  // #573/#6181). Releitura confirma que o `subscriber_filter` que a API
  // aceitou é de fato o da tag esperada, não algo diferente aplicado em
  // silêncio. `subscriber_filter` ausente na releitura não é tratado como
  // divergência — não há confirmação ao vivo de que `GET /broadcasts/{id}`
  // ecoa esse campo (ver docstring de `KitBroadcastDetail.subscriber_filter`)
  // — só como "não confirmável", registrado no resultado pra quem lê o
  // resumo saber que esta camada não pôde atestar a audiência.
  let audienceFilterVerified: boolean | undefined;
  try {
    const reread = await deps.getBroadcast(created.id);
    if (reread.subscriber_filter !== undefined) {
      const expected = buildTagFilter(tagCheck.tagId);
      const matches = JSON.stringify(reread.subscriber_filter) === JSON.stringify(expected);
      if (!matches) {
        // #6693: o broadcast JÁ EXISTE no Kit a partir daqui (efeito externo
        // real) — retornar `failed` sem persistir `broadcast_id` fazia o
        // RESUME automático não achar `existing.broadcast_id`,
        // `decideKitChannelDispatch` decidir `dispatch` de novo, e criar um
        // SEGUNDO broadcast duplicado para a mesma edição. Persistir ANTES de
        // retornar — com `audience_verified: false` — é o que faz o próximo
        // `decideKitChannelDispatch` cair em `already_done` em vez de
        // recomeçar do zero, mesma disciplina do bloco `writeState` mais
        // abaixo (#6138 finding 2) aplicada a este 2º ponto de saída.
        let persistError: string | undefined;
        try {
          deps.writeState(editionDir, {
            broadcast_id: created.id,
            subject,
            preview_text: previewText,
            audience_tag: audienceTag,
            audience_tag_id: tagCheck.tagId,
            status: "draft",
            audience_verified: false,
          });
        } catch (e) {
          persistError = (e as Error).message;
        }
        return {
          status: "failed",
          step: "verifyBroadcastAudience",
          reason:
            `broadcast_id=${created.id} JÁ FOI CRIADO no Kit, mas a releitura mostra subscriber_filter ` +
            `divergente do esperado (tag "${audienceTag}" id ${tagCheck.tagId}) — a API aceitou 2xx sem ` +
            `aplicar o filtro certo. NÃO re-rodar sem conferir/corrigir no Kit — risco de broadcast já ` +
            `existente com audiência errada.` +
            (persistError
              ? ` ADICIONALMENTE, o estado local não pôde ser gravado (${persistError}) — o resume NÃO vai ` +
                `reconhecer este broadcast e pode criar um 2º duplicado; corrigir manualmente antes de re-rodar.`
              : ` broadcast_id gravado em ${resolveKitDiariaStatePath(editionDir)} com audience_verified:false ` +
                `— o resume vai reconhecer este broadcast como já existente e não vai criar um 2º.`),
        };
      }
      audienceFilterVerified = true;
    } else {
      deps.log(
        `aviso: releitura de broadcast_id=${created.id} não trouxe 'subscriber_filter' — verificação ` +
          `pós-dispatch não pôde confirmar a audiência (campo não confirmado ao vivo na API do Kit).`,
      );
      audienceFilterVerified = false;
    }
  } catch (e) {
    // Fail-soft: a releitura é uma camada de verificação ADICIONAL — o
    // broadcast já existe independente dela. Falha de rede aqui não deve
    // reportar o dispatch inteiro como `failed`, só que a audiência não foi
    // confirmada.
    deps.log(
      `aviso: releitura pós-dispatch de broadcast_id=${created.id} falhou: ${(e as Error).message} — ` +
        `audiência não confirmada.`,
    );
    audienceFilterVerified = false;
  }

  if (opts.sendTest) {
    // Descartável: NÃO grava estado — senão o dispatch de produção veria
    // `already_done` e nunca criaria o broadcast real desta edição.
    deps.log(`test-send criado: broadcast_id=${created.id} → tag "${audienceTag}"`);
    return {
      status: "ok",
      broadcastId: created.id,
      audienceTag,
      audienceTagId: tagCheck.tagId,
      unresolvedImages,
      renderWarnings,
      creditoSubstituido,
      residuoBeehiiv,
      audienceFilterVerified,
    };
  }

  // #6138 finding 2: o broadcast JÁ EXISTE no Kit a partir daqui. Se a escrita
  // do estado local falhar (disco, permissão, conflito de sync do OneDrive —
  // ver #6130) e a exceção subir crua, o resume seguinte não acha estado,
  // decide `dispatch` de novo, e cria um SEGUNDO broadcast para a mesma
  // edição. Capturar e dizer explicitamente que o broadcast já foi criado é o
  // que permite a quem lê o resumo agir antes de re-rodar.
  try {
    deps.writeState(editionDir, {
      broadcast_id: created.id,
      subject,
      preview_text: previewText,
      audience_tag: audienceTag,
      audience_tag_id: tagCheck.tagId,
      status: "draft",
    });
  } catch (e) {
    return {
      status: "failed",
      step: "writeState",
      reason:
        `broadcast_id=${created.id} JÁ FOI CRIADO no Kit, mas o estado local não pôde ser gravado: ` +
        `${(e as Error).message}. NÃO re-rodar sem conferir no Kit — risco de broadcast duplicado.`,
    };
  }

  deps.log(`draft criado: broadcast_id=${created.id} · audiência: tag "${audienceTag}" (id=${tagCheck.tagId})`);
  if (unresolvedImages.length > 0 || renderWarnings.length > 0) {
    deps.log(
      `⚠️ concluído COM avisos: ${unresolvedImages.length} imagem(ns) sem URL, ` +
        `${renderWarnings.length} evento(s) de render — ver o JSON do resultado.`,
    );
  }
  return {
    status: "ok",
    broadcastId: created.id,
    audienceTag,
    audienceTagId: tagCheck.tagId,
    unresolvedImages,
    renderWarnings,
    creditoSubstituido,
    residuoBeehiiv,
    audienceFilterVerified,
    backfillTaggedCount,
    backfillErrors,
  };
}

export async function main(): Promise<void> {
  loadProjectEnv();
  const argv = process.argv.slice(2);
  const editionDirArg = argv.find((a) => !a.startsWith("--"));
  if (!editionDirArg) {
    console.error("uso: npx tsx scripts/kit-diaria-stage5-dispatch.ts <edition-dir> [--dry-run] [--send-test]");
    process.exitCode = 1;
    return;
  }
  // #6138 finding 3: try/catch de último recurso. O contrato deste script é
  // "SEMPRE imprime JSON parseável em stdout" — o orchestrator lê o JSON pra
  // montar o resumo da Etapa 5. Uma exceção inesperada escapando daqui
  // quebraria esse contrato com um stack trace cru, e o canal sumiria do
  // resumo em vez de aparecer como falha.
  let result: Stage5KitResult;
  try {
    result = await runStage5KitDispatch(resolve(ROOT, editionDirArg), productionDeps(), {
      dryRun: hasFlag(argv, "dry-run"),
      sendTest: hasFlag(argv, "send-test"),
    });
  } catch (e) {
    result = { status: "failed", step: "unexpected", reason: (e as Error).message };
  }
  console.log(JSON.stringify(result, null, 2));
  // Espelha `brevo-diaria-stage5-dispatch.ts:248` (#6138 finding 6): exit 1 em
  // `failed`. Fail-soft continua valendo — quem garante que a Etapa 5 não cai
  // é o orchestrator, que trata este canal como opcional e lê o `status` do
  // JSON; o exit code existe pra invocação manual/CI não reportar sucesso
  // falso.
  process.exitCode = result.status === "failed" ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  await main();
}

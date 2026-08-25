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
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, isMainModule } from "./lib/cli-args.ts";
import { extractContent } from "./lib/newsletter-parse.ts";
import { buildKitHtml, buildKitSubject, buildKitPreviewText, checkSubjectNotEmpty } from "./publish-newsletter-kit.ts";
import type { PublicImagesFile } from "./substitute-image-urls.ts";
import { createBroadcast, findTagIdByName, buildTagFilter } from "./lib/kit-broadcasts.ts";
import { KIT_NATIVE_SIGNUP_MARKER } from "./lib/shared/kit-signup-origin.ts";
import {
  decideKitChannelDispatch,
  resolveAudienceTagId,
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
  };
  readState(editionDir: string): KitDiariaPublished | null;
  writeState(editionDir: string, state: KitDiariaPublished): void;
  findTagId(name: string): Promise<number | null>;
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
  };
  createBroadcast(input: {
    subject: string;
    content: string;
    preview_text: string;
    send_at: null;
    subscriber_filter: ReturnType<typeof buildTagFilter>;
  }): Promise<{ id: number }>;
  log(line: string): void;
}

export function productionDeps(rootDir: string = ROOT): Stage5KitDeps {
  const log = (line: string) => process.stderr.write(`[kit-diaria stage5] ${line}\n`);
  return {
    readPlatformConfig: () =>
      JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as {
        kit_diaria?: KitDiariaChannelConfig;
      },
    readState: readKitDiariaState,
    writeState: writeKitDiariaState,
    findTagId: (name) => findTagIdByName(name),
    buildPayload: (editionDir) => {
      const content = extractContent(editionDir);
      const imagesPath = resolve(editionDir, "06-public-images.json");
      const publicImages: PublicImagesFile = existsSync(imagesPath)
        ? (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesFile)
        : {};
      const { html, unresolvedImages, renderWarnings } = buildKitHtml(content, publicImages);
      if (unresolvedImages.length > 0) {
        log(`warn: ${unresolvedImages.length} placeholder(s) de imagem sem URL: ${unresolvedImages.join(", ")}`);
      }
      if (renderWarnings.length > 0) {
        log(`warn: ${renderWarnings.length} evento(s) de conteúdo perdido no render Kit.`);
      }
      return {
        html,
        subject: buildKitSubject(content),
        previewText: buildKitPreviewText(content),
        unresolvedImages,
        renderWarnings: renderWarnings.map((w) => w.event),
      };
    },
    createBroadcast: (input) => createBroadcast(input),
    log,
  };
}

export async function runStage5KitDispatch(
  editionDir: string,
  deps: Stage5KitDeps,
  opts: { dryRun?: boolean } = {},
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

  const { audienceTag } = decision;

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

  let html: string;
  let subject: string;
  let previewText: string;
  let unresolvedImages: string[];
  let renderWarnings: string[];
  try {
    ({ html, subject, previewText, unresolvedImages, renderWarnings } = deps.buildPayload(editionDir));
  } catch (e) {
    return { status: "failed", step: "buildPayload", reason: (e as Error).message };
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
      send_at: null,
      subscriber_filter: buildTagFilter(tagCheck.tagId),
    });
  } catch (e) {
    return { status: "failed", step: "createBroadcast", reason: (e as Error).message };
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
  };
}

export async function main(): Promise<void> {
  loadProjectEnv();
  const argv = process.argv.slice(2);
  const editionDirArg = argv.find((a) => !a.startsWith("--"));
  if (!editionDirArg) {
    console.error("uso: npx tsx scripts/kit-diaria-stage5-dispatch.ts <edition-dir> [--dry-run]");
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

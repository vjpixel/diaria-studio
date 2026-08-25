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
  | { status: "ok"; broadcastId: number; audienceTag: string; audienceTagId: number };

export function resolveKitDiariaStatePath(editionDir: string): string {
  return resolve(editionDir, "_internal", "kit-diaria-published.json");
}

export function readKitDiariaState(editionDir: string): KitDiariaPublished | null {
  const p = resolveKitDiariaStatePath(editionDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as KitDiariaPublished;
  } catch {
    // Estado ilegível é tratado como ausente de propósito: recriar o broadcast
    // é recuperável (o Kit devolve um id novo e regravamos), enquanto abortar
    // deixaria a edição sem o canal sem motivo claro.
    return null;
  }
}

export function writeKitDiariaState(editionDir: string, state: KitDiariaPublished): void {
  const p = resolveKitDiariaStatePath(editionDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export interface Stage5KitDeps {
  readPlatformConfig(): { kit_diaria?: KitDiariaChannelConfig };
  readState(editionDir: string): KitDiariaPublished | null;
  writeState(editionDir: string, state: KitDiariaPublished): void;
  findTagId(name: string): Promise<number | null>;
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
  return {
    readPlatformConfig: () =>
      JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as {
        kit_diaria?: KitDiariaChannelConfig;
      },
    readState: readKitDiariaState,
    writeState: writeKitDiariaState,
    findTagId: (name) => findTagIdByName(name),
    createBroadcast: (input) => createBroadcast(input),
    log: (line) => process.stderr.write(`[kit-diaria stage5] ${line}\n`),
  };
}

export async function runStage5KitDispatch(
  editionDir: string,
  deps: Stage5KitDeps,
  opts: { dryRun?: boolean } = {},
): Promise<Stage5KitResult> {
  const decision = decideKitChannelDispatch({
    config: deps.readPlatformConfig().kit_diaria,
    existing: deps.readState(editionDir),
    defaultAudienceTag: KIT_NATIVE_SIGNUP_MARKER,
  });

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

  const content = extractContent(editionDir);
  const imagesPath = resolve(editionDir, "06-public-images.json");
  const publicImages: PublicImagesFile = existsSync(imagesPath)
    ? (JSON.parse(readFileSync(imagesPath, "utf8")) as PublicImagesFile)
    : {};

  const { html, unresolvedImages, renderWarnings } = buildKitHtml(content, publicImages);
  if (unresolvedImages.length > 0) {
    deps.log(`warn: ${unresolvedImages.length} placeholder(s) de imagem sem URL: ${unresolvedImages.join(", ")}`);
  }
  if (renderWarnings.length > 0) {
    deps.log(`warn: ${renderWarnings.length} evento(s) de conteúdo perdido no render Kit.`);
  }

  const subject = buildKitSubject(content);
  const previewText = buildKitPreviewText(content);
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

  deps.writeState(editionDir, {
    broadcast_id: created.id,
    subject,
    preview_text: previewText,
    audience_tag: audienceTag,
    audience_tag_id: tagCheck.tagId,
    status: "draft",
  });

  deps.log(`draft criado: broadcast_id=${created.id} · audiência: tag "${audienceTag}" (id=${tagCheck.tagId})`);
  return { status: "ok", broadcastId: created.id, audienceTag, audienceTagId: tagCheck.tagId };
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
  const result = await runStage5KitDispatch(resolve(ROOT, editionDirArg), productionDeps(), {
    dryRun: hasFlag(argv, "dry-run"),
  });
  // Fail-soft: `failed` NÃO derruba a Etapa 5 (exit 0 com aviso), mesma
  // disciplina do canal Brevo. O orchestrator lê o JSON pra montar o resumo.
  console.log(JSON.stringify(result, null, 2));
}

if (isMainModule(import.meta.url)) {
  await main();
}

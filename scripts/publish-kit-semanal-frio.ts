#!/usr/bin/env node
/**
 * scripts/publish-kit-semanal-frio.ts (#11221)
 *
 * Toda segunda, um 2º broadcast no Kit com a MESMA edição da diária, só pra
 * tag `frio`, com o intro de reconfirmação + botão "Quero a diária" no topo
 * (texto literal em `lib/kit-frio.ts`). Sai junto com a diária: mesmo
 * `send_at` do broadcast principal.
 *
 * ## Onde roda
 *
 * Chamado por `schedule-newsletter-kit.ts` (Etapa 6) logo depois de o
 * broadcast principal ser agendado e confirmado, fail-soft (nunca muda o exit
 * code do agendamento da diária). Também roda à mão:
 *
 *   npx tsx scripts/publish-kit-semanal-frio.ts --edition-dir <dir>          # dry-run
 *   npx tsx scripts/publish-kit-semanal-frio.ts --edition-dir <dir> --push   # cria + agenda
 *
 * ## Conteúdo
 *
 * O conteúdo é o do broadcast PRINCIPAL já agendado (relido por
 * `GET /broadcasts/{id}`), com o intro inserido no começo: é o mesmo texto
 * que o editor aprovou no gate da Etapa 4, sem re-render. Assunto e preview
 * iguais; `public: false` (a edição já tem a página pública do principal).
 *
 * ## Guards de audiência (#6126, #6582, #7651)
 *
 * Um `subscriber_filter` não resolvido no Kit manda pra base INTEIRA. Por isso:
 * - tag `frio` inexistente ⇒ recusa; com 0 membros ⇒ não cria (nada a mandar);
 * - depois de criar, RELÊ o broadcast e confere o filtro (tag `frio`); relido
 *   divergente ou ausente ⇒ APAGA o broadcast recém-criado e sai 1;
 * - vigia pausada (`data/kit-frio/semanal-pause.json`) ⇒ não cria.
 *
 * Exit: 0 criado/idempotente/pulado (desligado, não é segunda, pausado, tag
 * vazia); 1 falha (API, filtro não confirmado); 2 precondição (principal não
 * agendado, tag inexistente, config).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import { getBroadcast, type KitBroadcastDetail } from "./lib/kit-client.ts";
import {
  buildTagFilter,
  countKitTagMembers,
  createBroadcast,
  deleteBroadcast,
  findTagIdByName,
  type CreateBroadcastInput,
} from "./lib/kit-broadcasts.ts";
import { verifyDiariaAudienceFilter } from "./lib/kit-diaria-audience.ts";
import { isMondayEdition } from "./lib/brevo-diaria-semanal.ts";
import { tryResolveEditionDirArg } from "./lib/resolve-edition-dir-arg.ts";
import { readPublishedState, type KitNewsletterPublished } from "./publish-newsletter-kit.ts";
import { readSemanalFrioPause } from "./sync-kit-frio.ts";
import {
  KIT_FRIO_TAG_NAME,
  KIT_SEMANAL_FRIO_PUBLISHED_FILENAME,
  injectSemanalFrioIntro,
  isKitSemanalFrioEnabled,
  type KitFrioConfig,
  type KitSemanalFrioPublished,
  type SemanalFrioPauseState,
} from "./lib/kit-frio.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface SemanalFrioPublishDeps {
  log: (msg: string) => void;
  nowIso: () => string;
  readMainState: (editionDir: string) => KitNewsletterPublished | null;
  readOwnState: (editionDir: string) => KitSemanalFrioPublished | null;
  writeOwnState: (editionDir: string, s: KitSemanalFrioPublished) => void;
  readPause: () => SemanalFrioPauseState;
  findTagId: (name: string) => Promise<number | null>;
  countTagMembers: (tagId: number) => Promise<number>;
  getBroadcast: (id: number) => Promise<KitBroadcastDetail>;
  createBroadcast: (input: CreateBroadcastInput) => Promise<KitBroadcastDetail>;
  deleteBroadcast: (id: number) => Promise<void>;
}

export type SemanalFrioPublishResult =
  | { code: 0; status: "disabled" | "not_monday" | "paused" | "empty_tag" | "already_done" | "dry_run" | "scheduled"; broadcastId?: number; reason?: string }
  | { code: 1 | 2; status: "failed"; reason: string };

export async function publishKitSemanalFrio(
  editionDir: string,
  cfg: { kit?: { frio?: KitFrioConfig } },
  opts: { push: boolean },
  deps: SemanalFrioPublishDeps,
): Promise<SemanalFrioPublishResult> {
  const { log } = deps;
  if (!isKitSemanalFrioEnabled(cfg.kit?.frio)) return { code: 0, status: "disabled", reason: "kit.frio.semanal_enabled = false (#11221)." };
  const edition = basename(editionDir);
  if (!isMondayEdition(edition)) return { code: 0, status: "not_monday", reason: `edição ${edition} não é de segunda.` };
  const own = deps.readOwnState(editionDir);
  if (own && typeof own.broadcast_id === "number") {
    return { code: 0, status: "already_done", broadcastId: own.broadcast_id };
  }
  const pause = deps.readPause();
  if (pause.paused) {
    return { code: 0, status: "paused", reason: `vigia pausou a semanal (${(pause.reasons ?? []).join("; ") || "sem motivo registrado"}).` };
  }
  const main = deps.readMainState(editionDir);
  if (!main || main.status !== "scheduled" || typeof main.scheduled_at !== "string" || typeof main.broadcast_id !== "number") {
    return { code: 2, status: "failed", reason: "broadcast principal da diária não está agendado (newsletter-kit-published.json) — a semanal sai junto dele." };
  }
  const tagId = await deps.findTagId(KIT_FRIO_TAG_NAME);
  if (tagId === null) return { code: 2, status: "failed", reason: `tag "${KIT_FRIO_TAG_NAME}" não existe no Kit — recusado (#6126: filtro não resolvido = base inteira).` };
  const members = await deps.countTagMembers(tagId);
  if (members === 0) return { code: 0, status: "empty_tag", reason: `tag "${KIT_FRIO_TAG_NAME}" sem membros — nada a enviar.` };

  const source = await deps.getBroadcast(main.broadcast_id);
  if (!source.content) return { code: 1, status: "failed", reason: `broadcast principal ${main.broadcast_id} sem content no GET.` };
  const filter = buildTagFilter(tagId);
  const input: CreateBroadcastInput = {
    subject: source.subject,
    preview_text: source.preview_text ?? main.preview_text,
    content: injectSemanalFrioIntro(source.content),
    description: `Semanal frio (#11221) — edição ${edition}`,
    public: false,
    send_at: main.scheduled_at,
    email_template_id: source.email_template?.id,
    email_address: source.email_address,
    subscriber_filter: filter,
  };
  if (!opts.push) {
    log(`[dry-run] criaria a semanal de frio pra ${members} assinante(s), send_at ${main.scheduled_at}, filtro tag ${tagId}.`);
    return { code: 0, status: "dry_run", reason: `${members} membro(s) na tag ${KIT_FRIO_TAG_NAME}.` };
  }
  const created = await deps.createBroadcast(input);
  const reread = await deps.getBroadcast(created.id);
  const verdict = verifyDiariaAudienceFilter(reread.subscriber_filter, filter);
  if (!verdict.ok) {
    try {
      await deps.deleteBroadcast(created.id);
    } catch (e) {
      return {
        code: 1,
        status: "failed",
        reason: `filtro relido não confere (${verdict.reason}) e o broadcast ${created.id} NÃO foi apagado (${(e as Error).message}) — apagar à mão AGORA.`,
      };
    }
    return { code: 1, status: "failed", reason: `filtro relido não confere (${verdict.reason}) — broadcast ${created.id} apagado.` };
  }
  deps.writeOwnState(editionDir, {
    broadcast_id: created.id,
    status: "scheduled",
    scheduled_at: main.scheduled_at,
    source_broadcast_id: main.broadcast_id,
    tag_id: tagId,
    created_at: deps.nowIso(),
  });
  log(`semanal de frio ${created.id} agendada pra ${main.scheduled_at} (${members} na tag ${KIT_FRIO_TAG_NAME}, filtro confirmado).`);
  return { code: 0, status: "scheduled", broadcastId: created.id };
}

function ownStatePath(editionDir: string): string {
  return resolve(editionDir, "_internal", KIT_SEMANAL_FRIO_PUBLISHED_FILENAME);
}

export function productionSemanalFrioDeps(log: (msg: string) => void): SemanalFrioPublishDeps {
  return {
    log,
    nowIso: () => new Date().toISOString(),
    readMainState: (dir) => readPublishedState(dir),
    readOwnState: (dir) => (existsSync(ownStatePath(dir)) ? (JSON.parse(readFileSync(ownStatePath(dir), "utf8")) as KitSemanalFrioPublished) : null),
    writeOwnState: (dir, s) => {
      mkdirSync(dirname(ownStatePath(dir)), { recursive: true });
      writeFileSync(ownStatePath(dir), JSON.stringify(s, null, 2) + "\n");
    },
    readPause: () => readSemanalFrioPause(),
    findTagId: (name) => findTagIdByName(name),
    countTagMembers: (id) => countKitTagMembers(id),
    getBroadcast: (id) => getBroadcast(id),
    createBroadcast: (input) => createBroadcast(input),
    deleteBroadcast: (id) => deleteBroadcast(id),
  };
}

/** Entrada fail-soft pro `schedule-newsletter-kit.ts`: nunca lança. */
export async function runSemanalFrioAfterSchedule(
  editionDir: string,
  log: (msg: string) => void,
  rootDir: string = ROOT,
): Promise<SemanalFrioPublishResult> {
  try {
    const cfg = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as { kit?: { frio?: KitFrioConfig } };
    if (!isKitSemanalFrioEnabled(cfg.kit?.frio)) return { code: 0, status: "disabled" };
    return await publishKitSemanalFrio(editionDir, cfg, { push: true }, productionSemanalFrioDeps(log));
  } catch (e) {
    return { code: 1, status: "failed", reason: (e as Error).message };
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const log = (msg: string) => process.stderr.write(`[publish-kit-semanal-frio] ${msg}\n`);
  const arg = getStringArg(argv, "edition-dir");
  if (!arg) {
    log("uso: npx tsx scripts/publish-kit-semanal-frio.ts --edition-dir <dir> [--push]");
    process.exitCode = 2;
    return;
  }
  const resolved = tryResolveEditionDirArg(arg, { root: ROOT });
  if (!resolved.ok) {
    log(`ERRO: ${resolved.error}`);
    process.exitCode = 2;
    return;
  }
  const kitCfg = resolveKitConfig();
  if (!kitCfg.ok) {
    log(`ERRO: ${kitCfg.reason}`);
    process.exitCode = 2;
    return;
  }
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as { kit?: { frio?: KitFrioConfig } };
  const result = await publishKitSemanalFrio(resolved.editionDir, cfg, { push: hasFlag(argv, "push") }, productionSemanalFrioDeps(log));
  if ("reason" in result && result.reason) log(result.reason);
  console.log(JSON.stringify(result));
  process.exitCode = result.code;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    process.stderr.write(`[publish-kit-semanal-frio] erro fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}

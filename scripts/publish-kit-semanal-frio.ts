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
 * broadcast principal ser agendado e confirmado. Nunca muda o exit code do
 * agendamento da diária, mas o resultado vai no JSON dele (`semanal_frio`).
 * Também roda à mão:
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
 * - `kit.frio` precisa estar PLENAMENTE ligado (`parseKitFrio().fullyOn`:
 *   flags + segmento da diária confirmado excluindo `frio`); só `enabled` ⇒
 *   recusa (exit 2): sem o segmento, quem tem `frio` receberia a edição de
 *   segunda duas vezes;
 * - tag `frio` inexistente ⇒ recusa; com 0 membros ⇒ não cria (nada a mandar);
 * - cria como RASCUNHO (sem `send_at`) e grava `created_unverified` com o id
 *   ANTES de reler: se algo cair depois do POST, a rodada seguinte retoma o
 *   mesmo broadcast em vez de criar outro;
 * - relê e confere o filtro (exatamente a tag `frio`); divergente ⇒ APAGA e
 *   sai 1. Se o DELETE falhar, abre issue de alarme e sai 1;
 * - só então agenda (`send_at` do principal), relê (status `scheduled`,
 *   `send_at` e filtro) e grava `scheduled`;
 * - vigia pausada (`data/kit-frio/semanal-pause.json`) ⇒ não cria.
 *
 * ## Acompanha o principal depois de agendada (#11294 item 2)
 *
 * Semanal já `scheduled` e o principal reagendado ⇒ re-PATCH pro novo
 * `send_at` (relido); principal fora de `scheduled` (desagendado) ⇒ desagenda
 * a semanal e volta o estado pra `created_unverified`, que o próximo
 * agendamento do principal retoma. O `schedule-newsletter-kit.ts` chama com
 * `followOnly` quando o agendamento do principal falha ou é desfeito.
 *
 * Exit: 0 criado/idempotente/pulado (desligado, não é segunda, pausado, tag
 * vazia); 1 falha (API, filtro não confirmado, agendamento não confirmado);
 * 2 precondição (principal não agendado, tag inexistente, config, flags
 * parciais).
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
  updateBroadcast,
  type CreateBroadcastInput,
} from "./lib/kit-broadcasts.ts";
import { verifyDiariaAudienceFilter } from "./lib/kit-diaria-audience.ts";
import { isMondayEdition } from "./lib/brevo-diaria-semanal.ts";
import { tryResolveEditionDirArg } from "./lib/resolve-edition-dir-arg.ts";
import { readPublishedState, type KitNewsletterPublished } from "./publish-newsletter-kit.ts";
import { raiseKitFrioAlarm, readSemanalFrioPause } from "./sync-kit-frio.ts";
import {
  KIT_FRIO_TAG_NAME,
  KIT_SEMANAL_FRIO_PUBLISHED_FILENAME,
  injectSemanalFrioIntro,
  kitFrioNotFullyOnReason,
  parseKitFrio,
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
  /** PATCH de `send_at` (agendamento; `null` desagenda, #11294). */
  scheduleBroadcast: (id: number, sendAt: string | null) => Promise<void>;
  deleteBroadcast: (id: number) => Promise<void>;
  /** Issue de alarme: broadcast com filtro divergente que NÃO foi apagado. Fail-soft no caller. */
  raiseAlarm: (title: string, body: string) => void;
}

export type SemanalFrioPublishResult =
  | {
      code: 0;
      status:
        | "disabled"
        | "not_monday"
        | "paused"
        | "empty_tag"
        | "already_done"
        | "dry_run"
        | "scheduled"
        // #11294 item 2 — a semanal já agendada acompanhou o principal.
        | "rescheduled"
        | "unscheduled"
        // `followOnly` sem semanal agendada: nada a fazer.
        | "nothing_to_follow";
      broadcastId?: number;
      reason?: string;
    }
  | { code: 1 | 2; status: "failed"; reason: string; broadcastId?: number };

/** Config que o publisher lê (`kit.frio` + `kit.diaria_exclusion_segment`, via `parseKitFrio`). */
export interface SemanalFrioPlatformConfig {
  kit?: unknown;
}

const sameInstant = (a: string | null | undefined, b: string) => typeof a === "string" && Date.parse(a) === Date.parse(b);

export async function publishKitSemanalFrio(
  editionDir: string,
  cfg: SemanalFrioPlatformConfig,
  /**
   * `followOnly` (#11294 item 2): só acompanha uma semanal JÁ agendada
   * (reagenda/desagenda com o principal), nunca cria. Usado quando o
   * agendamento do principal falhou ou foi desfeito.
   */
  opts: { push: boolean; followOnly?: boolean },
  deps: SemanalFrioPublishDeps,
): Promise<SemanalFrioPublishResult> {
  const { log } = deps;
  const flags = parseKitFrio(cfg.kit);
  if ("error" in flags) return { code: 2, status: "failed", reason: flags.error };
  if (!flags.enabled) return { code: 0, status: "disabled", reason: "kit.frio.semanal_enabled = false (#11221)." };
  if (!flags.fullyOn) {
    return {
      code: 2,
      status: "failed",
      reason: `kit.frio não está plenamente ligado (${kitFrioNotFullyOnReason(flags)}) — sem o segmento da diária excluindo frio, a semanal duplicaria a edição (#11221).`,
    };
  }
  const edition = basename(editionDir);
  if (!isMondayEdition(edition)) return { code: 0, status: "not_monday", reason: `edição ${edition} não é de segunda.` };
  const own = deps.readOwnState(editionDir);
  if (own && own.status === "scheduled" && typeof own.broadcast_id === "number") {
    return followMainSchedule(editionDir, own, opts, deps);
  }
  if (opts.followOnly) {
    return { code: 0, status: "nothing_to_follow", reason: "semanal de frio não está agendada — nada a acompanhar." };
  }
  const main = deps.readMainState(editionDir);
  if (!main || main.status !== "scheduled" || typeof main.scheduled_at !== "string" || typeof main.broadcast_id !== "number") {
    return { code: 2, status: "failed", reason: "broadcast principal da diária não está agendado (newsletter-kit-published.json) — a semanal sai junto dele." };
  }
  const resuming = own && own.status === "created_unverified" && typeof own.broadcast_id === "number" ? own : null;
  const pause = deps.readPause();
  if (pause.paused) {
    // Um rascunho retomável (created_unverified) fica como está: rascunho não envia.
    return { code: 0, status: "paused", reason: `vigia pausou a semanal (${(pause.reasons ?? []).join("; ") || "sem motivo registrado"}).` };
  }
  const tagId = resuming ? resuming.tag_id : await deps.findTagId(KIT_FRIO_TAG_NAME);
  if (tagId === null) return { code: 2, status: "failed", reason: `tag "${KIT_FRIO_TAG_NAME}" não existe no Kit — recusado (#6126: filtro não resolvido = base inteira).` };
  const filter = buildTagFilter(tagId);

  let broadcastId: number;
  const stateBase = (id: number): KitSemanalFrioPublished => ({
    broadcast_id: id,
    status: "created_unverified",
    scheduled_at: main.scheduled_at!,
    source_broadcast_id: main.broadcast_id!,
    tag_id: tagId,
    created_at: deps.nowIso(),
  });
  if (resuming) {
    if (!opts.push) return { code: 0, status: "dry_run", reason: `retomaria o rascunho ${resuming.broadcast_id} (created_unverified).` };
    broadcastId = resuming.broadcast_id;
    log(`retomando a semanal de frio ${broadcastId} (created_unverified de uma rodada anterior).`);
  } else {
    const members = await deps.countTagMembers(tagId);
    if (members === 0) return { code: 0, status: "empty_tag", reason: `tag "${KIT_FRIO_TAG_NAME}" sem membros — nada a enviar.` };
    const source = await deps.getBroadcast(main.broadcast_id);
    if (!source.content) return { code: 1, status: "failed", reason: `broadcast principal ${main.broadcast_id} sem content no GET.` };
    const input: CreateBroadcastInput = {
      subject: source.subject,
      preview_text: source.preview_text ?? main.preview_text,
      content: injectSemanalFrioIntro(source.content),
      description: `Semanal frio (#11221) — edição ${edition}`,
      public: false,
      send_at: null, // RASCUNHO: só agenda depois de conferir o filtro
      email_template_id: source.email_template?.id,
      email_address: source.email_address,
      subscriber_filter: filter,
    };
    if (!opts.push) {
      log(`[dry-run] criaria a semanal de frio pra ${members} assinante(s), send_at ${main.scheduled_at}, filtro tag ${tagId}.`);
      return { code: 0, status: "dry_run", reason: `${members} membro(s) na tag ${KIT_FRIO_TAG_NAME}.` };
    }
    const created = await deps.createBroadcast(input);
    broadcastId = created.id;
    try {
      deps.writeOwnState(editionDir, stateBase(broadcastId));
    } catch (e) {
      // Sem registro, uma rodada seguinte criaria outro: apaga o rascunho.
      return deleteOrAlarm(deps, editionDir, broadcastId, `estado local não gravado (${(e as Error).message})`, null);
    }
  }

  // Confere o filtro no rascunho (ou no retomado).
  const reread = await deps.getBroadcast(broadcastId);
  const verdict = verifyDiariaAudienceFilter(reread.subscriber_filter, filter);
  if (!verdict.ok) return deleteOrAlarm(deps, editionDir, broadcastId, `filtro relido não confere (${verdict.reason})`, stateBase(broadcastId));

  // Agenda e confere de novo (status, send_at e filtro).
  if (!(reread.status === "scheduled" && sameInstant(reread.send_at, main.scheduled_at))) {
    await deps.scheduleBroadcast(broadcastId, main.scheduled_at);
  }
  const after = await deps.getBroadcast(broadcastId);
  const verdictAfter = verifyDiariaAudienceFilter(after.subscriber_filter, filter);
  if (!verdictAfter.ok) {
    return deleteOrAlarm(deps, editionDir, broadcastId, `filtro relido após o agendamento não confere (${verdictAfter.reason})`, stateBase(broadcastId));
  }
  if (after.status !== "scheduled" || !sameInstant(after.send_at, main.scheduled_at)) {
    return {
      code: 1,
      status: "failed",
      broadcastId,
      reason: `agendamento não confirmado na releitura (status=${after.status}, send_at=${after.send_at}); o broadcast ${broadcastId} fica created_unverified e a próxima rodada retoma.`,
    };
  }
  deps.writeOwnState(editionDir, { ...stateBase(broadcastId), status: "scheduled" });
  log(`semanal de frio ${broadcastId} agendada pra ${main.scheduled_at} (filtro tag ${KIT_FRIO_TAG_NAME} confirmado).`);
  return { code: 0, status: "scheduled", broadcastId };
}

/**
 * #11294 item 2 — a semanal já agendada acompanha o principal: mesmo
 * instante ⇒ `already_done`; principal reagendado ⇒ re-PATCH pro novo
 * `send_at` (relido: status, horário e filtro); principal fora de
 * `scheduled` (desagendado, ex. exit 7 do `schedule-newsletter-kit.ts`) ⇒
 * desagenda a semanal (`send_at: null`, relido) e volta o estado pra
 * `created_unverified`, que o próximo agendamento do principal retoma. Sem
 * isto a semanal sairia no horário antigo, ou sozinha.
 */
async function followMainSchedule(
  editionDir: string,
  own: KitSemanalFrioPublished,
  opts: { push: boolean },
  deps: SemanalFrioPublishDeps,
): Promise<SemanalFrioPublishResult> {
  const { log } = deps;
  const broadcastId = own.broadcast_id;
  const main = deps.readMainState(editionDir);
  const mainScheduled = main !== null && main.status === "scheduled" && typeof main.scheduled_at === "string";
  if (mainScheduled && sameInstant(own.scheduled_at, main.scheduled_at!)) {
    return { code: 0, status: "already_done", broadcastId };
  }

  if (!mainScheduled) {
    if (!opts.push) {
      return { code: 0, status: "dry_run", broadcastId, reason: `desagendaria a semanal ${broadcastId}: o principal não está mais agendado.` };
    }
    let after: KitBroadcastDetail | null = null;
    let err: string | null = null;
    try {
      await deps.scheduleBroadcast(broadcastId, null);
      after = await deps.getBroadcast(broadcastId);
    } catch (e) {
      err = (e as Error).message;
    }
    if (err !== null || after === null || after.send_at != null) {
      const reason =
        `o principal da edição ${basename(editionDir)} não está mais agendado, mas a semanal ${broadcastId} NÃO foi desagendada ` +
        `(${err ?? `releitura mostra send_at=${after?.send_at}`}) — ela sairia SOZINHA às ${own.scheduled_at}: desagendar à mão no Kit AGORA.`;
      try {
        deps.raiseAlarm(`Semanal de frio do Kit agendada sem o principal: broadcast ${broadcastId} (#11294)`, `- ${reason}`);
      } catch (alarmErr) {
        log(`aviso: issue de alarme não aberta (${(alarmErr as Error).message}).`);
      }
      return { code: 1, status: "failed", broadcastId, reason };
    }
    deps.writeOwnState(editionDir, { ...own, status: "created_unverified", reason: "principal desagendado (#11294)" });
    log(`semanal de frio ${broadcastId} desagendada junto com o principal; volta a ser agendada quando ele for.`);
    return { code: 0, status: "unscheduled", broadcastId };
  }

  const target = main!.scheduled_at!;
  if (!opts.push) {
    return { code: 0, status: "dry_run", broadcastId, reason: `reagendaria a semanal ${broadcastId} de ${own.scheduled_at} pra ${target} (principal reagendado).` };
  }
  await deps.scheduleBroadcast(broadcastId, target);
  const after = await deps.getBroadcast(broadcastId);
  const verdict = verifyDiariaAudienceFilter(after.subscriber_filter, buildTagFilter(own.tag_id));
  if (!verdict.ok) {
    return deleteOrAlarm(deps, editionDir, broadcastId, `filtro relido após o reagendamento não confere (${verdict.reason})`, own);
  }
  if (after.status !== "scheduled" || !sameInstant(after.send_at, target)) {
    return {
      code: 1,
      status: "failed",
      broadcastId,
      reason: `reagendamento da semanal ${broadcastId} pra ${target} não confirmado na releitura (status=${after.status}, send_at=${after.send_at}).`,
    };
  }
  deps.writeOwnState(editionDir, { ...own, scheduled_at: target });
  log(`semanal de frio ${broadcastId} reagendada de ${own.scheduled_at} pra ${target}, junto com o principal.`);
  return { code: 0, status: "rescheduled", broadcastId };
}

/** Apaga o broadcast com problema; se o DELETE falhar, alarme + estado `created_unverified` mantido. Sempre `failed`/1. */
async function deleteOrAlarm(
  deps: SemanalFrioPublishDeps,
  editionDir: string,
  broadcastId: number,
  why: string,
  state: KitSemanalFrioPublished | null,
): Promise<SemanalFrioPublishResult> {
  try {
    await deps.deleteBroadcast(broadcastId);
  } catch (e) {
    const reason = `${why} e o broadcast ${broadcastId} NÃO foi apagado (${(e as Error).message}) — apagar à mão no Kit AGORA.`;
    try {
      deps.raiseAlarm(
        `Semanal de frio do Kit com problema não apagada: broadcast ${broadcastId} (#11221)`,
        `O publisher da semanal de frio (#11221) não conseguiu apagar o broadcast ${broadcastId} (edição ${basename(editionDir)}):\n\n- ${reason}\n\n` +
          "Um filtro não resolvido no Kit manda pra base INTEIRA (#6126). Conferir o broadcast no painel e apagar se ainda estiver lá.",
      );
    } catch (alarmErr) {
      deps.log(`aviso: issue de alarme não aberta (${(alarmErr as Error).message}).`);
    }
    return { code: 1, status: "failed", broadcastId, reason };
  }
  if (state) {
    try {
      deps.writeOwnState(editionDir, { ...state, status: "deleted", reason: why });
    } catch (e) {
      deps.log(`aviso: estado 'deleted' não gravado (${(e as Error).message}); o broadcast já foi apagado.`);
    }
  }
  return { code: 1, status: "failed", broadcastId, reason: `${why} — broadcast ${broadcastId} apagado.` };
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
    scheduleBroadcast: async (id, sendAt) => {
      await updateBroadcast(id, { send_at: sendAt });
    },
    deleteBroadcast: (id) => deleteBroadcast(id),
    raiseAlarm: (title, body) => raiseKitFrioAlarm({ check: "kit-semanal-frio-filtro", fingerprintSuffix: "nao-apagado", title, body }),
  };
}

/**
 * Entrada fail-soft pro `schedule-newsletter-kit.ts`: nunca lança. `deps`
 * injetável em teste.
 */
export async function runSemanalFrioAfterSchedule(
  editionDir: string,
  log: (msg: string) => void,
  rootDir: string = ROOT,
  deps: SemanalFrioPublishDeps = productionSemanalFrioDeps(log),
  /** #11294 item 2 — `followOnly` quando o agendamento do principal falhou ou foi desfeito. */
  options: { followOnly?: boolean } = {},
): Promise<SemanalFrioPublishResult> {
  try {
    const cfg = JSON.parse(readFileSync(resolve(rootDir, "platform.config.json"), "utf8")) as SemanalFrioPlatformConfig;
    const flags = parseKitFrio(cfg.kit);
    if (!("error" in flags) && !flags.enabled) return { code: 0, status: "disabled" };
    return await publishKitSemanalFrio(editionDir, cfg, { push: true, followOnly: options.followOnly === true }, deps);
  } catch (e) {
    return { code: 1, status: "failed", reason: (e as Error).message };
  }
}

/** #11221 review — o que entra no JSON do `schedule-newsletter-kit.ts` (campo `semanal_frio`). */
export function summarizeSemanalFrioForSchedule(r: SemanalFrioPublishResult): { status: string; reason: string | null; broadcast_id: number | null } {
  return { status: r.status, reason: ("reason" in r && r.reason) || null, broadcast_id: r.broadcastId ?? null };
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
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8")) as SemanalFrioPlatformConfig;
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

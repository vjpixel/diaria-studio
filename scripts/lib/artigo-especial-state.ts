/**
 * artigo-especial-state.ts (#5979)
 *
 * Guard de idempotência por canal pra `/diaria-artigo-especial` — mesmo
 * padrão de `scripts/lib/mensal/monthly-apoiadores-state.ts` (leitura
 * fail-soft, escrita atômica), adaptado pra 3 canais independentes em vez de
 * 1 fluxo linear: `apoiase` (post via Claude in Chrome), `linkedin_pagina` e
 * `linkedin_perfil` (dispatch via Worker/Make, ver
 * `publish-artigo-especial-linkedin.ts`), e `box` (rewrite do snippet +
 * pin, ver `update-artigo-especial-box.ts`).
 *
 * Cada canal tem seu PRÓPRIO status — uma falha em `apoiase` (ex: DOM do
 * painel mudou) não impede `linkedin`/`box` de rodar, e um resume (rodar a
 * skill de novo pro mesmo `{ano}-{slug}`) pula só os canais já `done`
 * (mesmo fail-soft-por-canal do Stage 5 diário, `_internal/05-published.json`).
 * `--force` (por canal, no caller) reexecuta mesmo com `done`.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";

export type ChannelStatus = "pending" | "done" | "failed";

export const ARTIGO_ESPECIAL_CHANNELS = ["apoiase", "linkedin_pagina", "linkedin_perfil", "box"] as const;
export type ArtigoEspecialChannel = (typeof ARTIGO_ESPECIAL_CHANNELS)[number];

export interface ChannelState {
  status: ChannelStatus;
  /** ISO timestamp da última tentativa (sucesso ou falha). */
  attemptedAt: string;
  /** URL do post/PR resultante — apoia.se post URL, ou URL do PR do box. Nulo
   *  enquanto não há um artefato de sucesso pra apontar (linkedin_pagina/perfil
   *  não têm URL própria confiável — Make é fire-and-forget, ver
   *  publish-linkedin.ts — usam null aqui e confiam no worker_queue_key gravado
   *  no store próprio, não neste arquivo). */
  url: string | null;
  /** Motivo da falha, quando `status === "failed"`. */
  reason: string | null;
}

export interface ArtigoEspecialState {
  ano: string;
  slug: string;
  channels: Partial<Record<ArtigoEspecialChannel, ChannelState>>;
}

const STATE_FILENAME = "published.json";

/** Path do state file — `data/artigo-especial/{ano}-{slug}/published.json`. */
export function artigoEspecialStatePath(dataDir: string, ano: string, slug: string): string {
  return resolve(dataDir, "artigo-especial", `${ano}-${slug}`, STATE_FILENAME);
}

/**
 * Lê o state file. Fail-soft: ausente/corrompido/shape inesperado → estado
 * "vazio" (nenhum canal feito ainda) — nunca lança. Mesma disciplina de
 * `monthly-apoiadores-state.ts::readApoiadoresState`.
 */
export function readArtigoEspecialState(
  path: string,
  ano: string,
  slug: string,
): ArtigoEspecialState {
  const empty: ArtigoEspecialState = { ano, slug, channels: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ArtigoEspecialState>;
    if (typeof parsed.ano !== "string" || typeof parsed.slug !== "string" || typeof parsed.channels !== "object") {
      process.stderr.write(`[artigo-especial-state] AVISO: ${path} tem shape inesperado — tratando como vazio.\n`);
      return empty;
    }
    const channels: ArtigoEspecialState["channels"] = {};
    for (const ch of ARTIGO_ESPECIAL_CHANNELS) {
      const raw = (parsed.channels as Record<string, unknown>)[ch];
      if (raw && typeof raw === "object") {
        const r = raw as Partial<ChannelState>;
        if (r.status === "pending" || r.status === "done" || r.status === "failed") {
          channels[ch] = {
            status: r.status,
            attemptedAt: typeof r.attemptedAt === "string" ? r.attemptedAt : "",
            url: typeof r.url === "string" ? r.url : null,
            reason: typeof r.reason === "string" ? r.reason : null,
          };
        } else {
          // Status inválido/inesperado pra este canal — descartado (mesmo
          // fail-soft dos outros ramos), mas com aviso: sem log aqui, um
          // state file 95% saudável com 1 canal corrompido falhava mais
          // silenciosamente que um arquivo 100% corrompido (que já loga no
          // catch abaixo) — achado do silent-failure-hunter, review #5979/PR
          // #6000.
          process.stderr.write(
            `[artigo-especial-state] AVISO: ${path} — canal "${ch}" tem status inválido (${JSON.stringify(r.status)}) — descartado, tratado como "nunca tentado".\n`,
          );
        }
      }
    }
    return { ano: parsed.ano, slug: parsed.slug, channels };
  } catch (e) {
    process.stderr.write(
      `[artigo-especial-state] AVISO: ${path} existe mas não pôde ser lido/parseado (${(e as Error).message}) — tratando como vazio.\n`,
    );
    return empty;
  }
}

/** Escreve o state file (atômico). Cria o diretório do ciclo se faltar. */
export function writeArtigoEspecialState(path: string, state: ArtigoEspecialState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(state, null, 2) + "\n");
}

export type ChannelDecision = { action: "run" } | { action: "skip"; reason: string };

/**
 * Pura/testável: decide se um canal deve rodar nesta invocação.
 *   - Sem estado prévio (canal nunca tentado), ou `status === "failed"` → roda
 *     (falha é sempre retentável, sem precisar de `--force`).
 *   - `status === "done"` sem `force` → skip (já feito — idempotência real).
 *   - `status === "done"` com `force` → roda de novo.
 */
export function decideChannelAction(
  state: ArtigoEspecialState,
  channel: ArtigoEspecialChannel,
  force: boolean,
): ChannelDecision {
  const ch = state.channels[channel];
  if (!ch || ch.status === "failed") return { action: "run" };
  if (ch.status === "done" && !force) {
    return {
      action: "skip",
      reason: `Canal "${channel}" já está marcado como concluído (${ch.attemptedAt}${ch.url ? `, ${ch.url}` : ""}). Use --force para refazer.`,
    };
  }
  return { action: "run" };
}

/** Pura: monta o `ChannelState` de sucesso a gravar após um canal concluir. */
export function buildDoneChannelState(attemptedAt: string, url: string | null): ChannelState {
  return { status: "done", attemptedAt, url, reason: null };
}

/** Pura: monta o `ChannelState` de falha (não bloqueia os demais canais — fail-soft por canal). */
export function buildFailedChannelState(attemptedAt: string, reason: string): ChannelState {
  return { status: "failed", attemptedAt, url: null, reason };
}

/**
 * Atualiza (imutável) o state com o resultado de um canal e retorna o novo
 * objeto — caller decide quando persistir (`writeArtigoEspecialState`).
 */
export function withChannelState(
  state: ArtigoEspecialState,
  channel: ArtigoEspecialChannel,
  channelState: ChannelState,
): ArtigoEspecialState {
  return { ...state, channels: { ...state.channels, [channel]: channelState } };
}

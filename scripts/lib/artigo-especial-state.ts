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

/**
 * Canais do artigo especial. `email` (#7659) é o 5º — o broadcast Kit pros
 * apoiadores R$10+, gravado por `publish-artigo-especial-kit.ts`. O detalhe
 * do envio (id do broadcast, tag de audiência, verificação do filtro) mora em
 * `email-published.json`, mesma divisão de `linkedin_pagina`/`linkedin_perfil`
 * e `linkedin-published.json`: aqui fica só o status agregado.
 */
export const ARTIGO_ESPECIAL_CHANNELS = ["apoiase", "linkedin_pagina", "linkedin_perfil", "box", "email"] as const;
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
  /** Etapas de PRODUÇÃO (#9099) — antes dos canais de divulgação. Ausente em
   *  state files de artigos produzidos à mão (o-agente, engenharia-de-ilusao,
   *  o-jev); `nextProducaoEtapa` trata ausência como "nenhuma etapa feita". */
  producao?: ProducaoState;
}

/**
 * Etapas de produção de `/diaria-artigo-especial` (#9099), na ordem em que
 * rodam — cada uma termina num gate humano (ou, `pr`/`publicado`, num fato
 * externo verificado), e um resume retoma da 1ª não-`done`:
 *   tema      — tema + slug confirmados (votação ou `--tema`)
 *   briefing  — fontes, estrutura e tese aprovadas (`briefing.md`)
 *   rascunho  — `draft.md` aprovado, já com a passada do humanizador
 *   html      — `articles-src/{slug}.html` + registros gerados e conferidos
 *   pr        — PR do artigo aberto (url gravada)
 *   publicado — PR mergeado + probe da URL pública OK
 */
export const PRODUCAO_ETAPAS = ["tema", "briefing", "rascunho", "html", "pr", "publicado"] as const;
export type ProducaoEtapa = (typeof PRODUCAO_ETAPAS)[number];

export interface ProducaoState {
  /** Tema confirmado na etapa `tema` (texto livre — título do candidato vencedor ou `--tema`). */
  tema: string | null;
  etapas: Partial<Record<ProducaoEtapa, ChannelState>>;
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
    const channels = parseChannelStates(parsed.channels as Record<string, unknown>, ARTIGO_ESPECIAL_CHANNELS, path, "artigo-especial-state");
    const state: ArtigoEspecialState = { ano: parsed.ano, slug: parsed.slug, channels };
    // #9099: preservar `producao` — sem isto, qualquer escrita de canal
    // (mark-artigo-especial-channel.ts, publish-*) apagava o progresso da
    // produção ao regravar o arquivo.
    const producao = parseProducaoState(parsed.producao, path);
    if (producao) state.producao = producao;
    return state;
  } catch (e) {
    process.stderr.write(
      `[artigo-especial-state] AVISO: ${path} existe mas não pôde ser lido/parseado (${(e as Error).message}) — tratando como vazio.\n`,
    );
    return empty;
  }
}

/**
 * Pura (exceto o aviso em stderr): valida o mapa `channels` cru de um state
 * file por canal. Extraído de `readArtigoEspecialState` (#9474) pra que o
 * state da Retrospectiva do Mês (`scripts/lib/mensal/retrospectiva-divulgacao.ts`)
 * use EXATAMENTE a mesma tolerância — canal com status inválido é descartado
 * com aviso (achado do silent-failure-hunter, review #5979/PR #6000), nunca
 * aceito em silêncio.
 */
export function parseChannelStates<C extends string>(
  rawChannels: Record<string, unknown>,
  channelList: readonly C[],
  path: string,
  tag: string,
): Partial<Record<C, ChannelState>> {
  const channels: Partial<Record<C, ChannelState>> = {};
  for (const ch of channelList) {
    const raw = rawChannels[ch];
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
        // catch do caller) — achado do silent-failure-hunter, review
        // #5979/PR #6000.
        process.stderr.write(
          `[${tag}] AVISO: ${path} — canal "${ch}" tem status inválido (${JSON.stringify(r.status)}) — descartado, tratado como "nunca tentado".\n`,
        );
      }
    }
  }
  return channels;
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
export function decideChannelAction<C extends string>(
  state: { channels: Partial<Record<C, ChannelState>> },
  channel: C,
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
 *
 * Genérico desde #9474 (o state da Retrospectiva do Mês tem o mesmo shape de
 * `channels`, com 1 canal a mais — `pagina`); pro artigo especial a inferência
 * devolve `ArtigoEspecialState`, sem mudar nenhum call site.
 */
export function withChannelState<C extends string, S extends { channels: Partial<Record<C, ChannelState>> }>(
  state: S,
  channel: C,
  channelState: ChannelState,
): S {
  return { ...state, channels: { ...state.channels, [channel]: channelState } };
}

/** Pura (exceto aviso em stderr): valida o bloco `producao` cru. Ausente → `undefined`. */
export function parseProducaoState(raw: unknown, path: string): ProducaoState | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") {
    process.stderr.write(`[artigo-especial-state] AVISO: ${path} — "producao" com shape inesperado — descartado.\n`);
    return undefined;
  }
  const r = raw as { tema?: unknown; etapas?: unknown };
  let etapasRaw: Record<string, unknown> = {};
  if (r.etapas && typeof r.etapas === "object" && !Array.isArray(r.etapas)) {
    etapasRaw = r.etapas as Record<string, unknown>;
  } else if (r.etapas !== undefined) {
    process.stderr.write(`[artigo-especial-state] AVISO: ${path} — "producao.etapas" malformado — tratado como nenhuma etapa feita.\n`);
  }
  return {
    tema: typeof r.tema === "string" ? r.tema : null,
    etapas: parseChannelStates(etapasRaw, PRODUCAO_ETAPAS, path, "artigo-especial-state:producao"),
  };
}

/**
 * Pura: 1ª etapa de produção ainda não `done`, na ordem de `PRODUCAO_ETAPAS`
 * — é de onde um resume retoma. `null` = produção concluída, seguir pros
 * canais de divulgação. Etapa `failed` conta como não feita (retentável).
 */
export function nextProducaoEtapa(state: Pick<ArtigoEspecialState, "producao">): ProducaoEtapa | null {
  for (const etapa of PRODUCAO_ETAPAS) {
    if (state.producao?.etapas[etapa]?.status !== "done") return etapa;
  }
  return null;
}

/**
 * Pura: grava o resultado de uma etapa (imutável). Marcar uma etapa como
 * `done` exige as anteriores `done` — a ordem é o que garante, por exemplo,
 * que nenhum PR saia de um rascunho que o editor não aprovou. Refazer uma
 * etapa já feita (`done` de novo, ex: o editor pediu ajuste no rascunho
 * depois do HTML) INVALIDA as posteriores — o HTML de um rascunho velho não
 * vale para o novo.
 */
export function withProducaoEtapa(
  state: ArtigoEspecialState,
  etapa: ProducaoEtapa,
  etapaState: ChannelState,
  tema?: string,
): ArtigoEspecialState {
  const idx = PRODUCAO_ETAPAS.indexOf(etapa);
  const prev = state.producao ?? { tema: null, etapas: {} };
  if (tema !== undefined && etapa !== "tema") {
    throw new Error(`tema só pode ser gravado com a etapa "tema" (veio com "${etapa}").`);
  }
  if (etapa === "tema" && etapaState.status === "done" && !tema?.trim()) {
    throw new Error('etapa "tema" como feita exige o tema confirmado.');
  }
  if (etapa === "pr" && etapaState.status === "done" && !etapaState.url) {
    throw new Error('etapa "pr" como feita exige a URL do PR.');
  }
  if (etapaState.status === "done") {
    const pendente = PRODUCAO_ETAPAS.slice(0, idx).find((e) => prev.etapas[e]?.status !== "done");
    if (pendente) {
      throw new Error(`etapa "${etapa}" não pode ser marcada como feita antes de "${pendente}".`);
    }
  }
  const etapas: Partial<Record<ProducaoEtapa, ChannelState>> = {};
  for (const e of PRODUCAO_ETAPAS.slice(0, idx)) if (prev.etapas[e]) etapas[e] = prev.etapas[e];
  etapas[etapa] = etapaState;
  // Etapas posteriores só sobrevivem se esta não foi refeita como `done`.
  if (etapaState.status !== "done") {
    for (const e of PRODUCAO_ETAPAS.slice(idx + 1)) if (prev.etapas[e]) etapas[e] = prev.etapas[e];
  }
  return { ...state, producao: { tema: tema ?? prev.tema, etapas } };
}

/**
 * Leitura ESTRITA para quem vai GRAVAR etapa de produção: ausente → vazio;
 * existente mas ilegível ou fora do shape → lança. A leitura fail-soft de
 * `readArtigoEspecialState` trataria um arquivo corrompido como vazio, e a
 * escrita seguinte apagaria os canais e as etapas que ele tinha.
 */
export function readArtigoEspecialStateStrict(path: string, ano: string, slug: string): ArtigoEspecialState {
  if (!existsSync(path)) return { ano, slug, channels: {} };
  let parsed: Partial<ArtigoEspecialState>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ArtigoEspecialState>;
  } catch (e) {
    throw new Error(`${path} existe mas não é JSON válido (${(e as Error).message}) — conserte à mão antes de gravar (nada foi escrito).`);
  }
  if (typeof parsed?.ano !== "string" || typeof parsed.slug !== "string" || typeof parsed.channels !== "object" || parsed.channels === null) {
    throw new Error(`${path} tem shape inesperado (ano/slug/channels) — conserte à mão antes de gravar (nada foi escrito).`);
  }
  if (parsed.ano !== ano || parsed.slug !== slug) {
    throw new Error(`${path} é de ${parsed.ano}/${parsed.slug}, não de ${ano}/${slug} — nada foi escrito.`);
  }
  return readArtigoEspecialState(path, ano, slug);
}

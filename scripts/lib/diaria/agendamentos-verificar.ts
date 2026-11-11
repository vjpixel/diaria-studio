/**
 * scripts/lib/diaria/agendamentos-verificar.ts (#12774)
 *
 * Releitura da plataforma para os itens `agendado` do banco de agendamentos
 * (`agendamentos.ts`): o item só vira `publicado` quando TODOS os destinos
 * dele foram relidos na plataforma e estão no ar (#573). O 2xx da mutação, e
 * o `status: published` do registro local do vertical, nunca bastam: o
 * registro diz o que o SCRIPT fez, não o que a rede mostra
 * (`resolveShortEntryState`, `publish-state.ts`).
 *
 * De onde vem o id de cada destino: o vertical 2 sai como o corte `guia`
 * (`VERTICAL2_CORTE_SLUG`) da edição de origem, publicado pelo modo corte do
 * `publish-shorts.ts`, que registra em `data/cortes/guia-{edição}/`
 * (`extraVerticalSlug`, `corte.json` + `_internal/06-shorts-published*.json`,
 * lidos com `readShortsRegistry`). O registro só fornece o ID; o estado vem da
 * leitura na plataforma.
 *
 * Leitores por destino (somente LEITURA, nunca mutação):
 *   - `youtube_shorts`: `videos.list?part=status` pelo `fetchVideoStatus` do
 *     `youtube-upload.ts` (troca do refresh token pelo access token, que não
 *     muda nada no canal), normalizado por `resolveYouTubeState`.
 *   - os demais destinos do vertical (Instagram, páginas do Facebook, perfil
 *     do LinkedIn e repost da página, X e TikTok pela Buffer, Threads,
 *     perfil do Facebook) ficam `sem-leitor`: não há no repo uma função de
 *     leitura do post do vertical por id nesses destinos que sirva aqui sem
 *     escrever código de API novo. Item com qualquer destino `sem-leitor`
 *     continua `agendado`, e o dono marca à mão com `--verificado-fonte`
 *     depois de conferir na rede, como antes. Ligar um leitor novo é
 *     acrescentar a entrada em `LEITORES_PADRAO` (ou passar em `leitores`).
 *
 * Nunca rebaixa nem marca `falhou`: leitura que não confirma deixa o item
 * como está e sai no relatório (o alarme do tick cuida do vencido).
 *
 * Alarme do tick (#12825, decisão do editor, opção a): como destino
 * `sem-leitor` deixa o item `agendado` para sempre, o tick
 * (`avaliarAgendamentosComEnvio`) não alarma o `agendado` vencido cujos
 * destinos sem leitor têm registro de envio (`published`/`scheduled`) e cujos
 * destinos com leitor foram relidos no ar. Falta de registro, `send_unknown`,
 * leitura que não confirma ou que falha mantêm o alarme.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveYouTubeState } from "../publish-state.ts";
import { extractYouTubeVideoId } from "./d1-video-link.ts";
import { extraVerticalSlug } from "./extra-verticals.ts";
import { VERTICAL2_CORTE_SLUG } from "./roteiro-videos.ts";
import { CORTE_SPEC_FILE, corteRelDir, parseCorteSpec } from "./short-corte.ts";
import type { ShortPublishedEntry } from "./short-video.ts";
import { readShortsRegistry } from "./shorts-published-store.ts";
import {
  fetchVideoStatus,
  missingYouTubeCredentials,
  refreshYouTubeAccessToken,
  type YouTubeUploadDeps,
} from "./youtube-upload.ts";
import {
  avaliarAgendamentos,
  type AgendamentoItem,
  type AgendamentoVerificacao,
  type AgendamentosAvaliacao,
  type AgendamentosBanco,
} from "./agendamentos.ts";

/** Peça do banco → corte do `publish-shorts.ts` que a publica. */
export const PECA_CORTE: Readonly<Record<string, string>> = { "vertical-2": VERTICAL2_CORTE_SLUG };

export type LeituraDestino =
  /** Relido na plataforma e no ar. */
  | { destino: string; status: "publicado"; fonte: string; url?: string }
  /** Relido, mas ainda não está no ar (agendado, rascunho, estado ambíguo). */
  | { destino: string; status: "nao-publicado"; motivo: string }
  /** O registro do corte não tem o destino (nada foi enviado, ou não por este caminho). */
  | { destino: string; status: "sem-registro"; motivo: string }
  /**
   * Não há leitor da plataforma para este destino (ver docblock). `envio` é o
   * status da entrada do registro do corte (só existe `sem-leitor` com
   * registro; sem registro a leitura é `sem-registro`), usado pelo tick para
   * não alarmar envio registrado (#12825).
   */
  | { destino: string; status: "sem-leitor"; motivo: string; envio?: ShortPublishedEntry["status"] }
  /** A leitura falhou (rede, credencial, registro ilegível). */
  | { destino: string; status: "erro"; motivo: string };

export interface LeitorContexto {
  item: AgendamentoItem;
  destino: string;
  entry: ShortPublishedEntry;
}

export type LeitorDestino = (ctx: LeitorContexto) => Promise<LeituraDestino>;

export interface VerificacaoItem {
  item: AgendamentoItem;
  leituras: LeituraDestino[];
  /** `true` só com TODOS os destinos `publicado`. */
  publicado: boolean;
  verificacao?: AgendamentoVerificacao;
}

/** Puro: itens que o `verificar` relê (estado `agendado` e peça com corte conhecido). */
export function itensVerificaveis(banco: AgendamentosBanco, id?: string): AgendamentoItem[] {
  return banco.itens.filter((it) => it.estado === "agendado" && it.peca in PECA_CORTE && (id === undefined || it.id === id));
}

/** Puro: pasta do corte que publica o item (`data/cortes/{corte}-{edição}`), relativa à raiz. */
export function corteDirDoItem(item: Pick<AgendamentoItem, "peca" | "edicao">): string {
  const corte = PECA_CORTE[item.peca];
  if (!corte) throw new Error(`peça sem corte conhecido: ${item.peca}`);
  return corteRelDir(extraVerticalSlug(corte, item.edicao));
}

/**
 * Puro: junta as leituras de um item. `publicado` exige uma leitura
 * `publicado` para CADA destino do item; a `verificacao` cita a fonte de cada
 * um, e a URL só quando o item tem um destino (o campo é único).
 */
export function decidirVerificacao(item: AgendamentoItem, leituras: readonly LeituraDestino[], now: Date): VerificacaoItem {
  const porDestino = new Map(leituras.map((l) => [l.destino, l]));
  const todas = item.destinos.map((d) => porDestino.get(d));
  const publicado = todas.length > 0 && todas.every((l) => l?.status === "publicado");
  const ordered = todas.filter((l): l is LeituraDestino => l !== undefined);
  if (!publicado) return { item, leituras: ordered, publicado: false };
  const pubs = ordered as Array<Extract<LeituraDestino, { status: "publicado" }>>;
  const verificacao: AgendamentoVerificacao = {
    fonte: `agendamentos.ts verificar: ${pubs.map((l) => `${l.destino}=${l.fonte}`).join("; ")}`,
    em: now.toISOString(),
    ...(pubs.length === 1 && pubs[0].url ? { url: pubs[0].url } : {}),
  };
  return { item, leituras: ordered, publicado: true, verificacao };
}

// ─── Leitor do YouTube ───────────────────────────────────────────────────────

export interface YouTubeLeitorDeps {
  deps: YouTubeUploadDeps;
  env: Record<string, string | undefined>;
}

export const YOUTUBE_LEITURA_FONTE = "youtube videos.list part=status";

/**
 * Leitor do `youtube_shorts`: id do registro (o videoId, ou a URL de um
 * `--mark`) → `videos.list` → `resolveYouTubeState`. Só `published` (vídeo
 * `public`) confirma. O access token é obtido uma vez por leitor.
 */
export function youtubeShortsLeitor(input: YouTubeLeitorDeps): LeitorDestino {
  let tokenPromise: Promise<string> | null = null;
  return async ({ destino, entry }) => {
    const videoId = /^[A-Za-z0-9_-]{11}$/.test(entry.id) ? entry.id : extractYouTubeVideoId(entry.url ?? entry.id);
    if (!videoId) {
      return { destino, status: "nao-publicado", motivo: `registro sem id de vídeo do YouTube (status ${entry.status}, id ${entry.id})` };
    }
    const missing = missingYouTubeCredentials(input.env);
    if (missing.length) return { destino, status: "erro", motivo: `faltam ${missing.join(", ")} no ambiente` };
    try {
      tokenPromise ??= refreshYouTubeAccessToken(input.deps, {
        clientId: (input.env.GOOGLE_CLIENT_ID ?? "").trim(),
        clientSecret: (input.env.GOOGLE_CLIENT_SECRET ?? "").trim(),
        refreshToken: (input.env.YOUTUBE_REFRESH_TOKEN ?? "").trim(),
        channelId: (input.env.YOUTUBE_CHANNEL_ID ?? "").trim(),
      });
      const token = await tokenPromise;
      const status = await fetchVideoStatus(input.deps, token, videoId);
      if (!status) return { destino, status: "erro", motivo: `vídeo ${videoId} não está no canal (videos.list sem o item)` };
      const state = resolveYouTubeState({ status }, input.deps.now());
      if (state === "published") {
        return { destino, status: "publicado", fonte: YOUTUBE_LEITURA_FONTE, url: `https://youtube.com/shorts/${videoId}` };
      }
      return {
        destino,
        status: "nao-publicado",
        motivo: `estado relido ${state} (privacy ${status.privacyStatus ?? "?"}, publishAt ${status.publishAt ?? "nenhum"}, upload ${status.uploadStatus ?? "?"})`,
      };
    } catch (e) {
      tokenPromise = null;
      return { destino, status: "erro", motivo: (e as Error).message };
    }
  };
}

// ─── Orquestração (I/O injetado) ─────────────────────────────────────────────

export interface VerificarDeps {
  root: string;
  now: Date;
  /** Leitor por id de destino; destino fora do mapa sai `sem-leitor`. */
  leitores: Readonly<Record<string, LeitorDestino>>;
}

/** Leitores ligados por padrão (ver o docblock: só o YouTube tem leitura por id hoje). */
export function leitoresPadrao(yt: YouTubeLeitorDeps): Record<string, LeitorDestino> {
  return { youtube_shorts: youtubeShortsLeitor(yt) };
}

/** Lê o registro do corte do item. Erro de leitura volta como texto (vira `erro` em todos os destinos). */
export function lerRegistroDoCorte(root: string, item: AgendamentoItem): { entries: ShortPublishedEntry[] } | { erro: string } {
  const rel = corteDirDoItem(item);
  const dir = join(root, ...rel.split("/"));
  const specPath = join(dir, CORTE_SPEC_FILE);
  if (!existsSync(specPath)) return { erro: `${rel}/${CORTE_SPEC_FILE} ausente: o corte ainda não foi registrado nesta máquina` };
  try {
    const spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
    return { entries: readShortsRegistry(dir, spec.date).entries };
  } catch (e) {
    return { erro: (e as Error).message };
  }
}

/** Relê todos os destinos de um item. Nunca lança: falha vira leitura `erro`. */
export async function lerDestinosDoItem(item: AgendamentoItem, deps: VerificarDeps): Promise<LeituraDestino[]> {
  const reg = lerRegistroDoCorte(deps.root, item);
  if ("erro" in reg) return item.destinos.map((destino) => ({ destino, status: "erro" as const, motivo: reg.erro }));
  const out: LeituraDestino[] = [];
  for (const destino of item.destinos) {
    const entry = reg.entries.find((e) => e.destination === destino);
    if (!entry) {
      out.push({ destino, status: "sem-registro", motivo: `${corteDirDoItem(item)} não registra envio para ${destino}` });
      continue;
    }
    const leitor = deps.leitores[destino];
    if (!leitor) {
      out.push({
        destino,
        status: "sem-leitor",
        motivo: `sem leitura da plataforma ligada para ${destino}: conferir na rede e marcar à mão (#573)`,
        envio: entry.status,
      });
      continue;
    }
    try {
      out.push(await leitor({ item, destino, entry }));
    } catch (e) {
      out.push({ destino, status: "erro", motivo: (e as Error).message });
    }
  }
  return out;
}

// ─── Alarme do tick (#12825) ─────────────────────────────────────────────────

/**
 * Status de entrada do registro que contam como "envio registrado" para o
 * alarme. `send_unknown` (timeout/5xx na criação, #10772) fica de fora: o
 * envio pode não ter saído, e o editor precisa conferir, então o alarme fica.
 */
export const ENVIO_REGISTRADO_STATUS: readonly ShortPublishedEntry["status"][] = ["published", "scheduled"];

/**
 * Puro (#12825, decisão do editor: opção a). O item `agendado` vencido não
 * alarma quando CADA destino dele tem uma destas leituras:
 *   - `publicado` (destino com leitor, relido no ar);
 *   - `sem-leitor` com envio registrado (`ENVIO_REGISTRADO_STATUS`).
 * Qualquer outra (`sem-registro`, `nao-publicado`, `erro`, `sem-leitor` de
 * envio `send_unknown`, destino sem leitura) mantém o alarme.
 */
export function envioRegistradoSemAlarme(item: Pick<AgendamentoItem, "destinos">, leituras: readonly LeituraDestino[]): boolean {
  if (item.destinos.length === 0) return false;
  const porDestino = new Map(leituras.map((l) => [l.destino, l]));
  return item.destinos.every((d) => {
    const l = porDestino.get(d);
    return l !== undefined && leituraSemAlarme(l);
  });
}

/** Puro: a leitura de UM destino dispensa o alarme? (ver `envioRegistradoSemAlarme`). */
export function leituraSemAlarme(l: LeituraDestino): boolean {
  if (l.status === "publicado") return true;
  return l.status === "sem-leitor" && l.envio !== undefined && ENVIO_REGISTRADO_STATUS.includes(l.envio);
}

export interface EnvioRegistradoItem {
  item: AgendamentoItem;
  leituras: LeituraDestino[];
  semAlarme: boolean;
}

/**
 * Relê os destinos dos itens `agendado` de peça com corte conhecido (os
 * `ids` dados, ou todos) e diz quais têm o envio registrado
 * (`envioRegistradoSemAlarme`). Somente leitura; nunca lança (falha de
 * leitura vira `erro`, que mantém o alarme). O tick passa só os vencidos,
 * para não reler a plataforma à toa.
 */
export async function agendadosComEnvioRegistrado(
  banco: AgendamentosBanco,
  deps: VerificarDeps,
  ids?: ReadonlySet<string>,
): Promise<EnvioRegistradoItem[]> {
  const out: EnvioRegistradoItem[] = [];
  for (const item of itensVerificaveis(banco)) {
    if (ids && !ids.has(item.id)) continue;
    const leituras = await lerDestinosDoItem(item, deps);
    out.push({ item, leituras, semAlarme: envioRegistradoSemAlarme(item, leituras) });
  }
  return out;
}

export interface AvaliacaoComEnvio {
  avaliacao: AgendamentosAvaliacao;
  /** Releituras feitas nos `agendado` vencidos (vazio quando não há nenhum). */
  envios: EnvioRegistradoItem[];
}

/**
 * O que o tick avalia (#12825): `avaliarAgendamentos` com os `agendado`
 * vencidos cujo envio está registrado fora dos achados. Relê a plataforma só
 * para os `agendado` que seriam achado; sem nenhum, não lê nada.
 */
export async function avaliarAgendamentosComEnvio(
  banco: AgendamentosBanco,
  deps: VerificarDeps,
  graceMinutes?: number,
): Promise<AvaliacaoComEnvio> {
  const base = avaliarAgendamentos(banco, deps.now, { graceMinutes });
  const candidatos = new Set(
    base.achados.filter((a) => a.tipo === "vencido-sem-publicacao" && a.item.estado === "agendado").map((a) => a.item.id),
  );
  if (candidatos.size === 0) return { avaliacao: base, envios: [] };
  const envios = await agendadosComEnvioRegistrado(banco, deps, candidatos);
  const semAlarme = new Set(envios.filter((e) => e.semAlarme).map((e) => e.item.id));
  return { avaliacao: avaliarAgendamentos(banco, deps.now, { graceMinutes, semAlarme }), envios };
}

/** Relê os itens verificáveis do banco e decide cada um. Não grava. */
export async function verificarAgendamentos(banco: AgendamentosBanco, deps: VerificarDeps, id?: string): Promise<VerificacaoItem[]> {
  const out: VerificacaoItem[] = [];
  for (const item of itensVerificaveis(banco, id)) {
    out.push(decidirVerificacao(item, await lerDestinosDoItem(item, deps), deps.now));
  }
  return out;
}

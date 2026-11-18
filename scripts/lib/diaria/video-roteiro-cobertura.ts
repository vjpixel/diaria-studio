/**
 * #13544: fala do roteiro sem tomada na montagem, e vídeo solto na pasta da
 * edição fora do bruto do `source.json`.
 *
 * Na 261118 o CTA dos dois verticais (V1-CTA e V2-CTA) foi gravado num 2º
 * arquivo da pasta e a montagem usou só o 1º: decupagem, roteiro final e build
 * passaram sem acusar que duas falas do roteiro não tinham tomada, e o editor só
 * notou no Premiere. Daqui:
 *
 *   - `falasSemTomada`: as falas do `roteiro-falas.json` sem nenhum item do
 *     `blocks.json` resolvido no bruto (pelo id `fala`/`falaId` do item, ou
 *     pelo texto), por id, para o `build` avisar;
 *   - `videosForaDoBruto`: os vídeos soltos na pasta da edição que não são o
 *     bruto do `source.json` (nem um dos arquivos dele), para `decupagem` e
 *     `build` avisarem e sugerirem `transcribe --source a,b`.
 *
 * Puro, salvo `readRoteiroFalasLista` (lê o JSON do roteiro).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "./video-montage.ts";

/** O mesmo `ROTEIRO_FALAS_FILE` de `roteiro-videos.ts` (importar de lá fecha ciclo com `video-montage.ts`). */
const ROTEIRO_FALAS_PATH = "_internal/roteiro-falas.json";

export interface FalaDoRoteiro {
  id: string;
  texto: string;
  videos?: string[];
  gravarAParte?: boolean;
}

/**
 * As falas do roteiro (id, texto, vídeos). Roteiro ausente = `[]` (edição sem
 * `/diaria-video-roteiro`: nada a conferir); ilegível = `[]` com aviso.
 */
export function readRoteiroFalasLista(editionDir: string, warn: (msg: string) => void): FalaDoRoteiro[] {
  const path = join(editionDir, ROTEIRO_FALAS_PATH);
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warn(`${path} ilegível (${(e as Error).message}): falas do roteiro não conferidas contra o blocks.json (#13544)`);
    return [];
  }
  const falas = (raw as { falas?: unknown } | null)?.falas;
  if (!Array.isArray(falas)) return [];
  const out: FalaDoRoteiro[] = [];
  for (const f of falas as Array<Record<string, unknown> | null>) {
    if (!f || typeof f.id !== "string" || typeof f.texto !== "string" || !f.texto.trim()) continue;
    const videos = Array.isArray(f.videos) ? f.videos.filter((v): v is string => typeof v === "string") : undefined;
    out.push({ id: f.id, texto: f.texto, ...(videos ? { videos } : {}), ...(f.gravarAParte === true ? { gravarAParte: true } : {}) });
  }
  return out;
}

/** O mínimo de um item resolvido que a conferência lê. */
export interface ItemParaCobertura {
  text: string;
  heard?: string;
  fala?: string;
  falaId?: string;
}

/** Fração das palavras da fala presentes no texto de UM item, acima da qual o item é tomada dela. */
export const COBERTURA_MINIMA_FALA = 0.6;
/** Item de até tantas palavras só casa com a fala inteira (um "Sim." não cobre a fala de ninguém). */
const MIN_TOKENS_TRECHO = 3;

function cobre(fala: string[], item: string[]): boolean {
  if (!fala.length || !item.length) return false;
  const f = fala.join(" ");
  const x = item.join(" ");
  if (f === x) return true;
  // O corte parcial (#13129): o item é um trecho da fala, com 3+ palavras.
  if (item.length >= MIN_TOKENS_TRECHO && ` ${f} `.includes(` ${x} `)) return true;
  // Dito de outro jeito: a maior parte das palavras da fala está no item.
  const bag = new Map<string, number>();
  for (const t of item) bag.set(t, (bag.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of fala) {
    const n = bag.get(t) ?? 0;
    if (n > 0) {
      hit++;
      bag.set(t, n - 1);
    }
  }
  return fala.length >= MIN_TOKENS_TRECHO && hit / fala.length >= COBERTURA_MINIMA_FALA;
}

/**
 * As falas do roteiro sem tomada no `blocks.json` resolvido: nenhum item com o
 * id dela (`fala`, ou o `falaId` da decupagem) e nenhum item sem id cujo texto
 * (pedido ou ouvido) seja a fala, um trecho dela com 3+ palavras, ou cubra
 * `COBERTURA_MINIMA_FALA` das palavras dela. Item com id só conta para a fala
 * desse id (como o texto de tela, #13204/#13309). Na ordem do roteiro.
 */
export function falasSemTomada(falas: readonly FalaDoRoteiro[], items: readonly ItemParaCobertura[]): FalaDoRoteiro[] {
  const ids = new Set(items.flatMap((it) => {
    const id = it.fala ?? it.falaId;
    return id === undefined ? [] : [id];
  }));
  const semId = items.filter((it) => (it.fala ?? it.falaId) === undefined).map((it) => [tokenize(it.text), it.heard ? tokenize(it.heard) : []]);
  return falas.filter((f) => {
    if (ids.has(f.id)) return false;
    const toks = tokenize(f.texto);
    return !semId.some(([a, b]) => cobre(toks, a) || cobre(toks, b));
  });
}

/** O aviso do `build` para as falas sem tomada (uma linha, ids na ordem do roteiro). */
export function falasSemTomadaAviso(sem: readonly FalaDoRoteiro[], extras: readonly string[]): string | null {
  if (!sem.length) return null;
  const lista = sem.map((f) => `${f.id}${f.videos?.length ? ` (${f.videos.join("/")})` : ""}`).join(", ");
  const onde = extras.length
    ? `; há outro(s) vídeo(s) solto(s) na pasta fora do bruto (${extras.join(", ")}): se a fala foi gravada lá, refazer o transcribe com os dois arquivos (--source a,b --force) e a decupagem`
    : "; se a fala foi gravada noutro arquivo, refazer o transcribe com os dois arquivos (--source a,b --force)";
  return `${sem.length} fala(s) do roteiro sem tomada no blocks.json: ${lista}. Elas não entram em sequência nenhuma${onde}; se o corte foi de propósito, ignorar (#13544)`;
}

/**
 * Os vídeos soltos na pasta da edição (`candidates` do `pickRawSource`) que não
 * são o bruto do `source.json` nem um dos arquivos dele. Comparação pelo nome
 * do arquivo: o `source.json` grava o caminho, e o mesmo arquivo pode vir por
 * outra raiz (Drive for desktop × cache do modo API).
 */
export function videosForaDoBruto(
  candidates: ReadonlyArray<{ name: string }>,
  source: { path: string; files?: ReadonlyArray<{ path: string }>; audioOnly?: boolean },
): string[] {
  const base = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
  const used = new Set((source.files?.length ? source.files.map((x) => x.path) : [source.path]).map(base));
  return candidates.map((c) => c.name).filter((n) => !used.has(n));
}

/** O aviso de `decupagem`/`build` para os vídeos fora do bruto, com o comando do transcribe com todos. */
export function videosForaDoBrutoAviso(edition: string, extras: readonly string[], source: { path: string; files?: ReadonlyArray<{ path: string }> }): string | null {
  if (!extras.length) return null;
  const base = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
  const atuais = (source.files?.length ? source.files.map((x) => x.path) : [source.path]).map(base);
  return (
    `${extras.length} vídeo(s) solto(s) na pasta da edição fora do bruto do source.json (${extras.join(", ")}): ` +
    `fala gravada neles (CTA, regravação) não entra na montagem. Se for parte da gravação: ` +
    `npx tsx scripts/video-montagem.ts transcribe ${edition} --source "${[...atuais, ...extras].join(",")}" --force, e a decupagem de novo; se não for, ignorar (#13544)`
  );
}

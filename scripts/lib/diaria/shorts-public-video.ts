/**
 * shorts-public-video.ts (#11265)
 *
 * De onde sai a URL PÚBLICA do vertical do dia — o `video_url` que a Graph
 * API (Reels agendado na fila do Worker), a Buffer (X) e a Threads API baixam
 * no horário do disparo.
 *
 * Dois backends, escolhidos em `publishing.shorts.public_video.backend`:
 *
 *   - `tunnel` (decisão do editor no briefing 261027d, #11265): o vertical é
 *     COPIADO para uma pasta local do 300 que só contém verticais do dia, e
 *     servido em `https://media.diar.ia.br/diaria-comentada-{AAMMDD}-short.mp4`
 *     pelo `scripts/shorts-media-server.ts` (somente leitura, sem listagem,
 *     só o padrão de nome do vertical) atrás de um 2º hostname do Cloudflare
 *     Tunnel que já serve o Studio. Zero conta/custo novo.
 *     RISCO REGISTRADO: o 300, o servidor de mídia e o túnel precisam estar de
 *     pé NA HORA DO DISPARO — quem baixa o vídeo é a Graph/Buffer/Threads no
 *     horário agendado, não este script. A conferência daqui (HEAD na URL
 *     pública logo depois de copiar) só prova que estava de pé na hora do
 *     `--publish`. Runbook: docs/shorts-media-tunnel.md.
 *   - `r2` (#10823): sobe pro bucket R2 (`scripts/lib/r2-object-upload.ts`).
 *     Segue como alternativa; é o default quando `public_video` não existe
 *     no config.
 *
 * Só funciona na máquina que tem a pasta servida (o 300): em qualquer outra
 * o backend `tunnel` fica `ready: false` e os destinos que dependem de URL
 * pública caem no comportamento de sem-R2 (pendente/guiado), nunca publicam
 * com URL que não vai existir.
 */

import { copyFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadR2UploadConfig, uploadToR2 } from "../r2-object-upload.ts";
import { shortVideoFileName } from "./short-video.ts";

export type PublicVideoBackend = "tunnel" | "r2";

export interface TunnelPublicVideoConfig {
  backend: "tunnel";
  /** Base pública https, sem barra no fim (ex.: https://media.diar.ia.br). */
  publicBase: string;
  /** Pasta local servida pelo `shorts-media-server.ts` (já com `~` expandido). */
  dir: string;
}

export type PublicVideoConfig = TunnelPublicVideoConfig | { backend: "r2" };

/** Env que sobrepõe `tunnel_dir` do config (mesma pasta que o servidor de mídia lê). */
export const SHORTS_MEDIA_DIR_ENV = "SHORTS_MEDIA_DIR";

/** Nome servido: exatamente o do vertical de uma edição, nada mais (#11265). */
export const SHORT_VIDEO_NAME_RE = /^diaria-comentada-(\d{6})-short\.mp4$/;

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

/**
 * Pure: lê `publishing.shorts.public_video`. Ausente → `r2` (comportamento de
 * antes do #11265). Config inválido lança — erro de config nunca vira
 * "sem URL pública" em silêncio.
 */
export function loadPublicVideoConfig(
  config: unknown,
  env: Record<string, string | undefined>,
  home: string = homedir(),
): PublicVideoConfig {
  const raw = (config as any)?.publishing?.shorts?.public_video;
  if (raw === undefined || raw === null) return { backend: "r2" };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("[shorts] publishing.shorts.public_video precisa ser um objeto (#11265).");
  }
  if (raw.backend === "r2") return { backend: "r2" };
  if (raw.backend !== "tunnel") {
    throw new Error(`[shorts] publishing.shorts.public_video.backend precisa ser "tunnel" ou "r2" (veio ${JSON.stringify(raw.backend)}) (#11265).`);
  }
  const base = typeof raw.tunnel_public_base === "string" ? raw.tunnel_public_base.trim().replace(/\/+$/, "") : "";
  if (!/^https:\/\/[^/\s]+$/.test(base)) {
    throw new Error("[shorts] publishing.shorts.public_video.tunnel_public_base precisa ser uma origem https sem caminho (ex.: https://media.diar.ia.br) (#11265).");
  }
  const dirRaw = env[SHORTS_MEDIA_DIR_ENV]?.trim() || (typeof raw.tunnel_dir === "string" ? raw.tunnel_dir.trim() : "");
  if (!dirRaw) throw new Error("[shorts] publishing.shorts.public_video.tunnel_dir é obrigatório com backend tunnel (#11265).");
  return { backend: "tunnel", publicBase: base, dir: expandHome(dirRaw, home) };
}

/** URL pública do vertical no backend `tunnel`. */
export function tunnelVideoUrl(cfg: TunnelPublicVideoConfig, aammdd: string): string {
  return `${cfg.publicBase}/${shortVideoFileName(aammdd)}`;
}

/** Data AAMMDD de `now` no fuso de São Paulo. */
export function brtAammdd(now: Date): string {
  const ymd = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }); // YYYY-MM-DD
  return ymd.slice(2, 4) + ymd.slice(5, 7) + ymd.slice(8, 10);
}

/**
 * Pure (#11265): quais arquivos da pasta servida apagar ao publicar `aammdd`.
 * Sai o vertical de edição JÁ PASSADA (AAMMDD < hoje em BRT): o de hoje e os
 * futuros ainda podem estar na fila do Worker esperando o horário. Nunca o
 * recém-copiado. Arquivo fora do padrão de nome não é tocado (o servidor já
 * não o serve) — vira aviso.
 */
export function planTunnelRetention(names: string[], aammdd: string, now: Date): { remove: string[]; foreign: string[] } {
  const today = brtAammdd(now);
  const remove: string[] = [];
  const foreign: string[] = [];
  for (const n of names) {
    if (n.startsWith(".")) continue; // temporário da cópia atômica
    const m = SHORT_VIDEO_NAME_RE.exec(n);
    if (!m) {
      foreign.push(n);
      continue;
    }
    if (m[1] !== aammdd && m[1] < today) remove.push(n);
  }
  return { remove, foreign };
}

export interface PublicVideoHostDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => Date;
  warn: (msg: string) => void;
}

export type PublicVideoHost =
  | { ready: true; label: string; upload: (aammdd: string, file: Buffer, srcPath: string) => Promise<string> }
  | { ready: false; label: string; missing: string[] };

/** HEAD na URL pública e conferência do tamanho — mesma prova que o R2 faz. */
async function verifyPublicUrl(deps: PublicVideoHostDeps, url: string, size: number): Promise<void> {
  let head: Response;
  try {
    head = await deps.fetch(url, { method: "HEAD" });
  } catch (e) {
    throw new Error(`túnel: ${url} não respondeu (${(e as Error).message}) — confira diaria-shorts-media.service e diaria-studio-tunnel.service no 300 (docs/shorts-media-tunnel.md)`);
  }
  if (!head.ok) {
    throw new Error(`túnel: ${url} não está público (HEAD ${head.status}) — confira o ingress de media.diar.ia.br e o servidor de mídia no 300 (docs/shorts-media-tunnel.md)`);
  }
  const len = head.headers.get("content-length");
  if (len !== null && Number(len) !== size) {
    throw new Error(`túnel: ${url} serve ${len} bytes, o arquivo tem ${size} — cópia incompleta ou cache velho na borda`);
  }
}

/**
 * Copia o vertical pra pasta servida (cópia atômica: temporário oculto +
 * rename, assim o servidor nunca entrega um arquivo pela metade), aplica a
 * retenção e confere a URL pública. Lança em qualquer falha — o caller não
 * enfileira Reels com URL que a Graph não vai conseguir baixar.
 */
export async function stageVideoInTunnelDir(
  deps: PublicVideoHostDeps,
  cfg: TunnelPublicVideoConfig,
  aammdd: string,
  srcPath: string,
  size: number,
): Promise<string> {
  const name = shortVideoFileName(aammdd);
  const dest = join(cfg.dir, name);
  const tmp = join(cfg.dir, `.${name}.tmp`);
  copyFileSync(srcPath, tmp);
  renameSync(tmp, dest);
  const { remove, foreign } = planTunnelRetention(readdirSync(cfg.dir), aammdd, deps.now());
  for (const n of remove) {
    try {
      rmSync(join(cfg.dir, n), { force: true });
    } catch (e) {
      deps.warn(`[túnel] retenção (#11265): não apagou ${n} (${(e as Error).message}) — não bloqueia`);
    }
  }
  if (remove.length) deps.warn(`[túnel] retenção (#11265): apagados ${remove.length} vertical(is) de edição passada de ${cfg.dir}`);
  if (foreign.length) deps.warn(`[túnel] ${cfg.dir} tem arquivo(s) fora do padrão do vertical (${foreign.join(", ")}) — o servidor não os serve; remova à mão`);
  const url = tunnelVideoUrl(cfg, aammdd);
  await verifyPublicUrl(deps, url, size);
  return url;
}

/**
 * Resolve o host da URL pública pra esta rodada. `tunnel` exige a pasta
 * servida nesta máquina (só existe no 300) e, quando `probe` vem, que o
 * `/healthz` do servidor de mídia responda pela URL pública — se o túnel
 * estiver fora do ar já no planejamento, os destinos caem em pendente/guiado
 * em vez de falhar no `--publish`.
 */
export async function resolvePublicVideoHost(
  cfg: PublicVideoConfig,
  env: Record<string, string | undefined>,
  deps: PublicVideoHostDeps,
  opts: { probe: boolean; exists?: (p: string) => boolean; isDir?: (p: string) => boolean } = { probe: true },
): Promise<PublicVideoHost> {
  if (cfg.backend === "r2") {
    const r2 = loadR2UploadConfig(env);
    if (!r2.ready) return { ready: false, label: "R2", missing: r2.missing };
    return {
      ready: true,
      label: "R2",
      upload: (aammdd, file) =>
        uploadToR2({ fetch: deps.fetch, now: deps.now }, r2.config, `shorts/${shortVideoFileName(aammdd)}`, file, "video/mp4"),
    };
  }
  const label = `túnel (${cfg.publicBase})`;
  const exists = opts.exists ?? existsSync;
  const isDir = opts.isDir ?? ((p: string) => statSync(p).isDirectory());
  if (!exists(cfg.dir) || !isDir(cfg.dir)) {
    return {
      ready: false,
      label,
      missing: [`pasta servida ${cfg.dir} (só existe no 300; ${SHORTS_MEDIA_DIR_ENV} sobrepõe — docs/shorts-media-tunnel.md)`],
    };
  }
  if (opts.probe) {
    const health = `${cfg.publicBase}/healthz`;
    try {
      const res = await deps.fetch(health, { method: "GET", signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { ready: false, label, missing: [`${health} respondeu HTTP ${res.status} (túnel ou servidor de mídia fora do ar)`] };
    } catch (e) {
      return { ready: false, label, missing: [`${health} não respondeu (${(e as Error).message}) — túnel ou servidor de mídia fora do ar`] };
    }
  }
  return {
    ready: true,
    label,
    upload: (aammdd, file, srcPath) => stageVideoInTunnelDir(deps, cfg, aammdd, srcPath, file.length),
  };
}

/**
 * scripts/set-latest-video-redirect.ts (#12735)
 *
 * Aponta `diar.ia.br/video` (o link fixo da bio no TikTok, Instagram e
 * Threads) para o horizontal da edição: lê `_internal/05-video-url.txt` e
 * grava o registro `video:latest-horizontal` no KV `POLL`, que o Worker do
 * apex (`workers/site`) lê a cada clique. Contrato do registro e do redirect:
 * `scripts/lib/shared/latest-video-redirect.ts`.
 *
 * Uso:
 *   npx tsx scripts/set-latest-video-redirect.ts AAMMDD            # plano (dry-run), não grava
 *   npx tsx scripts/set-latest-video-redirect.ts AAMMDD --apply    # grava no KV
 *
 * O `--publish` do `publish-shorts.ts` chama `updateLatestVideoRedirect`
 * sozinho (fail-soft), então no fluxo do `/diaria-publica` este script só
 * serve para conferir ou regravar à mão.
 *
 * A gravação só avança: edição anterior à que está no KV não sobrescreve
 * (`shouldReplaceLatestVideo`). Horizontal agendado (#12801): o registro leva
 * o `public_at` do upload e o horizontal anterior em `previous`; o Worker só
 * passa a servir o novo depois do `public_at` — gravar na noite de D-1 nunca
 * manda o link da bio para um vídeo ainda privado. Sem o registro do upload
 * (caminho de reserva: subido pelo YouTube Studio, link colado), o `public_at`
 * presumido é 06:00 BRT do dia da edição (`resolveEditionHorizontalPublicAt`). Credenciais: `CLOUDFLARE_ACCOUNT_ID` +
 * `CLOUDFLARE_WORKERS_TOKEN` (as mesmas do upload de imagens no KV `POLL`).
 *
 * Exit: 0 gravado/sem mudança/plano; 1 falha (credencial, KV, link ausente
 * no `--apply`); 2 uso inválido.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { createKvRestOps } from "./lib/cloudflare-kv-rest.ts";
import { D1_VIDEO_URL_FILE, parseD1VideoUrlFile } from "./lib/diaria/d1-video-link.ts";
import { extractYouTubeVideoId } from "./lib/diaria/d1-video-link.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./lib/diaria/youtube-upload.ts";
import { DEFAULT_EDITION_SCHEDULE_HHMM, resolveEditionScheduledAt } from "./lib/edition-scheduled-at.ts";
import {
  LATEST_VIDEO_KV_KEY,
  isLatestVideoPublic,
  parseLatestVideoRecord,
  shouldReplaceLatestVideo,
  type LatestVideoPrevious,
  type LatestVideoRecord,
} from "./lib/shared/latest-video-redirect.ts";

/** Namespace `POLL` (`workers/site/wrangler.toml` e `workers/poll/wrangler.toml`). */
export const POLL_KV_NAMESPACE_ID = "72784da4ae39444481eb422ebac357c6";

/** O que o KV precisa oferecer (subconjunto de `KvOps`). */
export interface LatestVideoKv {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string) => Promise<void>;
}

export type LatestVideoUpdateOutcome =
  | { status: "no_link"; detail: string }
  | { status: "unchanged"; record: LatestVideoRecord }
  | { status: "older"; record: LatestVideoRecord; current: LatestVideoRecord }
  | { status: "would_write"; record: LatestVideoRecord; current: LatestVideoRecord | null }
  | { status: "written"; record: LatestVideoRecord; current: LatestVideoRecord | null };

/** Lê o link do horizontal da edição (`null` = arquivo ausente ou vazio). Lança se o conteúdo não for vídeo do YouTube. */
export function readEditionHorizontalUrl(editionDir: string): string | null {
  const path = join(editionDir, D1_VIDEO_URL_FILE);
  if (!existsSync(path)) return null;
  return parseD1VideoUrlFile(readFileSync(path, "utf8"));
}

/**
 * #12801: quando o horizontal `url` fica público, lido do registro do upload
 * (`_internal/05-youtube-published.json`: `rereadStatus.publishAt`, senão
 * `requested.publishAt`). `null` = sem agendamento no registro (upload na
 * hora, link colado à mão, registro de outro vídeo ou ilegível). Quem grava o
 * KV usa `resolveEditionHorizontalPublicAt`, que separa o upload na hora do
 * caminho de reserva.
 */
export function readEditionHorizontalPublicAt(editionDir: string, url: string): string | null {
  return readUploadRecordForVideo(editionDir, url).publishAt;
}

/**
 * #12801: o registro do upload (`05-youtube-published.json`) é DESTE vídeo?
 * `matched: false` = sem registro, ilegível ou de outro vídeo — o link veio
 * do caminho de reserva (upload pelo YouTube Studio + link colado,
 * `link-video-d1.ts --save`), e o estado do vídeo é desconhecido.
 */
function readUploadRecordForVideo(editionDir: string, url: string): { matched: boolean; publishAt: string | null } {
  const none = { matched: false, publishAt: null };
  const path = join(editionDir, YOUTUBE_PUBLISHED_FILE);
  if (!existsSync(path)) return none;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return none;
  }
  if (!raw || typeof raw !== "object") return none;
  const r = raw as Record<string, unknown>;
  const id = extractYouTubeVideoId(url);
  if (!id || r.videoId !== id) return none;
  const pick = (o: unknown): string | null => {
    const v = o && typeof o === "object" ? (o as Record<string, unknown>).publishAt : null;
    return typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null;
  };
  return { matched: true, publishAt: pick(r.rereadStatus) ?? pick(r.requested) };
}

export type HorizontalPublicAtSource = "upload" | "upload_immediate" | "edition_default";

/**
 * #12801 (resíduo): o `public_at` do registro do KV.
 *   - registro do upload deste vídeo com `publishAt` → ele (`upload`);
 *   - registro deste vídeo sem `publishAt` (upload na hora) → `null`, vale já
 *     (`upload_immediate`);
 *   - sem registro deste vídeo (caminho de reserva: o editor subiu pelo
 *     YouTube Studio e colou o link) → 06:00 BRT do dia da edição
 *     (`edition_default`), o horário em que o horizontal é agendado. Premissa
 *     conservadora: se o editor publicou na hora, o link da bio só segue no
 *     horizontal anterior (público) até as 06:00; sem ela, ia para um vídeo
 *     possivelmente privado até lá. Depois das 06:00 o default já passou e o
 *     registro vale na hora, como antes.
 */
export function resolveEditionHorizontalPublicAt(
  editionDir: string,
  url: string,
  aammdd: string,
): { publicAt: string | null; source: HorizontalPublicAtSource } {
  const upload = readUploadRecordForVideo(editionDir, url);
  if (upload.matched) return { publicAt: upload.publishAt, source: upload.publishAt ? "upload" : "upload_immediate" };
  let publicAt: string | null = null;
  try {
    publicAt = resolveEditionScheduledAt(aammdd, DEFAULT_EDITION_SCHEDULE_HHMM);
  } catch {
    publicAt = null; // AAMMDD fora do calendário: sem horário a presumir
  }
  return { publicAt, source: "edition_default" };
}

/** #12801: o registro sem o `previous` aninhado (o KV guarda um nível só). */
function withoutPrevious(r: LatestVideoRecord): LatestVideoPrevious {
  const { previous: _previous, ...rest } = r;
  return rest;
}

/**
 * #12801: o `previous` do registro novo — o horizontal que o link da bio
 * serve até o novo ficar público. Edição nova: o atual, se já público em
 * `now`, senão o `previous` dele. Mesma edição (link trocado): mantém o
 * `previous` do atual.
 */
export function previousForNewRecord(current: LatestVideoRecord | null, aammdd: string, now: Date): LatestVideoPrevious | null {
  if (!current) return null;
  if (current.aammdd === aammdd) return current.previous ?? null;
  return isLatestVideoPublic(current, now) ? withoutPrevious(current) : current.previous ?? null;
}

/**
 * Grava (ou, com `apply: false`, só planeja) o registro do horizontal da
 * edição. `kv` só é lido/escrito quando há link. Lança em falha de KV: quem
 * chama decide se é fatal (este CLI) ou aviso (`publish-shorts.ts`).
 */
export async function updateLatestVideoRedirect(input: {
  editionDir: string;
  aammdd: string;
  kv: LatestVideoKv;
  apply: boolean;
  now: Date;
}): Promise<LatestVideoUpdateOutcome> {
  const url = readEditionHorizontalUrl(input.editionDir);
  if (!url) return { status: "no_link", detail: `${D1_VIDEO_URL_FILE} ausente ou vazio — o horizontal da edição ${input.aammdd} ainda não tem link` };
  const record: LatestVideoRecord = { url, aammdd: input.aammdd, updated_at: input.now.toISOString() };
  // #12801: o horizontal agendado (private até 06:00 BRT de D) leva o `public_at`, e o
  // registro guarda o anterior para o Worker servir até lá (`effectiveLatestVideoRecord`).
  // Resíduo: no caminho de reserva (sem registro do upload) presume as 06:00 BRT da edição.
  const { publicAt } = resolveEditionHorizontalPublicAt(input.editionDir, url, input.aammdd);
  if (publicAt) record.public_at = publicAt;
  const current = parseLatestVideoRecord(await input.kv.get(LATEST_VIDEO_KV_KEY));
  const previous = previousForNewRecord(current, input.aammdd, input.now);
  if (previous) record.previous = previous;
  if (current && current.aammdd === record.aammdd && current.url === record.url && current.public_at === record.public_at) return { status: "unchanged", record: current };
  if (!shouldReplaceLatestVideo(current, record)) return { status: "older", record, current: current! };
  if (!input.apply) return { status: "would_write", record, current };
  await input.kv.put(LATEST_VIDEO_KV_KEY, JSON.stringify(record));
  return { status: "written", record, current };
}

/** KV `POLL` pela API REST, com as credenciais do ambiente; `null` + motivo se faltar alguma. */
export function pollKvFromEnv(env: NodeJS.ProcessEnv = process.env): { kv: LatestVideoKv; reason?: undefined } | { kv: null; reason: string } {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_WORKERS_TOKEN;
  const missing = [!accountId && "CLOUDFLARE_ACCOUNT_ID", !token && "CLOUDFLARE_WORKERS_TOKEN"].filter(Boolean);
  if (missing.length) return { kv: null, reason: `faltam ${missing.join(", ")} no ambiente` };
  return { kv: createKvRestOps({ accountId: accountId!, token: token!, namespaceId: POLL_KV_NAMESPACE_ID }) };
}

/** Linha de log de um resultado (usada aqui e no `publish-shorts.ts`). */
export function describeLatestVideoOutcome(o: LatestVideoUpdateOutcome): string {
  switch (o.status) {
    case "no_link":
      return `diar.ia.br/video sem mudança: ${o.detail}`;
    case "unchanged":
      return `diar.ia.br/video já aponta para ${o.record.url} (edição ${o.record.aammdd})`;
    case "older":
      // #12863: `older` só sai com a edição gravada estritamente mais nova; o texto
      // não presume isso, pra não voltar a dizer "mais nova que" ela mesma.
      return o.current.aammdd === o.record.aammdd
        ? `diar.ia.br/video mantido em ${o.current.url} (edição ${o.current.aammdd}, o registro novo não muda nada)`
        : `diar.ia.br/video mantido em ${o.current.url} (edição ${o.current.aammdd}, mais nova que ${o.record.aammdd})`;
    case "would_write":
      return `diar.ia.br/video passaria a ${o.record.url} (edição ${o.record.aammdd}; hoje ${o.current ? `${o.current.url}, ${o.current.aammdd}` : "sem registro"}) — rode com --apply`;
    case "written":
      return o.record.public_at
        ? `diar.ia.br/video aponta para ${o.record.url} (edição ${o.record.aammdd}) a partir de ${o.record.public_at}; até lá ${o.record.previous ? `segue em ${o.record.previous.url} (edição ${o.record.previous.aammdd})` : "cai na lista do canal"} (#12801)`
        : `diar.ia.br/video agora aponta para ${o.record.url} (edição ${o.record.aammdd})`;
  }
}

async function main(): Promise<number> {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const aammdd = positional[0];
  if (!aammdd || !/^\d{6}$/.test(aammdd)) {
    console.error("uso: set-latest-video-redirect.ts AAMMDD [--apply]");
    return 2;
  }
  loadProjectEnv();
  const env = pollKvFromEnv();
  if (!env.kv) {
    console.error(`set-latest-video-redirect: ${env.reason}`);
    return 1;
  }
  const apply = flags.has("apply");
  const outcome = await updateLatestVideoRedirect({ editionDir: editionDirFor(aammdd), aammdd, kv: env.kv, apply, now: new Date() });
  console.error(describeLatestVideoOutcome(outcome));
  console.log(JSON.stringify({ dry_run: !apply, ...outcome }, null, 2));
  return outcome.status === "no_link" && apply ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("set-latest-video-redirect:", e instanceof Error ? e.message : e) });
}

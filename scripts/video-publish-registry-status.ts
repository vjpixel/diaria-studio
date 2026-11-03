#!/usr/bin/env node
/**
 * scripts/video-publish-registry-status.ts (#11741)
 *
 * Relê os registros de publicação dos vídeos da edição — o horizontal
 * (`_internal/05-youtube-published.json`, de `publish-youtube.ts --upload`) e
 * o vertical (`_internal/06-shorts-published*.json`, de `publish-shorts.ts
 * --publish`, todos os escritores unidos) — e diz o que foi registrado desde
 * um instante. Só leitura: não chama API, não grava nada.
 *
 * Uso:
 *   npx tsx scripts/video-publish-registry-status.ts AAMMDD [--since ISO] [--edition-dir DIR]
 *   npx tsx scripts/video-publish-registry-status.ts --corte SLUG [AAMMDD] [--since ISO] [--edition-dir DIR]
 *
 * Corte avulso e vertical extra (#11970): o modo corte do `publish-shorts.ts`
 * (`--corte SLUG`, #11795/#11900) grava registro e marcas de envio em
 * `data/cortes/{slug}/_internal/`, não na pasta da edição. Com `--corte SLUG`
 * o status lê essa pasta (relativa à raiz do repo, como o publisher; o
 * `--edition-dir` só sobrepõe para o corte rodado com `--allow-unwatched-dir`)
 * e tira a data do `corte.json`. Sem isso, a releitura da edição respondia
 * `nothing-since` para um corte que o processo sobrevivente publicou.
 *
 * Para que serve: a `/diaria-publica-video` roda isto depois de QUALQUER
 * interrupção ou rejeição de uma chamada de publisher, antes de seguir
 * (decisão do editor, #11741). Em 261030 duas chamadas rejeitadas no app
 * parecem ter publicado mesmo assim — hipótese: a interrupção não mata o
 * processo já em execução (camada de harness, ver
 * `scripts/lib/diaria/publish-confirm.ts`). Com `--since` = o instante da
 * chamada interrompida, `registered_since` lista o que o processo
 * sobrevivente gravou. Um destino nessa lista saiu (ou pode ter saído, no
 * caso de `in_progress`/`upload_indeterminado`/`send_unknown`): relatar ao
 * editor, nunca publicar de novo.
 *
 * Envio em curso do vertical (finding P2 da PR #11827): o registro do
 * vertical só recebe o destino DEPOIS do aceite da plataforma. O
 * `publish-shorts.ts` grava antes uma marca por destino
 * (`_internal/06-shorts-sending*.json`, `lib/diaria/shorts-sending-marker.ts`);
 * marca sem entrada no registro gravada depois dela vai para `sending` e para
 * `registered_since` — o destino pode estar saindo agora. Com marca em aberto o
 * veredito nunca é `nothing-since`.
 *
 * Saída: JSON no stdout. Exit 0 = registros lidos; exit 1 = algum registro
 * ilegível (não dá para saber o que saiu: conferir as contas antes de
 * qualquer nova chamada); exit 2 = uso.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir as editionDirFor } from "./lib/edition-paths.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import type { ShortsPublishedFile } from "./lib/diaria/short-video.ts";
import { readPublishedRecord, type PublishedRecordRead } from "./publish-youtube.ts";
import { YOUTUBE_PUBLISHED_FILE } from "./lib/diaria/youtube-upload.ts";
import { openSendingMarks, readShortsSending, type ShortSendingMark } from "./lib/diaria/shorts-sending-marker.ts";
import { CORTE_SPEC_FILE, corteRelDir, parseCorteSpec, validateCorteSlug } from "./lib/diaria/short-corte.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type RegistryRead<T> = { ok: true; value: T } | { ok: false; error: string };

export interface VideoRegistryStatusInput {
  aammdd: string;
  since: string | null;
  youtube: RegistryRead<PublishedRecordRead>;
  shorts: RegistryRead<ShortsPublishedFile>;
  /** Marcas de "envio em curso" do vertical (todas as do disco; o resumo filtra as em aberto). */
  sending: RegistryRead<ShortSendingMark[]>;
}

export interface SendingStatusLine {
  destination: string;
  started_at: string;
  pid?: number;
  since_match?: boolean;
}

export interface YouTubeStatusLine {
  kind: "none" | "done" | "pending" | "unreadable";
  videoId?: string;
  url?: string;
  state?: string;
  status?: string;
  at?: string;
  error?: string;
  since_match?: boolean;
}

export interface ShortsStatusLine {
  destination: string;
  status: string;
  url?: string;
  at: string;
  since_match?: boolean;
}

export interface VideoRegistryStatus {
  aammdd: string;
  /** #11970: só no modo `--corte` — o slug e a pasta lida. */
  corte?: { slug: string; dir: string };
  since: string | null;
  youtube: YouTubeStatusLine;
  shorts: { kind: "ok"; entries: ShortsStatusLine[] } | { kind: "unreadable"; error: string };
  /** Destinos do vertical com envio começado e sem registro depois dele: podem ter saído (ou estar saindo). */
  sending: { kind: "ok"; marks: SendingStatusLine[] } | { kind: "unreadable"; error: string };
  /**
   * Só com `since`: destinos com registro em `at >= since` (`youtube` para o
   * horizontal) mais TODO destino com envio em aberto, de qualquer horário
   * (marca anterior ao corte é de um processo que morreu no meio: também pode ter saído).
   */
  registered_since: string[] | null;
  verdict: "unreadable" | "registered-since" | "nothing-since" | "no-cutoff";
  message: string;
}

function sinceMatch(at: string | undefined, sinceMs: number | null): boolean | undefined {
  if (sinceMs === null) return undefined;
  const t = at ? Date.parse(at) : NaN;
  // Registro sem data legível conta como "pode ter saído depois": nunca esconde.
  return Number.isNaN(t) ? true : t >= sinceMs;
}

/** Pure: resumo dos dois registros, com o corte `since` quando houver. */
export function summarizeVideoRegistries(input: VideoRegistryStatusInput): VideoRegistryStatus {
  const sinceMs = input.since === null ? null : Date.parse(input.since);
  if (sinceMs !== null && Number.isNaN(sinceMs)) throw new Error(`--since inválido: ${input.since}`);

  let youtube: YouTubeStatusLine;
  if (!input.youtube.ok) youtube = { kind: "unreadable", error: input.youtube.error };
  else if (input.youtube.value.kind === "none") youtube = { kind: "none" };
  else if (input.youtube.value.kind === "done") {
    const r = input.youtube.value.record;
    youtube = { kind: "done", videoId: r.videoId, url: r.url, state: r.state, at: r.uploadedAt, since_match: sinceMatch(r.uploadedAt, sinceMs) };
  } else {
    const s = input.youtube.value.sentinel;
    youtube = { kind: "pending", status: s.status, at: s.at, since_match: sinceMatch(s.at, sinceMs) };
  }
  if (youtube.since_match === undefined) delete youtube.since_match;

  const shorts: VideoRegistryStatus["shorts"] = input.shorts.ok
    ? {
        kind: "ok",
        entries: input.shorts.value.entries.map((e) => {
          const line: ShortsStatusLine = { destination: e.destination, status: e.status, ...(e.url ? { url: e.url } : {}), at: e.at };
          const m = sinceMatch(e.at, sinceMs);
          return m === undefined ? line : { ...line, since_match: m };
        }),
      }
    : { kind: "unreadable", error: input.shorts.error };

  let sending: VideoRegistryStatus["sending"];
  if (!input.sending.ok) sending = { kind: "unreadable", error: input.sending.error };
  else if (!input.shorts.ok) sending = { kind: "ok", marks: [] }; // registro ilegível já vira `unreadable`
  else {
    sending = {
      kind: "ok",
      marks: openSendingMarks(input.sending.value, input.shorts.value.entries).map((m) => {
        const line: SendingStatusLine = { destination: m.destination, started_at: m.started_at, ...(m.pid !== undefined ? { pid: m.pid } : {}) };
        const sm = sinceMatch(m.started_at, sinceMs);
        return sm === undefined ? line : { ...line, since_match: sm };
      }),
    };
  }

  const unreadable = youtube.kind === "unreadable" || shorts.kind === "unreadable" || sending.kind === "unreadable";
  let registered: string[] | null = null;
  if (sinceMs !== null) {
    const done = [
      ...(youtube.since_match ? ["youtube"] : []),
      ...(shorts.kind === "ok" ? shorts.entries.filter((e) => e.since_match).map((e) => e.destination) : []),
    ];
    const inFlight = sending.kind === "ok" ? sending.marks.map((m) => m.destination).filter((d) => !done.includes(d)) : [];
    registered = [...done, ...inFlight];
  }
  const inFlightNote =
    sending.kind === "ok" && sending.marks.length > 0
      ? ` Envio começado e sem registro (pode estar saindo agora ou ter saído sem registro): ${sending.marks.map((m) => m.destination).join(", ")} — conferir a conta antes de qualquer coisa.`
      : "";

  let verdict: VideoRegistryStatus["verdict"];
  let message: string;
  if (unreadable) {
    verdict = "unreadable";
    message =
      "registro ilegível: não dá para saber o que saiu — conferir o canal/as contas antes de qualquer nova chamada de publisher (#11741)";
  } else if (registered === null) {
    verdict = "no-cutoff";
    message = "sem --since: estado atual dos registros, sem corte de tempo." + inFlightNote;
  } else if (registered.length > 0) {
    verdict = "registered-since";
    message =
      `registrado desde ${input.since}: ${registered.join(", ")} — o processo da chamada interrompida pode ter seguido vivo e publicado. ` +
      "Relatar ao editor como saído (estado normalizado, #573) e nunca publicar esses destinos de novo (#11741)." +
      inFlightNote;
  } else {
    verdict = "nothing-since";
    message = `nada registrado nem em envio desde ${input.since}. A interrupção conta como "não": nova chamada só com novo "pode publicar" do editor (#11741)`;
  }
  return { aammdd: input.aammdd, since: input.since, youtube, shorts, sending, registered_since: registered, verdict, message };
}

function readSafely<T>(read: () => T): RegistryRead<T> {
  try {
    return { ok: true, value: read() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const USAGE =
  "uso: video-publish-registry-status.ts AAMMDD [--since ISO] [--edition-dir DIR]\n" +
  "     video-publish-registry-status.ts --corte SLUG [AAMMDD] [--since ISO] [--edition-dir DIR]";

/**
 * #11970: pasta e data do corte. A data sai do `corte.json` (é a que o
 * registro do corte carrega); um AAMMDD posicional diferente é erro de uso.
 * Sem `corte.json` legível, com ou sem AAMMDD, não dá para ler o registro:
 * exit 1 (mesmo sentido de `unreadable`, conferir as contas).
 */
function resolveCorte(
  slug: string,
  positionalDate: string | undefined,
  editionDirOverride: string | undefined,
  root: string,
): { ok: true; dir: string; aammdd: string } | { ok: false; code: 1 | 2; error: string } {
  const slugErr = validateCorteSlug(slug);
  if (slugErr) return { ok: false, code: 2, error: slugErr };
  if (positionalDate !== undefined && !/^\d{6}$/.test(positionalDate)) return { ok: false, code: 2, error: `AAMMDD inválido: ${positionalDate}` };
  // Mesmo critério do publish-shorts: a pasta canônica é da raiz do repo; o --edition-dir, do cwd.
  const dir = editionDirOverride !== undefined ? resolve(editionDirOverride) : join(root, corteRelDir(slug));
  const specPath = join(dir, CORTE_SPEC_FILE);
  if (!existsSync(specPath)) {
    // Sempre exit 1, com ou sem AAMMDD: aceitar a data faria um slug errado
    // (`--corte fluxo-26114 261104`) ler uma pasta vazia e responder
    // `nothing-since`. O prepareCorteRun grava o corte.json antes de qualquer
    // envio, então corte que publicou algo sempre tem o arquivo (#11975).
    return {
      ok: false,
      code: 1,
      error: `${specPath} ausente: slug errado ou corte que nunca rodou — confira o slug; até lá, conferir as contas antes de qualquer nova chamada (#11970)`,
    };
  }
  let date: string;
  try {
    date = parseCorteSpec(readFileSync(specPath, "utf8"), specPath).date;
  } catch (e) {
    return { ok: false, code: 1, error: `${(e as Error).message} — não dá para saber a data do corte: conferir as contas antes de qualquer nova chamada (#11970)` };
  }
  if (positionalDate !== undefined && positionalDate !== date) {
    return { ok: false, code: 2, error: `o corte "${slug}" é de ${date} (corte.json), não de ${positionalDate}` };
  }
  return { ok: true, dir, aammdd: date };
}

export function main(argv: string[] = process.argv.slice(2), root: string = ROOT): number {
  const { flags, values, positional } = parseArgs(argv);
  const corteSlug = values["corte"];
  if (flags.has("corte")) {
    console.error("video-publish-registry-status: --corte exige o SLUG do corte");
    console.error(USAGE);
    return 2;
  }
  const since = values["since"] ?? null;
  if (since !== null && Number.isNaN(Date.parse(since))) {
    console.error(`video-publish-registry-status: --since inválido: ${since}`);
    console.error(USAGE);
    return 2;
  }
  let aammdd: string;
  let dir: string;
  let corte: VideoRegistryStatus["corte"];
  if (corteSlug !== undefined) {
    if (values["edition"] !== undefined) {
      console.error("video-publish-registry-status: --corte usa a data do corte.json (ou AAMMDD posicional), não --edition");
      console.error(USAGE);
      return 2;
    }
    const r = resolveCorte(corteSlug, positional[0], values["edition-dir"], root);
    if (!r.ok) {
      console.error(`video-publish-registry-status: ${r.error}`);
      if (r.code === 2) console.error(USAGE);
      return r.code;
    }
    aammdd = r.aammdd;
    dir = r.dir;
    corte = { slug: corteSlug, dir };
  } else {
    const a = values["edition"] ?? positional[0];
    if (!a || !/^\d{6}$/.test(a)) {
      console.error(USAGE);
      return 2;
    }
    aammdd = a;
    dir = resolve(values["edition-dir"] ?? editionDirFor(aammdd));
  }
  const summary = summarizeVideoRegistries({
    aammdd,
    since,
    youtube: readSafely(() => readPublishedRecord(join(dir, YOUTUBE_PUBLISHED_FILE), aammdd)),
    shorts: readSafely(() => readShortsRegistry(dir, aammdd)),
    sending: readSafely(() => readShortsSending(dir, aammdd)),
  });
  const status: VideoRegistryStatus = corte ? { ...summary, corte } : summary;
  console.log(JSON.stringify(status, null, 2));
  console.error(`[${status.verdict}] ${status.message}`);
  return status.verdict === "unreadable" ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}

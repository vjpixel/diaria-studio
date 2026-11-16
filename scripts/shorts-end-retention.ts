/**
 * shorts-end-retention.ts — mede a queda de retenção nos últimos segundos dos
 * Shorts, separada pelo jeito como cada vertical termina (#13190).
 *
 * Só lê dados que já estão no disco; não chama API nenhuma:
 *   - `data/youtube-analytics/videos.jsonl` e `retention.jsonl` (snapshot do
 *     `youtube-analytics-snapshot.ts`, #12075);
 *   - `06-shorts-published.json` da edição (o vertical 1) e de cada corte em
 *     `data/cortes/{slug}/` (vertical 2/extra ou corte avulso), para ligar o
 *     videoId à peça;
 *   - `_internal/video-montagem/seq-*.transcript.json` da edição, para ler a
 *     fala do fim e a duração da sequência montada.
 *
 * Uso:
 *   npx tsx scripts/shorts-end-retention.ts [--data-root DIR] [--date YYYY-MM-DD]
 *        [--cauda-s 3] [--min-views 100] [--json] [--out arquivo.md]
 *
 * `--date` escolhe o snapshot (default: o mais recente de `videos.jsonl`).
 * Saída: relatório markdown no stdout (ou em `--out`); `--json` imprime a
 * análise crua. Exit 0 = relatório gerado; 1 = snapshot ausente/vazio;
 * 2 = argumento inválido.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findUnknownFlags, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import { YOUTUBE_ANALYTICS_FILES, parseJsonl, type RetentionLine, type VideoSnapshotLine } from "./lib/diaria/youtube-analytics.ts";
import { resolveShortId } from "./lib/diaria/youtube-short-related.ts";
import { analisarFins, renderRelatorio, type SequenceTranscript, type ShortInput } from "./lib/diaria/shorts-end-retention.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KNOWN_FLAGS = ["data-root", "date", "cauda-s", "min-views", "json", "out", "help"] as const;

/** De onde veio o Short: a sequência da montagem que o gerou. */
export interface FonteShort {
  peca: "vertical1" | "corte";
  edition: string;
  /** Caminho do `seq-*.transcript.json` esperado (pode não existir). */
  transcriptPath: string;
}

function editionDirOf(editionsRoot: string, aammdd: string): string {
  return join(editionsRoot, aammdd.slice(0, 4), aammdd);
}

function seqTranscript(editionsRoot: string, aammdd: string, seq: string): string {
  return join(editionDirOf(editionsRoot, aammdd), "_internal", "video-montagem", `seq-${seq}.transcript.json`);
}

/**
 * videoId → peça + transcrição esperada. O vertical da edição é a sequência
 * `outras-redes` (antes de 261103 a montagem também gravava `instagram`, com
 * a mesma fala). O corte `{nome}-{AAMMDD}` é a sequência `seq-{nome}` da
 * edição AAMMDD; corte avulso não tem montagem e fica sem transcrição.
 */
export function indexarFontes(dataRoot: string, warn: (m: string) => void): Map<string, FonteShort> {
  const out = new Map<string, FonteShort>();
  const editionsRoot = join(dataRoot, "editions");
  if (existsSync(editionsRoot)) {
    for (const aamm of readdirSync(editionsRoot).filter((n) => /^\d{4}$/.test(n)).sort()) {
      for (const aammdd of readdirSync(join(editionsRoot, aamm)).filter((n) => /^\d{6}$/.test(n)).sort()) {
        try {
          const id = resolveShortId(readShortsRegistry(join(editionsRoot, aamm, aammdd), aammdd));
          if (!id) continue;
          const principal = seqTranscript(editionsRoot, aammdd, "outras-redes");
          const legado = seqTranscript(editionsRoot, aammdd, "instagram");
          out.set(id.id, { peca: "vertical1", edition: aammdd, transcriptPath: existsSync(principal) || !existsSync(legado) ? principal : legado });
        } catch (e) {
          warn(`[aviso] ${aammdd}: ${(e as Error).message}`);
        }
      }
    }
  }
  const cortesRoot = join(dataRoot, "cortes");
  if (existsSync(cortesRoot)) {
    for (const slug of readdirSync(cortesRoot).sort()) {
      const dir = join(cortesRoot, slug);
      if (!statSync(dir).isDirectory() || !existsSync(join(dir, "corte.json"))) continue;
      try {
        const spec = JSON.parse(readFileSync(join(dir, "corte.json"), "utf8")) as { date?: string };
        const id = resolveShortId(readShortsRegistry(dir, spec.date ?? ""));
        if (!id) continue;
        const m = /^(.+)-(\d{6})$/.exec(slug);
        if (!m) {
          warn(`[aviso] corte ${slug}: slug sem AAMMDD da edição de origem, fica sem transcrição`);
          continue;
        }
        out.set(id.id, { peca: "corte", edition: m[2], transcriptPath: seqTranscript(editionsRoot, m[2], m[1]) });
      } catch (e) {
        warn(`[aviso] corte ${slug}: ${(e as Error).message}`);
      }
    }
  }
  return out;
}

function lerTranscript(path: string, warn: (m: string) => void): SequenceTranscript | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as SequenceTranscript;
    if (typeof j.duration !== "number" || !Array.isArray(j.segments)) {
      warn(`[aviso] ${path}: sem duration/segments, ignorada`);
      return null;
    }
    return j;
  } catch (e) {
    warn(`[aviso] ${path} ilegível (${(e as Error).message}), ignorada`);
    return null;
  }
}

export interface MontarResultado {
  snapshotDate: string;
  janela: string;
  inputs: ShortInput[];
}

/** Junta snapshot, curva de retenção, peça e transcrição de cada Short. */
export function montarInputs(dataRoot: string, date: string | null, warn: (m: string) => void): MontarResultado | null {
  const dir = join(dataRoot, "youtube-analytics");
  const vPath = join(dir, YOUTUBE_ANALYTICS_FILES.videos);
  const rPath = join(dir, YOUTUBE_ANALYTICS_FILES.retention);
  if (!existsSync(vPath) || !existsSync(rPath)) return null;
  const videos = parseJsonl<VideoSnapshotLine>(readFileSync(vPath, "utf8"), vPath).filter((v) => v.kind === "short");
  if (!videos.length) return null;
  const snapshotDate = date ?? videos.map((v) => v.date).sort().at(-1)!;
  const doDia = videos.filter((v) => v.date === snapshotDate);
  if (!doDia.length) return null;
  const retencao = parseJsonl<RetentionLine>(readFileSync(rPath, "utf8"), rPath).filter((r) => r.date <= snapshotDate);
  const curva = new Map<string, RetentionLine>();
  for (const r of retencao) {
    const prev = curva.get(r.videoId);
    if (!prev || r.date > prev.date || (r.date === prev.date && r.capturedAt >= prev.capturedAt)) curva.set(r.videoId, r);
  }
  const fontes = indexarFontes(dataRoot, warn);
  const inputs: ShortInput[] = [];
  for (const v of doDia) {
    const c = curva.get(v.videoId);
    if (!c?.points.length) {
      warn(`[aviso] ${v.videoId} (${v.title ?? "sem título"}): sem curva de retenção até ${snapshotDate}, fora da análise`);
      continue;
    }
    if (c.date !== snapshotDate) warn(`[aviso] ${v.videoId}: curva de ${c.date}, não do snapshot ${snapshotDate}`);
    const f = fontes.get(v.videoId);
    inputs.push({
      videoId: v.videoId,
      title: v.title,
      edition: f?.edition ?? v.edition,
      peca: f?.peca ?? "desconhecida",
      views: v.views,
      averageViewPercentage: v.averageViewPercentage,
      averageViewDuration: v.averageViewDuration,
      points: c.points,
      transcript: f ? lerTranscript(f.transcriptPath, warn) : null,
    });
  }
  return { snapshotDate, janela: `${doDia[0].startDate} a ${doDia[0].endDate}`, inputs };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const unknown = findUnknownFlags(argv, KNOWN_FLAGS);
  const args = parseArgs(argv);
  const uso = "uso: shorts-end-retention.ts [--data-root DIR] [--date YYYY-MM-DD] [--cauda-s 3] [--min-views 100] [--json] [--out arquivo.md]";
  if (unknown.length || args.flags.has("help")) {
    if (unknown.length) console.error(`flag(s) desconhecida(s): ${unknown.join(", ")}`);
    console.error(uso);
    return 2;
  }
  const date = args.values.date ?? null;
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`--date inválido: ${JSON.stringify(date)} (esperado YYYY-MM-DD)`);
    return 2;
  }
  const caudaS = Number(args.values["cauda-s"] ?? 3);
  const minViews = Number(args.values["min-views"] ?? 100);
  if (!(caudaS > 0) || !(minViews >= 0)) {
    console.error(`--cauda-s precisa ser > 0 e --min-views >= 0\n${uso}`);
    return 2;
  }
  const dataRoot = resolve(args.values["data-root"] ?? join(ROOT, "data"));
  const warn = (m: string) => console.error(m);
  const montado = montarInputs(dataRoot, date, warn);
  if (!montado) {
    console.error(`snapshot de Shorts ausente ou vazio em ${join(dataRoot, "youtube-analytics")}${date ? ` para ${date}` : ""} (rodar youtube-analytics-snapshot.ts)`);
    return 1;
  }
  const analise = analisarFins(montado.inputs, { caudaS, minViews });
  const saida = args.flags.has("json")
    ? JSON.stringify({ snapshotDate: montado.snapshotDate, janela: montado.janela, ...analise }, null, 2)
    : renderRelatorio(analise, { snapshotDate: montado.snapshotDate, janela: montado.janela });
  if (args.values.out) writeFileSync(resolve(args.values.out), saida + "\n");
  else console.log(saida);
  return 0;
}

if (isMainModule(import.meta.url)) {
  void runCli(main, { onError: (e) => console.error(`erro: ${(e as Error).message}`) });
}

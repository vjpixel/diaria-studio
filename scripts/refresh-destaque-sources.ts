#!/usr/bin/env tsx
/**
 * refresh-destaque-sources.ts (#9102)
 *
 * Re-sincroniza `_internal/fact-check-sources/` (manifest.json + d{N}.txt)
 * com os destaques ATUAIS de `_internal/01-approved.json`, depois de uma
 * troca/promoção de destaque no gate 4 (§4d.1b do orchestrator-stage-4,
 * `promote-to-destaque.ts`).
 *
 * Problema que resolve (edição 260930): ao promover itens do pool a destaque
 * SUBSTITUINDO um existente, nada re-baixava a fonte do artigo novo. Dois
 * efeitos:
 *   1. o `writer-destaque` (só Read/Write, sem WebFetch por design — #4000)
 *      escrevia o destaque novo só com título + summary;
 *   2. o `fact-checker`, redespachado direto (sem passar de novo por
 *      `run-fact-checker.ts`, que é quem invalida o cache — #8782), lia um
 *      `manifest.json`/`d{N}.txt` com o texto do destaque ANTIGO.
 *
 * Mecanismo: reusa `prefetchHighlightSources` (#8595/#8782) — mesma função
 * que o `run-fact-checker.ts` usa. Ela compara as URLs do manifest com as de
 * `highlights[]` por posição; se QUALQUER uma divergir, apaga manifest +
 * d{N}.txt e re-baixa tudo (nunca mistura texto velho com novo). Se tudo
 * bate, reusa o cache sem tocar a rede.
 *
 * Saída (stdout, JSON): `{ stale_before, refetched, failed, sources: [{destaque,
 * url, path?, error?}] }`. Passar o `path` da entrada com `destaque === N`
 * (nunca indexar por posição: slot sem URL é pulado) como `source_text_path`
 * ao `writer-destaque` do slot promovido. Rodar UMA vez depois de todas as
 * trocas da rodada.
 *
 * Uso:
 *   npx tsx scripts/refresh-destaque-sources.ts --edition-dir data/editions/2609/260930/
 *   npx tsx scripts/refresh-destaque-sources.ts --edition-dir ... --check   # só diz se está defasado
 *   npx tsx scripts/refresh-destaque-sources.ts --edition-dir ... --approved .../_internal/01-approved-capped.json --record-writer-inputs  # Stage 2 (#9252, #9648)
 *
 * `--record-writer-inputs` (#9648, SÓ no Stage 2): grava também
 * `_internal/02-writer-inputs.json` + cópia de cada texto em
 * `_internal/02-writer-inputs/d{N}.txt` — o registro do que cada
 * writer-destaque recebeu, que as trocas do Stage 4 (que rodam este script
 * SEM a flag) não sobrescrevem. Ver `scripts/lib/writer-inputs-record.ts`.
 *
 * Exit codes:
 *   0 — cache em dia (após refresh, ou já estava em dia no --check)
 *   1 — erro de args / 01-approved.json ausente ou ilegível
 *   3 — --check: manifest defasado (URL divergente/ausente) → rodar sem --check.
 *       Download falho para a URL atual NÃO é defasagem: sai 0 com `failed`
 *       preenchido (estado final aceito; writer/fact-checker usam o fallback).
 *
 * Falha de download de um destaque NÃO muda o exit code (fail-soft, mesmo
 * contrato do run-fact-checker): vira `error` na entrada e `status` != ok no
 * manifest — o fact-checker/writer seguem o fallback documentado.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { logEvent } from "./lib/run-log.ts";
import {
  highlightSourceUrls,
  isHighlightSourcesCacheFresh,
  prefetchHighlightSources,
  readExistingManifest,
  type PrefetchedSource,
} from "./run-fact-checker.ts";
import {
  buildWriterInputsRecord,
  findWriterInputGaps,
  writeWriterInputsRecord,
  type WriterInputGap,
} from "./lib/writer-inputs-record.ts";

export interface RefreshResult {
  /** true se as URLs do manifest em disco NÃO correspondiam às dos destaques atuais (ou manifest/txt ausente). */
  stale_before: boolean;
  /** true se houve re-download (cache não reusável; só fora do --check). */
  refetched: boolean;
  /** Destaques (1-based) cuja fonte está com download falho (blocked/error) — estado final aceito, não defasagem. */
  failed: number[];
  sources: PrefetchedSource[];
  /** (#9648) Só com `recordWriterInputs`: path do registro gravado + destaques sem texto/truncados. */
  writer_inputs?: { path: string; gaps: WriterInputGap[] };
  /** (#9648) Falha ao gravar o registro (fail-soft). */
  writer_inputs_error?: string;
}

/**
 * (#9102) true quando o manifest NÃO descreve os destaques atuais: ausente,
 * URL divergente em alguma posição, ou `d{N}.txt` de entrada `ok` sumido.
 * Entrada com download falho (`blocked`/`error`) para a MESMA URL não conta
 * como defasagem — senão o `--check` acusaria defasado pra sempre numa fonte
 * permanentemente bloqueada (451) e o playbook entraria em loop.
 */
export function isSourcesManifestStale(approved: unknown, internalDir: string): boolean {
  const dir = join(internalDir, "fact-check-sources");
  const manifest = readExistingManifest(dir);
  if (!manifest) return true;
  const urls = highlightSourceUrls(approved);
  const expected = urls.flatMap((url, i) => (url ? [{ destaque: i + 1, url }] : []));
  if (manifest.length !== expected.length) return true;
  return expected.some(({ destaque, url }) => {
    const e = manifest.find((m) => m.destaque === destaque);
    if (!e || e.url !== url) return true;
    return e.status === "ok" && !existsSync(join(dir, `d${destaque}.txt`));
  });
}

function failedDestaques(internalDir: string): number[] {
  const manifest = readExistingManifest(join(internalDir, "fact-check-sources")) ?? [];
  return manifest.filter((e) => e.status !== "ok").map((e) => e.destaque);
}

/** Prefixo do evento `warn` no run-log quando o registro #9648 não é gravado. */
export const WRITER_INPUTS_LOG_PREFIX = "writer_inputs_record_failed:";

function editionIdFromDir(editionDir: string): string | null {
  const name = editionDir.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
  return name && /^\d{6}$/.test(name) ? name : null;
}

export async function refreshDestaqueSources(
  editionDir: string,
  opts: {
    check?: boolean;
    fetchImpl?: typeof fetch;
    approvedPath?: string;
    recordWriterInputs?: boolean;
    now?: Date;
    /** Raiz onde fica `data/run-log.jsonl` (default: cwd). Injetável pra teste. */
    runLogRootDir?: string;
  } = {},
): Promise<RefreshResult> {
  const internalDir = join(editionDir, "_internal");
  // #9252: Stage 2 passa o 01-approved-capped.json (o mesmo que writer e lint
  // usam) — approved e capped podem divergir nos highlights (edição 260925).
  const approvedPath = opts.approvedPath ?? join(internalDir, "01-approved.json");
  if (!existsSync(approvedPath)) throw new Error(`approved não encontrado em ${approvedPath}`);
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as unknown;
  const stale = isSourcesManifestStale(approved, internalDir);
  if (opts.check) return { stale_before: stale, refetched: false, failed: failedDestaques(internalDir), sources: [] };
  const refetched = !isHighlightSourcesCacheFresh(approved, internalDir);
  const sources = await prefetchHighlightSources(approved, internalDir, opts.fetchImpl ?? fetch);
  const result: RefreshResult = { stale_before: stale, refetched, failed: failedDestaques(internalDir), sources };
  if (opts.recordWriterInputs) {
    // Fail-soft: o registro é auditoria — falha ao gravá-lo nunca derruba o
    // download das fontes nem o dispatch dos writers. Vira `error` no stdout.
    try {
      const record = buildWriterInputsRecord(editionDir, sources, { approvedPath, now: opts.now });
      result.writer_inputs = { path: writeWriterInputsRecord(editionDir, record), gaps: findWriterInputGaps(record) };
    } catch (e) {
      const msg = (e as Error).message;
      result.writer_inputs_error = msg;
      console.error(`refresh-destaque-sources: WARN — 02-writer-inputs.json não gravado: ${msg}`);
      // Rastro durável (#9648 review): o stdout do Stage 2 some com a sessão.
      // O Stage 6 não depende deste evento pra emitir o signal — registro
      // ausente em edição pós-cutover já vira `writer_source_text_gap` em
      // `collect-edition-signals.ts` —, mas o evento diz o PORQUÊ.
      logEvent(
        {
          edition: editionIdFromDir(editionDir),
          stage: 2,
          agent: "refresh-destaque-sources",
          level: "warn",
          message: `${WRITER_INPUTS_LOG_PREFIX} ${msg}`,
          details: { edition_dir: editionDir, error: msg },
        },
        opts.runLogRootDir,
      );
    }
  }
  return result;
}

async function main(): Promise<number | void> {
  const { values: args, flags } = parseArgs(process.argv.slice(2));
  if (!args["edition-dir"]) {
    console.error("Uso: refresh-destaque-sources.ts --edition-dir data/editions/AAMM/AAMMDD/ [--approved <path>] [--check | --record-writer-inputs]");
    return 1;
  }
  const check = flags.has("check");
  let result: RefreshResult;
  try {
    result = await refreshDestaqueSources(resolve(process.cwd(), args["edition-dir"]), {
      check,
      recordWriterInputs: flags.has("record-writer-inputs"),
      approvedPath: args.approved ? resolve(process.cwd(), args.approved) : undefined,
    });
  } catch (e) {
    console.error(`refresh-destaque-sources: ${(e as Error).message}`);
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  if (check && result.stale_before) return 3;
}

if (isMainModule(import.meta.url)) {
  // #9911: grava process.exitCode em vez de process.exit — no Windows (Node 24) o exit logo após um fetch sai 127.
  runCli(main, { onError: (e) => console.error(`refresh-destaque-sources: ${(e as Error).message}`) });
}

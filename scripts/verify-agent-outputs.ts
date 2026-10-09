/**
 * verify-agent-outputs.ts (#9962)
 *
 * Check determinístico, FAIL-LOUD, de que um subagente de escrita
 * (`writer-destaque`, `social-writer`, `social-curto`, ...) de fato gravou os
 * arquivos que devia — rodado pelo coordenador LOGO DEPOIS do dispatch, antes
 * de ler/integrar o output.
 *
 * Bug que motivou (#9962, edição 261009): o `writer-destaque` reportou "gravei
 * e conferi com Read", mas `_internal/02-d1-draft.md` / `_internal/02-d3-prompt.md`
 * não existiam em disco. Num caso o hook #9132 tinha recusado o nome do arquivo
 * e o agente respondeu sem avisar. Pior que o arquivo ausente é o arquivo
 * ANTIGO: no Stage 4 (§4d.1b, troca de destaque) o `02-d{N}-draft.md` do
 * destaque que SAIU pode continuar lá — só existir não prova nada. Por isso o
 * check compara o mtime com o instante do dispatch (`--since`).
 *
 * Uso:
 *   # 1) antes do dispatch, guardar o instante:
 *   npx tsx scripts/verify-agent-outputs.ts --now
 *   #    → imprime ISO, ex. 2026-10-09T03:12:45.123Z
 *   # 2) depois do dispatch:
 *   npx tsx scripts/verify-agent-outputs.ts --agent writer-destaque \
 *     --since 2026-10-09T03:12:45.123Z \
 *     --paths data/editions/261009/_internal/02-d1-draft.md,data/editions/261009/_internal/02-d1-prompt.md
 *
 * Sem `--since`: só checa existência + não-vazio (útil quando o arquivo não
 * existia antes do dispatch).
 *
 * Stdout: JSON `{ ok, agent, since, results: [{ path, status, mtime }] }`.
 * Exit codes:
 *   0 — todos os paths existem, não-vazios e (com --since) gravados depois do dispatch
 *   1 — algum path ausente / vazio / defasado (stderr diz qual e o que fazer)
 *   2 — uso inválido
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsWithTrueDefault, isMainModule } from "./lib/cli-args.ts";

/**
 * Folga de mtime pra filesystems de granularidade grossa (FAT/exFAT = 2s) e
 * pro relógio do `--now` vs. o do FS. Um arquivo gravado até 2s ANTES do
 * dispatch passaria como fresco — irrelevante na prática (o dispatch de um
 * subagente leva dezenas de segundos), e evita falso vermelho.
 */
export const MTIME_SLACK_MS = 2000;

export type OutputStatus = "ok" | "missing" | "empty" | "stale";

export interface OutputResult {
  path: string;
  status: OutputStatus;
  /** ISO do mtime, ou null quando o arquivo não existe. */
  mtime: string | null;
}

export interface StatLike {
  size: number;
  mtimeMs: number;
}

export type StatFn = (path: string) => StatLike | null;

const defaultStat: StatFn = (p) => {
  try {
    const s = statSync(p);
    if (!s.isFile()) return null;
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
};

/** Converte `--since` (ISO ou epoch em ms) em epoch ms; null se inválido. */
export function parseSince(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "true") return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : ms;
}

export function checkAgentOutputs(
  paths: string[],
  sinceMs: number | null,
  stat: StatFn = defaultStat,
): OutputResult[] {
  return paths.map((path) => {
    const s = stat(path);
    if (!s) return { path, status: "missing", mtime: null };
    const mtime = new Date(s.mtimeMs).toISOString();
    if (s.size === 0) return { path, status: "empty", mtime };
    if (sinceMs !== null && s.mtimeMs + MTIME_SLACK_MS < sinceMs) {
      return { path, status: "stale", mtime };
    }
    return { path, status: "ok", mtime };
  });
}

const REASON: Record<Exclude<OutputStatus, "ok">, string> = {
  missing: "AUSENTE — o agente disse que gravou, mas o arquivo não existe",
  empty: "VAZIO (0 bytes)",
  stale: "DEFASADO — mtime anterior ao dispatch (é o arquivo antigo; o Write não aconteceu)",
};

function main(): void {
  const args = parseArgsWithTrueDefault(process.argv.slice(2));

  if (args.now === "true") {
    console.log(new Date().toISOString());
    return;
  }

  const agent = args.agent && args.agent !== "true" ? args.agent : "subagente";
  const pathsArg = args.paths;
  if (!pathsArg || pathsArg === "true") {
    console.error("Erro: --paths obrigatório (lista separada por vírgula). Ou --now para imprimir o instante.");
    process.exit(2);
  }
  const paths = pathsArg
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(p));
  if (paths.length === 0) {
    console.error("Erro: --paths vazio.");
    process.exit(2);
  }

  let sinceMs: number | null = null;
  if (args.since !== undefined) {
    sinceMs = parseSince(args.since);
    if (sinceMs === null) {
      console.error(`Erro: --since inválido: "${args.since}" (use ISO 8601 ou epoch ms; gere com --now).`);
      process.exit(2);
    }
  }

  const results = checkAgentOutputs(paths, sinceMs);
  const failures = results.filter((r) => r.status !== "ok");
  const ok = failures.length === 0;

  console.log(
    JSON.stringify({
      ok,
      agent,
      since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
      results,
    }),
  );

  if (ok) return;

  console.error(`\nverify-agent-outputs: FALHOU — ${agent} não gravou ${failures.length}/${results.length} arquivo(s):`);
  for (const f of failures) {
    console.error(`  - ${f.path}: ${REASON[f.status as Exclude<OutputStatus, "ok">]}`);
  }
  console.error(
    `\nNão integrar o retorno do ${agent} — re-disparar o agente (conferir se o path bate com o que o hook de Write aceita) ` +
      `ou pedir o conteúdo colado na resposta e gravá-lo você mesmo. Nunca seguir com o arquivo antigo (#9962).`,
  );
  process.exit(1);
}

if (isMainModule(import.meta.url)) {
  main();
}

#!/usr/bin/env node
/**
 * scripts/artigo-especial-producao.ts (#9099)
 *
 * State das etapas de PRODUÇÃO de `/diaria-artigo-especial` — mesmo
 * `published.json` dos canais de divulgação (`lib/artigo-especial-state.ts`,
 * bloco `producao`), mesmo princípio do `mark-artigo-especial-channel.ts`:
 * o agente grava progresso rodando 1 comando auditável, nunca escrevendo o
 * JSON à mão.
 *
 * Subcomandos:
 *   status  --ano AAAA --slug slug [--json]
 *           próxima etapa (de onde o resume retoma) + o que já foi feito.
 *   mark    --ano AAAA --slug slug --etapa {tema|briefing|rascunho|html|pr|publicado}
 *           --status {done|failed} [--url ...] [--reason ...] [--tema "..."]
 *           grava uma etapa. `done` exige as anteriores `done`; refazer uma
 *           etapa `done` invalida as posteriores (ver `withProducaoEtapa`).
 *   tema    --stats-json path [--ballot path]
 *           resolve o tema vencedor a partir do JSON de
 *           `voto-tema-stats.ts --ciclo AAMM --json` (+ cédula local pra
 *           descrição) e sugere um slug. Só lê — não grava nada.
 *
 * [--data-dir path] em status/mark (default: data/).
 * Exit: 0 ok · 1 erro inesperado · 2 uso/guard (mensagem diz o quê).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getStringArg, hasFlag, isMainModule, parseArgs } from "./lib/cli-args.ts";
import {
  PRODUCAO_ETAPAS,
  type ProducaoEtapa,
  artigoEspecialStatePath,
  buildDoneChannelState,
  buildFailedChannelState,
  nextProducaoEtapa,
  readArtigoEspecialState,
  readArtigoEspecialStateStrict,
  withProducaoEtapa,
  writeArtigoEspecialState,
  type ArtigoEspecialState,
} from "./lib/artigo-especial-state.ts";
import { resolveTemaVencedor, suggestSlug, TemaVencedorError, type BallotLike, type TemaStatsLike } from "./lib/artigo-especial-tema.ts";

export function isProducaoEtapa(v: string): v is ProducaoEtapa {
  return (PRODUCAO_ETAPAS as readonly string[]).includes(v);
}

export interface MarkEtapaOptions {
  dataDir: string;
  ano: string;
  slug: string;
  etapa: ProducaoEtapa;
  status: "done" | "failed";
  url?: string;
  reason?: string;
  tema?: string;
  now?: Date;
}

export function runMarkProducaoEtapa(o: MarkEtapaOptions): { statePath: string; state: ArtigoEspecialState } {
  if (o.status === "failed" && !o.reason) throw new Error("--status failed exige --reason.");
  if (o.etapa === "tema" && o.status === "done" && !o.tema) {
    throw new Error('--etapa tema --status done exige --tema "..." (o tema confirmado fica gravado para as etapas seguintes).');
  }
  if (o.etapa === "pr" && o.status === "done" && !o.url) {
    throw new Error("--etapa pr --status done exige --url com o link do PR.");
  }
  const statePath = artigoEspecialStatePath(o.dataDir, o.ano, o.slug);
  const state = readArtigoEspecialStateStrict(statePath, o.ano, o.slug);
  const at = (o.now ?? new Date()).toISOString();
  const etapaState = o.status === "done" ? buildDoneChannelState(at, o.url ?? null) : buildFailedChannelState(at, o.reason!);
  const next = withProducaoEtapa(state, o.etapa, etapaState, o.tema);
  writeArtigoEspecialState(statePath, next);
  return { statePath, state: next };
}

export function describeProducao(state: ArtigoEspecialState): string {
  const lines = [`${state.ano}/${state.slug} — tema: ${state.producao?.tema ?? "(não definido)"}`];
  for (const e of PRODUCAO_ETAPAS) {
    const s = state.producao?.etapas[e];
    const detail = s ? `${s.status} ${s.attemptedAt}${s.url ? ` ${s.url}` : ""}${s.reason ? ` — ${s.reason}` : ""}` : "pendente";
    lines.push(`  ${e.padEnd(10)} ${detail}`);
  }
  const next = nextProducaoEtapa(state);
  lines.push(next ? `próxima etapa: ${next}` : "produção concluída — seguir para a divulgação (Passo 0 em diante).");
  return lines.join("\n");
}

function fail(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}

function main(): void {
  const argv = process.argv.slice(2);
  const sub = parseArgs(argv).positional[0];
  const root = resolve(import.meta.dirname, "..");
  const dataDirArg = getStringArg(argv, "data-dir", { example: "data" });
  const dataDir = dataDirArg ? resolve(root, dataDirArg) : resolve(root, "data");

  if (sub === "tema") {
    const statsPath = getStringArg(argv, "stats-json", { example: "/tmp/stats.json" });
    if (!statsPath) fail("Uso: artigo-especial-producao.ts tema --stats-json path [--ballot path]");
    const ballotPath = getStringArg(argv, "ballot", { example: "data/artigo-especial/votacao/2610/ballot.json" });
    try {
      const stats = JSON.parse(readFileSync(statsPath, "utf8")) as TemaStatsLike;
      if (ballotPath && !existsSync(ballotPath)) throw new TemaVencedorError(`--ballot ${ballotPath} não existe.`);
      const ballot = ballotPath ? (JSON.parse(readFileSync(ballotPath, "utf8")) as BallotLike) : null;
      const v = resolveTemaVencedor(stats, ballot);
      const out = { ...v, slugSugerido: suggestSlug(v.titulo) };
      console.log(hasFlag(argv, "json") ? JSON.stringify(out, null, 2) : `vencedor (opção ${v.n}): ${v.titulo}\nslug sugerido: ${out.slugSugerido}${v.descricao ? `\ndescrição: ${v.descricao}` : ""}`);
    } catch (e) {
      fail(`ERRO: ${(e as Error).message}`, e instanceof TemaVencedorError ? 2 : 1);
    }
    return;
  }

  const ano = getStringArg(argv, "ano", { example: "2026" });
  const slug = getStringArg(argv, "slug", { example: "o-jev" });
  if (!ano || !slug || (sub !== "status" && sub !== "mark")) {
    fail("Uso: artigo-especial-producao.ts {status|mark|tema} --ano AAAA --slug slug ... (ver docstring)");
  }

  if (sub === "status") {
    const state = readArtigoEspecialState(artigoEspecialStatePath(dataDir, ano, slug), ano, slug);
    console.log(hasFlag(argv, "json") ? JSON.stringify({ next: nextProducaoEtapa(state), producao: state.producao ?? null }, null, 2) : describeProducao(state));
    return;
  }

  const etapa = getStringArg(argv, "etapa", { example: "rascunho" });
  const status = getStringArg(argv, "status", { example: "done" });
  if (!etapa || !isProducaoEtapa(etapa)) fail(`--etapa inválida: "${etapa}" — esperado um de {${PRODUCAO_ETAPAS.join(", ")}}.`);
  if (status !== "done" && status !== "failed") fail(`--status inválido: "${status}" — esperado done ou failed.`);
  try {
    const { statePath, state } = runMarkProducaoEtapa({
      dataDir,
      ano,
      slug,
      etapa,
      status,
      url: getStringArg(argv, "url", { example: "https://github.com/vjpixel/diaria-studio/pull/1" }),
      reason: getStringArg(argv, "reason", { example: "motivo" }),
      tema: getStringArg(argv, "tema", { example: "Como usamos o Jev" }),
    });
    console.log(`OK — etapa "${etapa}" gravada como "${status}" em ${statePath}.`);
    console.log(describeProducao(state));
  } catch (e) {
    fail(`ERRO: ${(e as Error).message}`);
  }
}

if (isMainModule(import.meta.url)) main();

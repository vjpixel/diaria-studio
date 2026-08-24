/**
 * scripts/mark-artigo-especial-channel.ts (#5979, fleet review PR #6000,
 * achado P1 do type-design-analyzer)
 *
 * Wrapper CLI FINO pra gravar o resultado de um canal no guard de
 * idempotência de `/diaria-artigo-especial` (`scripts/lib/artigo-especial-
 * state.ts`) — existe especificamente pro canal `apoiase`, que — diferente
 * de `linkedin_pagina`/`linkedin_perfil` (gravados por
 * `publish-artigo-especial-linkedin.ts`) e `box` (gravado por
 * `update-artigo-especial-box.ts`) — não tem NENHUM script determinístico
 * que o execute: o Passo 3 da skill (post via Claude in Chrome) é
 * necessariamente orquestrado pelo agente top-level, que lê o DOM ao vivo
 * e decide sucesso/falha.
 *
 * Achado do review: sem este script, o "guard" pro canal `apoiase` existia
 * SÓ como instrução em prosa no SKILL.md ("grave status: done/failed") —
 * zero enforcement de código, dependendo inteiramente do agente lembrar de
 * escrever o JSON certo a cada rodada. É a MESMA classe de bug que fez o
 * canal `box` ficar "esquecido" numa versão anterior desta PR (já corrigido
 * lá) — só que pior aqui, porque `apoiase` posta numa conta PÚBLICA
 * (irreversível), então um guard que falha silenciosamente arrisca
 * double-post, não só um PR duplicado. Este script estreita a superfície de
 * "confiar que o agente escreve o JSON certo" pra "confiar que o agente
 * roda 1 comando" — muito mais auditável (aparece no histórico de Bash) e
 * testável (o corpo é uma função pura, só a I/O de leitura/escrita é
 * exercida pelo CLI).
 *
 * Uso:
 *   npx tsx scripts/mark-artigo-especial-channel.ts --ano AAAA --slug slug
 *     --channel apoiase --status done --url https://apoia.se/diaria/posts/123
 *   npx tsx scripts/mark-artigo-especial-channel.ts --ano AAAA --slug slug
 *     --channel apoiase --status failed --reason "DOM do painel mudou, ver X"
 *   [--data-dir path]  (default: data/, mesma convenção dos outros scripts)
 *
 * Genérico por canal de propósito (`--channel`, não hardcoded `apoiase`) —
 * mesmo mecanismo serve pra qualquer canal futuro que também não tenha
 * script próprio, sem precisar de um novo wrapper por canal.
 */

import { resolve } from "node:path";
import { parseArgs, isMainModule, getStringArg } from "./lib/cli-args.ts";
import {
  ARTIGO_ESPECIAL_CHANNELS,
  type ArtigoEspecialChannel,
  artigoEspecialStatePath,
  readArtigoEspecialState,
  writeArtigoEspecialState,
  buildDoneChannelState,
  buildFailedChannelState,
  withChannelState,
} from "./lib/artigo-especial-state.ts";

export interface MarkArtigoEspecialChannelOptions {
  ano: string;
  slug: string;
  channel: ArtigoEspecialChannel;
  status: "done" | "failed";
  /** URL do artefato resultante (post/PR) — só usado quando `status === "done"`. */
  url?: string;
  /** Motivo da falha — OBRIGATÓRIO quando `status === "failed"` (mesma disciplina de `buildFailedChannelState`). */
  reason?: string;
  dataDir: string;
}

function isArtigoEspecialChannel(value: string): value is ArtigoEspecialChannel {
  return (ARTIGO_ESPECIAL_CHANNELS as readonly string[]).includes(value);
}

/**
 * Corpo testável (extraído de `main()` — mesmo padrão de
 * `runArtigoEspecialLinkedinDispatch`/`runUpdateArtigoEspecialBox`). Só faz
 * I/O de leitura/escrita do state file — nenhuma lógica de decisão além do
 * que `artigo-especial-state.ts` já expõe.
 */
export function runMarkArtigoEspecialChannel(options: MarkArtigoEspecialChannelOptions): { statePath: string } {
  const { ano, slug, channel, status, url, reason, dataDir } = options;

  if (status === "failed" && !reason) {
    throw new Error("--status failed exige --reason (o motivo é o que o próximo run/editor vai ler pra decidir se retenta).");
  }

  const statePath = artigoEspecialStatePath(dataDir, ano, slug);
  const state = readArtigoEspecialState(statePath, ano, slug);
  const attemptedAt = new Date().toISOString();
  const channelState = status === "done" ? buildDoneChannelState(attemptedAt, url ?? null) : buildFailedChannelState(attemptedAt, reason!);
  const nextState = withChannelState(state, channel, channelState);
  writeArtigoEspecialState(statePath, nextState);
  return { statePath };
}

// ── CLI ───────────────────────────────────────────────────────────────

const ROOT = resolve(import.meta.dirname, "..");

function usageAndExit(): never {
  console.error(
    "Uso: npx tsx scripts/mark-artigo-especial-channel.ts --ano AAAA --slug slug " +
      `--channel {${ARTIGO_ESPECIAL_CHANNELS.join("|")}} --status {done|failed} ` +
      "[--url https://...] [--reason \"...\"] [--data-dir path]",
  );
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  const { values } = parseArgs(argv);

  const ano = getStringArg(argv, "ano", { example: "2026" });
  const slug = getStringArg(argv, "slug", { example: "engenharia-de-ilusao" });
  const channelArg = getStringArg(argv, "channel", { example: ARTIGO_ESPECIAL_CHANNELS[0] });
  const statusArg = getStringArg(argv, "status", { example: "done" });
  const url = getStringArg(argv, "url", { example: "https://apoia.se/diaria/posts/123" });
  const reason = getStringArg(argv, "reason", { example: "DOM do painel mudou" });
  const dataDir = values["data-dir"] ? resolve(ROOT, values["data-dir"]) : resolve(ROOT, "data");

  if (!ano || !slug || !channelArg || !statusArg) usageAndExit();
  if (!isArtigoEspecialChannel(channelArg)) {
    console.error(`--channel inválido: "${channelArg}" — esperado um de {${ARTIGO_ESPECIAL_CHANNELS.join(", ")}}.`);
    process.exit(2);
  }
  if (statusArg !== "done" && statusArg !== "failed") {
    console.error(`--status inválido: "${statusArg}" — esperado "done" ou "failed".`);
    process.exit(2);
  }

  try {
    const { statePath } = runMarkArtigoEspecialChannel({ ano, slug, channel: channelArg, status: statusArg, url, reason, dataDir });
    console.log(`OK — canal "${channelArg}" gravado como "${statusArg}" em ${statePath}.`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}

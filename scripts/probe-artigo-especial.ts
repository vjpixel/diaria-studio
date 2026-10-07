#!/usr/bin/env node
/**
 * scripts/probe-artigo-especial.ts (#9099)
 *
 * Etapa E de `/diaria-artigo-especial`: depois do merge do PR do artigo, o
 * `.github/workflows/deploy-artigos.yml` publica o Worker. Este script
 * confere que `https://especial.diar.ia.br/{ano}/{slug}/` responde COM o
 * teaser deste artigo (`lib/artigo-especial-probe.ts` — 200 + og:url +
 * bloco do gate), tentando de novo enquanto o deploy não termina.
 *
 * Só leitura (GET). Com `--mark`, grava a etapa `publicado` no state file
 * (done no sucesso, failed com o motivo na falha) — é o que libera os
 * Passos 0-6 da divulgação num resume.
 *
 * Uso:
 *   npx tsx scripts/probe-artigo-especial.ts --ano 2026 --slug o-jev
 *     [--attempts 10] [--interval 30] [--mark] [--data-dir data]
 *
 * Exit: 0 no ar · 1 não respondeu com o artigo depois de todas as tentativas ·
 *       2 uso, ou --mark recusado (ordem das etapas / state ilegível; o veredito sai antes)
 */

import { resolve } from "node:path";

import { getIntArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { artigoUrl } from "./lib/artigo-especial-draft.ts";
import { probeArtigoEspecial, type ProbeFetch } from "./lib/artigo-especial-probe.ts";
import { runMarkProducaoEtapa } from "./artigo-especial-producao.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const ano = getStringArg(argv, "ano", { example: "2026" });
  const slug = getStringArg(argv, "slug", { example: "o-jev" });
  if (!ano || !slug) {
    console.error("Uso: npx tsx scripts/probe-artigo-especial.ts --ano AAAA --slug slug [--attempts N] [--interval S] [--mark]");
    process.exit(2);
  }
  const attempts = getIntArg(argv, "attempts") ?? 10;
  const intervalS = getIntArg(argv, "interval") ?? 30;
  const root = resolve(import.meta.dirname, "..");
  const dataDirArg = getStringArg(argv, "data-dir", { example: "data" });
  const r = await runProbeArtigoEspecial({
    ano,
    slug,
    fetchImpl: fetch as unknown as ProbeFetch,
    attempts,
    intervalMs: intervalS * 1000,
    markDataDir: hasFlag(argv, "mark") ? (dataDirArg ? resolve(root, dataDirArg) : resolve(root, "data")) : undefined,
    log: (m) => console.log(m),
    err: (m) => console.error(m),
  });
  // exitCode, não process.exit(): sair à força com o socket do fetch ainda
  // fechando derruba o Node no Windows (assert do libuv em async.c).
  process.exitCode = r.exitCode;
}

export interface RunProbeOptions {
  ano: string;
  slug: string;
  fetchImpl: ProbeFetch;
  attempts: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Definido = `--mark`: grava a etapa `publicado` neste data dir. */
  markDataDir?: string;
  log: (m: string) => void;
  err: (m: string) => void;
}

/**
 * Corpo testável. O veredito do probe é SEMPRE impresso antes de qualquer
 * tentativa de `--mark` — um erro de ordem das etapas (`pr` ainda não
 * `done`) ou de state ilegível nunca esconde se o artigo está no ar.
 * Exit: 0 no ar (e gravado, se --mark) · 1 fora do ar · 2 --mark recusado.
 */
export async function runProbeArtigoEspecial(o: RunProbeOptions): Promise<{ exitCode: 0 | 1 | 2; ok: boolean }> {
  const url = artigoUrl(o.ano, o.slug);
  const verdict = await probeArtigoEspecial({ url, fetchImpl: o.fetchImpl, attempts: o.attempts, intervalMs: o.intervalMs, sleep: o.sleep });

  if (verdict.ok) {
    o.log(`OK — ${url} no ar com o teaser do artigo (tentativa ${verdict.attempts}).`);
  } else {
    o.err(
      `FALHOU — ${url} não respondeu com o artigo em ${verdict.attempts} tentativa(s): ${verdict.reason}. ` +
        "Confira o run do 'Deploy artigos Worker' (gh run list --workflow deploy-artigos.yml -L 3): job vermelho, ou deploy PULADO pelo guard de KV.",
    );
  }

  if (o.markDataDir) {
    try {
      runMarkProducaoEtapa({
        dataDir: o.markDataDir,
        ano: o.ano,
        slug: o.slug,
        etapa: "publicado",
        status: verdict.ok ? "done" : "failed",
        url: verdict.ok ? url : undefined,
        reason: verdict.ok ? undefined : `probe: ${verdict.reason}`,
      });
      o.log(`etapa "publicado" gravada como ${verdict.ok ? "done" : "failed"}.`);
    } catch (e) {
      o.err(`--mark NÃO gravou a etapa "publicado" (o resultado do probe acima vale): ${(e as Error).message}`);
      return { exitCode: 2, ok: verdict.ok };
    }
  }
  return { exitCode: verdict.ok ? 0 : 1, ok: verdict.ok };
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERRO inesperado: ${(e as Error).message}`);
    process.exit(1);
  });
}

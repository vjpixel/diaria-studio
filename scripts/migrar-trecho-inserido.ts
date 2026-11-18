#!/usr/bin/env node
/**
 * scripts/migrar-trecho-inserido.ts (#13437, PR 1 = formato)
 *
 * Migra o `trechoInserido` do roteiro (`_internal/roteiro-falas.json`) do
 * formato antigo, `{ origem, texto }` com a origem em texto livre ("Vídeo de
 * 10/11 (youtu.be/ID), de 3:42 a 3:46"), para o estruturado da decisão do
 * editor de 17/11/2026: `{ video, inicio, fim, texto }`. O resto do JSON fica
 * como está.
 *
 * Sem `--write`, só mostra o que mudaria (dry-run). Trecho antigo sem link do
 * YouTube ou sem intervalo legível não é migrado: sai em `[erro]` com o motivo,
 * para o editor preencher à mão (nunca inventa vídeo nem tempo), e o exit é 1.
 * A leitura do formato antigo continua valendo no validador, na página e na
 * montagem; migrar só deixa o JSON no formato que a skill documenta.
 *
 * Uso: npx tsx scripts/migrar-trecho-inserido.ts AAMMDD [--falas PATH] [--write]
 *   exit 0 = nada a migrar ou migrado; 1 = algum trecho não migrável; 2 = uso/leitura.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { lerTrechoInserido, migrarTrechoInserido } from "./lib/diaria/trecho-inserido-formato.ts";
import { ROTEIRO_FALAS_FILE } from "./lib/diaria/roteiro-videos.ts";

export interface ResultadoMigracao {
  /** O JSON com os trechos migrados (o mesmo objeto, alterado no lugar). */
  raw: unknown;
  migrados: Array<{ id: string; antes: unknown; depois: unknown }>;
  erros: string[];
}

/** Migra os `trechoInserido` antigos de um roteiro já lido. Puro (altera `raw` no lugar). */
export function migrarRoteiro(raw: unknown): ResultadoMigracao {
  const migrados: ResultadoMigracao["migrados"] = [];
  const erros: string[] = [];
  const falas = (raw as { falas?: unknown } | null)?.falas;
  if (!Array.isArray(falas)) return { raw, migrados, erros: ["`falas` ausente"] };
  falas.forEach((f: unknown, i: number) => {
    const o = f as Record<string, unknown> | null;
    if (!o || o.trechoInserido === undefined) return;
    const id = typeof o.id === "string" ? o.id : `falas[${i}]`;
    const lido = lerTrechoInserido(o.trechoInserido);
    if (!lido.ok) {
      erros.push(`${id}: ${lido.problemas.join("; ")}`);
      return;
    }
    if (!lido.trecho.migrado) return;
    const depois = migrarTrechoInserido(o.trechoInserido);
    if (!depois) return;
    migrados.push({ id, antes: o.trechoInserido, depois });
    o.trechoInserido = depois;
  });
  return { raw, migrados, erros };
}

export function main(
  argv: string[] = process.argv.slice(2),
  io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => console.log(s), err: (s) => console.error(s) },
): number {
  const { values, flags, positional } = parseArgs(argv);
  const edition = positional[0];
  if (!values["falas"] && (!edition || !/^\d{6}$/.test(edition))) {
    io.err("uso: migrar-trecho-inserido.ts AAMMDD [--falas PATH] [--write]");
    return 2;
  }
  const path = values["falas"] ?? join(editionDir(edition), ROTEIRO_FALAS_FILE);
  if (!existsSync(path)) {
    io.err(`[migrar-trecho-inserido] sem ${path}`);
    return 2;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    io.err(`[migrar-trecho-inserido] não li ${path}: ${(e as Error).message}`);
    return 2;
  }
  const r = migrarRoteiro(raw);
  for (const m of r.migrados) io.out(`${m.id}: ${JSON.stringify(m.antes)}\n  vira ${JSON.stringify(m.depois)}`);
  for (const e of r.erros) io.err(`[erro] ${e} (#13437)`);
  if (!r.migrados.length) io.out("nada a migrar: nenhum trechoInserido no formato antigo");
  else if (flags.has("write")) {
    writeFileSync(path, `${JSON.stringify(r.raw, null, 2)}\n`);
    io.out(`${r.migrados.length} trecho(s) migrado(s) em ${path}`);
  } else io.out(`dry-run: ${r.migrados.length} trecho(s) a migrar; --write grava em ${path}`);
  return r.erros.length ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}

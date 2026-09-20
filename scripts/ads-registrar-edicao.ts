#!/usr/bin/env node
/**
 * scripts/ads-registrar-edicao.ts (#8241 item 4)
 *
 * CLI pra gravar 1 linha nova em `data/aquisicao/teste-2608/edicoes.jsonl`
 * no schema unificado (#8241 item 1 — `ts`, `braco`, `tipo`, `efeito`,
 * `origem` + campos livres extras) — em vez de continuar sendo JSON escrito
 * à mão por sessões diferentes, o que foi exatamente a causa do desvio de
 * formato que motivou esta issue (snapshot à data desta issue: 7 linhas
 * gravadas entre 09-17/09/2026 sem `braco` nem `registrado_em_utc`).
 *
 * NUNCA reescreve o arquivo — é JSONL append-only (vive no OneDrive,
 * escrito por várias sessões concorrentes); esta CLI só faz `appendFile`.
 *
 * Uso:
 *   npx tsx scripts/ads-registrar-edicao.ts \
 *     --braco "Google Ads (teste 2608)" --tipo edicao-em-voo \
 *     --origem editor --motivo "..." --edicao "..."
 *   npx tsx scripts/ads-registrar-edicao.ts --braco todos --tipo pausa-total-anuncios --origem editor --efeito pausa --motivo "..."
 *
 * `--tipo` precisa estar no conjunto FECHADO de `TIPO_TO_EFEITO`
 * (`scripts/lib/ads-rolling-window.ts`, #8531) — `--efeito` é OPCIONAL e
 * sempre AUTO-DERIVADO da tabela quando omitido; se passado, precisa bater
 * com o valor catalogado (senão a gravação é recusada). `--tipo` fora da
 * tabela é SEMPRE recusado, mesmo com `--efeito` explícito — não há mais
 * escape-hatch de texto livre (era assim até o #8241; foi exatamente esse
 * escape-hatch que produziu os 5 tipos de texto livre gravados em
 * 09-17/09/2026 que motivaram a #8531). Tipo novo entra só via PR que
 * adiciona uma entrada em `TIPO_TO_EFEITO`, nunca via flag da CLI.
 * Campos extras livres (`--motivo`, `--edicao`, `--issue`, etc.) entram na
 * linha como estão — nenhuma allowlist de campo extra.
 *
 * Exit codes: 0 = gravou; 1 = validação falhou (nada foi escrito); 2 = erro de I/O.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/cli-args.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { TIPO_TO_EFEITO, EDICAO_EFEITOS, isTipoValido, type EdicaoEfeito } from "./lib/ads-rolling-window.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_EDICOES_JSONL_PATH = resolve(ROOT, "data/aquisicao/teste-2608/edicoes.jsonl");

const ORIGENS = ["editor", "agente", "plataforma"] as const;
type Origem = (typeof ORIGENS)[number];

/** Campos reservados que o CLI já resolve — o resto de `values` entra na
 *  linha como campo extra livre (`--motivo`, `--edicao`, `--issue`, ...). */
const RESERVED_FLAGS = new Set(["ts", "braco", "tipo", "efeito", "origem", "edicoes-path"]);

export interface RegistrarEdicaoInput {
  ts?: string;
  braco?: string;
  tipo?: string;
  efeito?: string;
  origem?: string;
  extra: Record<string, string>;
}

export type RegistrarEdicaoValidation =
  | { ok: true; line: Record<string, unknown> }
  | { ok: false; errors: string[] };

/**
 * Valida um candidato de linha nova — recusa (sem gravar nada) se faltar
 * `ts`, `braco`, `tipo`, `efeito` ou `origem` (critério de aceite #8241),
 * se `efeito`/`origem` não forem um dos valores conhecidos, ou se `tipo`
 * não estiver no conjunto FECHADO de `TIPO_TO_EFEITO` (#8531 — nenhum
 * `tipo` de texto livre passa, mesmo com `--efeito` explícito).
 *
 * @pure
 */
export function validateRegistrarEdicaoInput(input: RegistrarEdicaoInput, nowIso: string): RegistrarEdicaoValidation {
  const errors: string[] = [];
  const ts = input.ts ?? nowIso;
  const braco = input.braco?.trim();
  const tipo = input.tipo?.trim();
  let efeito = input.efeito?.trim() as EdicaoEfeito | undefined;
  const origem = input.origem?.trim() as Origem | undefined;

  if (!braco) errors.push("--braco é obrigatório (use 'todos' quando a linha vale para os 3 braços).");
  if (!tipo) errors.push("--tipo é obrigatório.");
  if (!origem) errors.push("--origem é obrigatório.");
  else if (!ORIGENS.includes(origem)) errors.push(`--origem "${origem}" inválido — use um de: ${ORIGENS.join(", ")}.`);

  if (tipo && !isTipoValido(tipo)) {
    errors.push(
      `--tipo "${tipo}" não está no conjunto fechado de tipos válidos (TIPO_TO_EFEITO em ads-rolling-window.ts). ` +
        `Tipo novo exige um PR adicionando uma entrada na tabela, não um valor de texto livre na CLI (#8531). ` +
        `Válidos: ${Object.keys(TIPO_TO_EFEITO).join(", ")}.`,
    );
  } else if (tipo) {
    const derivado = TIPO_TO_EFEITO[tipo];
    if (!efeito) {
      efeito = derivado;
    } else if (efeito !== derivado) {
      errors.push(`--efeito "${efeito}" não bate com o efeito catalogado para "${tipo}" ("${derivado}") — omita --efeito para auto-derivar, ou corrija.`);
    }
  }
  if (efeito && !EDICAO_EFEITOS.includes(efeito)) {
    errors.push(`--efeito "${efeito}" inválido — use um de: ${EDICAO_EFEITOS.join(", ")}.`);
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    line: { ts, braco, tipo, efeito, origem, ...input.extra },
  };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const { values, flags } = parseArgs(argv);
  if (flags.has("help")) {
    console.log("Uso: npx tsx scripts/ads-registrar-edicao.ts --braco <canal|todos> --tipo <tipo> --origem <editor|agente|plataforma> [--efeito <efeito>] [--ts <ISO>] [--campo-extra valor...]");
    return 0;
  }

  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!RESERVED_FLAGS.has(key)) extra[key] = value;
  }

  const result = validateRegistrarEdicaoInput(
    { ts: values.ts, braco: values.braco, tipo: values.tipo, efeito: values.efeito, origem: values.origem, extra },
    new Date().toISOString(),
  );
  if (!result.ok) {
    for (const e of result.errors) console.error(`[ads-registrar-edicao] ${e}`);
    return 1;
  }

  const path = values["edicoes-path"] || DEFAULT_EDICOES_JSONL_PATH;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(result.line)}\n`);
  } catch (e) {
    console.error(`[ads-registrar-edicao] falha ao gravar em ${path}: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  console.log(`[ads-registrar-edicao] linha gravada em ${path}: ${JSON.stringify(result.line)}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(main());
}

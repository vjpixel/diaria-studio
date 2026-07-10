/**
 * cli-args.ts — parser de argumentos CLI compartilhado.
 * Substitui o pattern args[args.indexOf(flag)+1] que retorna args[0] quando flag ausente.
 */

import { fileURLToPath } from "node:url";

export interface ParsedArgs {
  /** Flags booleanas presentes (ex: --force → flags.has("force")) */
  flags: Set<string>;
  /** Pares --key value (ex: --edition-dir foo → values["edition-dir"] = "foo") */
  values: Record<string, string>;
  /** Argumentos posicionais (sem --) */
  positional: string[];
}

/**
 * Parseia argv (process.argv.slice(2)) separando flags booleanas,
 * pares key-value e posicionais.
 *
 * Regra: `--key` seguido de valor que não começa com `--` → values["key"] = valor.
 * `--key` seguido de outro `--key` ou fim do array → flags.add("key").
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values[key] = next;
      i++;
    } else {
      flags.add(key);
    }
  }

  return { flags, values, positional };
}

/** Atalho: retorna values[key] ?? "" (never returns args[0] quando key ausente). */
export function getArg(argv: string[], key: string): string {
  return parseArgs(argv).values[key] ?? "";
}

/** Atalho: retorna true se --flag está presente. */
export function hasFlag(argv: string[], flag: string): boolean {
  return parseArgs(argv).flags.has(flag);
}

/**
 * Variante "flat" — retorna Record<string, string> direto (sem separar
 * flags/values/positional). Regra: `--key` seguido de QUALQUER próximo
 * elemento (mesmo que comece com `--`) consome esse elemento como valor;
 * `--key` no fim do array é ignorado (não vira flag booleana).
 *
 * #2834: era duplicada byte-a-byte (a menos de nome de variável local) em
 * 21 scripts — todos scripts que só usam `--key value`, nunca flags
 * booleanas standalone. NÃO usar em scripts que precisam de flags
 * booleanas (`--force` sem valor) — usar `parseArgs`/`hasFlag` para esses.
 */
export function parseArgsSimple(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

/**
 * Variante "flag-as-true" — retorna Record<string, string> onde `--key value`
 * vira values["key"] = valor, e `--key` sem valor seguinte (ou seguido de
 * outro `--flag`) vira values["key"] = "true" (string, não boolean).
 *
 * #2834: era duplicada byte-a-byte em analyze-h4.ts, analyze-scorer-impact.ts,
 * assemble-scored.ts e split-articles-for-scoring.ts.
 */
export function parseArgsWithTrueDefault(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

/**
 * Detecta se o módulo atual foi invocado diretamente via CLI (não importado
 * por outro módulo/teste). Uso: `if (isMainModule(import.meta.url)) { main(); }`.
 *
 * #2834: consolida 4 variantes de CLI-guard catalogadas no codebase (~226
 * scripts):
 *   (a) comparação manual de string `file://` com replace de backslash — a
 *       maioria, escrita antes de `fileURLToPath`/`pathToFileURL` serem o
 *       padrão adotado no repo;
 *   (b) `process.argv[1] === fileURLToPath(import.meta.url)`;
 *   (c) `import.meta.url === pathToFileURL(process.argv[1]).href`;
 *   (d) `/\/scripts\/nome-do-arquivo\.ts$/.test(argv1)` — regex de sufixo,
 *       mais permissiva que as outras 3 (casa por final de caminho, não por
 *       igualdade exata).
 * Todas resolvem pro mesmo objetivo prático e são equivalentes sob as formas
 * de invocação usadas neste repo (tsx direto, path absoluto ou relativo, de
 * qualquer cwd) — Node absolutiza `process.argv[1]` do script de entrada de
 * forma consistente com `import.meta.url` em todos os casos verificados
 * (incl. Windows). A variante (d) nunca precisou da leniência extra na
 * prática: sob essas formas de invocação a comparação estrita já é sempre
 * verdadeira quando o sufixo bateria.
 */
export function isMainModule(importMetaUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return fileURLToPath(importMetaUrl) === argv1;
}

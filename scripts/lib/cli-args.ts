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
 *
 * Suporta também a sintaxe `--key=valor` (#4272): quando o token contém `=`,
 * splita na PRIMEIRA ocorrência — `values["key"] = valor` mesmo que `valor`
 * comece com `--` ou contenha outros `=` (ex: `--key=a=b` → value `"a=b"`).
 * `--key=` (sem nada após o `=`) produz `values["key"] = ""` — é um valor
 * vazio explícito, não um `flags.add`. Antes desta mudança, um token
 * `--key=valor` produzia a chave garbled literal `"key=valor"` — nunca
 * reconhecida por nenhum caller (nem em `flags` nem em `values["key"]`) —
 * então suportar `=` é aditivo: não altera o comportamento de nenhum caller
 * existente, só passa a reconhecer uma sintaxe que antes caía fora do radar.
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
    const eqIdx = arg.indexOf("=");
    if (eqIdx !== -1) {
      const key = arg.slice(2, eqIdx);
      values[key] = arg.slice(eqIdx + 1);
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

/**
 * Atalho: retorna values[key] ?? "" (never returns args[0] quando key ausente).
 *
 * @deprecated (#4573) Colapsa "flag ausente" e "flag presente mas vazia/sem
 * valor" no mesmo sentinela `""` — 3 incidentes de produção já nasceram desse
 * colapso (#4476/#4496, #4542/#4564, #4568; ver issue #4573 pro histórico
 * completo). **Ainda legítimo** pra flag de TEXTO LIVRE onde `""` é um
 * "sem preferência" genuinamente aceitável (ex: `--label`, `--subject` com
 * fallback explícito). **Nunca** pra flag NUMÉRICA (`Number(getArg(...))`/
 * `parseInt(getArg(...))` sem proteção — barrado por `test/getarg-numeric-guard-4573.test.ts`)
 * nem pra flag OBRIGATÓRIA-quando-presente. Use `getIntArg` (numérica,
 * `undefined` quando ausente, lança em valor inválido) ou `getStringArg`
 * (texto obrigatório-quando-presente) nesses dois casos. Migração dos 118
 * call sites existentes é INCREMENTAL, sob demanda quando o arquivo for
 * tocado por outro motivo — não numa varredura única (decisão do editor,
 * #4573).
 */
export function getArg(argv: string[], key: string): string {
  return parseArgs(argv).values[key] ?? "";
}

/** Atalho: retorna true se --flag está presente. */
export function hasFlag(argv: string[], flag: string): boolean {
  return parseArgs(argv).flags.has(flag);
}

/**
 * Retorna os tokens do argv que parecem flag (começam com `-`) mas não estão na
 * lista `known` (nomes SEM os hífens, ex: `["task", "verify"]`). Aceita
 * `--nome` e `--nome=valor`; `-h` só se `"h"` estiver em `known`. Serve pra
 * scripts com efeito colateral real (armar timers) recusarem typo de flag em
 * vez de cair em silêncio no default (#11058). Tokens que não começam com `-`
 * (valores de `--flag valor`) são ignorados.
 */
export function findUnknownFlags(argv: string[], known: readonly string[]): string[] {
  const knownSet = new Set(known);
  const unknown: string[] = [];
  for (const a of argv) {
    if (!a.startsWith("-") || a === "-" || a === "--") continue;
    const name = a.replace(/^-{1,2}/, "").split("=")[0];
    if (!knownSet.has(name)) unknown.push(a);
  }
  return unknown;
}

/**
 * Contrato de linha de comando de um script com efeito real (alarme que manda
 * e-mail ou abre/fecha issue), validado por `resolveCliAction` ANTES de
 * qualquer I/O (#12503, generaliza o `resolveMetricsHealthCliAction` da #12476).
 * Nomes SEM os hífens. `help`/`h` entram sozinhos — não listar.
 */
export interface CliSpec {
  /** Caminho do script, só pro texto de uso (ex: `scripts/tmp-disk-alarm.ts`). */
  script: string;
  /** Flags sem valor (ex: `dry-run`, `json`). */
  booleans?: readonly string[];
  /** Flags que exigem valor (`--flag valor` ou `--flag=valor`). */
  values?: readonly string[];
  /** Subconjunto de `values` que precisa ser número finito e ≥ 0. */
  numeric?: readonly string[];
  /** Texto de uso próprio; sem ele, `formatCliUsage` monta um a partir das listas. */
  usage?: string;
}

export type CliAction =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "run" };

/** Texto de uso do `--help` (e do erro de argv) de um `CliSpec`. */
export function formatCliUsage(spec: CliSpec): string {
  if (spec.usage) return spec.usage;
  const parts = [
    ...(spec.booleans ?? []).map((b) => `[--${b}]`),
    ...(spec.values ?? []).map((v) => `[--${v} <valor>]`),
    "[--help | -h]",
  ];
  const lines = [`uso: npx tsx ${spec.script} ${parts.join(" ")}`];
  if ((spec.booleans ?? []).includes("dry-run")) {
    lines.push("", "Sem --dry-run roda o modo REAL (e-mail e/ou issues do alarme).");
  }
  lines.push(
    "Flag desconhecida, argumento solto ou flag sem o valor esperado sai 1 sem rodar nada (#12503).",
  );
  return lines.join("\n");
}

/**
 * #12503 — decide, antes de qualquer I/O, se o argv autoriza rodar. Sem isto,
 * `--help` ou um typo (`--dryrun`) era ignorado em silêncio e o script caía no
 * modo REAL (e-mail ao editor + issues do alarme). Regras (as da #12476):
 *   - flag desconhecida → `error` (vence o help: `--bogus --help` recusa);
 *   - `--help`/`-h` → `help` (imprimir uso, sair 0);
 *   - argumento posicional solto → `error`;
 *   - flag booleana com valor → `error` (`--dry-run foo` faria `parseArgs`
 *     engolir `foo` como valor e `hasFlag("dry-run")` virar false = modo real);
 *   - flag de valor sem valor, com valor vazio, ou com valor que parece flag
 *     (`--to -h`) → `error`; em `numeric`, valor não-numérico ou negativo → `error`;
 *   - resto → `run`.
 * `argv` é `process.argv.slice(2)` — nunca o `process.argv` inteiro (o caminho
 * do node e do script viram posicionais).
 * @pure
 */
export function resolveCliAction(argv: readonly string[], spec: CliSpec): CliAction {
  const list = [...argv];
  const booleans = [...(spec.booleans ?? []), "help", "h"];
  const values = spec.values ?? [];
  const numeric = new Set(spec.numeric ?? []);

  // Tokens consumidos como VALOR de uma flag de valor (`--flag valor`, mesma
  // regra de `parseArgs`: o próximo token que não começa com `--`) não são
  // flags. Sem isto, `--limiar -5` saía "flag desconhecida: -5" e `--to -h`
  // virava help (#12502).
  const valueSet = new Set<string>(values);
  const flagTokens: string[] = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    flagTokens.push(a);
    if (a.startsWith("--") && !a.includes("=") && valueSet.has(a.slice(2))) {
      const next = list[i + 1];
      if (next !== undefined && !next.startsWith("--")) i++;
    }
  }

  const unknown = findUnknownFlags(flagTokens, [...booleans, ...values]);
  if (unknown.length > 0) {
    return { kind: "error", message: `flag(s) desconhecida(s): ${unknown.join(", ")}` };
  }
  if (flagTokens.includes("-h") || flagTokens.includes("--help")) return { kind: "help" };

  const parsed = parseArgs(list);
  if (parsed.positional.length > 0) {
    return { kind: "error", message: `argumento(s) inesperado(s): ${parsed.positional.join(", ")}` };
  }
  for (const flag of booleans) {
    if (flag in parsed.values) {
      return { kind: "error", message: `--${flag} não aceita valor (recebido "${parsed.values[flag]}")` };
    }
  }
  for (const flag of values) {
    const value = parsed.values[flag];
    if (parsed.flags.has(flag) || value === "") {
      return { kind: "error", message: `--${flag} exige um valor` };
    }
    if (value === undefined) continue;
    if (numeric.has(flag)) {
      const n = Number(value);
      if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
        return { kind: "error", message: `--${flag} deve ser um número não-negativo (recebido "${value}")` };
      }
    } else if (value.startsWith("-")) {
      return { kind: "error", message: `--${flag} exige um valor (recebido "${value}", que parece uma flag)` };
    }
  }
  return { kind: "run" };
}

/**
 * Lado de efeito de `resolveCliAction`, pro topo do `main()` de um alarme:
 * `help` imprime o uso e devolve 0; `error` imprime a mensagem + uso em stderr
 * e devolve 1; `run` devolve `null` (seguir). Não chama `process.exit` — o
 * caller decide (`return code` ou `process.exitCode = code; return`).
 */
export function applyCliAction(
  argv: readonly string[],
  spec: CliSpec,
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => console.log(s),
    err: (s) => console.error(s),
  },
): 0 | 1 | null {
  const action = resolveCliAction(argv, spec);
  if (action.kind === "run") return null;
  const usage = formatCliUsage(spec);
  if (action.kind === "help") {
    io.out(usage);
    return 0;
  }
  io.err(`[${spec.script}] ${action.message}`);
  io.err(usage);
  return 1;
}

/**
 * Atalho tipado — retorna `--key` como inteiro, ou `undefined` quando a flag
 * está genuinamente AUSENTE. Diferente de `getArg` (que colapsa
 * ausente/inválido/zero no mesmo sentinela `""`, por design — ver docstring
 * acima), `getIntArg` LANÇA quando a flag foi passada mas o valor não é um
 * inteiro válido, em vez de degradar silenciosamente pra um default (#4497).
 *
 * Motivação (achado ao vivo #4476/#4496, 260802): `verify-pending-emails-mv.ts`
 * tinha `getArg(...) !== undefined` (sempre true, `getArg` nunca retorna
 * undefined) seguido de `Number("") === 0` — uma rodada real que devia
 * processar 625 e-mails processou 0, sem erro. O fix local virou
 * `parseLimitArg` naquele arquivo; `getIntArg` generaliza o mesmo padrão
 * (já validado em produção) pra qualquer flag numérica em qualquer script.
 *
 * Regras — usa `parseArgs` (não `getArg`) internamente, porque só `parseArgs`
 * distingue "ausente" (`undefined`) de "presente com valor inválido/vazio":
 *   - flag ausente → `undefined` (caller decide o default).
 *   - `--key` sem valor (fim do argv, ou seguido de outra `--flag`) → lança.
 *   - `--key=` ou `--key ""` (valor vazio explícito, sintaxe `=` do #4272) → lança.
 *   - valor não-inteiro (`--key abc`) → lança.
 *   - valor inteiro abaixo de `opts.min` (default 0 — não-negativo) → lança.
 *
 * @param opts.min valor mínimo aceito, inclusive. Default 0. Passe um `min`
 *   maior (ex: 1) pra flags que não fazem sentido como zero (ex: tamanho de
 *   lote, top-N).
 */
/**
 * Irmão de `getIntArg` pra flags de TEXTO cujo valor é obrigatório quando a
 * flag aparece (#4542). Mesma motivação e mesmas regras — `getArg` colapsa
 * "ausente" e "presente mas quebrada" no mesmo `""`, e um caller que trate
 * `""` como "não pediu" degrada em silêncio exatamente no erro de digitação
 * mais provável.
 *
 * Achado que motivou este helper (review do PR #4564): `--hold` lido via
 * `getArg` transformava `--hold` (sem valor), `--hold --dry-run` e `--hold=`
 * em "nenhuma reserva pedida" — o script saía 0 e gravava o segmento inteiro
 * que o operador tinha acabado de pedir pra segurar, sem nada no stdout, no
 * stderr ou no resumo JSON denunciando que a reserva foi descartada.
 *
 * Regras:
 *   - flag ausente → `undefined` (caller decide o default).
 *   - `--key` sem valor (fim do argv, ou seguido de outra `--flag`) → lança.
 *   - `--key=` ou `--key ""` (valor vazio explícito) → lança.
 *   - `--key` REPETIDA → lança. `parseArgs` guarda um valor por chave (último
 *     vence), então `--hold a --hold b` descartaria `a` em silêncio. Rejeitar
 *     é melhor que acumular aqui: acumular mudaria a semântica de toda flag
 *     que já usa `parseArgs`, e a sintaxe sancionada pra múltiplos valores é
 *     a lista por vírgula (`--key a,b`).
 *
 * @param opts.example valor de exemplo usado nas mensagens de erro.
 */
export function getStringArg(
  argv: string[],
  key: string,
  opts: { example?: string } = {},
): string | undefined {
  const exemplo = opts.example ?? "valor";
  const ocorrencias = argv.filter((a) => a === `--${key}` || a.startsWith(`--${key}=`)).length;
  if (ocorrencias > 1) {
    throw new Error(
      `--${key} foi passada ${ocorrencias}× — só o último valor valeria e os anteriores seriam ` +
        `descartados em silêncio. Passe uma lista separada por vírgula (ex: "--${key} ${exemplo}").`,
    );
  }
  const parsed = parseArgs(argv);
  if (parsed.flags.has(key)) {
    throw new Error(`--${key} foi passado sem valor (ex: "--${key} ${exemplo}") — omita a flag pra não usá-la.`);
  }
  const raw = parsed.values[key];
  if (raw === undefined) return undefined;
  if (raw.trim() === "") {
    throw new Error(
      `--${key} foi passado com valor vazio (ex: "--${key}=" ou "--${key} ''") — omita a flag pra não usá-la, ou passe um valor válido.`,
    );
  }
  return raw;
}

export function getIntArg(
  argv: string[],
  key: string,
  opts: { min?: number; max?: number; maxContext?: string } = {},
): number | undefined {
  const min = opts.min ?? 0;
  const max = opts.max;
  const parsed = parseArgs(argv);
  if (parsed.flags.has(key)) {
    throw new Error(`--${key} foi passado sem valor (ex: "--${key} 50") — omita a flag pra usar o default.`);
  }
  const raw = parsed.values[key];
  if (raw === undefined) return undefined;
  if (raw.trim() === "") {
    throw new Error(
      `--${key} foi passado com valor vazio (ex: "--${key}=" ou "--${key} ''") — omita a flag pra usar o default, ou passe um inteiro válido.`,
    );
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(
      `--${key} deve ser um inteiro ${min === 0 ? "não-negativo" : `≥ ${min}`}, recebido "${raw}".`,
    );
  }
  if (max !== undefined && value > max) {
    // #6850: mensagem base sempre genérica — o helper é usado por vários
    // chamadores, não só `update-artigo-especial-box.ts` (#6748). Contexto
    // específico (ex: "slot N é o último válido, #6748") entra via
    // `opts.maxContext`, nunca hardcoded aqui — um chamador futuro que use
    // `max` pra outra coisa (--limit, --max-add, --batch-size) não deve ver
    // vocabulário de "slot" que não tem relação com o argumento dele.
    const context = opts.maxContext ? ` (${opts.maxContext})` : "";
    throw new Error(`--${key} deve ser ≤ ${max}${context}, recebido "${raw}".`);
  }
  return value;
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

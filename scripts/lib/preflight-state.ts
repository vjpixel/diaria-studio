/**
 * preflight-state.ts (#5414)
 *
 * Persiste os resultados dos probes de preflight do Stage 0 que stages
 * POSTERIORES precisam consultar.
 *
 * ## Por que existe
 *
 * Até aqui esses valores viviam só na CONVERSA: o Stage 0 mandava "setar
 * `CHROME_MCP = true` em sessão" e o Stage 5, dezenas de milhares de tokens
 * depois, mandava "checar `CHROME_MCP`". Isso amarrava a edição inteira a um
 * único contexto contínuo — e é caro: medido no #5414, o contexto residente
 * de uma edição sobe de 159k para 933k tokens sem interrupção do Stage 0 ao
 * fim do Stage 4, porque nada pode ser descartado sem perder estado. Cada
 * turno paga o acumulado inteiro; a simulação sobre a edição 260814 aponta
 * ~49% do custo vindo dessa herança.
 *
 * Com o estado em disco, cada stage pode rodar em contexto próprio
 * (`/diaria-4-revisao` numa sessão limpa, por exemplo) sem "esquecer" o que
 * o preflight descobriu.
 *
 * ## Três estados, não dois
 *
 * Cada probe é `true` / `false` / `null`, e `null` NÃO é `false`:
 *
 *   - `true`  — probado, disponível.
 *   - `false` — probado, indisponível (o Stage 5 pula o dispatch de Chrome,
 *               grava `05-published.json` com `status: "skipped"`, etc.).
 *   - `null`  — NÃO PROBADO (Stage 0 não rodou, rodou numa versão antiga,
 *               ou o arquivo sumiu). O caller deve RE-PROBAR, nunca assumir
 *               indisponível: tratar `null` como `false` faria uma edição
 *               pular a publicação inteira em silêncio só porque o preflight
 *               não deixou registro.
 *
 * Mesma disciplina de `subagent_tokens_in: null` no #5413 — "não sei" e
 * "não" são respostas diferentes e o tipo precisa dizer qual é qual.
 *
 * ## Uso
 *
 *   # Stage 0, após cada probe:
 *   npx tsx scripts/lib/preflight-state.ts --edition-dir data/editions/2608/260817 \
 *     --set chrome_mcp=true
 *
 *   # Stage 2/5/6, antes de usar a dependência:
 *   npx tsx scripts/lib/preflight-state.ts --edition-dir ... --get clarice_rest
 *   # → imprime `true` | `false` | `unknown` (exit 0 sempre)
 *
 *   # Estado inteiro:
 *   npx tsx scripts/lib/preflight-state.ts --edition-dir ...
 *   # → JSON
 *
 * Leitura é fail-soft total (arquivo ausente, JSON corrompido, chave de tipo
 * errado) -> tudo `null`, nunca lança: preflight sem registro não pode
 * derrubar uma edição em andamento. Escrita propaga erro real (disco,
 * permissão) — falhar em silêncio ali deixaria o Stage 5 lendo um estado
 * que ninguém gravou.
 *
 * @see CLAUDE.md § "Data da edição é sempre explícita" — resume por stage
 * @see scripts/lib/studio-chat-enabled.ts — mesmo padrão de módulo+CLI
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule, parseArgs } from "./cli-args.ts";
import { acquireLock, releaseLock } from "./file-lock.ts";

/** Probes do Stage 0 consultados por stages posteriores. */
export const PREFLIGHT_KEYS = [
  "chrome_mcp",
  "gmail_mcp",
  "beehiiv_mcp",
  "clarice_rest",
  "cloudflare_token_ok",
] as const;

export type PreflightKey = (typeof PREFLIGHT_KEYS)[number];

/** `null` = não probado. Nunca equivalente a `false` — ver cabeçalho. */
export type PreflightProbe = boolean | null;

export type PreflightState = Record<PreflightKey, PreflightProbe> & {
  /** ISO da última escrita. `null` = nunca escrito. */
  updated_at: string | null;
};

export function emptyPreflightState(): PreflightState {
  const s = { updated_at: null } as PreflightState;
  for (const k of PREFLIGHT_KEYS) s[k] = null;
  return s;
}

export function preflightStatePath(editionDir: string): string {
  return resolve(editionDir, "_internal", "preflight-state.json");
}

export function isPreflightKey(v: string): v is PreflightKey {
  return (PREFLIGHT_KEYS as readonly string[]).includes(v);
}

/**
 * Lê o estado. Fail-soft total -> todas as chaves `null` quando o arquivo
 * não existe, não parseia, ou traz um valor que não é boolean (chave
 * desconhecida é ignorada, não contamina o resultado).
 */
export function readPreflightState(editionDir: string): PreflightState {
  const out = emptyPreflightState();
  const p = preflightStatePath(editionDir);
  if (!existsSync(p)) return out;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return out;
  }
  if (typeof raw !== "object" || raw === null) return out;
  for (const k of PREFLIGHT_KEYS) {
    if (typeof raw[k] === "boolean") out[k] = raw[k];
  }
  out.updated_at = typeof raw.updated_at === "string" ? raw.updated_at : null;
  return out;
}

/** Atalho de leitura de um probe só. `null` = não probado (re-probar). */
export function readProbe(editionDir: string, key: PreflightKey): PreflightProbe {
  return readPreflightState(editionDir)[key];
}

/**
 * Grava UM probe, preservando os demais (merge sobre o que já está em
 * disco). O Stage 0 chama isto uma vez por probe, conforme cada um resolve —
 * não há um momento em que todos os 5 estejam prontos ao mesmo tempo.
 *
 * **Sob lock, e isso não é precaução teórica.** É read-modify-write, e cada
 * `--set` é um processo separado. O playbook do Stage 0 manda explicitamente
 * disparar chamadas Bash independentes "numa única mensagem" (§0e–0h) — ou
 * seja, a própria convenção do projeto encoraja o paralelismo que causaria
 * lost update aqui: A lê, B lê o mesmo estado, A grava, B grava por cima e o
 * probe de A some. O write sucede, então nada acusaria a perda — o Stage 5
 * leria `unknown` para um probe que de fato rodou.
 *
 * Reusa `file-lock.ts`, o mesmo mecanismo que `social-published-store.ts` já
 * usa para os publishers paralelos gravarem `06-social-published.json`.
 * Escrita via tmp + `rename` (atômico) — nunca deixa o arquivo real pela
 * metade se o processo morrer no meio.
 */
export function setProbe(
  editionDir: string,
  key: PreflightKey,
  value: PreflightProbe,
  opts: { now?: () => Date } = {},
): PreflightState {
  const now = opts.now ?? (() => new Date());
  const p = preflightStatePath(editionDir);
  mkdirSync(dirname(p), { recursive: true });
  const lockPath = p + ".lock";
  acquireLock(lockPath);
  try {
    // Ler DENTRO do lock — ler fora seria a própria janela da corrida.
    const state = readPreflightState(editionDir);
    state[key] = value;
    state.updated_at = now().toISOString();
    const tmpPath = p + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf8");
    renameSync(tmpPath, p);
    return state;
  } finally {
    releaseLock(lockPath);
  }
}

/** `true`/`false`/`unknown` — forma legível que o playbook consegue casar. */
export function formatProbe(v: PreflightProbe): "true" | "false" | "unknown" {
  return v === null ? "unknown" : v ? "true" : "false";
}

function parseProbeValue(raw: string): PreflightProbe {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "unknown" || raw === "null") return null;
  throw new Error(`valor inválido: ${raw} (use true|false|unknown)`);
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionDir = values["edition-dir"];
  if (!editionDir) {
    console.error(
      "Uso: preflight-state.ts --edition-dir <path> [--set chave=true|false] [--get chave]",
    );
    process.exit(2);
  }
  const dir = resolve(process.cwd(), editionDir);

  // `--get`/`--set` SEM valor viram flag booleana no parseArgs, não entram em
  // `values` — cairiam no dump do estado inteiro, exit 0. Um template que
  // perdesse o `{chave}` devolveria um JSON multi-linha onde o caller espera
  // um único `true`/`false`/`unknown`, sem nada acusar. Typo falha alto neste
  // módulo; ausência de valor tem que falhar igual.
  for (const flag of ["set", "get"]) {
    if (flags.has(flag)) {
      console.error(`--${flag} exige um valor (ex: --${flag} chrome_mcp${flag === "set" ? "=true" : ""})`);
      process.exit(2);
    }
  }

  const set = values["set"];
  if (set) {
    const [key, rawValue] = set.split("=");
    if (!key || rawValue === undefined || !isPreflightKey(key)) {
      console.error(
        `--set precisa ser chave=valor com chave em: ${PREFLIGHT_KEYS.join(", ")}`,
      );
      process.exit(2);
    }
    let value: PreflightProbe;
    try {
      value = parseProbeValue(rawValue);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(2);
    }
    const state = setProbe(dir, key, value);
    console.log(JSON.stringify(state));
  } else if (values["get"]) {
    const key = values["get"];
    if (!isPreflightKey(key)) {
      console.error(`--get precisa ser uma de: ${PREFLIGHT_KEYS.join(", ")}`);
      process.exit(2);
    }
    console.log(formatProbe(readProbe(dir, key)));
  } else {
    console.log(JSON.stringify(readPreflightState(dir), null, 2));
  }
}

#!/usr/bin/env npx tsx
/**
 * scripts/lib/pr-body-fetch.ts (#7140)
 *
 * Busca o BODY de um PR pela API do GitHub (com retry+backoff), com
 * fallback declarado pro `PR_BODY` do payload do evento.
 *
 * ## Por que existe (#7140)
 *
 * `check-pr-bugfix.ts` (#970) e `check-pr-removal-declaration.ts` (#7115)
 * lêiam o body do PR exclusivamente via `process.env.PR_BODY`, que o workflow
 * popula a partir de `github.event.pull_request.body` — ou seja, o body
 * **congelado no estado que tinha quando o evento foi emitido**. As labels,
 * por outro lado, são buscadas frescas via API (`getPrLabels`, com
 * retry/backoff #2060). Resultado: quem editava o body e depois dava
 * `gh run rerun` (que replaya o mesmo payload) nunca destrava — a instrução
 * que o próprio gate imprime ("Adicione ... ao body") era insuficiente
 * sozinha, e o push de commit vazio era o único workaround.
 *
 * A assimetria era confusa: label e body lidos por caminhos diferentes no
 * mesmo script (label = API fresca, body = payload congelado), então quem
 * aplicava a label E editou o body via `gh-pr-safe-edit.ts` vê a label ser
 * reconhecida mas o body não — fazendo parecer que a edição não pegou.
 *
 * ## Correção
 *
 * O body é buscado pela API junto com as labels, no mesmo ponto e com o mesmo
 * retry/backoff (3 tentativas, 10–20s) — o `prNumber` já está disponível em
 * ambos os gates. `PR_BODY` do payload continua sendo usado, mas só como
 * **fallback declarado** quando a API falhar após esgotar as tentativas, e
 * isso é dito explicitamente no log (nunca silencioso).
 *
 * O caminho de API é o mesmo que `getPrLabels` usa: `gh pr view {n} --json
 * body --jq .body`. A API REST é a fonte canônica — é o que
 * `gh-pr-safe-edit.ts` usa pra ESCREVER o body (PATCH) e releio após, então
 * ler pelo mesmo caminho é consistente.
 *
 * ## Testabilidade
 *
 * `fetchPrBody` aceita o mesmo `PrCheckSpawnFn` injetável de
 * `check-pr-bugfix.ts` (+ `sleepFn` + `maxAttempts`) — mesmos padrões de
 * dependency injection de `getPrLabels`, testável com mock sem `gh`/rede
 * real. `resolvePrBody` é a lógica pura de fallback: dada uma função que
 * busca a API (ou que falha), decide se usa o resultado ou cai pro payload.
 */
import { type PrCheckSpawnFn } from "./spawn-types.ts";
import { spawnSync } from "node:child_process";

/** Delay real entre tentativas (produção). Em testes, substituído por mock. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Busca o body atual do PR pela API, com retry+backoff (3 tentativas, 10–20s)
 * pra falhas transitórias (401/5xx/timeout) — mesmo padrão de `getPrLabels`.
 *
 * Lança `[#7140] INFRA: não foi possível buscar o body após N tentativas.`
 * após esgotar as tentativas, com o último erro. O caller decide o
 * fallback (ver `resolvePrBody`).
 */
export async function fetchPrBody(
  prNumber: string,
  spawnFn: PrCheckSpawnFn = spawnSync as PrCheckSpawnFn,
  sleepFn: (ms: number) => Promise<void> = sleepMs,
  maxAttempts = 3,
): Promise<string> {
  if (maxAttempts < 1) {
    throw new Error(`[#7140] INFRA: maxAttempts deve ser ≥ 1, recebido ${maxAttempts}`);
  }
  const backoffMs = [10_000, 20_000];
  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = spawnFn(
      "gh",
      ["pr", "view", prNumber, "--json", "body", "--jq", ".body"],
      { encoding: "utf8" },
    );
    if (r.status === 0) {
      return r.stdout;
    }
    lastError = r.stderr || (r.status === null ? "processo morto por sinal — possível OOM/timeout do runner" : `exit ${r.status}`);
    if (attempt < maxAttempts) {
      const delay = backoffMs[attempt - 1] ?? 30_000;
      console.warn(
        `[#7140] tentativa ${attempt}/${maxAttempts} falhou (${lastError.trim()}). Aguardando ${delay / 1000}s...`,
      );
      await sleepFn(delay);
    }
  }
  throw new Error(
    `[#7140] INFRA: não foi possível buscar o body do PR após ${maxAttempts} tentativas. Último erro: ${lastError.trim()}`,
  );
}

export interface PrBodyResolution {
  /** Body efetivamente usado pelo gate. */
  body: string;
  /**
   * Origem do body: `api` = buscado fresco pela API (sempre que der,
   * esta é a fonte correta — reflete o estado ATUAL do PR, não o que tinha
   * quando o evento foi emitido); `env-fallback` = a API falhou após N
   * tentativas e o gate caiu para `PR_BODY` do payload, que pode estar
   * desatualizado (#7140).
   */
  source: "api" | "env-fallback";
}

/**
 * Lógica pura de fallback: tenta buscar o body pela API via `fetcher`; se
 * isso falhar (após as tentativas de retry que o próprio `fetcher` já fez),
 * cai para `envBody` — mas diz isso no log, em vez de silenciosamente usar
 * um body congelado.
 *
 * Testável sem I/O: basta passar um `fetcher` que retorna ou queifica.
 */
export async function resolvePrBody(
  prNumber: string,
  envBody: string,
  fetcher: (prNumber: string) => Promise<string>,
): Promise<PrBodyResolution> {
  try {
    const body = await fetcher(prNumber);
    return { body, source: "api" };
  } catch (e) {
    console.warn(
      `[#7140] não foi possível buscar o body do PR #${prNumber} pela API ` +
        `(${(e as Error).message}). Usando PR_BODY do payload do evento como ` +
        `fallback — pode estar DESATUALIZADO (#7140): um body editado após a ` +
        `emissão do evento não será visto até que o evento seja reemitido ` +
        `(push de commit, ou novo synchronize).`,
    );
    return { body: envBody, source: "env-fallback" };
  }
}
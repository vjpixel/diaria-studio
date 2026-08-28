#!/usr/bin/env -S npx tsx
/**
 * scripts/lib/gh-pr-safe-edit.ts (#6292)
 *
 * `gh pr edit --body`/`--add-label` roda uma mutação GraphQL que consulta
 * `projectCards` (campo DEPRECADO do GitHub) ao montar o request — e falha
 * NESSA consulta, não na edição em si, imprimindo um aviso em stderr sobre
 * `projectCards`/Projects (classic) e saindo com **exit 0** mesmo assim. O
 * corpo/label do PR fica INALTERADO. Medido ao vivo 2× na rodada
 * `/diaria-overnight` 260826: `gh pr edit 6290 --body-file ...` (corpo) e
 * `gh pr edit 6257 --add-label no-regression-test` (label) — os dois
 * reportaram sucesso sem mudar nada (`gh pr view --json body|labels`
 * confirmou o estado pré-chamada intocado nos dois casos).
 *
 * Isto quebra justamente o caminho do #5010 (marcador `Closes`/`REFS` por
 * issue no corpo do PR, guard "antes do merge" da SKILL do overnight): o
 * coordenador detecta um `Closes` superdimensionado, "corrige" via `gh pr
 * edit`, o comando reporta sucesso, e o merge fecha uma issue que não devia
 * fechar — silenciosamente, porque não há nenhum sinal de erro além de uma
 * linha de stderr sobre um campo deprecado que ninguém lê como "sua edição
 * falhou".
 *
 * A escrita funciona normalmente pela API REST (`PATCH /repos/{o}/{r}/pulls/{n}`
 * pro corpo, `POST /repos/{o}/{r}/issues/{n}/labels` pras labels) — é o que
 * este módulo usa, SEMPRE seguido de releitura pós-escrita comparando o
 * valor esperado contra o que o GitHub de fato gravou. Se a releitura não
 * bater, a função falha alto (`ok: false` + `error` explicando o que foi
 * pedido vs. o que foi lido de volta) — nunca reporta sucesso sem confirmar.
 *
 * `gh api repos/{owner}/{repo}/...` aceita os placeholders `{owner}`/`{repo}`
 * literalmente quando rodado dentro do checkout do repo (o `gh` os resolve
 * a partir do remote `origin`) — não precisamos descobrir o slug à mão.
 *
 * Mesmo padrão de dependency injection de `scripts/route-issue.ts`/
 * `scripts/lib/wait-until-sync.ts`/`scripts/lib/alarm-issues.ts`: `ghRun`
 * injetável (default `spawnGhSync`), testável sem `gh`/rede real.
 */
import { spawnGhSync, type GhSpawnResult } from "./shared/gh-run.ts";
import { isMainModule, parseArgs } from "./cli-args.ts";

export type GhRunFn = (args: string[], cwd: string) => GhSpawnResult;

export interface SafeEditResult {
  ok: boolean;
  error?: string;
}

/**
 * Sobrescreve o corpo de um PR via REST + verifica pós-escrita. Nunca usa
 * `gh pr edit` — ver docstring do módulo pro porquê.
 */
export function setPrBodyRest(
  pr: number,
  body: string,
  cwd: string,
  ghRun: GhRunFn = spawnGhSync,
): SafeEditResult {
  const write = ghRun(
    ["api", "-X", "PATCH", `repos/{owner}/{repo}/pulls/${pr}`, "-f", `body=${body}`],
    cwd,
  );
  if (write.status !== 0) {
    return { ok: false, error: `gh api PATCH pulls/${pr} falhou: ${write.stderr.trim() || write.stdout.trim() || "sem saída"}` };
  }

  const verify = ghRun(["pr", "view", String(pr), "--json", "body", "--jq", ".body"], cwd);
  if (verify.status !== 0) {
    return { ok: false, error: `escrita OK mas releitura pós-escrita falhou: ${verify.stderr.trim() || "gh pr view falhou"}` };
  }
  // `gh --jq .body` devolve a string com um `\n` final — normalizar antes de comparar.
  const readBack = verify.stdout.replace(/\n$/, "");
  if (readBack !== body) {
    return {
      ok: false,
      error:
        `PATCH reportou sucesso (exit 0) mas o corpo lido de volta NÃO bate com o esperado — ` +
        `mesmo modo de falha silenciosa que este módulo existe pra evitar (#6292). ` +
        `Esperado ${body.length} chars, lido ${readBack.length} chars.`,
    };
  }
  return { ok: true };
}

/**
 * Aplica labels a um PR via REST (endpoint de labels é compartilhado com
 * issues — PRs SÃO issues na API do GitHub) + verifica pós-escrita. Nunca
 * usa `gh pr edit --add-label` — mesmo modo de falha do corpo, confirmado
 * ao vivo com a label `no-regression-test` no PR #6257 (#6292).
 */
export function addPrLabelsRest(
  pr: number,
  labels: readonly string[],
  cwd: string,
  ghRun: GhRunFn = spawnGhSync,
): SafeEditResult {
  if (labels.length === 0) return { ok: true };

  const args = ["api", "-X", "POST", `repos/{owner}/{repo}/issues/${pr}/labels`];
  for (const label of labels) args.push("-f", `labels[]=${label}`);
  const write = ghRun(args, cwd);
  if (write.status !== 0) {
    return { ok: false, error: `gh api POST issues/${pr}/labels falhou: ${write.stderr.trim() || write.stdout.trim() || "sem saída"}` };
  }

  const verify = ghRun(["pr", "view", String(pr), "--json", "labels", "--jq", ".labels[].name"], cwd);
  if (verify.status !== 0) {
    return { ok: false, error: `escrita OK mas releitura pós-escrita falhou: ${verify.stderr.trim() || "gh pr view falhou"}` };
  }
  const current = new Set(
    verify.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  const missing = labels.filter((l) => !current.has(l));
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `POST reportou sucesso (exit 0) mas ${missing.length} label(s) não apareceram na releitura: ` +
        `${missing.join(", ")} — mesmo modo de falha silenciosa que este módulo existe pra evitar (#6292).`,
    };
  }
  return { ok: true };
}

// ─── CLI ────────────────────────────────────────────────────────────────

function usage(): string {
  return (
    "Uso:\n" +
    "  npx tsx scripts/lib/gh-pr-safe-edit.ts --pr N --body-file arquivo.md\n" +
    "  npx tsx scripts/lib/gh-pr-safe-edit.ts --pr N --add-label a,b,c\n" +
    "Substitui `gh pr edit --body`/`--add-label` (falha em silêncio, #6292) por REST + verificação pós-escrita."
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const { values } = parseArgs(argv);
  const prRaw = values.pr;
  const pr = prRaw ? Number(prRaw) : NaN;
  if (!Number.isInteger(pr) || pr <= 0) {
    console.error(`[gh-pr-safe-edit] --pr é obrigatório e precisa ser um inteiro positivo.\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  const cwd = process.cwd();

  if (values["body-file"]) {
    const { readFileSync } = await import("node:fs");
    const body = readFileSync(values["body-file"], "utf8");
    const result = setPrBodyRest(pr, body, cwd);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (values["add-label"]) {
    const labels = values["add-label"]
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);
    const result = addPrLabelsRest(pr, labels, cwd);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  console.error(`[gh-pr-safe-edit] nada a fazer — passe --body-file ou --add-label.\n\n${usage()}`);
  process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main();
}

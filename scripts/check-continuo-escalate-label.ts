#!/usr/bin/env npx tsx
/**
 * check-continuo-escalate-label.ts (#7446 item 2)
 *
 * CLI wrapper de `scripts/lib/continuo-escalate-owner.ts` — todo I/O
 * (`gh pr view` pra ler labels + REST pra criar/aplicar) fica aqui; a
 * decisão pura fica na lib. Consumido pelo
 * ramo `gate=escalate` de `try_merge_gate()` em
 * `hermes/scripts/continuo-pr-review.sh`: aplica o label
 * `continuo-escalado` (idempotente) e diz ao chamador se esta é a PRIMEIRA
 * vez que a PR escala (pra decidir se notifica no resumo do tick, que o cron
 * do Hermes entrega ao Telegram, ou só conta em silêncio).
 *
 * Uso:
 *   npx tsx scripts/check-continuo-escalate-label.ts --pr 7432 --head <sha>
 *
 * `--head` (#9323) é o SHA que o merge gate JULGOU (`details.currentHeadSha`
 * do JSON de `check-continuo-merge-gate.ts`). É ele que vai no marcador
 * `continuo-escalate: head=<sha>` — nunca uma releitura do head feita aqui,
 * que pode já enxergar um push posterior ao veredito. Sem `--head`, o
 * marcador não é gravado (fail-open na direção do alarme do watcher).
 *
 * Saída: JSON `{"firstTime": boolean, "labelApplied": boolean, "source":
 * "ok" | "error"}` em stdout. `labelApplied` = "o label ESTÁ na PR ao
 * final" (true também quando já estava lá antes desta chamada, #7704) —
 * não "eu apliquei agora"; para isso existe o `firstTime`. `source: "error"` (gh falhou ao ler labels)
 * resolve `firstTime: true` — fail-OPEN em direção a notificar (o pior caso
 * de um falso positivo aqui é 1 notificação a mais, nunca um merge indevido
 * nem uma PR escalada ficando muda para sempre).
 *
 * Exit code sempre 0 exceto uso inválido (`--pr` ausente/não-numérico, 2).
 *
 * @see scripts/lib/continuo-escalate-owner.ts
 * @see hermes/scripts/continuo-pr-review.sh (ramo `1)` de `try_merge_gate()`)
 */

import { execFileSync } from "node:child_process";
import { formatEscalateHeadMarker, isAlreadyEscalated, needsEscalateHeadMarker } from "./lib/continuo-escalate-owner.ts";
import { TRUSTED_AUTHOR_JQ_SELECT } from "./lib/trusted-comment-author.ts";
import { CONTINUO_ESCALATED_LABEL_SPEC, ensureContinuoLabel } from "./lib/continuo-labels.ts";
import { addPrLabelsRest } from "./lib/gh-pr-safe-edit.ts";

const SHA_RE = /^[0-9a-f]{7,40}$/;

function parseArgs(argv: string[]): { pr: string; head: string | null } | null {
  let pr: string | null = null;
  let head: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--pr") pr = argv[++i] ?? null;
    else if (argv[i] === "--head") head = argv[++i] ?? "";
  }
  if (!pr || !/^\d+$/.test(pr)) return null;
  if (head !== null && !SHA_RE.test(head)) return null;
  return { pr, head };
}

/** `null` = `gh` falhou de verdade (rede, auth, PR sumiu) — distinto de "0
 *  labels" (array vazio), que é estado válido, não erro. */
function fetchLabels(pr: string): string[] | null {
  try {
    const out = execFileSync("gh", ["pr", "view", pr, "--json", "labels", "--jq", "[.labels[].name]"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return JSON.parse(out) as string[];
  } catch {
    return null;
  }
}

/**
 * Cria o label (se ausente) e o aplica na PR, ambos por REST.
 *
 * **Nunca `gh label create` + `gh pr edit --add-label` (#7704).** Os dois
 * falhavam e o `catch {}` engolia: o `create` saía 422 porque a descrição
 * passava dos 100 chars do GitHub, e o `--add-label` seguinte saía 1 porque
 * o label não existia — `labelApplied: false` era o ÚNICO sinal, e o bash
 * chamador o ignorava. `addPrLabelsRest` (#6292) ainda cobre o outro modo de
 * falha do `gh pr edit`: exit 0 sem aplicar nada quando a mutação GraphQL
 * bate em `projectCards`.
 *
 * Continua best-effort quanto ao PROCESSO (nunca aborta — a decisão
 * `firstTime` já foi tomada), mas o motivo da falha agora sai em stderr em
 * vez de sumir, pra `continuo-pr-review.sh` registrar como erro de infra.
 */
function applyLabel(pr: string): boolean {
  const cwd = process.cwd();
  const ensured = ensureContinuoLabel(CONTINUO_ESCALATED_LABEL_SPEC, cwd);
  if (!ensured.ok) {
    process.stderr.write(`[check-continuo-escalate-label] ${CONTINUO_ESCALATED_LABEL_SPEC.name}: ${ensured.error}\n`);
    return false;
  }

  const applied = addPrLabelsRest(Number(pr), [CONTINUO_ESCALATED_LABEL_SPEC.name], cwd);
  if (!applied.ok) {
    process.stderr.write(`[check-continuo-escalate-label] PR #${pr}: ${applied.error}\n`);
    return false;
  }
  return true;
}

/**
 * #9184: grava `<!-- continuo-escalate: head=<sha> -->` a cada escalada cujo
 * head ainda não foi marcado (inclusive re-escalada de head novo, que não
 * gera evento `labeled` novo). Best-effort: falha vai pro stderr e o watcher
 * cai no fail-open NA DIREÇÃO DO ALARME (PR sem marcador do head atual conta).
 *
 * #9323: `head` é o SHA que o gate julgou, recebido por `--head`. Reler o
 * `headRefOid` aqui abria uma corrida: gate escala A, push de B, marcador
 * grava B — e o watcher passava a excluir do alarme de fila uma PR cujo
 * head B nunca foi escalado (o ponto cego que o #9156 fechou). Sem `head`,
 * não grava nada: ausência de marcador conta pro alarme.
 */
function markEscalatedHead(pr: string, head: string | null): void {
  if (head === null) {
    process.stderr.write(`[check-continuo-escalate-label] PR #${pr}: --head ausente — marcador de head escalado não gravado\n`);
    return;
  }
  try {
    const bodies = execFileSync(
      "gh",
      // #9632: só marcador de autor com vínculo ao repo conta como "já
      // gravado" — um terceiro (repo público) postando o marcador do head
      // atual não pode impedir que o NOSSO seja gravado.
      ["api", `repos/{owner}/{repo}/issues/${pr}/comments`, "--paginate", "--jq", `.[] | ${TRUSTED_AUTHOR_JQ_SELECT} | .body | @json`],
      { encoding: "utf8", timeout: 60_000 },
    )
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as string);
    if (!needsEscalateHeadMarker(bodies, head)) return;
    execFileSync(
      "gh",
      ["api", "--method", "POST", `repos/{owner}/{repo}/issues/${pr}/comments`, "-f", `body=${formatEscalateHeadMarker(head)}`],
      { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (e) {
    process.stderr.write(`[check-continuo-escalate-label] PR #${pr}: marcador de head escalado não gravado: ${(e as Error).message}\n`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write("uso: check-continuo-escalate-label.ts --pr <N> [--head <sha>]\n");
    process.exitCode = 2;
    return;
  }

  const labels = fetchLabels(args.pr);
  if (labels === null) {
    console.log(JSON.stringify({ firstTime: true, labelApplied: false, source: "error" }));
    return;
  }

  const alreadyEscalated = isAlreadyEscalated(labels);
  /** Semântica de `labelApplied` (#7704): "o label ESTÁ na PR ao final desta
   *  chamada", nunca "eu acabei de aplicá-lo agora". A distinção importa
   *  porque `continuo-pr-review.sh` trata `labelApplied: false` como erro de
   *  infra — e PR que JÁ carrega o label (o estado estacionário de toda PR
   *  escalada a partir do 2º tick) não teve aplicação nenhuma TENTADA, então
   *  reportar `false` ali faria o bash acusar falha a cada tick, para sempre,
   *  com stderr vazio. Quem quer saber se houve escrita nesta chamada lê
   *  `firstTime`. */
  const labelApplied = alreadyEscalated ? true : applyLabel(args.pr);
  markEscalatedHead(args.pr, args.head);
  console.log(JSON.stringify({ firstTime: !alreadyEscalated, labelApplied, source: "ok" }));
}

main();

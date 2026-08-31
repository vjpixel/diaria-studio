/**
 * test/ci-workflow-concurrency-group.test.ts (#6835)
 *
 * Guard de regressão pro achado do #6822/#6835: `.github/workflows/ci.yml`
 * usava um único `concurrency: { group: ci-${{ github.ref }}, cancel-in-
 * progress: true }` pros dois triggers do workflow (`push: [master]` e
 * `pull_request:`). Pra `push`, `github.ref` é sempre a MESMA string
 * (`refs/heads/master`) — qualquer 2 merges mais rápidos que a suíte
 * (~5-9min) cancelavam o run do commit anterior, sem retry. Levantamento
 * retroativo do #6822 mediu 37 merges recentes de `master` cujo job `test`
 * do próprio SHA mergeado nunca completou (`cancelled`) — essa árvore nunca
 * recebeu NENHUM resultado de CI, nem verde nem vermelho.
 *
 * O conserto (#6835) separa os dois regimes: `push` usa grupo único por
 * `github.sha` (nunca colide entre commits, então nunca cancela — todo
 * commit que entra em master merece seu próprio resultado);
 * `pull_request` continua usando grupo por `github.ref` (já único por PR —
 * `refs/pull/N/merge` — e cancelar o run de um push anterior na MESMA PR
 * continua sendo economia legítima, sem perda de sinal).
 *
 * 2 camadas de proteção, como #6711 faz pro `paths-ignore`:
 * 1. Regex sobre o texto bruto do `concurrency:` real em ci.yml — confirma
 *    que a expressão condiciona por `github.event_name`/`push` (não é mais
 *    um grupo/cancel fixo pros dois triggers).
 * 2. `resolveConcurrencyGroup` — espelho PURO da mesma lógica ternária, com
 *    cenários que provam a propriedade que importa: 2 pushes distintos
 *    NUNCA compartilham grupo (não podem se cancelar); 2 pushes do MESMO
 *    ref sempre tiveram essa colisão antes (regressão direta do bug
 *    medido); pull_request preserva o cancelamento legítimo entre 2 pushes
 *    na mesma PR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CI_YML_PATH = resolve(ROOT, ".github", "workflows", "ci.yml");

/** Extrai o bloco `concurrency:` (nível raiz, indentação 0) de ci.yml —
 *  mesmo estilo de parsing por regex de `ci-workflow-paths-ignore.test.ts`
 *  (#6711): evita dependência de parser YAML completo só pra este guard
 *  estreito sobre um formato estável. */
function extractConcurrencyBlock(yamlText: string): string {
  const lines = yamlText.split("\n");
  const startIdx = lines.findIndex((l) => /^concurrency:\s*$/.test(l));
  assert.notEqual(startIdx, -1, "bloco 'concurrency:' não encontrado em ci.yml");
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.match(/^\s*/)![0].length;
    if (indent === 0) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

describe("ci.yml: concurrency separa push (nunca cancela) de pull_request (cancela) (#6835)", () => {
  const yamlText = readFileSync(CI_YML_PATH, "utf8");
  const block = extractConcurrencyBlock(yamlText);

  it("bloco concurrency: existe e tem group + cancel-in-progress", () => {
    assert.match(block, /group:/);
    assert.match(block, /cancel-in-progress:/);
  });

  const groupLine = block.split("\n").find((l) => /^\s*group:/.test(l));

  it("group condiciona por github.event_name (não é mais 'ci-${{ github.ref }}' fixo pros dois triggers)", () => {
    assert.ok(groupLine, "linha group: não encontrada");
    // Regressão direta: essa era literalmente a linha antes do #6835.
    assert.doesNotMatch(
      groupLine!,
      /group:\s*ci-\$\{\{\s*github\.ref\s*\}\}\s*$/,
      "group voltou a ser um valor fixo compartilhado entre push e pull_request — reintroduz o bug do #6822/#6835",
    );
    assert.match(groupLine!, /github\.event_name/, "group deve condicionar por github.event_name");
  });

  it("group usa github.sha no ramo de push (grupo único por commit — nunca colide entre merges distintos)", () => {
    assert.match(groupLine!, /github\.sha/, "group deve referenciar github.sha (ramo push)");
  });

  it("cancel-in-progress condiciona por github.event_name (não é mais 'true' fixo)", () => {
    const cancelLine = block.split("\n").find((l) => /^\s*cancel-in-progress:/.test(l));
    assert.ok(cancelLine, "linha cancel-in-progress: não encontrada");
    assert.doesNotMatch(
      cancelLine!,
      /cancel-in-progress:\s*true\s*$/,
      "cancel-in-progress voltou a ser 'true' fixo — cancela push:master de novo",
    );
    assert.match(cancelLine!, /github\.event_name/);
  });
});

/** Pure (#6835): espelha a resolução do `group`/`cancel-in-progress` do
 *  GitHub Actions pros 2 triggers deste workflow — `push` (branches:
 *  [master]) e `pull_request`. Mesma fórmula do ci.yml:
 *    group: ci-${{ event_name == 'push' && sha || ref }}
 *    cancel-in-progress: ${{ event_name != 'push' }}
 */
export function resolveConcurrencyGroup(
  eventName: "push" | "pull_request",
  ctx: { sha: string; ref: string },
): { group: string; cancelInProgress: boolean } {
  const group = eventName === "push" ? `ci-${ctx.sha}` : `ci-${ctx.ref}`;
  return { group, cancelInProgress: eventName !== "push" };
}

describe("resolveConcurrencyGroup (#6835 — puro, espelha a fórmula real do ci.yml)", () => {
  it("push: cancelInProgress é sempre false", () => {
    const r = resolveConcurrencyGroup("push", { sha: "abc123", ref: "refs/heads/master" });
    assert.equal(r.cancelInProgress, false);
  });

  it("push: 2 commits DISTINTOS produzem grupos DISTINTOS — nunca podem se cancelar (o achado central do #6822/#6835)", () => {
    const r1 = resolveConcurrencyGroup("push", { sha: "sha-do-merge-1", ref: "refs/heads/master" });
    const r2 = resolveConcurrencyGroup("push", { sha: "sha-do-merge-2", ref: "refs/heads/master" });
    assert.notEqual(r1.group, r2.group, "2 merges distintos de master devem cair em grupos diferentes");
  });

  it("push: REGRESSÃO — mesmo ref ('refs/heads/master', sempre igual entre pushes) não é mais suficiente pra colidir", () => {
    // Antes do #6835, o group dependia só de `ref` — que é literalmente o
    // mesmo valor pra QUALQUER push a master, causando a colisão medida.
    // Este teste prova que, com a fórmula atual, o `ref` idêntico sozinho
    // não determina mais o group no caminho de push.
    const sameRef = "refs/heads/master";
    const r1 = resolveConcurrencyGroup("push", { sha: "sha-A", ref: sameRef });
    const r2 = resolveConcurrencyGroup("push", { sha: "sha-B", ref: sameRef });
    assert.notEqual(r1.group, r2.group);
  });

  it("pull_request: cancelInProgress é sempre true", () => {
    const r = resolveConcurrencyGroup("pull_request", { sha: "abc123", ref: "refs/pull/42/merge" });
    assert.equal(r.cancelInProgress, true);
  });

  it("pull_request: 2 pushes NA MESMA PR (mesmo ref, sha diferente por commit) continuam no MESMO grupo — cancelamento legítimo preservado", () => {
    const sameRef = "refs/pull/42/merge";
    const r1 = resolveConcurrencyGroup("pull_request", { sha: "sha-antes-do-push-novo", ref: sameRef });
    const r2 = resolveConcurrencyGroup("pull_request", { sha: "sha-depois-do-push-novo", ref: sameRef });
    assert.equal(r1.group, r2.group, "pull_request agrupa por ref (já único por PR), não por sha — sha não deve afetar o group aqui");
  });

  it("pull_request: 2 PRs diferentes (ref diferente) nunca compartilham grupo", () => {
    const r1 = resolveConcurrencyGroup("pull_request", { sha: "x", ref: "refs/pull/1/merge" });
    const r2 = resolveConcurrencyGroup("pull_request", { sha: "y", ref: "refs/pull/2/merge" });
    assert.notEqual(r1.group, r2.group);
  });
});

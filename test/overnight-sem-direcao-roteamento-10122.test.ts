/**
 * test/overnight-sem-direcao-roteamento-10122.test.ts (#10122)
 *
 * O bullet `sem-direcao-acionavel` (#5968) do passo 4 do `/diaria-overnight`
 * mandava rodar `route-issue --track fora-de-rodada` SEM `--motivo`. Sem
 * motivo, `route-issue` aplica a label default do track — `on-hold`, a de
 * engavetamento deliberado do editor —, que o `/diaria-desbloqueia` exclui
 * do escopo (#7708). Issues que só precisavam de um critério do editor
 * (#9422, #10090-#10093) sumiam de todas as filas.
 *
 * Correção: "sem direção, mas o editor pode dá-la" vira `--track overnight
 * --motivo trade-off` (briefing, #7493); `fora-de-rodada` fica pra quando nem
 * o editor destrava, e sempre com `--motivo sem-direcao`. Este teste cobre
 * (1) o round-trip mecânico de cada rota e (2) um guard de texto no playbook —
 * a mudança é de prompt, então o guard é o que impede o texto antigo de voltar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyRouteLabelPlan, planRouteLabels, type RouteMotivo } from "../scripts/lib/issue-route.ts";
import { classifyExecTrack } from "../scripts/lib/issue-exec-track.ts";
import { classifyDesbloqueioCandidate } from "../scripts/lib/desbloqueia-scan.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const OVERNIGHT = ".claude/skills/diaria-overnight/SKILL.md";
const DESBLOQUEIA = ".claude/skills/diaria-desbloqueia/SKILL.md";

function route(track: "overnight" | "fora-de-rodada", motivo?: RouteMotivo): string[] {
  return [...applyRouteLabelPlan(["bug", "P2"], planRouteLabels(track, motivo))];
}

function desbloqueiaStatus(labels: string[]) {
  return classifyDesbloqueioCandidate({
    number: 1,
    title: "t",
    labels,
    body: "",
    state: "OPEN",
    updatedAt: "2026-10-13T00:00:00Z",
    comments: [],
    dependencyState: null,
    now: new Date("2026-10-13T12:00:00Z"),
  })?.status ?? null;
}

describe("#10122 — rota de sem-direção nunca produz on-hold", () => {
  it("defeito reproduzido: fora-de-rodada sem --motivo aplica on-hold e o desbloqueia exclui", () => {
    const labels = route("fora-de-rodada");
    assert.ok(labels.includes("on-hold"));
    assert.equal(desbloqueiaStatus(labels), null, "on-hold sai do escopo do desbloqueia");
  });

  it("fora-de-rodada --motivo sem-direcao: label sem-direcao-acionavel, nunca on-hold, e vira pergunta", () => {
    const labels = route("fora-de-rodada", "sem-direcao");
    assert.ok(labels.includes("sem-direcao-acionavel"));
    assert.ok(!labels.includes("on-hold"));
    assert.equal(classifyExecTrack({ labels, body: "", state: "OPEN" }), "fora-de-rodada");
    assert.equal(desbloqueiaStatus(labels), "precisa-pergunta");
  });

  it("'editor pode dar a direção' → overnight --motivo trade-off continua overnight (briefing, #7493)", () => {
    const labels = route("overnight", "trade-off");
    assert.ok(labels.includes("trade-off-real"));
    assert.ok(!labels.includes("on-hold"));
    assert.equal(classifyExecTrack({ labels, body: "", state: "OPEN" }), "overnight");
  });
});

describe("#10122 — guard de texto do playbook", () => {
  const overnight = read(OVERNIGHT);

  it("todo comando route-issue --track fora-de-rodada do overnight traz --motivo", () => {
    const cmds = overnight.match(/route-issue\.ts[^`\n]*--track fora-de-rodada[^`\n]*/g) ?? [];
    assert.ok(cmds.length > 0, "esperava ao menos um comando literal");
    for (const c of cmds) assert.match(c, /--motivo /, c);
  });

  it("bullet sem-direcao-acionavel separa o caso 'editor pode dar a direção' (overnight --motivo trade-off)", () => {
    const bullet = overnight.split("\n").find((l) => l.includes("**`sem-direcao-acionavel` (#5968)**"));
    assert.ok(bullet, "bullet do passo 4 sumiu");
    assert.match(bullet!, /--track overnight --motivo trade-off/);
    assert.match(bullet!, /--track fora-de-rodada --motivo sem-direcao/);
    assert.ok(!bullet!.includes('--track fora-de-rodada --reason "sem-direcao-acionavel (#5968)"'), "texto antigo voltou");
  });

  it("desbloqueia: Passo 3 tem pergunta de direção pra sem-direcao-acionavel", () => {
    const d = read(DESBLOQUEIA);
    const passo3 = d.slice(d.indexOf("## Passo 3 —"), d.indexOf("## Passo 3b"));
    assert.match(passo3, /Direção para `sem-direcao-acionavel`/);
    assert.match(passo3, /--motivo sem-direcao/);
  });
});

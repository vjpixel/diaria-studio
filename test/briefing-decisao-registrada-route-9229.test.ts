/**
 * test/briefing-decisao-registrada-route-9229.test.ts (#9229)
 *
 * O passo 5 do `/diaria-overnight` (briefing) aplicava `decisao-registrada`
 * em toda issue decidida e roteava com `route-issue --track overnight` puro.
 * Só que `decisao-registrada` sozinha classifica `fora-de-rodada` em
 * `classifyExecTrack` ("já resolvida, sem código") — o dry-run do #8230
 * recusava o roteamento e a Triagem mostrava como Fora de rodada uma issue
 * que acabara de virar trabalho elegível (#9217, #4469, #8990).
 *
 * Correção: decisão que destrava código roteia `--track overnight --motivo
 * triada` (`triada-overnight` vence `decisao-registrada`, #8230). Este teste
 * cobre (1) o round-trip mecânico do fluxo do briefing e (2) um guard de
 * texto nas skills — a mudança é de prompt, então o guard é o que impede o
 * texto antigo de voltar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyRouteLabelPlan, planRouteLabels } from "../scripts/lib/issue-route.ts";
import { classifyExecTrack } from "../scripts/lib/issue-exec-track.ts";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** Simula o passo 5: roteia e depois aplica `decisao-registrada` (passo b). */
function briefingFlow(initial: string[], motivo?: "triada"): string {
  const routed = applyRouteLabelPlan(initial, planRouteLabels("overnight", motivo));
  const labels = [...new Set([...routed, "decisao-registrada"])];
  return classifyExecTrack({ labels, body: "", state: "OPEN" });
}

describe("#9229 — briefing: decisão que destrava código continua overnight", () => {
  it("defeito reproduzido: --track overnight puro + decisao-registrada → fora-de-rodada", () => {
    assert.equal(briefingFlow(["bug", "P2", "trade-off-real"]), "fora-de-rodada");
  });

  it("com --motivo triada → overnight (família trade-off-real, #7493)", () => {
    assert.equal(briefingFlow(["bug", "P2", "trade-off-real"], "triada"), "overnight");
  });

  it("com --motivo triada → overnight (issue sem label roteável prévia)", () => {
    assert.equal(briefingFlow(["enhancement", "P3"], "triada"), "overnight");
  });

  it("--motivo triada remove trade-off-real (o gate do #7493 continua satisfeito)", () => {
    const routed = applyRouteLabelPlan(["trade-off-real"], planRouteLabels("overnight", "triada"));
    assert.ok(!routed.includes("trade-off-real"));
    assert.ok(routed.includes("triada-overnight"));
  });
});

/** Recorta o passo 5 (Briefing) do overnight até o passo 6. */
function overnightStep5(): string {
  const s = read(".claude/skills/diaria-overnight/SKILL.md");
  const start = s.indexOf("5. **Briefing**");
  assert.ok(start >= 0, "passo 5 (Briefing) não encontrado no SKILL.md do overnight");
  const end = s.indexOf("\n6. **", start);
  assert.ok(end > start, "fim do passo 5 não encontrado");
  return s.slice(start, end);
}

describe("#9229 — guard de texto das skills", () => {
  it("overnight passo 5: todo route-issue --track overnight leva --motivo triada", () => {
    const step = overnightStep5();
    const calls = step.match(/route-issue\.ts[^`]*--track overnight\b[^`]*/g) ?? [];
    assert.ok(calls.length > 0, "nenhum route-issue --track overnight no passo 5");
    for (const c of calls) {
      assert.match(c, /--motivo triada/, `roteamento sem --motivo triada no passo 5: ${c}`);
    }
  });

  it("overnight passo 5: distingue decisão que encerra (fora-de-rodada --motivo decisao)", () => {
    assert.match(overnightStep5(), /--track fora-de-rodada --motivo decisao/);
  });

  for (const skill of ["diaria-continuo", "diaria-develop"]) {
    it(`${skill}: registro de decisão cita --motivo triada junto de decisao-registrada`, () => {
      const s = read(`.claude/skills/${skill}/SKILL.md`);
      // Ancorado na seção de registro da decisão (#5373), não num offset fixo.
      const start = s.indexOf("Registro machine-readable");
      assert.ok(start >= 0, `${skill}: seção 'Registro machine-readable' não encontrada`);
      const idx = s.indexOf("--add-label decisao-registrada", start);
      assert.ok(idx >= 0, `${skill} não aplica decisao-registrada na seção de registro?`);
      const next = s.indexOf("**Registro do bloqueio", idx);
      const window = s.slice(start, next > idx ? next : idx + 1500);
      assert.match(window, /--motivo\s+triada/, `${skill}: falta --motivo triada perto de decisao-registrada`);
    });
  }
});

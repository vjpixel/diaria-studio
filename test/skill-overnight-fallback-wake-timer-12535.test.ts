/**
 * #12535 — o fallback wake do overnight pedia `ScheduleWakeup` (~1200s), que
 * é ferramenta do modo `/loop`: o wake reenvia o prompt e reabriria a skill,
 * e a rodada 261108b o omitiu. O timer válido é `sleep` em `Bash` com
 * `run_in_background: true`, cancelado com `TaskStop`. Trava: nenhum trecho
 * da skill do overnight manda chamar `ScheduleWakeup`; toda menção é para
 * dizer que não é ele.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../.claude/skills/diaria-overnight/SKILL.md", import.meta.url), "utf8");

it("toda menção a ScheduleWakeup na skill do overnight é negativa (#12535)", () => {
  const lines = skill.split("\n").filter((l) => l.includes("ScheduleWakeup"));
  assert.ok(lines.length > 0, "a skill deve explicar por que não usa ScheduleWakeup");
  for (const line of lines) {
    for (const m of line.matchAll(/ScheduleWakeup/g)) {
      const around = line.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 80);
      assert.match(around, /não é|nunca|modo `\/loop`/, `menção não-negativa: ${around}`);
    }
  }
});

it("o bloco (iii) e a regra dura descrevem o timer em background (#12535)", () => {
  const fallback = skill.slice(skill.indexOf("- **(iii) Fallback wake"), skill.indexOf("**Sinal de resume"));
  assert.match(fallback, /`command: "sleep 1200"`/);
  assert.match(fallback, /`run_in_background: true`/);
  assert.match(fallback, /TaskStop/);
  const rule = skill.slice(skill.indexOf("- **Fallback wake é INVARIANTE MECÂNICO"));
  assert.match(rule.split("\n")[0], /`sleep 1200` com `run_in_background: true`/);
});

it("atribuição do commit segue a sessão do subagente, nunca o modelo do coordenador (#12535)", () => {
  const rules = readFileSync(new URL("../context/overnight-dispatch-rules.md", import.meta.url), "utf8");
  const item9 = rules.slice(rules.indexOf("## 9. "), rules.indexOf("## 10. "));
  assert.match(item9, /Atribuição do commit e da PR \(#12535\)/);
  assert.match(item9, /PRÓPRIA sessão/);
  assert.match(item9, /Nunca copiar o modelo\s+do coordenador/);
  const dispatchList = skill.slice(skill.indexOf("O prompt do subagente inclui, obrigatoriamente:"), skill.indexOf("O subagente implementa,"));
  assert.match(dispatchList, /atribuição de commit e PR \(#12535\)/);
});

it("o dispatch da Fase 1 arma o timer em background, não ScheduleWakeup (#12535)", () => {
  const dispatch = skill.slice(skill.indexOf("**Fallback wake determinístico (#2896)"));
  const firstLine = dispatch.split("\n")[0];
  assert.match(firstLine, /`run_in_background: true`/);
  assert.doesNotMatch(firstLine, /chama `ScheduleWakeup`/);
});

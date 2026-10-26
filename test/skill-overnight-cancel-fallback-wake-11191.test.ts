import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const skill = readFileSync(new URL("../.claude/skills/diaria-overnight/SKILL.md", import.meta.url), "utf8");

it("#11191 — Fase 2 cancela o fallback wake antes de encerrar marker e registro", () => {
  const step = skill.slice(skill.indexOf("7. **Encerrar sessão overnight ativa"), skill.indexOf("\n##", skill.indexOf("7. **Encerrar sessão overnight ativa")));
  const cancel = step.indexOf("`ScheduleWakeup` com `stop: true`");
  assert.ok(cancel >= 0, "passo 7 deve cancelar o wake pendente");
  assert.ok(cancel < step.indexOf("overnight-session-marker.ts --end"));
  assert.ok(cancel < step.indexOf("session-registry.ts end --kind overnight"));
});

it("#11191 — bloco Fallback wake documenta cancelamento no encerramento", () => {
  const fallback = skill.slice(skill.indexOf("- **(iii) Fallback wake"), skill.indexOf("**Sinal de resume"));
  assert.match(fallback, /ScheduleWakeup.*stop: true/);
  assert.match(fallback, /Fase 2 passo 7/);
});

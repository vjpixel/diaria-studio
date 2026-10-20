import { test } from "node:test";
import assert from "node:assert/strict";
import { buildArmInstructions } from "../scripts/setup-systemd-timers.ts";

test("#10619 receita de rearme: stop antes do touch, touch antes do start", () => {
  const t = buildArmInstructions();
  const stop = t.indexOf("systemctl --user stop <nome>.timer");
  const touch = t.indexOf("touch ~/.local/share/systemd/timers/stamp-<nome>.timer");
  const start = t.indexOf("systemctl --user start <nome>.timer");
  assert.ok(stop >= 0 && touch > stop && start > touch, "ordem stop < touch < start");
});

test("#10619 não recomenda restart na receita e avisa do touch com timer ativo", () => {
  const t = buildArmInstructions();
  assert.ok(!/systemctl --user restart/.test(t));
  assert.match(t, /touch \+ restart NÃO evita o catch-up/);
});

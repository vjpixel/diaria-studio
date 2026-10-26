import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("#10619 daemon-reload fica entre o touch e o start; unit nova usa enable --now após touch", () => {
  const t = buildArmInstructions();
  const touch = t.indexOf("3. touch ");
  const reload = t.indexOf("4. systemctl --user daemon-reload");
  const start = t.indexOf("5. systemctl --user start");
  assert.ok(touch >= 0 && reload > touch && start > reload, "touch < daemon-reload < start");
  assert.match(t, /Unit NOVA ou desabilitada[\s\S]*enable --now <nome>\.timer[\s\S]*touch ANTES/);
});

test("#10619 geradores/doc não recomendam mais 'touch antes do start' solto", () => {
  for (const f of [
    "scripts/lib/systemd-units.ts",
    "scripts/lib/edicao-systemd-units.ts",
    "scripts/lib/watchdog-systemd-units.ts",
  ]) {
    const s = readFileSync(f, "utf8").replace(/\s*\n\s*\/\/\s*/g, " ");
    assert.match(s, /`stop` → `touch`/, f);
    assert.match(s, /daemon-reload/, f);
    assert.match(s, /#10619/, f);
  }
  assert.ok(!/saída 3/.test(readFileSync("docs/on-hold-vencimento-alarm-setup.md", "utf8")));
});

test("#11058 setup-systemd-timers: --help sai 0 e flag desconhecida sai 2 sem gerar nada", async () => {
  const { main } = await import("../scripts/setup-systemd-timers.ts");
  const log = console.log;
  const err = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    assert.equal(main(["--help"], "/repo/inexistente"), 0);
    assert.equal(main(["--taks", "X"], "/repo/inexistente"), 2);
  } finally {
    console.log = log;
    console.error = err;
  }
});

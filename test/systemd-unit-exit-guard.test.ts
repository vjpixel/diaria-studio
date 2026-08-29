/**
 * #6695: `successExitCodes` declarado em `scripts/lib/scheduled-tasks.ts`
 * só vira comportamento real depois de `setup-systemd-timers.ts` regenerar
 * a unit + o editor copiar pra `~/.config/systemd/user/` na MÁQUINA que
 * roda o timer — uma unit já armada em produção antes dessa mudança fica
 * desatualizada em silêncio. Este teste cobre a lógica PURA de
 * `scripts/lib/systemd-unit-exit-guard.ts` (parse de `SuccessExitStatus=`
 * e resolução de path) sem tocar filesystem real, e um teste de
 * integração leve (`isExitCodeArmedForUnit`) contra um diretório temp que
 * simula `~/.config/systemd/user/`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSuccessExitStatuses,
  isSuccessExitStatusDeclared,
  armedServiceUnitPath,
  systemdUserUnitDir,
  isExitCodeArmedForUnit,
} from "../scripts/lib/systemd-unit-exit-guard.ts";

test("parseSuccessExitStatuses — extrai múltiplos códigos de uma linha SuccessExitStatus=", () => {
  const content = ["[Service]", "Type=oneshot", "SuccessExitStatus=75 3", "ExecStart=/bin/true"].join("\n");
  assert.deepEqual(parseSuccessExitStatuses(content), [75, 3]);
});

test("parseSuccessExitStatuses — sem a chave — retorna array vazio", () => {
  const content = ["[Service]", "Type=oneshot", "ExecStart=/bin/true"].join("\n");
  assert.deepEqual(parseSuccessExitStatuses(content), []);
});

test("parseSuccessExitStatuses — ignora linhas comentadas/indentadas de outra chave", () => {
  const content = ["# SuccessExitStatus=999 (comentário, não conta)", "Description=x"].join("\n");
  assert.deepEqual(parseSuccessExitStatuses(content), []);
});

test("isSuccessExitStatusDeclared — true quando o exit code está na lista declarada", () => {
  const content = "SuccessExitStatus=75";
  assert.equal(isSuccessExitStatusDeclared(content, 75), true);
  assert.equal(isSuccessExitStatusDeclared(content, 3), false);
});

test("armedServiceUnitPath — deriva o path a partir do nome kebab-case da task, dentro de systemdUserUnitDir()", () => {
  const path = armedServiceUnitPath("Diaria-Clarice-Guardrail-Alarm");
  assert.ok(path.startsWith(systemdUserUnitDir()));
  assert.ok(path.endsWith("diaria-clarice-guardrail-alarm.service"));
});

test("isExitCodeArmedForUnit — arquivo de unit ausente (unit nunca armada nesta máquina) — retorna false, nunca lança (#6695)", () => {
  // Nome de task garantidamente inexistente em ~/.config/systemd/user/
  // nesta máquina de teste (CI, worktree isolado nunca tem essa pasta
  // populada) — fail-soft é o caminho normal, não um erro.
  assert.equal(isExitCodeArmedForUnit("Task-Que-Nunca-Existiu-6695", 75), false);
});

test("isExitCodeArmedForUnit — unit presente e SuccessExitStatus confirmado — retorna true (integração com HOME isolado)", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "diaria-systemd-guard-test-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  try {
    // node:os homedir() usa HOME (posix) / USERPROFILE (win32) — setar os
    // dois cobre a plataforma de CI e a máquina Windows do editor.
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    const unitDir = join(fakeHome, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(
      join(unitDir, "diaria-clarice-guardrail-alarm.service"),
      ["[Service]", "Type=oneshot", "SuccessExitStatus=75", "ExecStart=/bin/true"].join("\n"),
      "utf8",
    );
    assert.equal(isExitCodeArmedForUnit("Diaria-Clarice-Guardrail-Alarm", 75), true);
    assert.equal(isExitCodeArmedForUnit("Diaria-Clarice-Guardrail-Alarm", 3), false);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

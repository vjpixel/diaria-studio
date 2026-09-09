/**
 * test/systemd-node-floor-guard.test.ts (#7522)
 *
 * Regressão pra 2 mecanismos:
 *
 * 1) `buildSystemdUnitFiles` (scripts/lib/systemd-units.ts) recusa gerar um
 *    unit quando o node atual (o que seria assado em `ExecStart=` via
 *    `process.execPath`) está abaixo do piso do projeto — falha alto em vez
 *    de emitir um unit nascido quebrado.
 * 2) `scripts/lib/systemd-node-floor-guard.ts` detecta units JÁ ARMADOS em
 *    `~/.config/systemd/user/` apontando pra node abaixo do piso — tri-state
 *    honesto (#7776): nunca "ok" quando não deu pra verificar.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemdUnitFiles } from "../scripts/lib/systemd-units.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import {
  evaluateUnitNodeFloor,
  isNodeBasedServiceUnit,
  scanArmedUnitsNodeFloor,
  type UnitNodeFloorResult,
} from "../scripts/lib/systemd-node-floor-guard.ts";
import { MIN_NODE_MAJOR, MIN_NODE_MINOR } from "../scripts/lib/check-node-version.ts";

const ANY_TASK = getScheduledTaskByName("Diaria-Corrupted-Names-Weekly-Check")!;

// --- 1) Gerador recusa gerar unit com node abaixo do piso -----------------

test("buildSystemdUnitFiles — process.execPath aponta pro node ATUAL rodando o teste (>=piso aqui) — gera normalmente", () => {
  // O ambiente de teste roda sob Node >= 22.5 (guard do CI/CLAUDE.md), então
  // isto documenta o caminho feliz sem precisar mockar process.version.
  assert.doesNotThrow(() => buildSystemdUnitFiles(ANY_TASK, "/repo"));
});

test("buildSystemdUnitFiles — node abaixo do piso NUNCA emite unit, lança alto (#7522)", async (t) => {
  // Mocka process.version temporariamente pra simular o node do sistema
  // (achado ao vivo: /usr/bin/node v20.20.2) — sem executar nenhum binário
  // real, sem tocar filesystem.
  const original = Object.getOwnPropertyDescriptor(process, "version")!;
  Object.defineProperty(process, "version", { value: "v20.20.2", configurable: true });
  t.after(() => Object.defineProperty(process, "version", original));

  assert.throws(
    () => buildSystemdUnitFiles(ANY_TASK, "/repo"),
    /Node v20\.20\.2 detectado.*requer Node >=22\.5\.0/s,
  );
});

// --- 2) evaluateUnitNodeFloor (pura, resolver injetado) --------------------

function fakeResolver(map: Record<string, string | null>) {
  return (path: string) => (path in map ? map[path] : null);
}

test("evaluateUnitNodeFloor — unit com ExecStart=/usr/bin/node abaixo do piso -> below-floor", () => {
  const content = ["[Service]", "ExecStart=/usr/bin/node --import tsx run-task.ts --task X"].join("\n");
  const result = evaluateUnitNodeFloor(
    "diaria-corrupted-names-weekly-check.service",
    content,
    fakeResolver({ "/usr/bin/node": "v20.20.2" }),
  );
  assert.equal(result.verdict, "below-floor");
  assert.match(result.detail!, /20\.20\.2/);
  assert.equal(result.nodePath, "/usr/bin/node");
});

test("evaluateUnitNodeFloor — unit com node >= piso -> ok", () => {
  const content = ["[Service]", "ExecStart=/home/x/.nvm/versions/node/v24.19.0/bin/node --import tsx run-task.ts"].join(
    "\n",
  );
  const result = evaluateUnitNodeFloor(
    "diaria-clarice-sync.service",
    content,
    fakeResolver({ "/home/x/.nvm/versions/node/v24.19.0/bin/node": "v24.19.0" }),
  );
  assert.equal(result.verdict, "ok");
  assert.equal(result.detail, undefined);
});

test(`evaluateUnitNodeFloor — versão exatamente no piso (${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0) -> ok`, () => {
  const content = "ExecStart=/usr/bin/node x";
  const result = evaluateUnitNodeFloor(
    "x.service",
    content,
    fakeResolver({ "/usr/bin/node": `v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0` }),
  );
  assert.equal(result.verdict, "ok");
});

test("evaluateUnitNodeFloor — resolver não consegue determinar a versão -> cannot-verify, NUNCA ok (#7776)", () => {
  const content = "ExecStart=/usr/bin/node x";
  const result = evaluateUnitNodeFloor("x.service", content, () => null);
  assert.equal(result.verdict, "cannot-verify");
  assert.ok(result.detail);
});

test("evaluateUnitNodeFloor — sem ExecStart= reconhecível -> cannot-verify", () => {
  const content = "[Service]\nDescription=sem ExecStart";
  const result = evaluateUnitNodeFloor("x.service", content, () => "v24.0.0");
  assert.equal(result.verdict, "cannot-verify");
  assert.equal(result.nodePath, null);
});

test("evaluateUnitNodeFloor — versão em formato inesperado -> cannot-verify (nunca ok por fail-soft)", () => {
  const content = "ExecStart=/usr/bin/node x";
  const result = evaluateUnitNodeFloor("x.service", content, () => "not-a-version");
  assert.equal(result.verdict, "cannot-verify");
});

// --- isNodeBasedServiceUnit -------------------------------------------------

test("isNodeBasedServiceUnit — true quando o binário se chama node, qualquer path", () => {
  assert.equal(isNodeBasedServiceUnit("ExecStart=/usr/bin/node --version"), true);
  assert.equal(isNodeBasedServiceUnit("ExecStart=/home/x/.nvm/versions/node/v24.19.0/bin/node x"), true);
});

test("isNodeBasedServiceUnit — false quando o binário não é node (fora de escopo, não é finding)", () => {
  assert.equal(isNodeBasedServiceUnit("ExecStart=/bin/bash -c 'echo x'"), false);
  assert.equal(isNodeBasedServiceUnit("Description=sem ExecStart"), false);
});

// --- 3) scanArmedUnitsNodeFloor — integração com diretório temp -----------

test("scanArmedUnitsNodeFloor — diretório ausente/ilegível -> cannot-verify (nunca ok, #7776)", () => {
  const missingDir = join(tmpdir(), "nao-existe-" + Math.random().toString(36).slice(2));
  const report = scanArmedUnitsNodeFloor(missingDir, () => "v24.0.0");
  assert.equal(report.verdict, "cannot-verify");
  assert.deepEqual(report.units, []);
  assert.ok(report.detail);
});

test("scanArmedUnitsNodeFloor — fixture com 1 unit /usr/bin/node abaixo do piso + 1 unit ok + 1 unit não-node -> below-floor agregado", () => {
  const dir = mkdtempSync(join(tmpdir(), "systemd-node-floor-"));
  try {
    writeFileSync(
      join(dir, "diaria-corrupted-names-weekly-check.service"),
      ["[Service]", "ExecStart=/usr/bin/node --import tsx run-task.ts --task X"].join("\n"),
    );
    writeFileSync(
      join(dir, "diaria-clarice-sync.service"),
      ["[Service]", "ExecStart=/home/x/.nvm/versions/node/v24.19.0/bin/node --import tsx run-task.ts --task Y"].join(
        "\n",
      ),
    );
    writeFileSync(
      join(dir, "diaria-studio-tunnel.service"),
      ["[Service]", "ExecStart=/usr/bin/cloudflared tunnel run"].join("\n"),
    );
    writeFileSync(join(dir, "not-a-service.timer"), "[Timer]\nOnCalendar=daily\n");

    const resolver = (path: string): string | null => {
      if (path === "/usr/bin/node") return "v20.20.2";
      if (path === "/home/x/.nvm/versions/node/v24.19.0/bin/node") return "v24.19.0";
      return null;
    };
    const report = scanArmedUnitsNodeFloor(dir, resolver);

    assert.equal(report.verdict, "below-floor");
    // .timer ignorado, unit não-node ignorado — só os 2 .service node-based aparecem
    assert.equal(report.units.length, 2);
    const byName = Object.fromEntries(report.units.map((u: UnitNodeFloorResult) => [u.unitFileName, u]));
    assert.equal(byName["diaria-corrupted-names-weekly-check.service"].verdict, "below-floor");
    assert.equal(byName["diaria-clarice-sync.service"].verdict, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanArmedUnitsNodeFloor — todas as units node-based ok, nenhuma abaixo do piso -> ok agregado", () => {
  const dir = mkdtempSync(join(tmpdir(), "systemd-node-floor-ok-"));
  try {
    writeFileSync(
      join(dir, "diaria-clarice-sync.service"),
      ["[Service]", "ExecStart=/home/x/.nvm/versions/node/v24.19.0/bin/node --import tsx run-task.ts"].join("\n"),
    );
    const report = scanArmedUnitsNodeFloor(dir, () => "v24.19.0");
    assert.equal(report.verdict, "ok");
    assert.equal(report.units.length, 1);
    assert.equal(report.units[0].verdict, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanArmedUnitsNodeFloor — arquivo *.service ilegível (readFileSync lança) -> cannot-verify agregado, sem mascarar em below-floor/ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "systemd-node-floor-unreadable-"));
  try {
    // Trick portátil (sem depender de chmod/permissão do runner): um
    // DIRETÓRIO chamado "*.service" faz readFileSync lançar EISDIR — mesma
    // classe de "não deu pra ler o arquivo" que uma permissão negada
    // produziria, sem depender de rodar como não-root.
    mkdirSync(join(dir, "diaria-broken.service"));
    const report = scanArmedUnitsNodeFloor(dir, () => "v24.0.0");
    assert.equal(report.verdict, "cannot-verify");
    assert.equal(report.units.length, 1);
    assert.equal(report.units[0].verdict, "cannot-verify");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanArmedUnitsNodeFloor — unit .service sem ExecStart=node (ex: cloudflared) é IGNORADA, não vira finding", () => {
  const dir = mkdtempSync(join(tmpdir(), "systemd-node-floor-nonnode-"));
  try {
    writeFileSync(join(dir, "diaria-studio-tunnel.service"), "[Service]\nExecStart=/usr/bin/cloudflared tunnel run\n");
    const report = scanArmedUnitsNodeFloor(dir, () => "v24.0.0");
    assert.equal(report.verdict, "ok");
    assert.deepEqual(report.units, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

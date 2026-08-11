/**
 * test/pending-scheduled-tasks.test.ts (#4708 Parte 1)
 *
 * Cobertura de `scripts/lib/pending-scheduled-tasks.ts`: o parser do
 * `$TaskName` (ponto frágil explícito da issue — precisa falhar RUIDOSAMENTE,
 * nunca silenciar num diff vazio), o diff puro, a seção markdown, e a
 * orquestração fail-soft (`checkPendingScheduledTasks`) com fixtures em
 * tmpdir (mesmo padrão de `test/studio-reports.test.ts`).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseTaskNameFromSetupScript,
  parseTaskNamesFromSetupScript,
  listExpectedScheduledTasks,
  computePendingScheduledTasksDiff,
  buildPendingScheduledTasksSection,
  queryRegisteredTaskNames,
  checkPendingScheduledTasks,
  type SetupScriptTaskName,
} from "../scripts/lib/pending-scheduled-tasks.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let root: string | null = null;
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
    root = null;
  }
});

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), "pending-scheduled-tasks-"));
  return root;
}

describe("parseTaskNameFromSetupScript — ponto frágil (#4708): lança, nunca retorna null silenciosamente", () => {
  it("extrai o nome de um $TaskName = \"...\" simples", () => {
    const source = `$TaskName = "Diaria-Apoios-Diff-Alarm"\n$Foo = "bar"\n`;
    assert.equal(parseTaskNameFromSetupScript(source, "fixture.ps1"), "Diaria-Apoios-Diff-Alarm");
  });

  it("tolera espaçamento extra ao redor do = (ex: $TaskName   = \"...\")", () => {
    const source = `$TaskName   = "Diaria-Edicao-Diaria"\n`;
    assert.equal(parseTaskNameFromSetupScript(source, "fixture.ps1"), "Diaria-Edicao-Diaria");
  });

  it("pega a PRIMEIRA declaração quando há mais de uma linha candidata", () => {
    const source = `# comentario\n$TaskName = "Diaria-Primeira"\n$Outro = "Diaria-Segunda"\n`;
    assert.equal(parseTaskNameFromSetupScript(source, "fixture.ps1"), "Diaria-Primeira");
  });

  it("PoC exato do risco da issue: source SEM o padrão esperado -> LANÇA (não retorna null)", () => {
    const source = `# script sem $TaskName nenhum\nWrite-Output "oi"\n`;
    assert.throws(
      () => parseTaskNameFromSetupScript(source, "scripts/setup-quebrado-schedule.ps1"),
      /não encontrei/,
    );
  });

  it("mensagem de erro cita o path do arquivo (facilita triagem)", () => {
    try {
      parseTaskNameFromSetupScript("sem padrao aqui", "scripts/setup-x-schedule.ps1");
      assert.fail("esperava lançar");
    } catch (e) {
      assert.match((e as Error).message, /scripts\/setup-x-schedule\.ps1/);
    }
  });

  it("aspas simples NÃO batem o padrão (só aspas duplas são suportadas) -> lança, não engole em silêncio", () => {
    const source = `$TaskName = 'Diaria-Aspas-Simples'\n`;
    assert.throws(() => parseTaskNameFromSetupScript(source, "fixture.ps1"));
  });
});

describe("parseTaskNamesFromSetupScript — script de setup que registra MAIS DE UMA task (260811)", () => {
  it("script de task única -> lista de 1 (mesmo comportamento de sempre)", () => {
    const source = `$TaskName = "Diaria-Apoios-Diff-Alarm"\n`;
    assert.deepEqual(parseTaskNamesFromSetupScript(source, "fixture.ps1"), ["Diaria-Apoios-Diff-Alarm"]);
  });

  it("par 19:00 + 05:00 ($TaskName + $GuardTaskName) -> os DOIS nomes, na ordem do source", () => {
    const source = [
      `$TaskName      = "Diaria-Clarice-Envio"`,
      `$TaskDesc      = "diar.ia.br: planeja e agenda a onda Clarice"`,
      `$GuardTaskName = "Diaria-Clarice-Envio-Guard"`,
      `$GuardTaskDesc = "diar.ia.br: guard matinal"`,
      ``,
    ].join("\n");
    assert.deepEqual(parseTaskNamesFromSetupScript(source, "fixture.ps1"), [
      "Diaria-Clarice-Envio",
      "Diaria-Clarice-Envio-Guard",
    ]);
  });

  it("PoC do risco: a task-guard ficaria INVISÍVEL se o parser lesse só a primeira", () => {
    const source = `$TaskName = "Diaria-Clarice-Envio"\n$GuardTaskName = "Diaria-Clarice-Envio-Guard"\n`;
    // parseTaskNameFromSetupScript (singular) segue existindo e devolvendo a
    // primeira — por isso ela NÃO deve ser usada no caminho de descoberta.
    assert.equal(parseTaskNameFromSetupScript(source, "fixture.ps1"), "Diaria-Clarice-Envio");
    assert.ok(parseTaskNamesFromSetupScript(source, "fixture.ps1").includes("Diaria-Clarice-Envio-Guard"));
  });

  it("nenhum nome encontrado -> LANÇA (nunca [] silencioso)", () => {
    assert.throws(
      () => parseTaskNamesFromSetupScript(`Write-Output "oi"\n`, "scripts/setup-quebrado-schedule.ps1"),
      /não encontrei/,
    );
  });

  it("variável parecida mas que não termina em TaskName é ignorada (ex: $TaskDesc)", () => {
    const source = `$TaskDesc = "Diaria-Nao-Sou-Nome"\n$TaskName = "Diaria-Sou"\n`;
    assert.deepEqual(parseTaskNamesFromSetupScript(source, "fixture.ps1"), ["Diaria-Sou"]);
  });
});

describe("listExpectedScheduledTasks — varredura real do repo", () => {
  it("todo setup-*-schedule.ps1 REAL sob scripts/ (recursivo) tem um $TaskName parseável — trava a regressão descrita na issue", () => {
    // Roda contra o repo de verdade (não fixture) — se um script novo
    // introduzir uma convenção diferente e o parser não acompanhar, este
    // teste quebra ANTES de qualquer sessão futura descobrir isso por um
    // relatório silenciosamente vazio.
    assert.doesNotThrow(() => {
      const tasks = listExpectedScheduledTasks(REPO_ROOT);
      assert.ok(tasks.length > 0, "esperava ao menos 1 setup-*-schedule.ps1 sob scripts/");
    });
  });

  it("sanity: a varredura recursiva cobre exatamente os mesmos scripts que um scan manual de scripts/**/setup-*-schedule.ps1", () => {
    function scan(dir: string): string[] {
      const out: string[] = [];
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...scan(full));
        else if (/^setup-.*-schedule\.ps1$/i.test(name)) out.push(full);
      }
      return out;
    }
    const manual = scan(join(REPO_ROOT, "scripts"))
      .map((f) => f.slice(REPO_ROOT.length + 1).split("\\").join("/"))
      .sort();
    // Comparação por CONJUNTO DE SCRIPTS, não por contagem de tasks: desde
    // 260811 um mesmo setup-*.ps1 pode declarar mais de uma task
    // (setup-clarice-envio-schedule.ps1 registra o par 19:00 + 05:00), então
    // `viaLib.length === manual.length` deixou de ser a expressão correta de
    // "a varredura não perdeu nem inventou script".
    const viaLib = [...new Set(listExpectedScheduledTasks(REPO_ROOT).map((t) => t.scriptPath))].sort();
    assert.deepEqual(viaLib, manual);
  });

  it("um script de setup que declara N tasks produz N entradas (nenhuma some do diff)", () => {
    const r = makeRoot();
    mkdirSync(join(r, "scripts"), { recursive: true });
    writeFileSync(
      join(r, "scripts", "setup-par-schedule.ps1"),
      `$TaskName = "Diaria-Par-Um"\n$GuardTaskName = "Diaria-Par-Dois"\n`,
    );
    // `listExpectedScheduledTasks` ordena por taskName (output determinístico),
    // não pela ordem de declaração no .ps1 — daí "Dois" antes de "Um".
    const tasks = listExpectedScheduledTasks(r);
    assert.deepEqual(
      tasks.map((t) => t.taskName),
      ["Diaria-Par-Dois", "Diaria-Par-Um"],
    );
    // as duas apontam pro MESMO script de setup — é assim que o relatório de
    // pendências diz ao editor qual comando rodar pra armar a que faltou
    assert.deepEqual(
      [...new Set(tasks.map((t) => t.scriptPath))],
      ["scripts/setup-par-schedule.ps1"],
    );
  });

  it("resultado é ordenado por taskName (output determinístico)", () => {
    const r = makeRoot();
    mkdirSync(join(r, "scripts"), { recursive: true });
    writeFileSync(join(r, "scripts", "setup-zzz-schedule.ps1"), `$TaskName = "Diaria-ZZZ"\n`);
    writeFileSync(join(r, "scripts", "setup-aaa-schedule.ps1"), `$TaskName = "Diaria-AAA"\n`);
    const tasks = listExpectedScheduledTasks(r);
    assert.deepEqual(
      tasks.map((t) => t.taskName),
      ["Diaria-AAA", "Diaria-ZZZ"],
    );
  });

  it("varre recursivamente subdiretórios (ex: scripts/overnight/)", () => {
    const r = makeRoot();
    mkdirSync(join(r, "scripts", "overnight"), { recursive: true });
    writeFileSync(join(r, "scripts", "overnight", "setup-watchdog-schedule.ps1"), `$TaskName = "Diaria-Overnight-Watchdog"\n`);
    const tasks = listExpectedScheduledTasks(r);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].taskName, "Diaria-Overnight-Watchdog");
    assert.equal(tasks[0].scriptPath, "scripts/overnight/setup-watchdog-schedule.ps1");
  });

  it("ignora .ps1 que não bate o padrão de nome setup-*-schedule.ps1 (ex: um runner)", () => {
    const r = makeRoot();
    mkdirSync(join(r, "scripts"), { recursive: true });
    writeFileSync(join(r, "scripts", "run-apoios-diff-alarm.ps1"), `Write-Output "roda a task"\n`);
    const tasks = listExpectedScheduledTasks(r);
    assert.deepEqual(tasks, []);
  });

  it("um script SEM $TaskName parseável propaga a exceção (fail LOUD, não filtra silenciosamente)", () => {
    const r = makeRoot();
    mkdirSync(join(r, "scripts"), { recursive: true });
    writeFileSync(join(r, "scripts", "setup-bom-schedule.ps1"), `$TaskName = "Diaria-Bom"\n`);
    writeFileSync(join(r, "scripts", "setup-quebrado-schedule.ps1"), `Write-Output "sem TaskName aqui"\n`);
    assert.throws(() => listExpectedScheduledTasks(r), /não encontrei/);
  });

  it("scripts/ ausente -> lista vazia (não lança)", () => {
    const r = makeRoot();
    assert.deepEqual(listExpectedScheduledTasks(r), []);
  });
});

describe("computePendingScheduledTasksDiff (puro)", () => {
  const expected: SetupScriptTaskName[] = [
    { scriptPath: "scripts/setup-a-schedule.ps1", taskName: "Diaria-A" },
    { scriptPath: "scripts/setup-b-schedule.ps1", taskName: "Diaria-B" },
    { scriptPath: "scripts/setup-c-schedule.ps1", taskName: "Diaria-C" },
  ];

  it("todas registradas -> diff vazio", () => {
    assert.deepEqual(computePendingScheduledTasksDiff(expected, ["Diaria-A", "Diaria-B", "Diaria-C"]), []);
  });

  it("PoC do padrão medido na issue: 3 esperadas, 0 registradas -> 3 pendências", () => {
    const diff = computePendingScheduledTasksDiff(expected, []);
    assert.equal(diff.length, 3);
    assert.deepEqual(diff.map((d) => d.taskName), ["Diaria-A", "Diaria-B", "Diaria-C"]);
  });

  it("registro parcial -> só as ausentes entram no diff", () => {
    const diff = computePendingScheduledTasksDiff(expected, ["Diaria-B"]);
    assert.deepEqual(diff.map((d) => d.taskName), ["Diaria-A", "Diaria-C"]);
  });

  it("comparação é case-insensitive (Task Scheduler do Windows não é case-sensitive)", () => {
    const diff = computePendingScheduledTasksDiff(expected, ["diaria-a", "DIARIA-B", "Diaria-C"]);
    assert.deepEqual(diff, []);
  });

  it("tasks registradas extras (não esperadas por nenhum script) não afetam o diff", () => {
    const diff = computePendingScheduledTasksDiff(expected, [
      "Diaria-A",
      "Diaria-B",
      "Diaria-C",
      "Diaria-Overnight-Watchdog",
    ]);
    assert.deepEqual(diff, []);
  });
});

describe("buildPendingScheduledTasksSection", () => {
  it("diff vazio -> null (não polui rodada limpa, #4708)", () => {
    assert.equal(buildPendingScheduledTasksSection([]), null);
  });

  it("1 pendência -> seção markdown com singular", () => {
    const section = buildPendingScheduledTasksSection([
      { scriptPath: "scripts/setup-apoios-diff-alarm-schedule.ps1", taskName: "Diaria-Apoios-Diff-Alarm" },
    ]);
    assert.ok(section);
    assert.match(section!, /## Tasks pendentes de registro \(#4708\)/);
    assert.match(section!, /1 task declarada/);
    assert.match(section!, /`Diaria-Apoios-Diff-Alarm`/);
    assert.match(section!, /`scripts\/setup-apoios-diff-alarm-schedule\.ps1`/);
  });

  it("N pendências -> plural + 1 linha por task", () => {
    const section = buildPendingScheduledTasksSection([
      { scriptPath: "scripts/setup-a-schedule.ps1", taskName: "Diaria-A" },
      { scriptPath: "scripts/setup-b-schedule.ps1", taskName: "Diaria-B" },
    ]);
    assert.ok(section);
    assert.match(section!, /2 tasks declaradas/);
    assert.match(section!, /`Diaria-A`/);
    assert.match(section!, /`Diaria-B`/);
  });
});

describe("queryRegisteredTaskNames — I/O injetável", () => {
  it("exec mockado retornando lista -> parseia linhas, remove vazias/espaços", () => {
    const fakeExec = (() => "Diaria-A\r\nDiaria-B\r\n\r\n  Diaria-C  \r\n") as unknown as typeof import("node:child_process").execFileSync;
    const names = queryRegisteredTaskNames(fakeExec);
    assert.deepEqual(names, ["Diaria-A", "Diaria-B", "Diaria-C"]);
  });

  it("exec mockado sem nenhuma task -> []", () => {
    const fakeExec = (() => "") as unknown as typeof import("node:child_process").execFileSync;
    assert.deepEqual(queryRegisteredTaskNames(fakeExec), []);
  });

  it("exec mockado que lança (PowerShell indisponível) -> null, nunca lança", () => {
    const fakeExec = (() => {
      throw new Error("ENOENT: powershell não encontrado");
    }) as unknown as typeof import("node:child_process").execFileSync;
    assert.equal(queryRegisteredTaskNames(fakeExec), null);
  });
});

describe("checkPendingScheduledTasks — orquestração fail-soft", () => {
  it("modo cloud -> no-op (pending: null, section: null), nunca chama Task Scheduler", () => {
    const r = makeRoot(); // sem data/ -> exec-mode detecta cloud
    const result = checkPendingScheduledTasks(r);
    assert.equal(result.mode, "cloud");
    assert.equal(result.pending, null);
    assert.equal(result.section, null);
  });

  it("modo local, scripts/ sem setup-schedule.ps1 nenhum -> pending: [] (checagem OK, 0 esperadas)", () => {
    const r = makeRoot();
    mkdirSync(join(r, "data"), { recursive: true }); // sinaliza modo local
    mkdirSync(join(r, "scripts"), { recursive: true });
    const result = checkPendingScheduledTasks(r);
    assert.equal(result.mode, "local");
    // sem PowerShell real disponível neste ambiente de teste, a consulta ao
    // Task Scheduler pode falhar (pending: null) OU suceder retornando [];
    // o que importa aqui é que NUNCA lança e nunca finge pendência.
    assert.ok(result.pending === null || Array.isArray(result.pending));
    if (Array.isArray(result.pending)) {
      assert.deepEqual(result.pending, []);
      assert.equal(result.section, null);
    }
  });

  it("modo local, script de setup com $TaskName QUEBRADO -> pending: null (fail-soft, nunca lança, nunca finge 0 pendências)", () => {
    const r = makeRoot();
    mkdirSync(join(r, "data"), { recursive: true });
    mkdirSync(join(r, "scripts"), { recursive: true });
    writeFileSync(join(r, "scripts", "setup-quebrado-schedule.ps1"), `Write-Output "sem TaskName"\n`);
    assert.doesNotThrow(() => {
      const result = checkPendingScheduledTasks(r);
      assert.equal(result.mode, "local");
      assert.equal(result.pending, null);
      assert.equal(result.section, null);
    });
  });
});

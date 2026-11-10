/**
 * #12503 — `--help` ou flag desconhecida caíam no modo REAL (e-mail ao editor
 * + issues do alarme) nos scripts de alarme. A #12476 corrigiu só o
 * `check-metrics-health.ts`; aqui a regra virou `resolveCliAction` em
 * `scripts/lib/cli-args.ts` e os alarmes passam por ela antes de qualquer I/O.
 *
 * Três camadas:
 *   1. o helper puro (`resolveCliAction` / `applyCliAction`);
 *   2. catraca: script com `alarm-issues`/`notifyEditorForOutcomes` precisa
 *      validar o argv (helper ou `findUnknownFlags`), salvo os da allowlist
 *      de pendentes, que só pode encolher;
 *   3. o `CLI_SPEC` de cada script migrado cobre toda flag que o script lê e
 *      os `args` com que o registry de tasks agendadas o chama — senão a
 *      migração quebraria o alarme em produção com "flag desconhecida".
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { applyCliAction, formatCliUsage, resolveCliAction, type CliSpec } from "../scripts/lib/cli-args.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";

const ROOT = join(import.meta.dirname, "..");
const SCRIPTS = join(ROOT, "scripts");

const SPEC: CliSpec = {
  script: "scripts/exemplo-alarm.ts",
  booleans: ["dry-run"],
  values: ["to", "threshold-hours"],
  numeric: ["threshold-hours"],
};

describe("resolveCliAction (#12503)", () => {
  test("--help/-h → help, inclusive junto com --dry-run", () => {
    assert.deepEqual(resolveCliAction(["--help"], SPEC), { kind: "help" });
    assert.deepEqual(resolveCliAction(["-h"], SPEC), { kind: "help" });
    assert.deepEqual(resolveCliAction(["--dry-run", "--help"], SPEC), { kind: "help" });
  });

  test("flag desconhecida → error, e vence o help", () => {
    for (const argv of [["--bogus"], ["--dryrun"], ["--dry_run"], ["--bogus", "--help"], ["-x"]]) {
      const r = resolveCliAction(argv, SPEC);
      assert.equal(r.kind, "error", argv.join(" "));
    }
  });

  test("argumento posicional solto → error", () => {
    assert.equal(resolveCliAction(["dry-run"], SPEC).kind, "error");
  });

  test("booleana com valor → error (senão --dry-run foo vira modo real)", () => {
    const r = resolveCliAction(["--dry-run", "foo"], SPEC);
    assert.equal(r.kind, "error");
    assert.match((r as { message: string }).message, /--dry-run não aceita valor/);
    assert.equal(resolveCliAction(["--dry-run=1"], SPEC).kind, "error");
  });

  test("flag de valor sem valor, vazia ou com cara de flag → error", () => {
    for (const argv of [["--to"], ["--to", "--dry-run"], ["--to="], ["--to", "-h"]]) {
      assert.equal(resolveCliAction(argv, SPEC).kind, "error", argv.join(" "));
    }
  });

  test("numeric: não-numérico ou negativo → error; válido → run", () => {
    assert.equal(resolveCliAction(["--threshold-hours", "abc"], SPEC).kind, "error");
    assert.equal(resolveCliAction(["--threshold-hours", "-5"], SPEC).kind, "error");
    assert.deepEqual(resolveCliAction(["--threshold-hours", "12"], SPEC), { kind: "run" });
  });

  test("argv válido → run", () => {
    assert.deepEqual(resolveCliAction([], SPEC), { kind: "run" });
    assert.deepEqual(resolveCliAction(["--dry-run"], SPEC), { kind: "run" });
    assert.deepEqual(resolveCliAction(["--dry-run", "--to", "a@b.c"], SPEC), { kind: "run" });
    assert.deepEqual(resolveCliAction(["--to=a@b.c"], SPEC), { kind: "run" });
  });

  test("spec sem flags: só --help é aceito", () => {
    const vazio: CliSpec = { script: "scripts/x.ts" };
    assert.deepEqual(resolveCliAction([], vazio), { kind: "run" });
    assert.deepEqual(resolveCliAction(["--help"], vazio), { kind: "help" });
    assert.equal(resolveCliAction(["--dry-run"], vazio).kind, "error");
  });
});

describe("applyCliAction (#12503)", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  }

  test("help imprime o uso em stdout e devolve 0", () => {
    const c = capture();
    assert.equal(applyCliAction(["--help"], SPEC, c.io), 0);
    assert.equal(c.out.length, 1);
    assert.match(c.out[0], /uso: npx tsx scripts\/exemplo-alarm\.ts/);
    assert.match(c.out[0], /--dry-run/);
    assert.deepEqual(c.err, []);
  });

  test("error vai pro stderr com o uso e devolve 1", () => {
    const c = capture();
    assert.equal(applyCliAction(["--bogus"], SPEC, c.io), 1);
    assert.match(c.err.join("\n"), /--bogus/);
    assert.match(c.err.join("\n"), /uso:/);
    assert.deepEqual(c.out, []);
  });

  test("run devolve null sem imprimir nada", () => {
    const c = capture();
    assert.equal(applyCliAction(["--dry-run"], SPEC, c.io), null);
    assert.deepEqual([...c.out, ...c.err], []);
  });

  test("formatCliUsage respeita usage próprio", () => {
    assert.equal(formatCliUsage({ ...SPEC, usage: "uso: custom" }), "uso: custom");
  });
});

// ---------------------------------------------------------------------------
// Catraca e cobertura dos scripts reais
// ---------------------------------------------------------------------------

/**
 * Scripts de alarme ainda SEM validação de argv. Só pode encolher: ao migrar
 * um, tire daqui. A #12528 migrou os 12 que sobravam da #12503 e esvaziou a
 * lista; script de alarme novo já nasce validando o argv.
 */
const PENDENTES = new Set<string>([]);

/**
 * Casam o regex de `alarmScripts()` só por citar `alarm-issues` num
 * COMENTÁRIO: não importam o módulo de alarme nem chamam
 * `notifyEditorForOutcomes`. O teste "NAO_ALARMES" trava isso: se um deles
 * virar alarme de verdade, sai daqui e passa a validar o argv.
 *   - `run-tests.ts`: o runner da suíte (`npm test`). O argv é repassado ao
 *     `node --test` (`--test-name-pattern`, `--test-reporter`...), e uma lista
 *     fechada de flags quebraria o runner (#12528).
 */
const NAO_ALARMES = new Set(["run-tests.ts"]);

/** Importa o módulo de alarme ou chama o portão de e-mail: código, não comentário. */
function isRealAlarm(src: string): boolean {
  return /from\s+["']\.\/lib\/alarm-issues(\.ts)?["']|\bnotifyEditorForOutcomes\(/.test(src);
}

function alarmScripts(): { file: string; src: string }[] {
  return readdirSync(SCRIPTS)
    .filter((f) => f.endsWith(".ts"))
    .map((file) => ({ file, src: readFileSync(join(SCRIPTS, file), "utf8") }))
    .filter(({ src }) => /alarm-issues|notifyEditorForOutcomes/.test(src));
}

function validatesArgv(src: string): boolean {
  return /\b(applyCliAction|resolveCliAction|findUnknownFlags)\(/.test(src);
}

/** Lê `booleans`/`values` do literal `CLI_SPEC` no fonte (sem importar o script). */
function readSpec(src: string): { booleans: string[]; values: string[] } | null {
  const block = /export const CLI_SPEC: CliSpec = \{([\s\S]*?)\n\};/.exec(src);
  if (!block) return null;
  const list = (key: string): string[] => {
    const m = new RegExp(`${key}: \\[([^\\]]*)\\]`).exec(block[1]);
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
  };
  return { booleans: list("booleans"), values: list("values") };
}

function flagsRead(src: string): Set<string> {
  const re = /\b(hasFlag|getArg|getIntArg|getStringArg)\(\s*[\w.()]+\s*,\s*"([^"]+)"/g;
  return new Set([...src.matchAll(re)].map((m) => m[2]));
}

describe("scripts de alarme validam o argv (#12503)", () => {
  const scripts = alarmScripts();

  test("todo alarme fora da allowlist valida o argv antes do I/O", () => {
    const faltando = scripts
      .filter(({ file, src }) => !PENDENTES.has(file) && !NAO_ALARMES.has(file) && !validatesArgv(src))
      .map((s) => s.file);
    assert.deepEqual(faltando, [], `alarmes sem validação de argv: ${faltando.join(", ")} — use applyCliAction (scripts/lib/cli-args.ts)`);
  });

  test("NAO_ALARMES: casam o regex só por comentário, sem importar alarm-issues (#12528)", () => {
    const byFile = new Map(scripts.map((s) => [s.file, s.src]));
    for (const file of NAO_ALARMES) {
      const src = byFile.get(file);
      assert.ok(src !== undefined, `${file} não casa mais o regex de alarme — tire de NAO_ALARMES`);
      assert.ok(!isRealAlarm(src), `${file} virou alarme de verdade — tire de NAO_ALARMES e valide o argv`);
      assert.ok(!PENDENTES.has(file), `${file} está em PENDENTES e em NAO_ALARMES`);
    }
  });

  test("allowlist só encolhe: pendente que já valida o argv sai da lista", () => {
    const byFile = new Map(scripts.map((s) => [s.file, s.src]));
    for (const file of PENDENTES) {
      const src = byFile.get(file);
      assert.ok(src !== undefined, `${file} não é mais alarme (ou sumiu) — tire da allowlist`);
      assert.ok(!validatesArgv(src), `${file} já valida o argv — tire da allowlist`);
    }
  });

  test("CLI_SPEC de cada script migrado cobre toda flag que ele lê", () => {
    let migrados = 0;
    for (const { file, src } of scripts) {
      if (!src.includes("applyCliAction(")) continue;
      const spec = readSpec(src);
      assert.ok(spec, `${file}: applyCliAction sem literal CLI_SPEC legível`);
      migrados++;
      const aceitas = new Set([...spec.booleans, ...spec.values]);
      const faltando = [...flagsRead(src)].filter((f) => !aceitas.has(f));
      assert.deepEqual(faltando, [], `${file} lê flag(s) fora do CLI_SPEC: ${faltando.join(", ")}`);
      for (const b of spec.booleans) {
        assert.ok(!spec.values.includes(b), `${file}: --${b} em booleans e values`);
      }
    }
    // 40 da #12503 + 12 da #12528.
    assert.ok(migrados >= 52, `esperava ≥52 alarmes migrados, achei ${migrados}`);
  });

  test("args das tasks agendadas passam no CLI_SPEC do script", () => {
    const specs = new Map<string, CliSpec>();
    for (const { file, src } of scripts) {
      const s = src.includes("applyCliAction(") ? readSpec(src) : null;
      if (s) specs.set(`scripts/${file}`, { script: `scripts/${file}`, ...s });
    }
    let conferidos = 0;
    for (const task of SCHEDULED_TASKS) {
      for (const step of task.steps ?? []) {
        const spec = specs.get(step.script);
        if (!spec) continue;
        conferidos++;
        const r = resolveCliAction(step.args ?? [], spec);
        assert.deepEqual(r, { kind: "run" }, `${task.name} → ${step.script} ${(step.args ?? []).join(" ")}`);
      }
    }
    assert.ok(conferidos > 0, "nenhuma task agendada chama um alarme migrado — o teste não conferiu nada");
  });

  test("hub-staleness-check: args reais do registry (--threshold-days 1) seguem válidos", () => {
    const src = readFileSync(join(SCRIPTS, "hub-staleness-check.ts"), "utf8");
    const s = readSpec(src);
    assert.ok(s);
    assert.deepEqual(
      resolveCliAction(["--threshold-days", "1"], { script: "scripts/hub-staleness-check.ts", ...s }),
      { kind: "run" },
    );
  });
});

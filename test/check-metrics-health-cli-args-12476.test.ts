/**
 * test/check-metrics-health-cli-args-12476.test.ts (#12476)
 *
 * Regressão: `check-metrics-health.ts --help` (ou qualquer flag desconhecida)
 * era ignorado em silêncio e o script caía no modo REAL — e-mail ao editor e
 * issues do alarme abertas/comentadas/fechadas. Agora `main()` decide pelo
 * argv ANTES de qualquer I/O, via `resolveMetricsHealthCliAction` (pura).
 *
 * Não spawna o script de propósito: se a regressão voltasse, o subprocesso
 * rodaria o modo real. A ordem "validar argv antes de I/O" é travada por
 * leitura da fonte de `main()`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveMetricsHealthCliAction,
  CHECK_METRICS_HEALTH_USAGE,
} from "../scripts/check-metrics-health.ts";

describe("resolveMetricsHealthCliAction (#12476)", () => {
  it("--help e -h -> help (nunca run)", () => {
    assert.deepEqual(resolveMetricsHealthCliAction(["--help"]), { kind: "help" });
    assert.deepEqual(resolveMetricsHealthCliAction(["-h"]), { kind: "help" });
    assert.deepEqual(resolveMetricsHealthCliAction(["--dry-run", "--help"]), { kind: "help" });
  });

  it("flag desconhecida -> error, citando a flag", () => {
    const r = resolveMetricsHealthCliAction(["--bogus"]);
    assert.equal(r.kind, "error");
    assert.match((r as { message: string }).message, /--bogus/);
  });

  it("typo de --dry-run (--dryrun) -> error, nunca modo real", () => {
    assert.equal(resolveMetricsHealthCliAction(["--dryrun"]).kind, "error");
    assert.equal(resolveMetricsHealthCliAction(["--dry_run"]).kind, "error");
  });

  it("argumento posicional solto (dry-run sem hífens) -> error", () => {
    assert.equal(resolveMetricsHealthCliAction(["dry-run"]).kind, "error");
  });

  it("--dry-run seguido de valor solto -> error (parseArgs engoliria o valor e desligaria o dry-run)", () => {
    const r = resolveMetricsHealthCliAction(["--dry-run", "foo"]);
    assert.equal(r.kind, "error");
    assert.match((r as { message: string }).message, /--dry-run não aceita valor/);
  });

  it("flag de valor sem valor -> error", () => {
    assert.equal(resolveMetricsHealthCliAction(["--to"]).kind, "error");
    assert.equal(resolveMetricsHealthCliAction(["--to", "--dry-run"]).kind, "error");
    assert.equal(resolveMetricsHealthCliAction(["--db="]).kind, "error");
  });

  it("invocações válidas -> run", () => {
    assert.deepEqual(resolveMetricsHealthCliAction([]), { kind: "run" });
    assert.deepEqual(resolveMetricsHealthCliAction(["--dry-run"]), { kind: "run" });
    assert.deepEqual(
      resolveMetricsHealthCliAction([
        "--dry-run",
        "--to",
        "editor@exemplo.com",
        "--db=x.db",
        "--root",
        "data/beehiiv-backup",
        "--metas",
        "m.json",
        "--queda-min-pct",
        "30",
        "--frescor-max-dias=2",
        "--min-dias-serie",
        "14",
        "--indeterminado-max-fracao",
        "0.5",
      ]),
      { kind: "run" },
    );
  });

  it("flag desconhecida junto com --help -> error (o --bogus não some no help)", () => {
    const r = resolveMetricsHealthCliAction(["--bogus", "--help"]);
    assert.equal(r.kind, "error");
    assert.match((r as { message: string }).message, /--bogus/);
  });

  it("limiar negativo -> error com mensagem de valor, nunca 'flag desconhecida' (#12502)", () => {
    for (const argv of [["--queda-min-pct", "-5"], ["--queda-min-pct=-5"], ["--min-dias-serie", "-1"]]) {
      const r = resolveMetricsHealthCliAction(argv);
      assert.equal(r.kind, "error", argv.join(" "));
      const msg = (r as { message: string }).message;
      assert.doesNotMatch(msg, /desconhecida/);
      assert.match(msg, /não-negativo/);
    }
    assert.equal(resolveMetricsHealthCliAction(["--frescor-max-dias", "abc"]).kind, "error");
  });

  it("valor de --to que parece flag (-h) -> error, não help", () => {
    const r = resolveMetricsHealthCliAction(["--to", "-h"]);
    assert.equal(r.kind, "error");
    assert.match((r as { message: string }).message, /--to exige um valor/);
  });

  it("uso cita --help e --dry-run", () => {
    assert.match(CHECK_METRICS_HEALTH_USAGE, /--help/);
    assert.match(CHECK_METRICS_HEALTH_USAGE, /--dry-run/);
  });
});

describe("main() valida argv antes de qualquer I/O (#12476)", () => {
  const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", "check-metrics-health.ts"), "utf8");
  const mainBody = src.slice(src.indexOf("async function main(): Promise<void> {"));

  it("resolveMetricsHealthCliAction vem antes de loadProjectEnv e de qualquer leitura de flag", () => {
    const iAction = mainBody.indexOf("resolveMetricsHealthCliAction(argv)");
    assert.ok(iAction > 0, "main() precisa chamar resolveMetricsHealthCliAction(argv)");
    for (const marker of ["loadProjectEnv(", "hasFlag(argv", "getArg(argv", "resolveThresholds(argv"]) {
      const i = mainBody.indexOf(marker);
      assert.ok(i > iAction, `${marker} precisa vir depois da validação de argv`);
    }
  });
});

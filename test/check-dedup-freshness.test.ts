import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateFreshness, parseArgs } from "../scripts/check-dedup-freshness.ts";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";

/** Roda o script CLI e captura {stdout, stderr, exitCode}.
 * Usa spawnSync (não execFileSync) para capturar stdout mesmo em exit != 0 (#311).
 * shell:true no Windows pra resolver npx via cmd.exe.
 */
function runCli(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync(
    NPX,
    ["tsx", "scripts/check-dedup-freshness.ts", ...args],
    { encoding: "utf8", stdio: "pipe", shell: isWindows },
  );
  // spawnSync não throw — retorna status null quando processo não iniciou (ENOENT)
  if (result.error) throw result.error;
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

const NOW_ISO = "2026-04-28T03:00:00Z";
const NOW_MS = Date.parse(NOW_ISO);

describe("evaluateFreshness (#230)", () => {
  it("ok=true quando edição mais recente está dentro da janela", () => {
    const posts = [
      { id: "a", published_at: "2026-04-26T18:00:00Z" }, // 33h atrás
      { id: "b", published_at: "2026-04-23T10:00:00Z" },
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, true);
    assert.equal(r.most_recent, "2026-04-26T18:00:00Z");
    assert.equal(r.count, 2);
    assert.equal(r.reason, undefined);
  });

  it("ok=false quando todas as entradas estão fora da janela", () => {
    // Cenário real do #230: raw com 5 edições de 14-23 abril, agora é 28 abril
    const posts = [
      { id: "a", published_at: "2026-04-23T10:00:00Z" }, // 113h atrás
      { id: "b", published_at: "2026-04-22T10:00:00Z" },
      { id: "c", published_at: "2026-04-18T10:00:00Z" },
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.most_recent, "2026-04-23T10:00:00Z");
    assert.match(r.reason ?? "", /publicada há \d+\.\d+h.*limite 48h/);
  });

  it("ok=false com lista vazia + reason indicando bootstrap", () => {
    const r = evaluateFreshness([], NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.count, 0);
    assert.equal(r.most_recent, null);
    assert.match(r.reason ?? "", /bootstrap/);
  });

  it("ok=false quando nenhuma entrada tem published_at parseável", () => {
    const posts = [
      { id: "a" },
      { id: "b", published_at: "garbage" },
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.most_recent, null);
    assert.match(r.reason ?? "", /parseável/);
  });

  it("ignora entradas inválidas mas usa as válidas", () => {
    const posts = [
      { id: "x", published_at: "not-a-date" },
      { id: "y", published_at: "2026-04-27T20:00:00Z" }, // 7h atrás
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, true);
    assert.equal(r.most_recent, "2026-04-27T20:00:00Z");
  });

  it("idade exatamente igual à janela conta como ok", () => {
    const posts = [{ id: "a", published_at: "2026-04-26T03:00:00Z" }]; // 48h exatos
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, true);
  });

  it("idade um segundo acima da janela falha", () => {
    const posts = [{ id: "a", published_at: "2026-04-26T02:59:59Z" }]; // 48h e 1s
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
  });

  it("janela customizada funciona", () => {
    const posts = [{ id: "a", published_at: "2026-04-27T00:00:00Z" }]; // 27h atrás
    assert.equal(evaluateFreshness(posts, NOW_MS, 24).ok, false);
    assert.equal(evaluateFreshness(posts, NOW_MS, 72).ok, true);
  });

  it("escolhe o post com published_at mais recente independente da ordem", () => {
    const posts = [
      { id: "old", published_at: "2026-04-20T00:00:00Z" },
      { id: "new", published_at: "2026-04-27T22:00:00Z" }, // 5h atrás
      { id: "mid", published_at: "2026-04-25T00:00:00Z" },
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.most_recent, "2026-04-27T22:00:00Z");
    assert.equal(r.ok, true);
  });

  it("age_hours arredondado a 1 casa decimal", () => {
    const posts = [{ id: "a", published_at: "2026-04-27T15:34:12Z" }];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    // Sanity: número, finito, com no máximo 1 casa.
    assert.equal(typeof r.age_hours, "number");
    const decimals = (String(r.age_hours).split(".")[1] ?? "").length;
    assert.ok(decimals <= 1, `age_hours ${r.age_hours} tem mais de 1 decimal`);
  });

  it("ok=false quando edição mais recente tem published_at no futuro (#241)", () => {
    const posts = [{ id: "a", published_at: "2026-04-29T12:00:00Z" }]; // 33h no futuro
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.most_recent, "2026-04-29T12:00:00Z");
    assert.match(r.reason ?? "", /futuro|à frente/);
    // age_hours deve ser negativo (sinal de detecção)
    assert.ok(r.age_hours !== null && r.age_hours < 0);
  });

  it("entrada futura não mascara stale real — escolhe ainda a mais recente (#241)", () => {
    // Garantia: se houver mistura de futuro + passado, a função pega a mais recente
    // (que pode ser a futura) e dispara o guard de futuro, não cai pra "stale".
    const posts = [
      { id: "future", published_at: "2026-05-01T00:00:00Z" }, // ~3 dias à frente
      { id: "past", published_at: "2026-04-20T00:00:00Z" }, // ~8 dias atrás
    ];
    const r = evaluateFreshness(posts, NOW_MS, 48);
    assert.equal(r.ok, false);
    assert.equal(r.most_recent, "2026-05-01T00:00:00Z");
    assert.match(r.reason ?? "", /futuro/);
  });
});

describe("parseArgs", () => {
  it("default: 48h, raw padrão, now undefined", () => {
    const r = parseArgs([]);
    assert.deepEqual(r, {
      maxStalenessHours: 48,
      rawPath: "data/past-editions-raw.json",
      now: undefined,
    });
  });

  it("override de janela", () => {
    const r = parseArgs(["--max-staleness-hours", "72"]);
    if ("error" in r) throw new Error(r.error);
    assert.equal(r.maxStalenessHours, 72);
  });

  it("override de raw e now", () => {
    const r = parseArgs([
      "--raw",
      "tmp/raw.json",
      "--now",
      "2026-04-28T03:00:00Z",
    ]);
    if ("error" in r) throw new Error(r.error);
    assert.equal(r.rawPath, "tmp/raw.json");
    assert.equal(r.now, "2026-04-28T03:00:00Z");
  });

  it("janela inválida (não numérica) retorna erro", () => {
    const r = parseArgs(["--max-staleness-hours", "abc"]);
    assert.ok("error" in r);
  });

  it("janela <= 0 retorna erro", () => {
    const r = parseArgs(["--max-staleness-hours", "0"]);
    assert.ok("error" in r);
    const r2 = parseArgs(["--max-staleness-hours", "-5"]);
    assert.ok("error" in r2);
  });
});

describe("CLI: emite JSON em todos os exit codes (#240)", () => {
  let tmp: string;

  function setup() {
    tmp = mkdtempSync(join(tmpdir(), "freshness-"));
    return tmp;
  }
  function cleanup() {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }

  it("path stale (exit 1) emite JSON parseável", () => {
    const dir = setup();
    try {
      const raw = join(dir, "raw.json");
      writeFileSync(
        raw,
        JSON.stringify([{ id: "a", published_at: "2026-04-20T00:00:00Z" }]),
      );
      const { stdout, exitCode } = runCli([
        "--raw",
        raw,
        "--now",
        "2026-04-28T03:00:00Z",
      ]);
      assert.equal(exitCode, 1);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason ?? "", /publicada há/);
    } finally {
      cleanup();
    }
  });

  it("path raw missing (exit 1) emite JSON com reason de bootstrap", () => {
    const { stdout, exitCode } = runCli(["--raw", "/tmp/never-exists-xyz.json"]);
    assert.equal(exitCode, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason ?? "", /bootstrap/);
  });

  it("path JSON corrompido (exit 2) emite JSON em vez de stderr", () => {
    const dir = setup();
    try {
      const raw = join(dir, "broken.json");
      writeFileSync(raw, "{ not valid json");
      const { stdout, stderr, exitCode } = runCli(["--raw", raw]);
      assert.equal(exitCode, 2);
      // Antes de #240: vinha em stderr. Agora em stdout como JSON.
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason ?? "", /JSON parse falhou/);
      // stderr deve estar limpo (ou pelo menos sem o texto livre legacy).
      assert.ok(!stderr.includes("raw inválido (JSON parse"));
    } finally {
      cleanup();
    }
  });

  it("path raw não-array (exit 2) emite JSON", () => {
    const dir = setup();
    try {
      const raw = join(dir, "obj.json");
      writeFileSync(raw, JSON.stringify({ not: "an array" }));
      const { stdout, exitCode } = runCli(["--raw", raw]);
      assert.equal(exitCode, 2);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason ?? "", /esperado array/);
    } finally {
      cleanup();
    }
  });

  it("path --now inválido (exit 2) emite JSON", () => {
    const dir = setup();
    try {
      const raw = join(dir, "raw.json");
      writeFileSync(raw, "[]");
      const { stdout, exitCode } = runCli([
        "--raw",
        raw,
        "--now",
        "not-a-date",
      ]);
      assert.equal(exitCode, 2);
      const parsed = JSON.parse(stdout);
      assert.equal(parsed.ok, false);
      assert.match(parsed.reason ?? "", /--now inválido/);
    } finally {
      cleanup();
    }
  });

  it("path parseArgs error (exit 2) emite JSON", () => {
    // --max-staleness-hours abc cai no error path do parseArgs
    const { stdout, exitCode } = runCli([
      "--max-staleness-hours",
      "abc",
    ]);
    assert.equal(exitCode, 2);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, false);
    assert.match(parsed.reason ?? "", /max-staleness-hours inválido/);
  });
});

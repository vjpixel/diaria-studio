/**
 * test/geo-citation-monitor-cli.test.ts (#4558 Parte C)
 *
 * Cobre o CLI `scripts/geo-citation-monitor.ts` (`main()`) — só os caminhos
 * que NÃO tocam rede: `--dry-run` e "nenhum provider configurado". O
 * caminho com API key real (chamada de rede de verdade) é deliberadamente
 * NÃO testado aqui — não há credencial no worktree isolado (ver docstring
 * do script); a lógica de rede em si já é coberta com `fetchImpl` injetado
 * em `test/geo-citation-monitor.test.ts` (`runGeoCitationMonitor`).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  main,
  resolveStrictOutcome,
  readHistoryRecordsForPanel,
  listSafeBackupConflictFiles,
} from "../scripts/geo-citation-monitor.ts";
import { GEO_PROVIDERS } from "../scripts/lib/geo-citation-monitor.ts";
import type { GeoCitationRecord } from "../scripts/lib/geo-citation-monitor.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const KEYS = GEO_PROVIDERS.map((p) => p.envKey);
let saved: Record<string, string | undefined> = {};
let originalArgv: string[] = [];
let logs: string[] = [];
let originalLog: typeof console.log;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  originalArgv = process.argv;
  logs = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
  process.argv = originalArgv;
  console.log = originalLog;
});

describe("scripts/geo-citation-monitor.ts main() (#4558 Parte C)", () => {
  it("--dry-run: não faz chamada de rede, imprime as perguntas, retorna 0", async () => {
    process.argv = ["node", "geo-citation-monitor.ts", "--dry-run"];
    const code = await main();
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("--dry-run")));
    assert.ok(logs.some((l) => l.includes("newsletter")), "deve imprimir pelo menos 1 pergunta");
  });

  it("sem NENHUMA API key configurada: reporta e retorna 0 (não é erro fatal)", async () => {
    process.argv = ["node", "geo-citation-monitor.ts"];
    const code = await main();
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("nenhum provider configurado")));
  });

  /**
   * `--strict` (#4754) NÃO inverte o default acima — ele é opt-in, e só o
   * caminho agendado (`run-geo-citation-monitor.ps1`) o liga.
   *
   * A distinção importa: na mão, "sem key configurada" é estado válido e
   * devolver 0 é decisão deliberada do #4616. Numa task agendada, o mesmo 0
   * é mentira — reportaria verde para sempre enquanto `history.jsonl`
   * congelava, que é o modo de falha que deixou este monitor inerte por
   * semanas.
   */
  it("--strict sem NENHUMA API key: exit 2 (config), não 0", async () => {
    process.argv = ["node", "geo-citation-monitor.ts", "--strict"];
    const code = await main();
    assert.equal(code, 2, "sob --strict, zero providers é falha de configuração");
  });

  it("--strict com --dry-run continua 0 — dry-run é opt-in explícito de não medir", async () => {
    process.argv = ["node", "geo-citation-monitor.ts", "--strict", "--dry-run"];
    const code = await main();
    assert.equal(code, 0);
  });

  it("--dry-run lista os providers configurados quando alguma key está presente", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key-for-dry-run";
    process.argv = ["node", "geo-citation-monitor.ts", "--dry-run"];
    const code = await main();
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("Claude (Anthropic)")));
  });

  describe("--panel (#4900 item a)", () => {
    it("--dry-run --panel hubs imprime as perguntas do painel de hubs, não as de GEO_QUESTIONS", async () => {
      process.argv = ["node", "geo-citation-monitor.ts", "--dry-run", "--panel", "hubs"];
      const code = await main();
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes('painel "hubs"')));
      assert.ok(logs.some((l) => l.includes("Anthropic")), "esperava alguma pergunta do painel de hubs mencionando Anthropic");
      assert.ok(!logs.some((l) => l.includes("newsletter diária")), "não deveria imprimir pergunta do painel 'geral'");
    });

    it("sem --panel: default continua 'geral' (comportamento pré-#4900 preservado)", async () => {
      process.argv = ["node", "geo-citation-monitor.ts", "--dry-run"];
      const code = await main();
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes('painel "geral"')));
    });

    it("--panel com valor inválido cai em 'geral', não quebra", async () => {
      process.argv = ["node", "geo-citation-monitor.ts", "--dry-run", "--panel", "lixo"];
      const code = await main();
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes('painel "geral"')));
    });
  });
});

describe("readHistoryRecordsForPanel (scripts/geo-citation-monitor.ts, I/O real via tmpdir — #4900 item b)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "geo-citation-history-panel-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("arquivo inexistente -> []", () => {
    assert.deepEqual(readHistoryRecordsForPanel(resolve(tmpDir, "nao-existe.jsonl"), "geral"), []);
  });

  it("filtra pelo painel pedido; registro legado sem 'panel' conta como 'geral'", () => {
    const path = resolve(tmpDir, "history.jsonl");
    const lines = [
      JSON.stringify({ date: "2026-08-03", provider: "openai" }), // legado, sem panel
      JSON.stringify({ date: "2026-08-03", provider: "google", panel: "geral" }),
      JSON.stringify({ date: "2026-08-03", provider: "anthropic", panel: "hubs" }),
    ];
    writeFileSync(path, lines.join("\n") + "\n");

    const geral = readHistoryRecordsForPanel(path, "geral");
    assert.equal(geral.length, 2);
    assert.deepEqual(
      geral.map((r) => r.provider).sort(),
      ["google", "openai"],
    );

    const hubs = readHistoryRecordsForPanel(path, "hubs");
    assert.equal(hubs.length, 1);
    assert.equal(hubs[0].provider, "anthropic");
  });

  it("linha corrompida não invalida as outras (fail-soft linha a linha)", () => {
    const path = resolve(tmpDir, "history.jsonl");
    writeFileSync(path, "não é json\n" + JSON.stringify({ date: "2026-08-03", provider: "openai" }) + "\n");
    assert.deepEqual(readHistoryRecordsForPanel(path, "geral"), [{ date: "2026-08-03", provider: "openai" }]);
  });
});

describe("listSafeBackupConflictFiles (scripts/geo-citation-monitor.ts, I/O real via tmpdir — #4900 item c)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "geo-citation-conflict-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("diretório sem conflito -> []", () => {
    writeFileSync(resolve(tmpDir, "history.jsonl"), "");
    assert.deepEqual(listSafeBackupConflictFiles(resolve(tmpDir, "history.jsonl")), []);
  });

  it("diretório com arquivo -safeBackup- -> devolve o nome do arquivo", () => {
    writeFileSync(resolve(tmpDir, "history.jsonl"), "");
    writeFileSync(resolve(tmpDir, "history-predator-safeBackup-0001.jsonl"), "");
    assert.deepEqual(listSafeBackupConflictFiles(resolve(tmpDir, "history.jsonl")), [
      "history-predator-safeBackup-0001.jsonl",
    ]);
  });

  it("diretório inexistente -> [] (fail-soft, ex: sessão cloud sem o junction data/)", () => {
    assert.deepEqual(listSafeBackupConflictFiles(resolve(tmpDir, "subdir-inexistente", "history.jsonl")), []);
  });
});

describe("scripts/geo-citation-monitor.ts: main() invocado com .catch() explícito (#4616 achado 3)", () => {
  // O caminho de rede real de main() não é testável aqui sem uma chamada de
  // API ao vivo (proibido nesta sessão — ver docstring do script), então
  // esta é uma checagem ESTRUTURAL da fonte: garante que a invocação
  // top-level de main() nunca regride pro padrão antigo
  // `main().then((code) => { process.exitCode = code; })` sem `.catch()`,
  // que deixava uma exceção não tratada virar stack trace cru em vez do log
  // estruturado `[geo-citation-monitor] erro: ...` que o `.ps1` wrapper (se
  // este script for agendado via Task Scheduler no futuro) capturaria.
  // Mesmo padrão já usado em postmaster-spam-sync.ts/apoios-diff-alarm.ts/
  // cursos-error-alarm.ts.
  it("o bloco isMainModule encadeia .catch() depois de main()", () => {
    const source = readFileSync(resolve(ROOT, "scripts", "geo-citation-monitor.ts"), "utf8");
    const mainInvocationBlock = /if \(isMainModule\(import\.meta\.url\)\) \{([\s\S]*?)\n\}/.exec(source);
    assert.ok(mainInvocationBlock, "esperava encontrar o bloco `if (isMainModule(...))`");
    const block = mainInvocationBlock![1];
    assert.match(block, /main\(\)/);
    assert.match(block, /\.catch\(/, "main() precisa ter um .catch() explícito (#4616 achado 3)");
    assert.match(block, /process\.exit\(1\)|process\.exitCode\s*=\s*1/, "o catch precisa sinalizar falha via exit code");
  });
});

/**
 * `resolveStrictOutcome` — extraída de `main()` no fleet review da PR #4754
 * justamente pra ser testável: `main()` chama `runGeoCitationMonitor(process.env)`
 * sem ponto de injeção, então a decisão embutida ali só seria exercitável com
 * rede real. Mesma armadilha do guard inline apontada no review da #4751.
 */
describe("resolveStrictOutcome (#4754)", () => {
  const rec = (over: Partial<GeoCitationRecord> = {}): GeoCitationRecord =>
    ({
      ts: "2026-08-07T00:00:00.000Z",
      provider: "openai",
      question: "q",
      cited: false,
      ...over,
    }) as GeoCitationRecord;

  it("sem --strict nunca reprova, mesmo com 100% de erro", () => {
    const out = resolveStrictOutcome([rec({ error: "x", errorKind: "network" })], false);
    assert.equal(out.code, 0);
    assert.equal(out.level, "none");
  });

  it("falha PARCIAL sai 0 — o fail-soft por provedor é desenhado", () => {
    const out = resolveStrictOutcome(
      [rec({ error: "x", errorKind: "network" }), rec({ cited: true })],
      true,
    );
    assert.equal(out.code, 0);
  });

  it("lista vazia não reprova (nada foi tentado, não é falha de medição)", () => {
    assert.equal(resolveStrictOutcome([], true).code, 0);
  });

  /**
   * O cenário que mais preocupa: as 8 perguntas de um provider saem em
   * sequência com um único retry de 1,5s. Num free tier de RPM baixo — o
   * Gemini é o caso concreto de hoje — isso pode dar 429 nas 8 TODA SEMANA
   * sem nada estar quebrado. Exit != 0 recorrente em cenário benigno treina
   * o editor a ignorar o alarme, que é o oposto do que a #4558 quer.
   */
  it("100% HTTP 429 NÃO reprova — avisa, mas sai 0 pra não virar alarme falso semanal", () => {
    const out = resolveStrictOutcome(
      [
        rec({ error: "HTTP 429", errorKind: "http", httpStatus: 429 }),
        rec({ error: "HTTP 429", errorKind: "http", httpStatus: 429 }),
      ],
      true,
    );
    assert.equal(out.code, 0);
    assert.equal(out.level, "warn");
    assert.match(out.message, /rate limit/i);
  });

  it("100% HTTP 401 reprova e NOMEIA a causa — 401 exige ação, DNS só espera", () => {
    const out = resolveStrictOutcome(
      [
        rec({ error: "HTTP 401", errorKind: "http", httpStatus: 401 }),
        rec({ error: "HTTP 401", errorKind: "http", httpStatus: 401 }),
      ],
      true,
    );
    assert.equal(out.code, 1);
    assert.equal(out.level, "error");
    assert.match(out.message, /HTTP 401 \(2\)/);
  });

  it("429 misturado com outra causa reprova — não é só rate limit", () => {
    const out = resolveStrictOutcome(
      [
        rec({ error: "HTTP 429", errorKind: "http", httpStatus: 429 }),
        rec({ error: "dns", errorKind: "network" }),
      ],
      true,
    );
    assert.equal(out.code, 1);
    assert.match(out.message, /network/);
  });
});

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
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../scripts/geo-citation-monitor.ts";
import { GEO_PROVIDERS } from "../scripts/lib/geo-citation-monitor.ts";

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

  it("--dry-run lista os providers configurados quando alguma key está presente", async () => {
    process.env.ANTHROPIC_API_KEY = "fake-key-for-dry-run";
    process.argv = ["node", "geo-citation-monitor.ts", "--dry-run"];
    const code = await main();
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("Claude (Anthropic)")));
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

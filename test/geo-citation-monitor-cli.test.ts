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

import { main } from "../scripts/geo-citation-monitor.ts";
import { GEO_PROVIDERS } from "../scripts/lib/geo-citation-monitor.ts";

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

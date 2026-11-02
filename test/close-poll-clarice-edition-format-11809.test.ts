/**
 * test/close-poll-clarice-edition-format-11809.test.ts (#11809)
 *
 * CENÁRIO REAL (01/11/2026): `/diaria-clarice-envio` mandava rodar
 * `close-poll.ts --brand clarice --cycle 2610-11 --edition 261022` (AAMMDD).
 * O Worker recusa AAMMDD pra brand anual (#4157) com a mensagem genérica de
 * formato diário; funcionou com `--edition 2610-11`.
 *
 * Trava três coisas:
 *   1. `checkBrandEditionFormat` recusa AAMMDD com `--brand clarice` e sugere o ciclo;
 *   2. o CLI real sai 1 ANTES de qualquer chamada de rede (mock conta as chamadas);
 *   3. nenhuma instrução (SKILL.md, mensagem do guard do --schedule, docstrings)
 *      volta a prescrever `--brand clarice ... --edition {AAMMDD}`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { checkBrandEditionFormat } from "../scripts/close-poll.ts";
import { checkEiaGuard } from "../scripts/clarice-schedule-sends.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";

describe("checkBrandEditionFormat (#11809)", () => {
  it("clarice + AAMMDD → erro sugerindo o --cycle", () => {
    const err = checkBrandEditionFormat("clarice", "261022", "2610-11");
    assert.ok(err, "deveria recusar AAMMDD com brand clarice");
    assert.match(err!, /--edition 2610-11/);
    assert.match(err!, /261022/);
  });

  it("clarice + AAMMDD sem --cycle válido → sugere o formato YYMM-MM", () => {
    const err = checkBrandEditionFormat("clarice", "261022", undefined);
    assert.ok(err);
    assert.match(err!, /YYMM-MM/);
  });

  it("clarice + ciclo → ok", () => {
    assert.equal(checkBrandEditionFormat("clarice", "2610-11", "2610-11"), null);
  });

  it("diária (brand null) + AAMMDD → ok (não muda o fluxo diário)", () => {
    assert.equal(checkBrandEditionFormat(null, "261022"), null);
  });

  it("brand web + AAMMDD → ok (mirror da diária usa AAMMDD)", () => {
    assert.equal(checkBrandEditionFormat("web", "261022"), null);
  });
});

function startCountingServer(): Promise<{ server: Server; url: string; calls: () => number }> {
  let n = 0;
  return new Promise((res) => {
    const server = createServer((_req, r) => {
      n++;
      r.writeHead(500);
      r.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ server, url: `http://127.0.0.1:${port}`, calls: () => n });
    });
  });
}

describe("close-poll.ts CLI — clarice + AAMMDD recusado antes da rede (#11809)", () => {
  it("sai 1 com a mensagem de ciclo e zero chamadas ao Worker", async () => {
    const { server, url, calls } = await startCountingServer();
    try {
      const result = await new Promise<{ status: number | null; stderr: string }>((res, rej) => {
        const child = spawn(
          "npx",
          ["tsx", "scripts/close-poll.ts", "--brand", "clarice", "--cycle", "2610-11", "--edition", "261022", "--answer", "A"],
          {
            cwd: ROOT,
            shell: isWindows,
            env: { ...process.env, ADMIN_SECRET: "test-secret-11809", POLL_WORKER_URL: url },
          },
        );
        let stderr = "";
        child.stderr?.on("data", (d) => (stderr += d.toString()));
        child.on("error", rej);
        child.on("close", (status) => res({ status, stderr }));
      });
      assert.equal(result.status, 1, `esperava exit 1, stderr: ${result.stderr}`);
      assert.match(result.stderr, /--edition 2610-11/);
      assert.equal(calls(), 0, "não deveria chamar o Worker");
    } finally {
      server.close();
    }
  });
});

describe("instruções não prescrevem --edition AAMMDD com --brand clarice (#11809)", () => {
  const WRONG = /close-poll\.ts --brand clarice[^\n]*--edition (\{AAMMDD\}|\d{6}\b)/;
  const FILES = [
    ".claude/skills/diaria-clarice-envio/SKILL.md",
    ".claude/skills/diaria-mensal/SKILL.md",
    "scripts/clarice-schedule-sends.ts",
    "scripts/clarice-schedule-group.ts",
    "scripts/clarice-schedule-ramp.ts",
    "scripts/publish-monthly.ts",
  ];
  for (const f of FILES) {
    it(f, () => {
      const src = readFileSync(resolve(ROOT, f), "utf8");
      assert.doesNotMatch(src, WRONG);
    });
  }

  it("mensagem do guard do --schedule usa o ciclo como --edition", () => {
    const r = checkEiaGuard("2610-11", false, "/caminho/inexistente/.close-poll-clarice.json");
    assert.ok(!r.ok);
    assert.ok("message" in r);
    assert.match(r.message, /--edition 2610-11/);
    assert.doesNotMatch(r.message, /\{AAMMDD\}/);
  });
});

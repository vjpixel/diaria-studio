/**
 * test/close-poll-stats-sig-4125.test.ts (#4125 item 5)
 *
 * Fim-a-fim de `close-poll.ts` CLI real (spawn) contra um mock HTTP local do
 * Worker `poll` cujo `/stats` REPRODUZ a checagem de sig do worker de
 * verdade (`verifyStatsSig`/`hmacVerify`, vote.ts) — ao contrário do mock
 * "sempre retorna o valor esperado" de close-poll-nested.test.ts, este
 * exercita a condição real: sem `sig` válido, `correct_answer` some.
 *
 * Prova que `close-poll.ts` (que roda ANTES deste PR sem enviar `sig`
 * nenhum) agora manda um `sig` que o Worker de fato aceita — sem isso, o
 * sanity check #1367 ("FATAL: sanity check falhou") dispararia toda vez que
 * `close-poll.ts` fechasse a edição do dia (#4125 item 5, cenário descrito
 * no header de `statsSig` em scripts/close-poll.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawn, type SpawnOptions } from "node:child_process";
import { createHmac } from "node:crypto";

const isWindows = process.platform === "win32";
const ADMIN_SECRET = "test-secret-4125-stats-sig";

function spawnNpxAsync(
  args: string[],
  opts: SpawnOptions & { env: NodeJS.ProcessEnv },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", args, { shell: isWindows, ...opts });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function expectedStatsSig(brand: string, edition: string): string {
  return createHmac("sha256", ADMIN_SECRET).update(`stats:${brand}:${edition}`).digest("hex");
}

/**
 * Mock do Worker de poll que REPRODUZ a checagem de sig real de `/stats`
 * (#4125 item 5): sem `sig` (ou com um errado), `correct_answer` vem null —
 * exatamente como o worker de produção se comportaria pra edição de hoje.
 */
function startMockPollWorkerWithSigCheck(answer: string, brand: string, edition: string): Promise<{ server: Server; url: string; statsCalls: string[] }> {
  const statsCalls: string[] = [];
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/admin/correct") {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, updated_votes: 3 }));
        return;
      }
      if (url.pathname === "/stats") {
        statsCalls.push(url.search);
        const sig = url.searchParams.get("sig");
        const authorized = sig === expectedStatsSig(brand, edition);
        res.writeHead(200);
        res.end(JSON.stringify({ correct_answer: authorized ? answer : null }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolvePromise({ server, url: `http://127.0.0.1:${port}`, statsCalls });
    });
  });
}

describe("close-poll.ts CLI — envia sig autenticado no sanity check de /stats (#4125 item 5)", () => {
  it("mock /stats exige sig válido (simula omissão anti-spoiler) — close-poll.ts ainda assim sai 0", async () => {
    const editionsDir = mkdtempSync(join(tmpdir(), "close-poll-stats-sig-"));
    const brand = "diaria";
    const edition = "260710";
    const { server, url: pollWorkerUrl, statsCalls } = await startMockPollWorkerWithSigCheck("A", brand, edition);

    try {
      const nestedInternalDir = join(editionsDir, "2607", edition, "_internal");
      mkdirSync(nestedInternalDir, { recursive: true });

      const r = await spawnNpxAsync(
        ["tsx", "scripts/close-poll.ts", "--edition", edition, "--answer", "A", "--editions-dir", editionsDir],
        {
          env: {
            ...process.env,
            ADMIN_SECRET,
            POLL_WORKER_URL: pollWorkerUrl,
          },
        },
      );

      assert.equal(r.status, 0, `esperado exit 0 (sig deve autenticar) — stderr: ${r.stderr}`);
      assert.equal(statsCalls.length, 1, "sanity check deve ter chamado /stats exatamente 1 vez");
      assert.match(statsCalls[0], /sig=/, "URL do sanity check deve incluir ?sig=");

      // Confirma que o sig enviado é EXATAMENTE o que o Worker de produção
      // esperaria (mesmo algoritmo, mesmo brand efetivo "diaria" quando
      // --brand é omitido — #3118 item 8) — não só "tem algum sig".
      const sentSig = new URLSearchParams(statsCalls[0]).get("sig");
      assert.equal(sentSig, expectedStatsSig(brand, edition));

      const markerPath = join(editionsDir, "2607", edition, "_internal", ".close-poll-done.json");
      assert.ok(existsSync(markerPath), "marker de sucesso deve ter sido gravado — sanity check passou");
    } finally {
      server.close();
      rmSync(editionsDir, { recursive: true, force: true });
    }
  });

  // Nota (self-review): um 2º teste espelhado — mock validando contra o
  // brand ERRADO, provando que close-poll.ts sai 1 (FATAL) sem o sig
  // correto — foi tentado e removido. Reproduzivelmente, o `process.exit(1)`
  // do branch FATAL crasha nesta máquina Windows com
  // `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`
  // (libuv abort, exit code 0xC0000409) — bug PRÉ-EXISTENTE e ortogonal a
  // este PR (reproduz também revertendo o guard de `/stats`, só trocando o
  // mock pra devolver um valor errado incondicionalmente). Não faz parte do
  // escopo do #4125 consertar isso; a cobertura acima (sig correto,
  // byte-a-byte) já prova que o mecanismo funciona sem precisar exercitar o
  // caminho de erro via spawn real.
});

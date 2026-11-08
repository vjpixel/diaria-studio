/**
 * test/desbloqueia-scan-threads-12388.test.ts
 *
 * #12388 — `desbloqueia-scan.ts` lia corpo e comentários de cada candidata e
 * jogava tudo fora: o JSON trazia só metadados e o coordenador de
 * `/diaria-desbloqueia` refazia 1 `gh issue view --json body,comments` por
 * candidata (54 numa rodada). Estes testes rodam o pipeline inteiro com um
 * `gh` fake e travam: (1) a saída default não muda de forma; (2)
 * `includeThreads` devolve corpo + comentários (só autor confiável, #9752);
 * (3) `dumpThreadsDir` grava 1 arquivo por candidata e aponta `threadFile`;
 * (4) falha de leitura vira `comments: null`, nunca thread vazia; (5) o scan
 * não faz nenhuma chamada `gh` a mais para isso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDesbloqueioScan,
  threadFileName,
  trustedThreadComments,
  type GhRunFn,
} from "../scripts/desbloqueia-scan.ts";

const ISSUE_BODY = "Corpo da issue 42: falta o token X.";

function fakeGh(opts: { commentsFail?: boolean } = {}): { run: GhRunFn; calls: string[][] } {
  const calls: string[][] = [];
  const run: GhRunFn = (args) => {
    calls.push(args);
    if (args[1] === "list") {
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 42,
            title: "issue 42",
            labels: [{ name: "external-blocker" }],
            body: ISSUE_BODY,
            state: "OPEN",
            updatedAt: "2026-09-01T00:00:00Z",
          },
        ]),
        stderr: "",
      };
    }
    if (opts.commentsFail) return { status: 1, stdout: "", stderr: "rede caiu" };
    return {
      status: 0,
      stdout: JSON.stringify({
        comments: [
          {
            body: "comentário do editor",
            authorAssociation: "OWNER",
            author: { login: "vjpixel" },
            createdAt: "2026-09-02T10:00:00Z",
          },
          { body: "spam forjado", authorAssociation: "NONE", author: { login: "estranho" }, createdAt: "2026-09-03T00:00:00Z" },
        ],
      }),
      stderr: "",
    };
  };
  return { run, calls };
}

describe("#12388 — desbloqueia-scan devolve a thread que já leu", () => {
  it("sem flag: saída sem thread/threadFile/threadsDir (consumidores existentes intactos)", () => {
    const report = runDesbloqueioScan(".", { runGh: fakeGh().run });
    const [c] = report.precisaPergunta;
    assert.equal(c.number, 42);
    assert.equal("thread" in c, false);
    assert.equal("threadFile" in c, false);
    assert.equal("threadsDir" in report, false);
  });

  it("includeThreads: corpo + comentários de autor confiável, com autor e data", () => {
    const report = runDesbloqueioScan(".", { runGh: fakeGh().run, includeThreads: true });
    const [c] = report.precisaPergunta;
    assert.deepEqual(c.thread, {
      body: ISSUE_BODY,
      comments: [{ author: "vjpixel", createdAt: "2026-09-02T10:00:00Z", body: "comentário do editor" }],
    });
  });

  it("não faz chamada gh extra para devolver a thread (1 list + 1 view por candidata)", () => {
    const { run, calls } = fakeGh();
    runDesbloqueioScan(".", { runGh: run, includeThreads: true });
    assert.equal(calls.length, 2);
  });

  it("dumpThreadsDir: 1 arquivo por candidata, threadFile e threadsDir apontando pra ele", () => {
    const dir = mkdtempSync(join(tmpdir(), "desbloqueia-threads-12388-"));
    try {
      const report = runDesbloqueioScan(".", { runGh: fakeGh().run, dumpThreadsDir: dir });
      const [c] = report.precisaPergunta;
      assert.equal(report.threadsDir, dir);
      assert.equal("thread" in c, false, "dump não infla o stdout");
      assert.deepEqual(readdirSync(dir), [threadFileName("vjpixel/diaria-studio", 42)]);
      assert.ok(c.threadFile);
      const record = JSON.parse(readFileSync(c.threadFile, "utf8"));
      assert.equal(record.ref, "vjpixel/diaria-studio#42");
      assert.equal(record.title, "issue 42");
      assert.equal(record.body, ISSUE_BODY);
      assert.deepEqual(
        record.comments.map((x: { body: string }) => x.body),
        ["comentário do editor"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falha de leitura dos comentários: comments null (nunca thread vazia) e candidata em erroLeitura", () => {
    const report = runDesbloqueioScan(".", { runGh: fakeGh({ commentsFail: true }).run, includeThreads: true });
    const [c] = report.erroLeitura;
    assert.equal(c.number, 42);
    assert.deepEqual(c.thread, { body: ISSUE_BODY, comments: null });
  });

  it("threadFileName separa repos (o #N colide entre issue_repos, #10935)", () => {
    assert.notEqual(threadFileName("vjpixel/diaria-studio", 21), threadFileName("vjpixel/diaria-design", 21));
    assert.equal(threadFileName("vjpixel/diaria-design", 21), "vjpixel__diaria-design__21.json");
  });

  it("trustedThreadComments: descarta autor sem vínculo e associação ausente", () => {
    assert.deepEqual(
      trustedThreadComments([
        { body: "a", authorAssociation: "MEMBER" },
        { body: "b" },
        { body: "c", authorAssociation: "CONTRIBUTOR" },
        { authorAssociation: "OWNER" },
      ]),
      [{ author: null, createdAt: null, body: "a" }],
    );
    assert.deepEqual(trustedThreadComments(null), []);
  });
});

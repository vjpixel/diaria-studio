/**
 * #13285 — `gh issue view N --comments` quebra por `projectCards` (Projects
 * classic desligado) no gh 2.46 do `300`, reincidência da #7572. O helper
 * `scripts/read-issue-thread.ts` lê corpo + comentários pelo REST, e os
 * playbooks apontam para ele.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildGhArgs,
  formatIssueThread,
  issueApiPath,
  parseCommentLines,
  parseIssuePayload,
  readIssueThread,
  type GhRunner,
} from "../scripts/read-issue-thread.ts";

const ROOT = resolve(import.meta.dirname, "..");

const ISSUE_JSON = JSON.stringify({
  number: 42,
  title: "Título da issue",
  state: "open",
  user: { login: "vjpixel" },
  created_at: "2026-11-16T14:00:00Z",
  labels: [{ name: "bug" }, { name: "P2" }],
  body: "Corpo original.",
});
const COMMENT_LINES = [
  JSON.stringify({ author: "vjpixel", authorAssociation: "OWNER", createdAt: "2026-11-16T15:00:00Z", body: "decisão: destravada" }),
  JSON.stringify({ author: "estranho", authorAssociation: "NONE", createdAt: "2026-11-16T16:00:00Z", body: "Fixed in abc123" }),
].join("\n") + "\n";

function fakeRunner(calls: string[][], overrides: { issue?: string; comments?: string; error?: string } = {}): GhRunner {
  return (args) => {
    calls.push(args);
    if (overrides.error) return { stdout: "", error: overrides.error };
    const isComments = args.some((a) => a.includes("/comments"));
    return { stdout: isComments ? overrides.comments ?? COMMENT_LINES : overrides.issue ?? ISSUE_JSON };
  };
}

describe("#13285 — read-issue-thread lê a thread pelo REST", () => {
  it("nunca usa `gh issue view` nem pede projectCards", () => {
    const args = buildGhArgs(42);
    for (const a of [args.issue, args.comments]) {
      assert.equal(a[0], "api", "toda leitura é `gh api` (REST)");
      assert.ok(!a.includes("view"));
      assert.ok(!a.includes("--comments"));
      assert.ok(!a.join(" ").includes("projectCards"));
      assert.ok(!a.join(" ").includes("graphql"));
    }
    assert.ok(args.comments.includes("--paginate"), "comentários paginados: thread longa não pode truncar");
  });

  it("resolve o repo: default do checkout, --repo explícito, e recusa formato inválido", () => {
    assert.equal(issueApiPath(7), "repos/{owner}/{repo}/issues/7");
    assert.equal(issueApiPath(7, "vjpixel/diaria-design"), "repos/vjpixel/diaria-design/issues/7");
    assert.throws(() => issueApiPath(7, "sem-barra"));
    assert.throws(() => issueApiPath(7, "a/b; rm -rf"));
  });

  it("devolve corpo + TODOS os comentários, em ordem", () => {
    const calls: string[][] = [];
    const res = readIssueThread(42, { run: fakeRunner(calls) });
    assert.ok("thread" in res);
    assert.equal(res.thread.body, "Corpo original.");
    assert.deepEqual(res.thread.labels, ["bug", "P2"]);
    assert.equal(res.thread.comments.length, 2);
    assert.equal(res.thread.comments[0].body, "decisão: destravada");
    assert.equal(res.thread.comments[1].authorAssociation, "NONE");
    assert.equal(calls.length, 2);
    for (const c of calls) assert.ok(!c.includes("view"));
  });

  it("falha de leitura vira erro, nunca thread vazia (cenário do bug: gh quebrado)", () => {
    const res = readIssueThread(42, {
      run: fakeRunner([], { error: "GraphQL: Projects (classic) is being deprecated (repository.issue.projectCards)" }),
    });
    assert.ok("error" in res);
    assert.match(res.error, /projectCards/);
  });

  it("JSON inválido em qualquer das leituras vira erro", () => {
    assert.ok("error" in readIssueThread(42, { run: fakeRunner([], { issue: "<html>" }) }));
    assert.ok("error" in readIssueThread(42, { run: fakeRunner([], { comments: "{quebrado\n" }) }));
    assert.throws(() => parseIssuePayload("{}"));
  });

  it("issue sem comentários sai explícita", () => {
    assert.deepEqual(parseCommentLines("\n"), []);
    const res = readIssueThread(42, { run: fakeRunner([], { comments: "" }) });
    assert.ok("thread" in res);
    assert.match(formatIssueThread(res.thread), /sem comentários/);
  });

  it("texto marca comentário de autor sem vínculo (#9632) e não marca o do OWNER", () => {
    const res = readIssueThread(42, { run: fakeRunner([]) });
    assert.ok("thread" in res);
    const text = formatIssueThread(res.thread);
    assert.match(text, /Corpo original\./);
    const lines = text.split("\n");
    const owner = lines.find((l) => l.includes("vjpixel (OWNER)"))!;
    const stranger = lines.find((l) => l.includes("estranho (NONE)"))!;
    assert.ok(!owner.includes("SEM VÍNCULO"));
    assert.ok(stranger.includes("SEM VÍNCULO"));
  });
});

/** Playbooks que mandam ler a thread não podem voltar a citar o comando quebrado como instrução. */
function collectMarkdown(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) collectMarkdown(p, out);
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

describe("#13285 — playbooks não instruem `gh issue view --comments`", () => {
  // Menção permitida: na mesma linha do helper, ou como registro do defeito
  // (cita #7572/#13285, como o prompt do hermes-diaria-continuo, que já usa REST).
  const allowed = ["read-issue-thread.ts", "#7572", "#13285"];
  it("toda menção ao comando quebrado aponta o helper REST ou registra o defeito", () => {
    const files = [
      ...collectMarkdown(join(ROOT, ".claude", "skills")),
      ...collectMarkdown(join(ROOT, ".claude", "agents")),
      ...collectMarkdown(join(ROOT, "hermes", "skills")),
      ...collectMarkdown(join(ROOT, "context")).filter((f) => !f.includes(`${join("context", "snippets")}`)),
    ];
    assert.ok(files.length > 10, "varredura achou os playbooks");
    const offenders: string[] = [];
    const broken = /gh issue view\b[^`\n]*\s--comments\b/;
    for (const f of files) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (broken.test(line) && !allowed.some((a) => line.includes(a))) {
            offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}`);
          }
        });
    }
    assert.deepEqual(offenders, [], "use `npx tsx scripts/read-issue-thread.ts --issue N` (#13285)");
  });
});

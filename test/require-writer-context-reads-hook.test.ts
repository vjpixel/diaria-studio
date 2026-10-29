import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  REQUIRED_READS,
  MAX_DENIES,
  handlePayload,
  missingRequiredReads,
  readCovers,
  readRegistry,
} from "../.claude/hooks/require-writer-context-reads.mjs";

// #11533 — agents de escrita gravavam o output sem ler o contexto obrigatório
// (edição 261029: writer-destaque D1 leu 2 de 4; social-writer não leu
// social-instagram.md nem editorial-rules.md). O hook registra os Reads e nega
// o Write enquanto faltar algum.

const ROOT = "/repo";
const allExist = () => true;
const noLog = () => {};

function read(agent_type: string, agent_id: string, file_path: string) {
  return { hook_event_name: "PostToolUse", tool_name: "Read", agent_type, agent_id, tool_input: { file_path } };
}
function write(agent_type: string | undefined, agent_id: string | undefined, file_path = "/repo/data/editions/261029/_internal/02-d1-draft.md") {
  return { hook_event_name: "PreToolUse", tool_name: "Write", agent_type, agent_id, tool_input: { file_path, content: "x" } };
}

describe("require-writer-context-reads (#11533)", () => {
  let dir: string;
  const opts = () => ({ dir, root: ROOT, exists: allExist, log: noLog });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wctx-"));
  });

  it("cenário real 261029: writer-destaque que leu 2 de 4 é negado, com os 2 caminhos que faltam", () => {
    handlePayload(read("writer-destaque", "a1", "/repo/context/templates/newsletter.md"), opts());
    handlePayload(read("writer-destaque", "a1", "/repo/data/editions/261029/_internal/01-approved.json"), opts());
    handlePayload(read("writer-destaque", "a1", "/repo/context/editorial-rules.md"), opts());
    const r = handlePayload(write("writer-destaque", "a1"), opts());
    assert.equal(r.action, "deny");
    assert.deepEqual((r as { missing: string[] }).missing, ["context/audience-profile.md", "data/past-editions-recent.md"]);
    assert.match((r as { reason: string }).reason, /\/repo\/context\/audience-profile\.md/);
  });

  it("depois de ler o que faltava, o Write passa", () => {
    for (const p of REQUIRED_READS["writer-destaque"]) handlePayload(read("writer-destaque", "a2", `/repo/${p}`), opts());
    assert.equal(handlePayload(write("writer-destaque", "a2"), opts()).action, "allow");
  });

  it("social-writer sem social-instagram.md é negado; registros de agents diferentes não se misturam", () => {
    handlePayload(read("social-writer", "s1", "/repo/context/editorial-rules.md"), opts());
    for (const p of REQUIRED_READS["social-writer"]) handlePayload(read("social-writer", "s2", `/repo/${p}`), opts());
    const r1 = handlePayload(write("social-writer", "s1"), opts());
    assert.equal(r1.action, "deny");
    assert.deepEqual((r1 as { missing: string[] }).missing, ["context/templates/social-instagram.md"]);
    assert.equal(handlePayload(write("social-writer", "s2"), opts()).action, "allow");
  });

  it("social-curto exige editorial-rules.md", () => {
    assert.equal(handlePayload(write("social-curto", "c1"), opts()).action, "deny");
    handlePayload(read("social-curto", "c1", "context\\editorial-rules.md"), opts());
    assert.equal(handlePayload(write("social-curto", "c1"), opts()).action, "allow");
  });

  it("teto de negações: depois de MAX_DENIES o Write passa (nunca trava a edição) e loga warn", () => {
    const logs: string[] = [];
    const o = { ...opts(), log: (_r: string, _a: string, level: string) => logs.push(level) };
    for (let i = 0; i < MAX_DENIES; i++) assert.equal(handlePayload(write("social-curto", "c2"), o).action, "deny");
    const r = handlePayload(write("social-curto", "c2"), o);
    assert.equal(r.action, "allow");
    assert.equal((r as { capped?: boolean }).capped, true);
    assert.equal(logs.at(-1), "warn");
    assert.equal(readRegistry(dir, "c2").denies, MAX_DENIES);
  });

  it("arquivo obrigatório inexistente no disco não é exigido", () => {
    const exists = (p: string) => !p.replaceAll("\\", "/").endsWith("data/past-editions-recent.md");
    const o = { ...opts(), exists };
    for (const p of REQUIRED_READS["writer-destaque"].filter((x: string) => !x.startsWith("data/")))
      handlePayload(read("writer-destaque", "a3", `/repo/${p}`), o);
    assert.equal(handlePayload(write("writer-destaque", "a3"), o).action, "allow");
  });

  it("fail-open: outro agent, sem agent_type ou sem agent_id nunca bloqueia nem registra", () => {
    assert.equal(handlePayload(write("writer", "w1"), opts()).action, "skip");
    assert.equal(handlePayload(write(undefined, "w1"), opts()).action, "skip");
    assert.equal(handlePayload(write("writer-destaque", undefined), opts()).action, "skip");
    assert.equal(handlePayload(null, opts()).action, "skip");
    assert.equal(handlePayload(read("writer", "w1", "/repo/context/editorial-rules.md"), opts()).action, "skip");
    assert.equal(existsSync(join(dir, "w1.log")), false);
  });

  it("readCovers casa por segmento inteiro e recusa traversal", () => {
    assert.equal(readCovers("/x/diaria-studio/context/editorial-rules.md", "context/editorial-rules.md"), true);
    assert.equal(readCovers("C:\\x\\context\\editorial-rules.md", "context/editorial-rules.md"), true);
    assert.equal(readCovers("context/editorial-rules.md", "context/editorial-rules.md"), true);
    assert.equal(readCovers("/x/mycontext/editorial-rules.md", "context/editorial-rules.md"), false);
    assert.equal(readCovers("/x/context/editorial-rules.md.bak", "context/editorial-rules.md"), false);
    assert.equal(readCovers("/x/../context/editorial-rules.md", "context/editorial-rules.md"), false);
    assert.equal(readCovers("/x/data/past-editions.md", "data/past-editions-recent.md"), false);
  });

  it("missingRequiredReads ignora agent desconhecido", () => {
    assert.deepEqual(missingRequiredReads("fact-checker", [], { root: ROOT, exists: allExist }), []);
  });

  it("paridade: todo caminho exigido está citado no .md do agent e os de context/ existem no repo", () => {
    for (const [agent, paths] of Object.entries(REQUIRED_READS)) {
      const md = readFileSync(join(process.cwd(), ".claude/agents", `${agent}.md`), "utf8");
      for (const p of paths as readonly string[]) {
        assert.ok(md.includes(p), `${agent}.md não cita ${p}`);
        if (p.startsWith("context/")) assert.ok(existsSync(join(process.cwd(), p)), `${p} não existe`);
      }
    }
  });

  it("armado: settings.json registra o hook em PreToolUse/Write e PostToolUse/Read", () => {
    const settings = JSON.parse(readFileSync(join(process.cwd(), ".claude/settings.json"), "utf8"));
    const has = (event: string, matcher: string) =>
      (settings.hooks[event] as Array<{ matcher?: string; hooks: Array<{ args?: string[] }> }>).some(
        (e) => e.matcher === matcher && e.hooks.some((h) => (h.args ?? []).some((a) => a.endsWith("require-writer-context-reads.mjs"))),
      );
    assert.ok(has("PreToolUse", "Write"));
    assert.ok(has("PostToolUse", "Read"));
  });

  it("CLI: payload sem agent sai sem output (fail-open)", () => {
    const res = spawnSync(process.execPath, [".claude/hooks/require-writer-context-reads.mjs"], {
      input: JSON.stringify(write(undefined, undefined)),
      encoding: "utf8",
    });
    assert.equal(res.status, 0);
    assert.equal(res.stdout, "");
  });
});

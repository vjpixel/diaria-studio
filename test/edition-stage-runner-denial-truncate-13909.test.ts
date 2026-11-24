import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DENIAL_DETAIL_MAX_CHARS,
  redactDenialSecrets,
  runEditionStages,
  summarizeDenialDetail,
  summarizePermissionDenials,
} from "../scripts/lib/edition-stage-runner.ts";

// #13909: um Write negado carrega o arquivo inteiro em tool_input.content, e um
// Bash negado pode carregar segredo literal no comando. Nada disso pode ir
// inteiro para o failureTail nem para data/run-log.jsonl.
const bigContent = "LINHA DO ARQUIVO GERADO ".repeat(4000); // ~96 KB
const secretKey = "sk-ant-api03-" + "A".repeat(60);
const ghToken = "ghp_" + "b".repeat(36);
const denials = [
  { tool_name: "Write", tool_input: { file_path: "/repo/data/editions/261124/02-reviewed.md", content: bigContent }, tool_use_id: "toolu_1" },
  { tool_name: "Bash", tool_input: { command: `ANTHROPIC_API_KEY=${secretKey} curl -H "Authorization: Bearer ${ghToken}" https://x` }, message: "PreToolUse: hook denied" },
];
const stdout = JSON.stringify({ result: "PRIVATE STAGE OUTPUT", permission_denials: denials });

it("#13909 detalhe de Write grande vira caminho + tamanho, truncado no teto", () => {
  const detail = summarizeDenialDetail(denials[0]);
  assert.match(detail, /^Write file_path="\/repo\/data\/editions\/261124\/02-reviewed\.md"/);
  assert.match(detail, new RegExp(`content=<${bigContent.length} chars>`));
  assert.doesNotMatch(detail, /LINHA DO ARQUIVO/);
  assert.doesNotMatch(detail, /toolu_1/);
  assert.ok(detail.length <= DENIAL_DETAIL_MAX_CHARS);

  const long = summarizeDenialDetail({ tool_name: "Bash", tool_input: { command: "echo " + "x ".repeat(1000) } });
  assert.equal(long.length, DENIAL_DETAIL_MAX_CHARS);
  assert.ok(long.endsWith("…"));
});

it("#13909 segredo do comando Bash negado é redigido, diagnóstico do hook preservado", () => {
  const detail = summarizeDenialDetail(denials[1]);
  assert.match(detail, /^Bash command=/);
  assert.match(detail, /PreToolUse: hook denied/);
  assert.match(detail, /ANTHROPIC_API_KEY=\[REDACTED\]/);
  assert.match(detail, /Authorization: Bearer \[REDACTED\]/);
  assert.ok(!detail.includes(secretKey));
  assert.ok(!detail.includes(ghToken));
});

it("#13909 redactDenialSecrets cobre formatos de provedor e KEY=valor sem apagar texto comum", () => {
  assert.equal(redactDenialSecrets(`token: ${"z".repeat(10)}`), "token: [REDACTED]");
  assert.equal(redactDenialSecrets(`x ${ghToken} y`), "x [REDACTED] y");
  assert.equal(redactDenialSecrets("npx tsx scripts/gen-eia.ts 261124"), "npx tsx scripts/gen-eia.ts 261124");
});

it("#13909 resumo inteiro fica curto e sem segredo", () => {
  const summary = summarizePermissionDenials(stdout)!;
  assert.match(summary, /^2 permission_denials \(/);
  assert.ok(summary.length < 2 * DENIAL_DETAIL_MAX_CHARS + 120, `resumo com ${summary.length} chars`);
  assert.ok(!summary.includes(secretKey));
  assert.ok(!summary.includes(ghToken));
  assert.doesNotMatch(summary, /LINHA DO ARQUIVO|PRIVATE STAGE OUTPUT/);
});

it("#13909 failureTail e run-log recebem o resumo truncado e redigido", () => {
  const root = mkdtempSync(join(tmpdir(), "denials-13909-"));
  try {
    const result = runEditionStages({
      aammdd: "261124", editionDir: join(root, "edition"), repoRootAbs: root,
      plan: [{ stage: 2, skill: "diaria-2-escrita" }],
      resolveClaudeBin: () => "/bin/claude", env: {}, nowMs: () => 0,
      execFn: (() => stdout) as never,
      assertSentinelFn: (() => ({ ok: false, reason: "sentinel_missing", missingOutputs: [] })) as never,
    });
    const tail = result.outcomes[0].failureTail!;
    assert.ok(!tail.includes(secretKey) && !tail.includes(ghToken));
    assert.doesNotMatch(tail, /LINHA DO ARQUIVO/);
    const log = readFileSync(join(root, "data/run-log.jsonl"), "utf8");
    assert.ok(log.length < 4000, `run-log com ${log.length} bytes`);
    assert.ok(!log.includes(secretKey) && !log.includes(ghToken));
    assert.doesNotMatch(log, /LINHA DO ARQUIVO/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

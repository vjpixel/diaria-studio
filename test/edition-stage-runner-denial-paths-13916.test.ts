import { it } from "node:test";
import assert from "node:assert/strict";
import { redactDenialSecrets, summarizeDenialDetail } from "../scripts/lib/edition-stage-runner.ts";

// #13916: o padrão genérico de token opaco (40+ chars de [A-Za-z0-9_-]) rodava
// sobre o detalhe inteiro e apagava caminho longo de arquivo, deixando o Write
// negado sem dizer qual arquivo era.
const longPath = "test/edition-stage-runner-denial-truncate-13909.test.ts";
const camelPath = "/repo/scripts/studio-ui/ScheduledTasksRegistryPanelWithFilters.tsx";
const opaque = "Zx9" + "aB3dE5fG7hJ".repeat(4); // 47 chars, base64url-like

it("#13916 file_path longo em kebab sobrevive no detalhe do Write negado", () => {
  const detail = summarizeDenialDetail({ tool_name: "Write", tool_input: { file_path: longPath, content: "x" } });
  assert.match(detail, /file_path="test\/edition-stage-runner-denial-truncate-13909\.test\.ts"/);
  assert.doesNotMatch(detail, /REDACTED/);
});

it("#13916 campo de caminho não passa pelo genérico, nem com componente CamelCase longo", () => {
  const detail = summarizeDenialDetail({ tool_name: "Edit", tool_input: { file_path: camelPath } });
  assert.ok(detail.includes(camelPath), detail);
  const grep = summarizeDenialDetail({ tool_name: "Grep", tool_input: { pattern: "x", path: camelPath } });
  assert.ok(grep.includes(camelPath), grep);
});

it("#13916 nome de branch/worktree em kebab no comando é preservado", () => {
  const cmd = "git push -u origin overnight/fix-13916-redacao-generica-preserva-caminhos";
  const detail = summarizeDenialDetail({ tool_name: "Bash", tool_input: { command: cmd } });
  assert.ok(detail.includes("fix-13916-redacao-generica-preserva-caminhos"), detail);
});

it("#13916 token opaco segue redigido no comando, na url e nos campos de diagnóstico", () => {
  const bash = summarizeDenialDetail({ tool_name: "Bash", tool_input: { command: `curl https://x/hook/${opaque}` } });
  assert.ok(!bash.includes(opaque), bash);
  assert.match(bash, /\[REDACTED\]/);
  const msg = summarizeDenialDetail({ tool_name: "Bash", tool_input: { command: "ls" }, message: `leak ${opaque}` });
  assert.ok(!msg.includes(opaque), msg);
  // SHA/hex de 40 sem separador também é formato de token (GitHub clássico): segue redigido.
  const hex = "0123456789abcdef".repeat(3).slice(0, 40);
  assert.equal(redactDenialSecrets(`git show ${hex}`), "git show [REDACTED]");
});

it("#13916 campo de caminho ainda redige formato de provedor", () => {
  const gh = "ghp_" + "b".repeat(36);
  const detail = summarizeDenialDetail({ tool_name: "Write", tool_input: { file_path: `/tmp/${gh}.txt` } });
  assert.ok(!detail.includes(gh), detail);
});

it("#13916 kebab com segmento longo ou caixa mista não ganha a exceção", () => {
  assert.equal(redactDenialSecrets(`a ${"q".repeat(33)}-ab-cd-ef b`), "a [REDACTED] b");
  assert.equal(redactDenialSecrets("x Abc-defghijklmnop-qrstuvwxyz-0123456789ab y"), "x [REDACTED] y");
});

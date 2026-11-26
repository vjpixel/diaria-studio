import { it } from "node:test";
import assert from "node:assert/strict";
import { redactDenialSecrets, summarizeDenialDetail } from "../scripts/lib/edition-stage-runner.ts";

const phrase = "correct-horse-battery-staple-purple-monkey";

it("#13965 contexto de senha redige frase hifenizada sem KEY=, inclusive entre aspas no JSON", () => {
  for (const flag of ["password", "passwd", "passphrase", "senha"]) {
    for (const quote of ["", "'", '"']) {
      const command = `client --${flag} ${quote}${phrase}${quote} --verbose`;
      assert.equal(redactDenialSecrets(command), `client --${flag} ${quote}[REDACTED]${quote} --verbose`);
      const detail = summarizeDenialDetail({ tool_name: "Bash", tool_input: { command } });
      assert.ok(!detail.includes(phrase), detail);
      assert.ok(detail.includes("[REDACTED]"), detail);
      assert.ok(detail.includes("--verbose"), detail);
    }
  }
});

it("#13965 contexto não sensível preserva caminhos, branches e argumentos hifenizados", () => {
  for (const command of [
    `cat test/${phrase}.test.ts`,
    `git push origin continuo/${phrase}`,
    `client --output /tmp/${phrase}.json`,
    `client --password-file /tmp/${phrase}.txt`,
    `client ${phrase}`, // Sem contexto, indistinguível de um slug legítimo.
  ]) {
    assert.equal(redactDenialSecrets(command), command);
    const detail = summarizeDenialDetail({ tool_name: "Bash", tool_input: { command } });
    assert.ok(detail.includes(phrase), detail);
  }
});

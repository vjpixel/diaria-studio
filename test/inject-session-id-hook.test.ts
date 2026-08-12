/**
 * test/inject-session-id-hook.test.ts (#5156)
 *
 * Cobre a lógica PURA de `.claude/hooks/inject-session-id.mjs` — injeta
 * `--session-id {payload.session_id}` em chamadas standalone de
 * `overnight-session-marker.ts --start`/`--phase` e `session-registry.ts
 * {register,heartbeat,end,claim-issue,is-claimed,merge-lock-acquire,merge-lock-release}`
 * que ainda não trazem a flag. Sem I/O — as funções exportadas são puras.
 *
 * #5161 fleet review item 10 (pr-test-analyzer): o describe "CLI end-to-end"
 * no final exercita o HARNESS real (stdin real via processo filho) — este
 * hook roda em TODA chamada Bash uma vez wireado (o de maior tráfego deste
 * PR) e é fail-open por design; um bug de parsing de stdin ou de path-
 * matching não erraria, só silenciosamente NUNCA injetaria a flag,
 * desligando o mecanismo #5156 inteiro sem aviso — só as 5 funções puras
 * nunca exercitariam esse caminho. Mesmo padrão de `test/notify-sound-hook.test.ts`
 * (spawnSync do processo real, #4830).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  isChainedCommand,
  needsSessionId,
  alreadyHasSessionId,
  shellSingleQuote,
  buildUpdatedCommand,
} from "../.claude/hooks/inject-session-id.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookPath = join(__dirname, "..", ".claude", "hooks", "inject-session-id.mjs");

describe("isChainedCommand", () => {
  it("comando simples não é encadeado", () => {
    assert.equal(isChainedCommand("npx tsx scripts/overnight-session-marker.ts --start"), false);
  });

  it("&&, ;, | e || marcam como encadeado", () => {
    assert.equal(isChainedCommand("git pull && npx tsx scripts/overnight-session-marker.ts --start"), true);
    assert.equal(isChainedCommand("npx tsx scripts/overnight-session-marker.ts --start; echo ok"), true);
    assert.equal(isChainedCommand("cat x | npx tsx scripts/overnight-session-marker.ts --start"), true);
    assert.equal(isChainedCommand("npx tsx scripts/overnight-session-marker.ts --start || echo fail"), true);
  });

  it("newline embutido (script Bash multi-linha) também marca como encadeado (#5161 item 6)", () => {
    assert.equal(
      isChainedCommand("npx tsx scripts/lib/session-registry.ts register --kind overnight\necho done"),
      true,
    );
    assert.equal(
      isChainedCommand("npx tsx scripts/lib/session-registry.ts register --kind overnight\r\necho done"),
      true,
    );
  });
});

describe("needsSessionId", () => {
  it("overnight-session-marker.ts --start → true", () => {
    assert.equal(needsSessionId("npx tsx scripts/overnight-session-marker.ts --start"), true);
  });

  it("overnight-session-marker.ts --phase autonomous → true", () => {
    assert.equal(needsSessionId("npx tsx scripts/overnight-session-marker.ts --phase autonomous"), true);
  });

  it("overnight-session-marker.ts --end → false (leitura/remoção, session_id irrelevante)", () => {
    assert.equal(needsSessionId("npx tsx scripts/overnight-session-marker.ts --end"), false);
  });

  it("session-registry.ts register/heartbeat/end/claim-issue/is-claimed/merge-lock-* → true", () => {
    for (const sub of ["register", "heartbeat", "end", "claim-issue", "is-claimed", "merge-lock-acquire", "merge-lock-release"]) {
      assert.equal(
        needsSessionId(`npx tsx scripts/lib/session-registry.ts ${sub} --kind overnight`),
        true,
        `esperava true para subcomando ${sub}`,
      );
    }
  });

  it("session-registry.ts list-active → false (leitura pura, sem noção de sessão atual)", () => {
    assert.equal(needsSessionId("npx tsx scripts/lib/session-registry.ts list-active"), false);
  });

  it(
    "session-registry.ts is-claimed → true (#5161 item 4: recebe --session-id como excludeSessionId, " +
      "senão uma sessão vê o PRÓPRIO claim como 'de outra sessão' ao reavaliar numa onda posterior)",
    () => {
      assert.equal(needsSessionId("npx tsx scripts/lib/session-registry.ts is-claimed --issue 1"), true);
    },
  );

  it("comando encadeado nunca é candidato, mesmo citando o script-alvo", () => {
    assert.equal(
      needsSessionId("git checkout master && npx tsx scripts/overnight-session-marker.ts --start"),
      false,
    );
  });

  it("comando não relacionado → false", () => {
    assert.equal(needsSessionId("npm test"), false);
    assert.equal(needsSessionId(""), false);
    assert.equal(needsSessionId(undefined), false);
  });
});

describe("alreadyHasSessionId", () => {
  it("detecta --session-id já presente", () => {
    assert.equal(
      alreadyHasSessionId("npx tsx scripts/overnight-session-marker.ts --start --session-id abc"),
      true,
    );
  });

  it("false quando ausente", () => {
    assert.equal(alreadyHasSessionId("npx tsx scripts/overnight-session-marker.ts --start"), false);
  });
});

describe("shellSingleQuote", () => {
  it("envolve em aspas simples", () => {
    assert.equal(shellSingleQuote("abc-123"), "'abc-123'");
  });

  it("escapa aspas simples embutidas com segurança", () => {
    assert.equal(shellSingleQuote("a'b"), `'a'\\''b'`);
  });
});

describe("buildUpdatedCommand (#5156)", () => {
  it("injeta --session-id em overnight-session-marker.ts --start sem a flag", () => {
    const result = buildUpdatedCommand("npx tsx scripts/overnight-session-marker.ts --start", "sess-abc");
    assert.equal(result, "npx tsx scripts/overnight-session-marker.ts --start --session-id 'sess-abc'");
  });

  it("injeta --session-id em session-registry.ts register", () => {
    const result = buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts register --kind overnight", "sess-abc");
    assert.equal(result, "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id 'sess-abc'");
  });

  it("retorna null quando o comando já tem --session-id (nunca sobrescreve)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/overnight-session-marker.ts --start --session-id ja-presente",
      "sess-novo",
    );
    assert.equal(result, null);
  });

  it("retorna null quando sessionId está ausente/vazio", () => {
    assert.equal(buildUpdatedCommand("npx tsx scripts/overnight-session-marker.ts --start", undefined), null);
    assert.equal(buildUpdatedCommand("npx tsx scripts/overnight-session-marker.ts --start", ""), null);
  });

  it("retorna null pra comando não-relacionado (fail-open — nunca modifica por engano)", () => {
    assert.equal(buildUpdatedCommand("npm test", "sess-abc"), null);
  });

  it("retorna null pra comando encadeado, mesmo citando o script-alvo", () => {
    assert.equal(
      buildUpdatedCommand("git pull && npx tsx scripts/overnight-session-marker.ts --start", "sess-abc"),
      null,
    );
  });

  it("retorna null pra list-active (leitura pura, sem noção de sessão atual)", () => {
    assert.equal(buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts list-active", "sess-abc"), null);
  });

  it("injeta --session-id em session-registry.ts is-claimed (#5161 item 4)", () => {
    const result = buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts is-claimed --issue 1", "sess-abc");
    assert.equal(result, "npx tsx scripts/lib/session-registry.ts is-claimed --issue 1 --session-id 'sess-abc'");
  });

  it("retorna null pra script-alvo com script multi-linha (newline embutido, #5161 item 6)", () => {
    const result = buildUpdatedCommand(
      "npx tsx scripts/lib/session-registry.ts register --kind overnight\necho done",
      "sess-abc",
    );
    assert.equal(result, null);
  });
});

describe("CLI end-to-end — harness real via stdin (#5161 fleet review item 10)", () => {
  it("PreToolUse Bash real (payload via stdin) → injeta --session-id no updatedInput.command emitido", () => {
    const payload = {
      session_id: "sess-real-abc",
      tool_name: "Bash",
      tool_input: { command: "npx tsx scripts/lib/session-registry.ts register --kind overnight" },
    };
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(
      output.hookSpecificOutput.updatedInput.command,
      "npx tsx scripts/lib/session-registry.ts register --kind overnight --session-id 'sess-real-abc'",
    );
  });

  it("comando não-alvo (ex: npm test) via stdin real → nenhum stdout emitido", () => {
    const payload = { session_id: "sess-real-abc", tool_name: "Bash", tool_input: { command: "npm test" } };
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trim(), "");
  });

  it("tool_name diferente de Bash via stdin real → nenhum stdout emitido (guard defensivo)", () => {
    const payload = { session_id: "sess-real-abc", tool_name: "Read", tool_input: {} };
    const result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });

  it("payload JSON malformado no stdin real → fail-open, exit 0, sem stdout/stderr", () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: "{not valid json",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
    assert.equal(result.stderr, "");
  });

  it("stdin vazio (payload ausente) via processo real → fail-open, exit 0, sem stdout", () => {
    const result = spawnSync(process.execPath, [hookPath], {
      input: "",
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "");
  });
});

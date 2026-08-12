/**
 * test/inject-session-id-hook.test.ts (#5156)
 *
 * Cobre a lógica PURA de `.claude/hooks/inject-session-id.mjs` — injeta
 * `--session-id {payload.session_id}` em chamadas standalone de
 * `overnight-session-marker.ts --start`/`--phase` e `session-registry.ts
 * {register,heartbeat,end,claim-issue,merge-lock-acquire,merge-lock-release}`
 * que ainda não trazem a flag. Sem I/O — as funções exportadas são puras.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isChainedCommand,
  needsSessionId,
  alreadyHasSessionId,
  shellSingleQuote,
  buildUpdatedCommand,
} from "../.claude/hooks/inject-session-id.mjs";

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

  it("session-registry.ts register/heartbeat/end/claim-issue/merge-lock-* → true", () => {
    for (const sub of ["register", "heartbeat", "end", "claim-issue", "merge-lock-acquire", "merge-lock-release"]) {
      assert.equal(
        needsSessionId(`npx tsx scripts/lib/session-registry.ts ${sub} --kind overnight`),
        true,
        `esperava true para subcomando ${sub}`,
      );
    }
  });

  it("session-registry.ts list-active/is-claimed → false (leitura, não precisa de identidade)", () => {
    assert.equal(needsSessionId("npx tsx scripts/lib/session-registry.ts list-active"), false);
    assert.equal(needsSessionId("npx tsx scripts/lib/session-registry.ts is-claimed --issue 1"), false);
  });

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

  it("retorna null pra subcomandos de leitura (list-active/is-claimed)", () => {
    assert.equal(buildUpdatedCommand("npx tsx scripts/lib/session-registry.ts list-active", "sess-abc"), null);
  });
});

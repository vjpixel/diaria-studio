/**
 * test/studio-wave-fire.test.ts (#3702) — cobertura das camadas puras de
 * scripts/studio-ui/studio-wave-fire.ts: parsing do corpo de
 * `POST /api/waves/fire`, construção do prompt da sessão coordenadora, o
 * guard de publicação como decisão pura, e `runWaveFire` (I/O real do SDK)
 * exercido com um `queryFn` mockado — mesmo padrão de
 * `test/studio-chat.test.ts` (#3556): sem spawnar o CLI real, sem depender
 * de rede/auth.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  parseWaveFireRequestBody,
  buildWaveFireCoordinatorPrompt,
  evaluateWaveTool,
  runWaveFire,
  type QueryFn,
} from "../scripts/studio-ui/studio-wave-fire.ts";
import type { ChatWireEvent } from "../scripts/studio-ui/studio-chat.ts";

describe("parseWaveFireRequestBody (#3702)", () => {
  it("aceita um corpo válido com issueNumbers", () => {
    const result = parseWaveFireRequestBody(JSON.stringify({ issueNumbers: [101, 102] }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.issueNumbers, [101, 102]);
  });

  it("rejeita JSON inválido", () => {
    assert.equal(parseWaveFireRequestBody("{not json").ok, false);
  });

  it("rejeita corpo que não é objeto", () => {
    assert.equal(parseWaveFireRequestBody(JSON.stringify([1, 2])).ok, false);
    assert.equal(parseWaveFireRequestBody(JSON.stringify("oi")).ok, false);
  });

  it("rejeita 'issueNumbers' ausente ou vazio", () => {
    assert.equal(parseWaveFireRequestBody(JSON.stringify({})).ok, false);
    assert.equal(parseWaveFireRequestBody(JSON.stringify({ issueNumbers: [] })).ok, false);
  });

  it("rejeita itens não-inteiros, não-positivos, ou de tipo errado", () => {
    assert.equal(parseWaveFireRequestBody(JSON.stringify({ issueNumbers: [1.5] })).ok, false);
    assert.equal(parseWaveFireRequestBody(JSON.stringify({ issueNumbers: [0] })).ok, false);
    assert.equal(parseWaveFireRequestBody(JSON.stringify({ issueNumbers: [-3] })).ok, false);
    assert.equal(parseWaveFireRequestBody(JSON.stringify({ issueNumbers: ["101"] })).ok, false);
  });

  it("rejeita duplicatas", () => {
    const result = parseWaveFireRequestBody(JSON.stringify({ issueNumbers: [101, 101] }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /duplicata/);
  });

  it("rejeita listas maiores que o teto de concorrência (default 6)", () => {
    const result = parseWaveFireRequestBody(JSON.stringify({ issueNumbers: [1, 2, 3, 4, 5, 6, 7] }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /teto de concorrência/);
  });

  it("respeita maxConcurrency customizado", () => {
    const result = parseWaveFireRequestBody(JSON.stringify({ issueNumbers: [1, 2, 3] }), { maxConcurrency: 2 });
    assert.equal(result.ok, false);
  });
});

describe("buildWaveFireCoordinatorPrompt (#3702)", () => {
  it("lista todas as issues da onda", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101, 202, 303]);
    assert.match(prompt, /#101/);
    assert.match(prompt, /#202/);
    assert.match(prompt, /#303/);
  });

  it("cita o checklist canônico de dispatch rules", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101]);
    assert.match(prompt, /context\/overnight-dispatch-rules\.md/);
  });

  it("aceita path customizado do checklist (parametrização de teste)", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101], { dispatchRulesPath: "context/fake-rules.md" });
    assert.match(prompt, /context\/fake-rules\.md/);
  });

  it("instrui isolation: worktree + model sonnet explícito por unidade", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101]);
    assert.match(prompt, /isolation: "worktree"/);
    assert.match(prompt, /model: "sonnet"/);
  });

  it("instrui convenção de branch develop/fix-{numero}", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101]);
    assert.match(prompt, /develop\/fix-\{numero\}/);
  });

  it("instrui o teto de concorrência (default 6, ou customizado)", () => {
    assert.match(buildWaveFireCoordinatorPrompt([101]), /teto de concorrência 6/);
    assert.match(buildWaveFireCoordinatorPrompt([101], { maxConcurrency: 3 }), /teto de concorrência 3/);
  });

  it("instrui o gate de merge serial (nunca 2 merges ao mesmo tempo)", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101]);
    assert.match(prompt, /MERGE É SEMPRE SERIAL/);
    assert.match(prompt, /nunca rode dois.*gh pr merge.*ao mesmo tempo/);
  });

  it("instrui o Gate 2 determinístico (checks + threads não-resolvidas)", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101]);
    assert.match(prompt, /gh pr checks/);
    assert.match(prompt, /gh api graphql/);
    assert.match(prompt, /FORBIDDEN/);
  });

  it("proíbe AskUserQuestion (mesma Regra 1 do overnight — sessão headless, sem editor presente)", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101]);
    assert.match(prompt, /AskUserQuestion é proibido/);
  });

  it("proíbe mutar o working tree da pasta principal (colisão com sessão manual, incidente 260716)", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101]);
    assert.match(prompt, /git checkout.*git pull.*git stash/);
  });

  it("reafirma o guard de publicação (scripts/publish-*, clarice-schedule-sends, close-poll, Beehiiv/LinkedIn/Facebook/Brevo)", () => {
    const prompt = buildWaveFireCoordinatorPrompt([101]);
    assert.match(prompt, /scripts\/publish-\*/);
    assert.match(prompt, /clarice-schedule-sends/);
    assert.match(prompt, /close-poll/);
    assert.match(prompt, /Beehiiv\/LinkedIn\/Facebook\/Brevo/);
  });
});

describe("evaluateWaveTool (#3702) — guard de publicação como código", () => {
  it("nega Bash que roda scripts/publish-*", () => {
    const decision = evaluateWaveTool("Bash", { command: "npx tsx scripts/publish-newsletter.ts --edition 260420" });
    assert.equal(decision.allow, false);
    assert.match(decision.reason ?? "", /guard de publicação/);
  });

  it("nega Bash que roda clarice-schedule-sends", () => {
    const decision = evaluateWaveTool("Bash", { command: "npx tsx scripts/clarice-schedule-sends.ts" });
    assert.equal(decision.allow, false);
  });

  it("nega Bash que roda clarice-import-*", () => {
    const decision = evaluateWaveTool("Bash", { command: "npx tsx scripts/clarice-import-waves.ts --cycle 2605-06" });
    assert.equal(decision.allow, false);
  });

  it("nega Bash que roda close-poll.ts", () => {
    const decision = evaluateWaveTool("Bash", { command: "npx tsx scripts/close-poll.ts --edition 260420" });
    assert.equal(decision.allow, false);
  });

  it("nega Bash que menciona Beehiiv/LinkedIn/Facebook/Brevo mesmo fora do padrão scripts/publish-*", () => {
    assert.equal(evaluateWaveTool("Bash", { command: "curl https://api.brevo.com/v3/whatever" }).allow, false);
    assert.equal(evaluateWaveTool("Bash", { command: "echo testing linkedin webhook" }).allow, false);
  });

  it("nega por padrão qualquer tool NÃO coberta pelo blocklist (conservador — sem editor presente)", () => {
    const decision = evaluateWaveTool("Bash", { command: "gh api graphql -f query=whatever" });
    assert.equal(decision.allow, false);
    assert.match(decision.reason ?? "", /confirmação interativa/);
  });

  it("nunca allow=true na implementação atual (documentado — settings.json resolve os casos legítimos ANTES desta função ser chamada)", () => {
    assert.equal(evaluateWaveTool("Agent", {}).allow, false);
    assert.equal(evaluateWaveTool("Read", { file_path: "foo.ts" }).allow, false);
  });
});

describe("runWaveFire (#3702) — com queryFn mockado (sem SDK real)", () => {
  it("monta o prompt com as issues certas e passa cwd/permissionMode/canUseTool pro SDK", async () => {
    let capturedPrompt = "";
    let capturedOptions: Record<string, unknown> = {};
    const fakeQuery: QueryFn = (params) => {
      capturedPrompt = params.prompt;
      capturedOptions = (params.options ?? {}) as Record<string, unknown>;
      async function* gen() {
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };

    const received: ChatWireEvent[] = [];
    await runWaveFire({
      issueNumbers: [101, 202],
      cwd: "/repo",
      queryFn: fakeQuery,
      onEvent: (e) => received.push(e),
    });

    assert.match(capturedPrompt, /#101/);
    assert.match(capturedPrompt, /#202/);
    assert.equal(capturedOptions.cwd, "/repo");
    assert.equal(capturedOptions.permissionMode, "default");
    assert.equal(typeof capturedOptions.canUseTool, "function");
    assert.equal(received.length, 1);
    assert.equal(received[0].event, "chat-done");
  });

  it("traduz tool calls (Agent, Bash) via o mesmo tradutor do chat drawer", async () => {
    const fakeMessages: SDKMessage[] = [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "tu-1", name: "Agent", input: { issue: 101 } }],
        },
      } as unknown as SDKMessage,
      { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" } as unknown as SDKMessage,
    ];
    const fakeQuery: QueryFn = () => {
      async function* gen() {
        for (const m of fakeMessages) yield m;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };

    const received: ChatWireEvent[] = [];
    await runWaveFire({ issueNumbers: [101], cwd: "/repo", queryFn: fakeQuery, onEvent: (e) => received.push(e) });

    assert.equal(received.length, 2);
    assert.equal(received[0].event, "chat-tool");
    if (received[0].event === "chat-tool" && received[0].data.status === "start") {
      assert.equal(received[0].data.name, "Agent");
    }
    assert.equal(received[1].event, "chat-done");
  });

  it("fail-soft: queryFn que lança vira um único evento chat-error, nunca propaga", async () => {
    const throwingQuery: QueryFn = () => {
      throw new Error("spawn claude ENOENT");
    };
    const received: ChatWireEvent[] = [];
    await assert.doesNotReject(
      runWaveFire({ issueNumbers: [101], cwd: "/repo", queryFn: throwingQuery, onEvent: (e) => received.push(e) }),
    );
    assert.equal(received.length, 1);
    assert.equal(received[0].event, "chat-error");
  });

  it("respeita maxConcurrency customizado no prompt gerado", async () => {
    let capturedPrompt = "";
    const fakeQuery: QueryFn = (params) => {
      capturedPrompt = params.prompt;
      async function* gen() {
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" } as unknown as SDKMessage;
      }
      return gen() as unknown as ReturnType<QueryFn>;
    };
    await runWaveFire({
      issueNumbers: [101],
      cwd: "/repo",
      maxConcurrency: 2,
      queryFn: fakeQuery,
      onEvent: () => {},
    });
    assert.match(capturedPrompt, /teto de concorrência 2/);
  });
});

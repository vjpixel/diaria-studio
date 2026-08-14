/**
 * test/notify-continuo-askuserquestion.test.ts (#5293)
 *
 * Cobre `.claude/hooks/notify-continuo-askuserquestion.mjs` — fecha a
 * lacuna registrada em `.claude/skills/diaria-continuo/SKILL.md`
 * §"Risco aceito": um `AskUserQuestion` bloqueante rodando numa sessão
 * `/diaria-continuo` de TERMINAL (não pelo chat drawer do Studio) não
 * disparava nem `studio-telegram-notify.ts` nem `gate-chat-bridge.js` — os
 * dois só cobrem sessões abertas PELO chat drawer. Este hook cobre
 * especificamente o caminho de terminal, via Telegram Bot API direto.
 *
 * Testa só as funções PURAS/injetáveis exportadas pelo hook — a integração
 * fim-a-fim (leitura de stdin, `execFileSync` real) não é reexercitada aqui,
 * mesmo padrão de `test/block-askuserquestion-overnight-autonomous.test.ts`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  findActiveContinuoSession,
  summarizePendingQuestion,
  buildNotifyRequest,
  buildNotifyMessage,
} from "../.claude/hooks/notify-continuo-askuserquestion.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "notify-continuo-"));
}

function writeSession(repoRoot, kind, tag, sessionId, record) {
  mkdirSync(join(repoRoot, "data", "sessions"), { recursive: true });
  writeFileSync(join(repoRoot, "data", "sessions", `${kind}-${tag}-${sessionId}.json`), JSON.stringify(record));
}

describe("findActiveContinuoSession (#5293)", () => {
  const NOW = Date.parse("2026-08-14T12:00:00.000Z");

  it("data/sessions/ ausente → null", () => {
    const dir = tmp();
    try {
      assert.equal(findActiveContinuoSession(dir, "sess-1", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessionId ausente/vazio → null (nunca varre à toa)", () => {
    const dir = tmp();
    try {
      assert.equal(findActiveContinuoSession(dir, undefined, NOW), null);
      assert.equal(findActiveContinuoSession(dir, "", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessão continuo ativa (heartbeat recente) → encontrada", () => {
    const dir = tmp();
    try {
      writeSession(dir, "continuo", "host-a", "sess-live", {
        kind: "continuo",
        sessionId: "sess-live",
        startedAt: "2026-08-14T10:00:00.000Z",
        lastHeartbeat: "2026-08-14T11:55:00.000Z",
      });
      const found = findActiveContinuoSession(dir, "sess-live", NOW);
      assert.ok(found);
      assert.equal(found.sessionId, "sess-live");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessão de OUTRO kind (overnight) com o mesmo sessionId → não conta (filtro por prefixo de arquivo)", () => {
    const dir = tmp();
    try {
      writeSession(dir, "overnight", "host-a", "sess-x", {
        kind: "overnight",
        sessionId: "sess-x",
        lastHeartbeat: "2026-08-14T11:55:00.000Z",
      });
      assert.equal(findActiveContinuoSession(dir, "sess-x", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessão continuo STALE (heartbeat > 24h atrás) → null", () => {
    const dir = tmp();
    try {
      writeSession(dir, "continuo", "host-a", "sess-stale", {
        kind: "continuo",
        sessionId: "sess-stale",
        lastHeartbeat: "2026-08-10T10:00:00.000Z", // > 24h antes de NOW
      });
      assert.equal(findActiveContinuoSession(dir, "sess-stale", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sessão continuo com heartbeat 'no futuro' (clock skew) → null (fail-safe, não finge ativa)", () => {
    const dir = tmp();
    try {
      writeSession(dir, "continuo", "host-a", "sess-future", {
        kind: "continuo",
        sessionId: "sess-future",
        lastHeartbeat: "2026-08-15T00:00:00.000Z", // depois de NOW
      });
      assert.equal(findActiveContinuoSession(dir, "sess-future", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("JSON corrompido no arquivo de sessão → null, sem lançar", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "data", "sessions"), { recursive: true });
      writeFileSync(join(dir, "data", "sessions", "continuo-host-a-sess-broken.json"), "{ isto não é json");
      assert.doesNotThrow(() => findActiveContinuoSession(dir, "sess-broken", NOW));
      assert.equal(findActiveContinuoSession(dir, "sess-broken", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("record.sessionId no arquivo diverge do nome do arquivo → não conta (paranoia contra colisão de nome)", () => {
    const dir = tmp();
    try {
      writeSession(dir, "continuo", "host-a", "sess-mismatch", {
        kind: "continuo",
        sessionId: "outro-id-completamente-diferente",
        lastHeartbeat: "2026-08-14T11:55:00.000Z",
      });
      assert.equal(findActiveContinuoSession(dir, "sess-mismatch", NOW), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("summarizePendingQuestion (#5293)", () => {
  it("extrai header + question da primeira pergunta", () => {
    const toolInput = { questions: [{ header: "Escopo", question: "Cat. D destrava?" }] };
    assert.equal(summarizePendingQuestion(toolInput), "[Escopo] Cat. D destrava?");
  });

  it("sem header → só a pergunta", () => {
    const toolInput = { questions: [{ question: "Sem header aqui" }] };
    assert.equal(summarizePendingQuestion(toolInput), "Sem header aqui");
  });

  it("tool_input ausente/malformado → null, nunca lança", () => {
    assert.equal(summarizePendingQuestion(undefined), null);
    assert.equal(summarizePendingQuestion({}), null);
    assert.equal(summarizePendingQuestion({ questions: [] }), null);
  });

  it("pergunta muito longa é truncada (limite de mensagem do Telegram)", () => {
    const longQuestion = "x".repeat(500);
    const toolInput = { questions: [{ question: longQuestion }] };
    const summary = summarizePendingQuestion(toolInput);
    assert.ok(summary.length <= 301);
    assert.ok(summary.endsWith("…"));
  });
});

describe("buildNotifyRequest (#5293)", () => {
  it("inclui AbortSignal de timeout (nunca fica pendurado sem limite, mesmo princípio do #2958)", () => {
    const { options } = buildNotifyRequest("tok", "chat", "msg");
    assert.ok(options.signal instanceof AbortSignal);
  });

  it("body carrega chat_id e a mensagem", () => {
    const { url, options } = buildNotifyRequest("tok123", "chat456", "olá");
    assert.equal(url, "https://api.telegram.org/bottok123/sendMessage");
    const body = JSON.parse(options.body);
    assert.equal(body.chat_id, "chat456");
    assert.equal(body.text, "olá");
  });
});

describe("buildNotifyMessage (#5293)", () => {
  it("inclui o session_id sempre", () => {
    const msg = buildNotifyMessage("sess-123", null);
    assert.match(msg, /sess-123/);
    assert.match(msg, /continuo/);
  });

  it("inclui o resumo da pergunta quando disponível", () => {
    const msg = buildNotifyMessage("sess-123", "[Escopo] Cat. D destrava?");
    assert.match(msg, /Cat\. D destrava\?/);
  });
});

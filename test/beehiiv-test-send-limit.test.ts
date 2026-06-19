/**
 * test/beehiiv-test-send-limit.test.ts (#2376)
 *
 * Testes de regressão para o helper de tracking do limite de test emails
 * por post no Beehiiv.
 *
 * Cobre os comportamentos críticos para prevenir o bug do incidente 260619:
 * 1. incrementTestEmailCount: persiste e incrementa corretamente (modo fix)
 * 2. setTestEmailCount: grava contagem inicial (modo create, passo 8)
 * 3. decideTestSendAction: alerta em >= 3, fallback em > 3
 * 4. markDraftVerified: seta draft_verified=true preservando outros campos
 * 5. Robustez contra arquivo corrompido / count negativo (não neutralizar a guard)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readTestEmailCount,
  incrementTestEmailCount,
  setTestEmailCount,
  markDraftVerified,
  decideTestSendAction,
  TEST_SEND_ALERT_THRESHOLD,
} from "../scripts/lib/beehiiv-test-send-limit.ts";

function makeFixture(initialPublished?: Record<string, unknown> | string): {
  dir: string;
  publishedPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "diaria-test-send-limit-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  const publishedPath = resolve(dir, "_internal", "05-published.json");
  if (typeof initialPublished === "string") {
    // Conteúdo literal — usado pra simular JSON corrompido
    writeFileSync(publishedPath, initialPublished, "utf8");
  } else if (initialPublished !== undefined) {
    writeFileSync(publishedPath, JSON.stringify(initialPublished, null, 2) + "\n", "utf8");
  }
  return { dir, publishedPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Roda `fn` e garante cleanup mesmo se uma assertion falhar (evita tmpdir leak). */
function withFixture(
  initial: Record<string, unknown> | string | undefined,
  fn: (f: ReturnType<typeof makeFixture>) => void,
): void {
  const f = makeFixture(initial);
  try {
    fn(f);
  } finally {
    f.cleanup();
  }
}

// ---------------------------------------------------------------------------
// readTestEmailCount
// ---------------------------------------------------------------------------

describe("readTestEmailCount (#2376)", () => {
  it("retorna 0 quando 05-published.json não existe", () => {
    withFixture(undefined, ({ dir }) => assert.equal(readTestEmailCount(dir), 0));
  });

  it("retorna 0 quando campo test_email_count ausente", () => {
    withFixture(
      { draft_url: "https://app.beehiiv.com/posts/x/edit", status: "draft" },
      ({ dir }) => assert.equal(readTestEmailCount(dir), 0),
    );
  });

  it("retorna valor correto quando campo presente", () => {
    withFixture({ test_email_count: 2, status: "draft" }, ({ dir }) =>
      assert.equal(readTestEmailCount(dir), 2),
    );
  });

  it("retorna 0 para valor negativo (defensivo — não neutralizar a guard)", () => {
    withFixture({ test_email_count: -1, status: "draft" }, ({ dir }) =>
      assert.equal(readTestEmailCount(dir), 0),
    );
  });

  it("retorna 0 para valor não-numérico (defensivo)", () => {
    withFixture({ test_email_count: "three", status: "draft" }, ({ dir }) =>
      assert.equal(readTestEmailCount(dir), 0),
    );
  });

  it("retorna 0 quando JSON está corrompido (mid-write crash)", () => {
    withFixture('{"test_email_count": 2, "status":', ({ dir }) =>
      assert.equal(readTestEmailCount(dir), 0),
    );
  });
});

// ---------------------------------------------------------------------------
// incrementTestEmailCount
// ---------------------------------------------------------------------------

describe("incrementTestEmailCount (#2376)", () => {
  it("incrementa de 0 para 1 (campo ausente inicialmente)", () => {
    withFixture(
      { draft_url: "https://app.beehiiv.com/posts/abc/edit", status: "draft", title: "Teste" },
      ({ dir }) => {
        assert.equal(incrementTestEmailCount(dir), 1);
        assert.equal(readTestEmailCount(dir), 1);
      },
    );
  });

  it("incrementa sequencialmente: 1 → 2 → 3 → 4", () => {
    withFixture(
      { draft_url: "https://app.beehiiv.com/posts/abc/edit", status: "draft", title: "Teste" },
      ({ dir }) => {
        assert.equal(incrementTestEmailCount(dir), 1);
        assert.equal(incrementTestEmailCount(dir), 2);
        assert.equal(incrementTestEmailCount(dir), 3);
        assert.equal(incrementTestEmailCount(dir), 4);
        assert.equal(readTestEmailCount(dir), 4);
      },
    );
  });

  it("preserva outros campos (incluindo arrays) ao incrementar", () => {
    const initial = {
      draft_url: "https://app.beehiiv.com/posts/xyz/edit",
      status: "draft",
      title: "Meu Título",
      test_email_sent_to: "vjpixel@gmail.com",
      unfixed_issues: [{ reason: "x", section: "y", details: "z" }],
    };
    withFixture(initial, ({ dir, publishedPath }) => {
      incrementTestEmailCount(dir);
      const data = JSON.parse(readFileSync(publishedPath, "utf8")) as Record<string, unknown>;
      assert.equal(data["draft_url"], initial.draft_url);
      assert.equal(data["title"], initial.title);
      assert.equal(data["test_email_sent_to"], initial.test_email_sent_to);
      assert.equal(data["test_email_count"], 1);
      // Array sobrevive o round-trip
      assert.deepEqual(data["unfixed_issues"], initial.unfixed_issues);
    });
  });

  it("retorna null e não cria arquivo quando 05-published.json não existe", () => {
    withFixture(undefined, ({ dir }) => {
      const result = incrementTestEmailCount(dir);
      assert.equal(result, null, "increment deve sinalizar null (não 0) quando perdido");
      assert.equal(existsSync(resolve(dir, "_internal", "05-published.json")), false);
    });
  });

  it("retorna null quando JSON corrompido (não persiste increment perdido)", () => {
    withFixture('{"test_email_count": 1, "status":', ({ dir }) =>
      assert.equal(incrementTestEmailCount(dir), null),
    );
  });

  it("não conta a partir de count negativo no arquivo (clamp pra 0 antes de +1)", () => {
    // Arquivo corrompido/editado com count -5 não pode exigir 6 increments
    // pra cruzar o threshold — o clamp garante que increment vai de 0 → 1.
    withFixture({ test_email_count: -5, status: "draft" }, ({ dir }) => {
      assert.equal(incrementTestEmailCount(dir), 1);
      assert.equal(readTestEmailCount(dir), 1);
    });
  });
});

// ---------------------------------------------------------------------------
// setTestEmailCount (modo create — passo 8)
// ---------------------------------------------------------------------------

describe("setTestEmailCount (#2376 — ordering create-mode)", () => {
  it("grava contagem explícita preservando outros campos", () => {
    withFixture(
      { draft_url: "https://app.beehiiv.com/posts/abc/edit", status: "draft", title: "T" },
      ({ dir, publishedPath }) => {
        assert.equal(setTestEmailCount(dir, 2), true);
        const data = JSON.parse(readFileSync(publishedPath, "utf8")) as Record<string, unknown>;
        assert.equal(data["test_email_count"], 2);
        assert.equal(data["draft_url"], "https://app.beehiiv.com/posts/abc/edit");
      },
    );
  });

  it("clampa valores negativos para 0", () => {
    withFixture({ status: "draft" }, ({ dir }) => {
      assert.equal(setTestEmailCount(dir, -3), true);
      assert.equal(readTestEmailCount(dir), 0);
    });
  });

  it("retorna false quando 05-published.json não existe", () => {
    withFixture(undefined, ({ dir }) => assert.equal(setTestEmailCount(dir, 1), false));
  });
});

// ---------------------------------------------------------------------------
// markDraftVerified
// ---------------------------------------------------------------------------

describe("markDraftVerified (#2376)", () => {
  it("seta draft_verified=true preservando outros campos e retorna true", () => {
    const initial = {
      draft_url: "https://app.beehiiv.com/posts/abc/edit",
      status: "draft",
      title: "Título",
      test_email_count: 4,
    };
    withFixture(initial, ({ dir, publishedPath }) => {
      assert.equal(markDraftVerified(dir), true);
      const data = JSON.parse(readFileSync(publishedPath, "utf8")) as Record<string, unknown>;
      assert.equal(data["draft_verified"], true);
      assert.equal(data["draft_url"], initial.draft_url);
      assert.equal(data["test_email_count"], initial.test_email_count);
      assert.equal(data["title"], initial.title);
    });
  });

  it("retorna false quando 05-published.json não existe (caller deve logar)", () => {
    withFixture(undefined, ({ dir }) => assert.equal(markDraftVerified(dir), false));
  });

  it("retorna false quando JSON corrompido", () => {
    withFixture('{"status":', ({ dir }) => assert.equal(markDraftVerified(dir), false));
  });

  it("idempotente: chamar 2× não quebra nada", () => {
    withFixture(
      { draft_url: "https://app.beehiiv.com/posts/abc/edit", status: "draft", title: "Título" },
      ({ dir, publishedPath }) => {
        markDraftVerified(dir);
        markDraftVerified(dir);
        const data = JSON.parse(readFileSync(publishedPath, "utf8")) as Record<string, unknown>;
        assert.equal(data["draft_verified"], true);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// decideTestSendAction (pure)
// ---------------------------------------------------------------------------

describe("decideTestSendAction (#2376)", () => {
  it("ok quando count < ALERT_THRESHOLD (0, 1, 2)", () => {
    for (let i = 0; i < TEST_SEND_ALERT_THRESHOLD; i++) {
      const d = decideTestSendAction(i);
      assert.equal(d.action, "ok", `count=${i} deveria ser ok`);
      assert.equal(d.count, i);
    }
  });

  it("alert quando count === ALERT_THRESHOLD (3)", () => {
    const d = decideTestSendAction(TEST_SEND_ALERT_THRESHOLD);
    assert.equal(d.action, "alert");
    assert.equal(d.count, TEST_SEND_ALERT_THRESHOLD);
    assert.ok("message" in d);
    if (d.action === "alert") {
      // Mensagem não-vazia (sem casar substring incidental do texto PT)
      assert.ok(d.message.length > 0);
    }
  });

  it("use_draft_fallback quando count > ALERT_THRESHOLD (4, 5, 10)", () => {
    for (const count of [4, 5, 10]) {
      const d = decideTestSendAction(count);
      assert.equal(d.action, "use_draft_fallback", `count=${count} deveria ser use_draft_fallback`);
      assert.equal(d.count, count);
      if (d.action === "use_draft_fallback") {
        assert.ok(d.message.length > 0);
      }
    }
  });

  it("TEST_SEND_ALERT_THRESHOLD é 3 (incidente 260619: limite atingido com 4 iterações)", () => {
    assert.equal(TEST_SEND_ALERT_THRESHOLD, 3);
  });
});

// ---------------------------------------------------------------------------
// Fluxo combinado: read → decide → increment (boundary do incidente 260619)
// ---------------------------------------------------------------------------

describe("fluxo combinado read→decide→increment (#2376)", () => {
  it("permite 4 sends antes do fallback (ok×3 + alert×1), bloqueia no 5º", () => {
    withFixture(
      { draft_url: "https://app.beehiiv.com/posts/abc/edit", status: "draft", title: "T" },
      ({ dir }) => {
        const actions: string[] = [];
        // Simula o loop do playbook: lê count, decide, (envia), incrementa.
        for (let send = 1; send <= 5; send++) {
          const count = readTestEmailCount(dir);
          const decision = decideTestSendAction(count);
          actions.push(decision.action);
          if (decision.action === "use_draft_fallback") break; // não envia
          incrementTestEmailCount(dir); // só incrementa após "envio"
        }
        // count pré-envio: 0(ok) 1(ok) 2(ok) 3(alert) 4(fallback→break)
        assert.deepEqual(actions, ["ok", "ok", "ok", "alert", "use_draft_fallback"]);
        // 4 sends efetivos foram contados antes do bloqueio
        assert.equal(readTestEmailCount(dir), 4);
      },
    );
  });
});

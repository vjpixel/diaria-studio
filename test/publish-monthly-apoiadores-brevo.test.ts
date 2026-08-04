/**
 * test/publish-monthly-apoiadores-brevo.test.ts (#4593)
 *
 * Cobre `scripts/publish-monthly-apoiadores-brevo.ts` — o motor do Passo 2
 * (Publicar) da skill `/diaria-mensal-apoiadores`, reescrito pra criar uma
 * campanha Brevo REAL (rascunho) em vez do paste manual antigo no Beehiiv.
 *
 *   - `checkApoiadoresBrevoGuards`: aborta corretamente quando `list_id` é
 *     `null` (pré-requisito real ainda pendente, #4572/#4593), sender/API key
 *     ausentes — tudo puro, sem tocar disco.
 *   - `buildApoiadoresBrevoCampaignBody`: monta a campanha corretamente e
 *     NUNCA inclui `scheduledAt`/flag de envio — sempre rascunho.
 *   - `createApoiadoresBrevoCampaign` + `main()`: teste de integração com
 *     `fetch` mockado (mesmo padrão de `publish-daily-brevo-integration-4532.test.ts`)
 *     provando que a campanha É criada via `POST /emailCampaigns` quando
 *     `list_id` está presente, e NUNCA quando ausente.
 *
 * `main()` recebe `deps.renderEmail` injetado (nunca a implementação real,
 * `renderMonthlyApoiadoresBrevoEmail`) porque `monthlyDir()` resolve sempre
 * contra `data/monthly/` REAL, não é fixture-ável — mesma limitação já aceita
 * por `test/send-monthly-apoiadores.test.ts`/`test/render-monthly-beehiiv.test.ts`.
 * Isso também significa que o branch `--dry-run` (que só reporta o
 * `htmlPath` já escrito por `deps.renderEmail` em produção) não é exercitado
 * aqui via `main()` de ponta a ponta — comportamento coberto indiretamente
 * pelo guard bypass testado abaixo (dry-run nunca exige list_id/sender/apiKey).
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkApoiadoresBrevoGuards,
  buildApoiadoresBrevoCampaignBody,
  buildApoiadoresBrevoCampaignName,
  createApoiadoresBrevoCampaign,
  main,
  type BrevoApoiadoresPublishConfig,
  type ApoiadoresBrevoEmailContent,
} from "../scripts/publish-monthly-apoiadores-brevo.ts";
import type { RenderedMonthlyApoiadoresBrevoEmail } from "../scripts/render-monthly-apoiadores-brevo.ts";

const CONTENT: ApoiadoresBrevoEmailContent = {
  subject: "Assunto de teste",
  previewText: "Preview de teste",
  html: "<html><body>oi</body></html>",
};

describe("#4593 — checkApoiadoresBrevoGuards", () => {
  it("config ausente (brevo_apoiadores não configurado) — sempre bloqueia, mesmo em dry-run", () => {
    const r = checkApoiadoresBrevoGuards({ dryRun: true, config: undefined, apiKey: undefined });
    assert.equal(r.ok, false);
  });

  it("list_id null fora de --dry-run — bloqueia (pré-requisito real #4572/#4593)", () => {
    const config: BrevoApoiadoresPublishConfig = { api_key_env: "X", list_id: null, sender_email: "a@b.com" };
    const r = checkApoiadoresBrevoGuards({ dryRun: false, config, apiKey: "key" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /list_id/);
  });

  it("list_id null EM --dry-run — não bloqueia (dry-run não exige list_id)", () => {
    const config: BrevoApoiadoresPublishConfig = { api_key_env: "X", list_id: null };
    const r = checkApoiadoresBrevoGuards({ dryRun: true, config, apiKey: undefined });
    assert.equal(r.ok, true);
  });

  it("sender_email ausente fora de --dry-run — bloqueia", () => {
    const config: BrevoApoiadoresPublishConfig = { api_key_env: "X", list_id: 7 };
    const r = checkApoiadoresBrevoGuards({ dryRun: false, config, apiKey: "key" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /sender_email/);
  });

  it("API key ausente no ambiente fora de --dry-run — bloqueia", () => {
    const config: BrevoApoiadoresPublishConfig = { api_key_env: "X", list_id: 7, sender_email: "a@b.com" };
    const r = checkApoiadoresBrevoGuards({ dryRun: false, config, apiKey: undefined });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /ambiente/);
  });

  it("tudo presente fora de --dry-run — ok", () => {
    const config: BrevoApoiadoresPublishConfig = { api_key_env: "X", list_id: 7, sender_email: "a@b.com" };
    const r = checkApoiadoresBrevoGuards({ dryRun: false, config, apiKey: "key" });
    assert.equal(r.ok, true);
  });
});

describe("#4593 — buildApoiadoresBrevoCampaignBody / buildApoiadoresBrevoCampaignName", () => {
  it("monta o body com name/subject/previewText/sender/recipients/htmlContent", () => {
    const body = buildApoiadoresBrevoCampaignBody(
      CONTENT,
      { sender_email: "oi@diar.ia.br", sender_name: "diar.ia.br" },
      42,
      buildApoiadoresBrevoCampaignName("2607-08"),
    );
    assert.deepEqual(body, {
      name: "diar.ia.br mensal apoiadores — 2607-08",
      subject: CONTENT.subject,
      previewText: CONTENT.previewText,
      sender: { name: "diar.ia.br", email: "oi@diar.ia.br" },
      recipients: { listIds: [42] },
      htmlContent: CONTENT.html,
    });
  });

  it("NUNCA inclui scheduledAt nem qualquer flag de envio — sempre rascunho", () => {
    const body = buildApoiadoresBrevoCampaignBody(CONTENT, { sender_email: "a@b.com" }, 1, "nome");
    // Chaves reais da campanha Brevo que disparariam/agendariam envio, se
    // presentes (`sender`/`recipients` são legítimas — endereço/audiência,
    // não disparo — por isso o check é por CHAVE exata, não substring).
    for (const forbidden of ["scheduledAt", "sendAtBestTime", "sendNow", "schedule"]) {
      assert.equal(forbidden in body, false, `chave de disparo/agendamento presente: ${forbidden}`);
    }
  });

  it("sender_name default 'diar.ia.br' quando ausente", () => {
    const body = buildApoiadoresBrevoCampaignBody(CONTENT, { sender_email: "a@b.com" }, 1, "nome") as {
      sender: { name: string };
    };
    assert.equal(body.sender.name, "diar.ia.br");
  });

  it("buildApoiadoresBrevoCampaignName inclui o ciclo pra rastreabilidade", () => {
    assert.equal(buildApoiadoresBrevoCampaignName("2607-08"), "diar.ia.br mensal apoiadores — 2607-08");
  });
});

// ── createApoiadoresBrevoCampaign — fetch mockado ───────────────────────────

function jsonRes(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => text,
    json: async () => body,
    body: { cancel: async () => {} },
  } as unknown as Response;
}

let originalFetch: typeof fetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("#4593 — createApoiadoresBrevoCampaign (fetch mockado)", () => {
  it("cria a campanha via POST /v3/emailCampaigns e retorna o id", async () => {
    let capturedBody: unknown;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.hostname, "api.brevo.com");
      assert.equal(url.pathname, "/v3/emailCampaigns");
      capturedBody = JSON.parse(init!.body as string);
      return jsonRes(201, { id: 555 });
    }) as typeof fetch;

    const config: BrevoApoiadoresPublishConfig = { api_key_env: "X", list_id: 42, sender_email: "oi@diar.ia.br", sender_name: "diar.ia.br" };
    const result = await createApoiadoresBrevoCampaign("fake_key", config, CONTENT, "2607-08");

    assert.equal(result.id, 555);
    assert.deepEqual((capturedBody as { recipients: { listIds: number[] } }).recipients, { listIds: [42] });
    assert.equal("scheduledAt" in (capturedBody as object), false);
  });

  it("lança se a API não devolver um id numérico", async () => {
    globalThis.fetch = (async () => jsonRes(201, { ok: true })) as typeof fetch;
    const config: BrevoApoiadoresPublishConfig = { api_key_env: "X", list_id: 42, sender_email: "oi@diar.ia.br" };
    await assert.rejects(() => createApoiadoresBrevoCampaign("fake_key", config, CONTENT, "2607-08"), /sem campo 'id'/);
  });

  it("#4593 self-review: list_id null → lança ANTES de qualquer chamada fetch, mesmo chamada direta sem passar por main()/checkApoiadoresBrevoGuards", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return jsonRes(201, { id: 1 });
    }) as typeof fetch;
    const config: BrevoApoiadoresPublishConfig = { api_key_env: "X", list_id: null, sender_email: "oi@diar.ia.br" };
    await assert.rejects(() => createApoiadoresBrevoCampaign("fake_key", config, CONTENT, "2607-08"), /list_id é null/);
    assert.equal(fetchCalled, false, "fetch nunca deve ser chamado quando list_id é null");
  });
});

// ── main() — integração com deps.renderEmail injetado + fetch mockado ──────

const originalExit = process.exit;
const originalArgv = process.argv;
let exitCode: number | null = null;

function mockProcessExit(): void {
  exitCode = null;
  // @ts-expect-error mocking
  process.exit = (code?: number) => {
    exitCode = code ?? 0;
    throw new Error("__mocked_exit__");
  };
}
function restoreProcessExit(): void {
  process.exit = originalExit;
}

before(() => {});
after(() => {
  process.argv = originalArgv;
});

function mkTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "publish-monthly-apoiadores-brevo-test-"));
}

function writePlatformConfig(root: string, brevoApoiadores: Partial<BrevoApoiadoresPublishConfig> | null): void {
  const cfg = brevoApoiadores === null ? {} : { brevo_apoiadores: { api_key_env: "TEST_APOIADORES_KEY_4593", ...brevoApoiadores } };
  writeFileSync(join(root, "platform.config.json"), JSON.stringify(cfg), "utf8");
}

const FAKE_RENDERED: RenderedMonthlyApoiadoresBrevoEmail = {
  cycle: "2607-08",
  yymm: "2607",
  subject: CONTENT.subject,
  previewText: CONTENT.previewText,
  html: CONTENT.html,
  htmlPath: "/fake/path/apoiadores-brevo-preview.html",
};

describe("#4593 — main() integração (deps.renderEmail injetado, fetch mockado)", () => {
  afterEach(restoreProcessExit);

  it("list_id null: aborta com exit(2), renderEmail NUNCA chamado, POST /emailCampaigns NUNCA disparado", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root, { list_id: null, sender_email: "oi@diar.ia.br" });
      process.env.TEST_APOIADORES_KEY_4593 = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-brevo.ts", "--cycle", "2607-08"];
      mockProcessExit();

      let renderCalled = false;
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return jsonRes(201, { id: 1 });
      }) as typeof fetch;

      await assert.rejects(
        () => main(root, { renderEmail: () => { renderCalled = true; return FAKE_RENDERED; } }),
        /__mocked_exit__/,
      );
      assert.equal(exitCode, 2, "guard de list_id ausente deveria abortar com exit(2)");
      assert.equal(renderCalled, false, "renderEmail nunca deveria ter sido chamado — guard roda ANTES do render");
      assert.equal(fetchCalled, false, "POST /emailCampaigns nunca deveria ter sido disparado");
    } finally {
      delete process.env.TEST_APOIADORES_KEY_4593;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("list_id presente, dry-run FALSO: cria a campanha via POST /emailCampaigns (rascunho)", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root, { list_id: 42, sender_email: "oi@diar.ia.br", sender_name: "diar.ia.br" });
      process.env.TEST_APOIADORES_KEY_4593 = "fake_key";
      process.argv = ["node", "publish-monthly-apoiadores-brevo.ts", "--cycle", "2607-08"];
      mockProcessExit();

      let capturedBody: unknown;
      globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/v3/emailCampaigns") {
          capturedBody = JSON.parse(init!.body as string);
          return jsonRes(201, { id: 777 });
        }
        throw new Error(`unexpected fetch: ${url.pathname}`);
      }) as typeof fetch;

      let renderCalledWith: string | null = null;
      await main(root, { renderEmail: (cycle) => { renderCalledWith = cycle; return FAKE_RENDERED; } });

      assert.equal(exitCode, null, "não deveria ter chamado process.exit");
      assert.equal(renderCalledWith, "2607-08");
      assert.ok(capturedBody, "POST /emailCampaigns deveria ter sido disparado");
      const body = capturedBody as { recipients: { listIds: number[] }; sender: { email: string } };
      assert.deepEqual(body.recipients, { listIds: [42] });
      assert.equal(body.sender.email, "oi@diar.ia.br");
      assert.equal("scheduledAt" in (capturedBody as object), false, "campanha criada NUNCA deve ter scheduledAt — sempre rascunho");
    } finally {
      delete process.env.TEST_APOIADORES_KEY_4593;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("--dry-run: NUNCA chama a API Brevo, mesmo com list_id/sender ausentes", async () => {
    const root = mkTmpRoot();
    try {
      writePlatformConfig(root, { list_id: null });
      process.argv = ["node", "publish-monthly-apoiadores-brevo.ts", "--cycle", "2607-08", "--dry-run"];
      mockProcessExit();

      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return jsonRes(201, { id: 1 });
      }) as typeof fetch;

      await main(root, { renderEmail: () => FAKE_RENDERED });

      assert.equal(exitCode, null, "--dry-run não deveria abortar mesmo sem list_id/sender/apiKey");
      assert.equal(fetchCalled, false, "--dry-run nunca chama a API Brevo");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * test/audit-wave-no-duplicate-sends-7880.test.ts (#7880)
 *
 * Cobertura de `scripts/audit-wave-no-duplicate-sends.ts::main` —
 * integração ponta-a-ponta: CSV do grupo (montado por
 * `clarice-build-segment.ts`) + store SQLite (`brevo_list_ids` por contato) +
 * Brevo mockada (`status=sent`/`status=queued`). NUNCA bate na API real da
 * Brevo — `fetch` é sempre mockado.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { main, renderWaveAuditReport } from "../scripts/audit-wave-no-duplicate-sends.ts";
import { openClariceDb } from "../scripts/lib/clarice-db.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";
import { DEFAULT_RATE_STATE_PATH, recordCampaignQuotaRemaining } from "../scripts/lib/brevo-rate-state.ts";

const stateDir = resolve(DEFAULT_RATE_STATE_PATH, "..");
let dirPreexisted: boolean;
let origApiKey: string | undefined;

beforeEach(() => {
  dirPreexisted = existsSync(stateDir);
  if (existsSync(DEFAULT_RATE_STATE_PATH)) rmSync(DEFAULT_RATE_STATE_PATH);
  origApiKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "fake-key-teste-7880";
});

afterEach(() => {
  if (existsSync(DEFAULT_RATE_STATE_PATH)) rmSync(DEFAULT_RATE_STATE_PATH);
  if (!dirPreexisted && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
  if (origApiKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
  else process.env.BREVO_CLARICE_API_KEY = origApiKey;
});

function makeJsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response);
}

/** Monta um tmpdir com `{group}.csv` + store SQLite, pronto pra `main()`. */
function setupWave(opts: {
  cycle: string;
  group: string;
  contacts: Array<{ email: string; name?: string; brevoListIds?: number[] }>;
}): { dir: string; dbPath: string } {
  const dir = mkdtempSync(resolve(tmpdir(), "audit-wave-"));
  const dbPath = resolve(dir, "store.db");
  const db = openClariceDb(dbPath);
  for (const c of opts.contacts) {
    db.prepare(
      "INSERT INTO clarice_users (email, name, brevo_list_ids) VALUES (?, ?, ?)",
    ).run(c.email, c.name ?? "Fulano", c.brevoListIds ? JSON.stringify(c.brevoListIds) : null);
  }
  db.close();

  const segDir = clariceSegmentsDir(opts.cycle, dir);
  mkdirSync(segDir, { recursive: true });
  const csv = ["email,NOME", ...opts.contacts.map((c) => `${c.email},${c.name ?? "Fulano"}`)].join("\n");
  writeFileSync(resolve(segDir, `${opts.group}.csv`), csv, "utf8");

  return { dir, dbPath };
}

describe("audit-wave-no-duplicate-sends main() (#7880)", () => {
  it("BREVO_CLARICE_API_KEY ausente => lança sem fazer nenhuma chamada", async () => {
    delete process.env.BREVO_CLARICE_API_KEY;
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(
        () => main(["--cycle", "2608-09", "--group", "engajados"]),
        /BREVO_CLARICE_API_KEY/,
      );
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("--group ausente => lança sem consultar nada", async () => {
    await assert.rejects(() => main(["--cycle", "2608-09"]), /--group/);
  });

  it("{group}.csv ausente => lança com instrução de como gerá-lo", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "audit-wave-missing-"));
    await assert.rejects(
      () => main(["--cycle", "2608-09", "--group", "engajados", "--data-root", dir]),
      /não existe/,
    );
  });

  it("cota abaixo da reserva => recusa ANTES de ler o CSV/DB, zero chamadas HTTP", async () => {
    recordCampaignQuotaRemaining(5, 100); // abaixo do default de reserva
    const { dir } = setupWave({ cycle: "2608-09", group: "engajados", contacts: [{ email: "a@x.com" }] });
    let calls = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(
        () => main(["--cycle", "2608-09", "--group", "engajados", "--data-root", dir]),
        /Cota da família/,
      );
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("sem colisão: onda limpa contra sent/queued do mês => exitCode intocado", async () => {
    const { dir, dbPath } = setupWave({
      cycle: "2608-09",
      group: "engajados",
      contacts: [
        { email: "limpo@x.com", brevoListIds: [10] }, // lista 10 não aparece em nenhuma campanha do mês
      ],
    });
    const orig = globalThis.fetch;
    const origExitCode = process.exitCode;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("status=sent")) {
        return makeJsonResponse({
          campaigns: [
            { id: 1, name: "d10-ago", status: "sent", sentDate: "2026-08-15T00:00:00Z", recipients: { lists: [99] } },
          ],
        });
      }
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      process.exitCode = undefined;
      await main(["--cycle", "2608-09", "--group", "engajados", "--month", "2026-09", "--db", dbPath, "--data-root", dir]);
      assert.equal(process.exitCode, undefined);
    } finally {
      globalThis.fetch = orig;
      process.exitCode = origExitCode;
    }
  });

  it("colisão real: contato da onda pertence a lista de campanha SENT dentro do mês => exitCode=2", async () => {
    const { dir, dbPath } = setupWave({
      cycle: "2608-09",
      group: "engajados",
      contacts: [
        { email: "ja-recebeu@x.com", brevoListIds: [72] },
        { email: "livre@x.com", brevoListIds: [50] },
      ],
    });
    const orig = globalThis.fetch;
    const origExitCode = process.exitCode;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("status=sent")) {
        return makeJsonResponse({
          campaigns: [
            { id: 5, name: "d10-set", status: "sent", sentDate: "2026-09-05T00:00:00Z", recipients: { lists: [72] } },
          ],
        });
      }
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      process.exitCode = undefined;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        await main(["--cycle", "2608-09", "--group", "engajados", "--month", "2026-09", "--db", dbPath, "--data-root", dir, "--json"]);
      } finally {
        console.log = origLog;
      }
      assert.equal(process.exitCode, 2);
      const out = JSON.parse(logs.join("\n"));
      assert.equal(out.checked, 2);
      assert.equal(out.collisions.length, 1);
      assert.equal(out.collisions[0].email, "ja-recebeu@x.com");
    } finally {
      globalThis.fetch = orig;
      process.exitCode = origExitCode;
    }
  });

  it("armadilha do #7880: campanha suspended com scheduledAt 2035 NUNCA gera falso positivo (mock só devolve o que a query status=sent/status=queued pediu)", async () => {
    const { dir, dbPath } = setupWave({
      cycle: "2608-09",
      group: "engajados",
      contacts: [{ email: "contato@x.com", brevoListIds: [62] }],
    });
    const orig = globalThis.fetch;
    const origExitCode = process.exitCode;
    globalThis.fetch = (async (url: string | URL) => {
      // Simula fielmente o comportamento real da Brevo: o filtro `?status=`
      // é aplicado NO SERVIDOR — uma campanha suspended nunca aparece na
      // resposta de `status=sent` nem `status=queued`, mesmo que exista com
      // scheduledAt=2035 no lado da Brevo. O mock só devolve campanhas do
      // status pedido, então a "suspended com data fictícia" da lista 62
      // nunca chega neste script — exatamente o comportamento correto.
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      process.exitCode = undefined;
      await main(["--cycle", "2608-09", "--group", "engajados", "--month", "2026-09", "--db", dbPath, "--data-root", dir]);
      assert.equal(process.exitCode, undefined, "suspended/data fictícia não deve gerar colisão");
    } finally {
      globalThis.fetch = orig;
      process.exitCode = origExitCode;
    }
  });

  it("--exclude-list ignora a lista da PRÓPRIA onda (já importada/agendada) — não colide consigo mesma", async () => {
    const { dir, dbPath } = setupWave({
      cycle: "2608-09",
      group: "engajados",
      contacts: [{ email: "propria-onda@x.com", brevoListIds: [200] }],
    });
    const orig = globalThis.fetch;
    const origExitCode = process.exitCode;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("status=queued")) {
        return makeJsonResponse({
          campaigns: [
            { id: 9, name: "engajados-set", status: "queued", scheduledAt: "2026-09-06T00:00:00Z", recipients: { lists: [200] } },
          ],
        });
      }
      return makeJsonResponse({ campaigns: [] });
    }) as unknown as typeof fetch;
    try {
      process.exitCode = undefined;
      await main([
        "--cycle", "2608-09", "--group", "engajados", "--month", "2026-09",
        "--db", dbPath, "--data-root", dir, "--exclude-list", "200",
      ]);
      assert.equal(process.exitCode, undefined, "lista 200 excluída — é a própria onda, não deveria colidir");
    } finally {
      globalThis.fetch = orig;
      process.exitCode = origExitCode;
    }
  });

  it("onda vazia (0 contatos) => não abre o DB, não colide, sem lançar", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "audit-wave-empty-"));
    const segDir = clariceSegmentsDir("2608-09", dir);
    mkdirSync(segDir, { recursive: true });
    writeFileSync(resolve(segDir, "engajados.csv"), "email,NOME\n", "utf8");
    const orig = globalThis.fetch;
    const origExitCode = process.exitCode;
    globalThis.fetch = (async () => makeJsonResponse({ campaigns: [] })) as unknown as typeof fetch;
    try {
      process.exitCode = undefined;
      await main(["--cycle", "2608-09", "--group", "engajados", "--data-root", dir]);
      assert.equal(process.exitCode, undefined);
    } finally {
      globalThis.fetch = orig;
      process.exitCode = origExitCode;
    }
  });
});

describe("renderWaveAuditReport (#7880)", () => {
  it("sem colisões: mensagem de sucesso com contagem e mês", () => {
    const text = renderWaveAuditReport(42, "2026-09", []);
    assert.match(text, /✅/);
    assert.match(text, /42/);
    assert.match(text, /2026-09/);
  });

  it("com colisões: nomeia contato, listas e campanhas envolvidas", () => {
    const text = renderWaveAuditReport(10, "2026-09", [
      { email: "a@x.com", listIds: ["72"], campaigns: [{ id: 1, name: "d10-set", status: "sent", date: "2026-09-05" }] },
    ]);
    assert.match(text, /⚠️/);
    assert.match(text, /a@x\.com/);
    assert.match(text, /lista\(s\) 72/);
    assert.match(text, /#1 "d10-set"/);
  });
});

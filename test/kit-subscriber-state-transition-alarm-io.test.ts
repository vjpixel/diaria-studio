/**
 * test/kit-subscriber-state-transition-alarm-io.test.ts (#7660, review da PR #7828)
 *
 * Cobre as três funções de I/O do alarme que o teste do CLI não alcança —
 * ele roda o script inteiro em subprocesso e só com `--dry-run`, então
 * `--fetch`, o e-mail e a leitura do store de onboarding ficavam fora.
 *
 * O achado do review era esse: o modo que a task agendada de fato invoca
 * (`--fetch`, sem `--dry-run`) não era exercido por teste nenhum, e o
 * construtor do e-mail — o único canal que chega ao editor no mesmo dia —
 * não tinha uma única asserção de conteúdo, ao contrário do alarme irmão
 * (`buildKitSubscriberLimitAlarmEmail`, testado em
 * `test/kit-subscriber-limit-alarm.test.ts`).
 *
 * As três são importadas direto do módulo: o `isMainModule` guard impede
 * que importar o script rode `main()`.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchCurrentSnapshot,
  buildAlarmEmail,
  loadOnboardingCorrelations,
} from "../scripts/kit-subscriber-state-transition-alarm.ts";
import type { KitSubscriberSummary } from "../scripts/lib/kit-subscribers.ts";

const realFetch = globalThis.fetch;
const realKey = process.env.KIT_API_KEY;

before(() => {
  process.env.KIT_API_KEY = "chave-de-teste";
});
after(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.KIT_API_KEY;
  else process.env.KIT_API_KEY = realKey;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function sub(id: number, state: string): KitSubscriberSummary {
  return { id, email_address: `s${id}@x.com`, state, created_at: "2026-01-01T00:00:00Z" };
}

/** Serve uma resposta por `status=` da query, com paginação opcional. */
function mockKit(porStatus: Record<string, KitSubscriberSummary[][]>): { urls: string[] } {
  const urls: string[] = [];
  const cursores = new Map<string, number>();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const status = new URL(url).searchParams.get("status") ?? "(sem status)";
    const paginas = porStatus[status] ?? [[]];
    const i = cursores.get(status) ?? 0;
    cursores.set(status, i + 1);
    const temProxima = i + 1 < paginas.length;
    return new Response(
      JSON.stringify({
        subscribers: paginas[i] ?? [],
        pagination: { has_next_page: temProxima, end_cursor: temProxima ? `cursor-${status}-${i}` : null },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { urls };
}

describe("fetchCurrentSnapshot (#7828)", () => {
  it("varre `all` E cada estado de alarme, unindo por id sem duplicar", async () => {
    const { urls } = mockKit({
      all: [[sub(1, "active"), sub(2, "bounced")]],
      complained: [[]],
      bounced: [[sub(2, "bounced")]],
      cancelled: [[sub(3, "cancelled")]],
      inactive: [[]],
    });
    const res = await fetchCurrentSnapshot();
    assert.deepEqual(
      res.map((s) => s.id).sort((a, b) => a - b),
      [1, 2, 3],
      "id presente em duas varreduras entra uma vez só",
    );
    const statuses = urls.map((u) => new URL(u).searchParams.get("status"));
    assert.deepEqual(statuses, ["all", "complained", "bounced", "cancelled", "inactive"]);
  });

  it("assinante só encontrado na varredura POR ESTADO entra no snapshot", async () => {
    // O cenário que motivou a varredura extra: `status=all` que não devolve
    // o `complained`. Se a união não o pegasse, o alarme ficaria cego
    // justamente pro estado que ele existe pra detectar.
    mockKit({
      all: [[sub(1, "active")]],
      complained: [[sub(9, "complained")]],
      bounced: [[]],
      cancelled: [[]],
      inactive: [[]],
    });
    const res = await fetchCurrentSnapshot();
    assert.ok(res.find((s) => s.id === 9 && s.state === "complained"));
  });

  it("pagina até o fim — página 2 não é perdida", async () => {
    mockKit({
      all: [[sub(1, "active")], [sub(2, "active")]],
      complained: [[]],
      bounced: [[]],
      cancelled: [[]],
      inactive: [[]],
    });
    const res = await fetchCurrentSnapshot();
    assert.deepEqual(res.map((s) => s.id).sort((a, b) => a - b), [1, 2]);
  });

  it("erro da API PROPAGA — nunca devolve snapshot parcial como se fosse a base inteira", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500, headers: { "content-type": "text/plain" } })) as typeof fetch;
    await assert.rejects(() => fetchCurrentSnapshot());
  });

  it("sem KIT_API_KEY, lança em vez de comparar contra vazio", async () => {
    const salvo = process.env.KIT_API_KEY;
    delete process.env.KIT_API_KEY;
    try {
      await assert.rejects(() => fetchCurrentSnapshot(), /KIT_API_KEY/);
    } finally {
      process.env.KIT_API_KEY = salvo;
    }
  });
});

describe("buildAlarmEmail (#7828)", () => {
  const t = { id: 1, address: "a@x.com", fromState: "active", toState: "complained" };
  const d = { id: 2, address: "b@x.com", lastState: "active", detectedAt: "2026-09-09T00:00:00Z" };

  it("nomeia os dois eventos e lista as issues abertas", () => {
    const { subject, body } = buildAlarmEmail([t], [d], [
      { fingerprint: "f1", action: "created", issueNumber: 10, url: "https://gh/10" },
    ]);
    assert.match(subject, /2 assinante\(s\)/);
    assert.match(body, /a@x\.com \(id 1\): active → complained/);
    assert.match(body, /b@x\.com \(último estado: active\)/);
    assert.match(body, /https:\/\/gh\/10/);
  });

  it("issue que FALHOU aparece nomeada e com o erro, nunca como um '#?' mudo", () => {
    const { subject, body } = buildAlarmEmail([t], [], [
      {
        fingerprint: "kit-subscriber-state-transition:1",
        action: "failed",
        issueNumber: null,
        url: null,
        error: "gh: HTTP 403",
      },
    ]);
    assert.match(subject, /1 issue\(s\) NÃO abertas/, "a falha precisa estar no assunto, não escondida no corpo");
    assert.match(body, /FALHA ao abrir issue/);
    assert.match(body, /kit-subscriber-state-transition:1/);
    assert.match(body, /gh: HTTP 403/);
    assert.doesNotMatch(body, /- #\?/);
  });

  it("falha e sucesso na mesma rodada não se misturam nas duas listas", () => {
    const { body } = buildAlarmEmail([t], [], [
      { fingerprint: "ok", action: "created", issueNumber: 10, url: "https://gh/10" },
      { fingerprint: "ruim", action: "failed", issueNumber: null, url: null, error: "boom" },
    ]);
    const abertas = body.slice(body.indexOf("Issues abertas"), body.indexOf("FALHA ao abrir"));
    assert.match(abertas, /https:\/\/gh\/10/);
    assert.doesNotMatch(abertas, /ruim/);
  });

  it("sem nenhuma issue, diz isso em vez de deixar a seção vazia", () => {
    const { body } = buildAlarmEmail([t], [], []);
    assert.match(body, /\(nenhuma — ver o log da task\)/);
  });

  it("desaparecimento sem address cai no id, nunca em 'null'", () => {
    const { body } = buildAlarmEmail([], [{ ...d, address: null }], []);
    assert.match(body, /id 2 \(último estado: active\)/);
    assert.doesNotMatch(body, /null/);
  });
});

describe("loadOnboardingCorrelations (#7828)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-corr-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  function store(nome: string, entries: unknown): string {
    const p = join(dir, nome);
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({ version: 1, entries }), "utf8");
    return p;
  }

  it("indexa por e-mail em MINÚSCULAS — o Kit devolve o endereço como cadastrado", () => {
    const p = store("ok.json", {
      "123": { email: "Pedro@X.com", email1_sent_at: "2026-08-24T12:05:25.000Z", seeded_by: "#7660" },
    });
    const map = loadOnboardingCorrelations(p);
    assert.equal(map.get("pedro@x.com")?.email1SentAt, "2026-08-24T12:05:25.000Z");
    assert.equal(map.get("pedro@x.com")?.seededBy, "#7660");
  });

  it("`seeded_by` ausente não vira `null` — o campo simplesmente não existe", () => {
    const p = store("sem-seed.json", { "1": { email: "a@x.com", email1_sent_at: null } });
    const ctx = loadOnboardingCorrelations(p).get("a@x.com");
    assert.equal(ctx?.email1SentAt, null);
    assert.ok(!("seededBy" in (ctx ?? {})));
  });

  it("store ausente devolve mapa vazio — o alarme não morre por causa do enriquecimento", () => {
    assert.equal(loadOnboardingCorrelations(join(dir, "nao-existe.json")).size, 0);
  });

  it("entrada sem e-mail é pulada, não indexada sob chave vazia", () => {
    const p = store("sem-email.json", { "1": { email1_sent_at: null }, "2": { email: "b@x.com", email1_sent_at: null } });
    const map = loadOnboardingCorrelations(p);
    assert.equal(map.size, 1);
    assert.ok(map.has("b@x.com"));
  });

  it("`entries` malformado não derruba o alarme — degrada pra mapa vazio", () => {
    const p = join(dir, "quebrado.json");
    writeFileSync(p, JSON.stringify({ version: 1, entries: 42 }), "utf8");
    assert.equal(loadOnboardingCorrelations(p).size, 0);
  });
});

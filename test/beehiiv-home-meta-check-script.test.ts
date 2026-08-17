/**
 * test/beehiiv-home-meta-check-script.test.ts (#4557)
 *
 * Cobre as partes de I/O de `scripts/beehiiv-home-meta-check.ts` que não
 * exigem rede real nem `data/.credentials.json` (guard de #573/CLAUDE.md —
 * sem credencial Gmail real neste worktree; a regra de dispatch overnight
 * também proíbe qualquer chamada de rede real nesta sessão, mesmo sendo GET
 * público de leitura). Mesmo molde de `test/hub-drift-check-script.test.ts`:
 *
 *   - `fetchHomeHtml` com `fetchFn` mockado — 200, não-ok, e exceção de rede
 *     (nunca lança, sempre resolve pra `{ html, fetchError }`).
 *   - `loadState`/`saveState` — roundtrip de I/O em diretório temporário.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  fetchHomeHtml,
  loadState,
  saveState,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  checkLatestPostPage,
  ALARM_ALLOWLIST,
  toAlarmFinding,
} from "../scripts/beehiiv-home-meta-check.ts";
import {
  emptyHomeMetaAlarmState,
  advanceHomeMetaAlarmState,
  extractHomeMeta,
  evaluateHomeMetaDrift,
  homeMetaFindingIssueKey,
} from "../scripts/lib/beehiiv-home-meta-check.ts";
import { emptyAlarmIssuesState, planAlarmReconciliation, type AlarmIssuesState } from "../scripts/lib/alarm-issues.ts";

describe("fetchHomeHtml (#4557) — fetch mockado, sem rede real", () => {
  it("200 -> html preenchido, fetchError null", async () => {
    const mockFetch = (async () => new Response("<html>ok</html>", { status: 200 })) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, "<html>ok</html>");
    assert.equal(r.fetchError, null);
  });

  it("404 -> html null, fetchError com o status (não é exceção, é resposta HTTP não-ok)", async () => {
    const mockFetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, null);
    assert.match(r.fetchError ?? "", /404/);
  });

  it("500 -> html null, fetchError com o status", async () => {
    const mockFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, null);
    assert.match(r.fetchError ?? "", /500/);
  });

  it("fetch lança (rede indisponível) -> fetchError preenchido, html null, nunca propaga a exceção", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, null);
    assert.match(r.fetchError ?? "", /ECONNREFUSED/);
  });

  it("timeout (AbortError) -> fetchError preenchido, nunca propaga", async () => {
    const mockFetch = (async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    }) as unknown as typeof fetch;
    const r = await fetchHomeHtml("https://diar.ia.br/", mockFetch);
    assert.equal(r.html, null);
    assert.match(r.fetchError ?? "", /abort/i);
  });
});

describe("loadState / saveState (#4557, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "beehiiv-home-meta-check-state-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadState(resolve(tmpDir, "nao-existe.json")), emptyHomeMetaAlarmState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "state.json");
    const state = advanceHomeMetaAlarmState("og-title-brand:x", new Date("2026-08-11T12:00:00Z"));
    saveState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadState(path), emptyHomeMetaAlarmState());
  });

  it("lastAlarmedFingerprint null é preservado no roundtrip (drift limpo/re-armado)", () => {
    const path = resolve(tmpDir, "state.json");
    const state = advanceHomeMetaAlarmState(null, new Date("2026-08-11T12:00:00Z"));
    saveState(state, path);
    assert.equal(loadState(path).lastAlarmedFingerprint, null);
  });
});

describe("loadAlarmIssuesState / saveAlarmIssuesState (#5112, I/O)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "beehiiv-home-meta-check-alarm-issues-"));
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("arquivo ausente -> estado vazio (fail-soft)", () => {
    assert.deepEqual(loadAlarmIssuesState(resolve(tmpDir, "nao-existe.json")), emptyAlarmIssuesState());
  });

  it("roundtrip: save + load preserva o estado", () => {
    const path = resolve(tmpDir, "sub", "alarm-issues.json");
    const state: AlarmIssuesState = {
      "english-labels:x": { issueNumber: 5101, url: "https://x/5101", missingStreak: 0, closedAt: null },
    };
    saveAlarmIssuesState(state, path);
    assert.equal(existsSync(path), true);
    assert.deepEqual(loadAlarmIssuesState(path), state);
  });

  it("JSON corrompido -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "corrompido.json");
    writeFileSync(path, "{ nao é json válido");
    assert.deepEqual(loadAlarmIssuesState(path), emptyAlarmIssuesState());
  });

  it("JSON que não é objeto (array) -> estado vazio, nunca lança", () => {
    const path = resolve(tmpDir, "array.json");
    writeFileSync(path, "[1,2,3]");
    assert.deepEqual(loadAlarmIssuesState(path), emptyAlarmIssuesState());
  });
});

describe("ALARM_ALLOWLIST (#5364)", () => {
  it("fingerprint da entry english-labels casa EXATAMENTE com o fingerprint real gerado pelo achado 'N min read' isolado", () => {
    const html = [
      "<!doctype html><html><head>",
      '<meta property="og:title" content="diar.ia.br">',
      "</head><body>",
      "<p>5 min read</p>",
      "</body></html>",
    ].join("");
    const findings = evaluateHomeMetaDrift(html, extractHomeMeta(html));
    const finding = findings.find((f) => f.check === "english-labels");
    assert.ok(finding, `esperava achado english-labels: ${JSON.stringify(findings)}`);
    assert.equal(finding!.check, ALARM_ALLOWLIST[0].check);
    // Redundante de propósito (guarda contra o assert de fingerprint abaixo
    // ficar frouxo se `homeMetaFindingIssueKey` mudar de fórmula no futuro):
    // a mensagem precisa continuar batendo com o texto exato que a produção
    // já viu na issue real (#5364).
    assert.equal(finding!.message, 'rótulo(s) em inglês residual(is) encontrado(s): "N min read"');
    assert.equal(homeMetaFindingIssueKey(finding!), ALARM_ALLOWLIST[0].fingerprint);
  });

  it("cada entry carrega motivo, data e issue de referência (auditabilidade — não é array de strings sem contexto)", () => {
    for (const entry of ALARM_ALLOWLIST) {
      assert.ok(entry.reason && entry.reason.length > 10, "reason precisa ser texto explicativo, não vazio");
      assert.match(entry.accepted_at, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(entry.ref_issue, /^#\d+$/);
    }
  });

  it("planAlarmReconciliation com ALARM_ALLOWLIST real -> achado 'N min read' isolado nunca gera ação", () => {
    const html = [
      "<!doctype html><html><head>",
      '<meta property="og:title" content="diar.ia.br">',
      "</head><body>",
      "<p>5 min read</p>",
      "</body></html>",
    ].join("");
    const findings = evaluateHomeMetaDrift(html, extractHomeMeta(html));
    const finding = findings.find((f) => f.check === "english-labels")!;
    const alarmFinding = {
      check: finding.check,
      fingerprint: homeMetaFindingIssueKey(finding),
      title: "irrelevante pro teste",
      body: "irrelevante pro teste",
    };
    const actions = planAlarmReconciliation([alarmFinding], emptyAlarmIssuesState(), 2, ALARM_ALLOWLIST);
    assert.deepEqual(actions, []);
  });
});

describe("checkLatestPostPage (#5106) — fetch mockado, sem rede real", () => {
  const HOME_WITH_POST_LINK = `<nav><a href="https://diar.ia.br/p/edicao-mais-recente">Edição de hoje</a></nav>`;

  it("sem link /p/ na home -> findings vazio, postUrl null, não chama fetch", () => {
    let fetchCalled = false;
    const mockFetch = (async () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    return checkLatestPostPage("<html>sem posts</html>", mockFetch).then((r) => {
      assert.deepEqual(r, { findings: [], postUrl: null });
      assert.equal(fetchCalled, false);
    });
  });

  it("post encontrado, sem porta na URL -> findings vazio", async () => {
    const mockFetch = (async () =>
      new Response('<a href="https://diar.ia.br/archive">View more</a>', { status: 200 })) as unknown as typeof fetch;
    const r = await checkLatestPostPage(HOME_WITH_POST_LINK, mockFetch);
    assert.deepEqual(r.findings, []);
    assert.equal(r.postUrl, "https://diar.ia.br/p/edicao-mais-recente");
  });

  it("post encontrado, com porta na URL -> achado port-in-url", async () => {
    const mockFetch = (async () =>
      new Response('<a href="https://diar.ia.br:3002/archive">View more</a>', { status: 200 })) as unknown as typeof fetch;
    const r = await checkLatestPostPage(HOME_WITH_POST_LINK, mockFetch);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].check, "port-in-url");
  });

  it("fetch da página do post falha -> findings vazio (fail-soft), postUrl ainda preenchido", async () => {
    const mockFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await checkLatestPostPage(HOME_WITH_POST_LINK, mockFetch);
    assert.deepEqual(r.findings, []);
    assert.equal(r.postUrl, "https://diar.ia.br/p/edicao-mais-recente");
  });
});

describe("toAlarmFinding — family (#5558)", () => {
  it("é sempre 'estado' — os 6 eixos deste check são condição re-checável do HTML publicado", () => {
    const finding = toAlarmFinding({ check: "og-title-brand", message: "og:title diverge do H1" });
    assert.equal(finding.family, "estado");
  });
});

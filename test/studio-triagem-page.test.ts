/**
 * test/studio-triagem-page.test.ts (#3562) — cockpit de triagem de issues/PRs:
 * `GET /triagem` faz rewrite pro shell estático (`public/triagem.html`),
 * `GET /api/issues` serve o snapshot montado por `studio-issues.ts` (com um
 * `ghRun` mockado — nunca invoca o binário `gh` real nem rede em teste,
 * mesmo precedente de `test/bug-heatmap.test.ts`), e nenhuma rota de
 * mutação existe (guard read-only já coberto genericamente em
 * `studio-server.test.ts`, reforçado aqui pra `/api/issues` especificamente).
 * A página em si (fetch + filtros client-side) roda no browser sem harness
 * de DOM neste projeto — mesmo precedente de `studio-edicao-page.test.ts`.
 *
 * #4004: a seção "Composição de wave — preview" (rota de composição de onda
 * sobre este mesmo snapshot) e sua cobertura aqui foram removidas — o
 * mecanismo real de disparo já tinha sido descontinuado no #3720/#3985.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import { clearTriageCache, type GhRunFn } from "../scripts/studio-ui/studio-issues.ts";
import { EXEC_TRACK_LABELS } from "../scripts/lib/issue-exec-track.ts";

const mockIssues = [
  { number: 10, title: "issue P1", url: "https://github.com/x/y/issues/10", state: "OPEN", labels: [{ name: "P1" }] },
  { number: 11, title: "issue sem prioridade", url: "https://github.com/x/y/issues/11", state: "OPEN", labels: [{ name: "bug" }] },
];
const mockPrs = [
  {
    number: 20,
    title: "fix overnight",
    url: "https://github.com/x/y/pull/20",
    state: "OPEN",
    isDraft: false,
    headRefName: "overnight/fix-10-slug",
    labels: [{ name: "P0" }],
  },
];

const mockGhRun: GhRunFn = (args: string[]) => {
  if (args[0] === "issue") return { status: 0, stdout: JSON.stringify(mockIssues), stderr: "" };
  return { status: 0, stdout: JSON.stringify(mockPrs), stderr: "" };
};

describe("GET /triagem + GET /api/issues (#3562)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-triagem-page-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30, ghRun: mockGhRun });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearTriageCache();
  });

  it("serve o shell triagem.html", async () => {
    const res = await fetch(new URL("/triagem", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("triagem.js"));
    assert.ok(body.includes("filters-bar"));
    assert.ok(body.includes("issues-tbody"));
    assert.ok(body.includes("prs-tbody"));
  });

  it("aceita /triagem/ com trailing slash", async () => {
    const res = await fetch(new URL("/triagem/", server.url));
    assert.equal(res.status, 200);
  });

  it("(#3874) banners de erro têm role=alert; tabela zerada tem contêiner de estado vazio; botão desabilitado tem motivo em texto visível", async () => {
    const res = await fetch(new URL("/triagem", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="triage-error" class="panel alert-banner" role="alert"'));
    assert.ok(body.includes('id="issues-empty"'));
    assert.ok(body.includes('id="prs-empty"'));
    assert.ok(body.includes('id="dispatch-track-legend"'), "legenda visível de DISPATCH_TRACK_EXPLAIN precisa existir (não só title= por linha)");
  });

  it("GET /triagem.js é servido com content-type JS", async () => {
    const res = await fetch(new URL("/triagem.js", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
  });

  it("GET /triagem.css é servido com content-type CSS", async () => {
    const res = await fetch(new URL("/triagem.css", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  });

  it("POST /triagem é rejeitado com 405 (guard read-only)", async () => {
    const res = await fetch(new URL("/triagem", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("GET /api/issues retorna 200 JSON com o shape esperado, populado pelo runner mockado", async () => {
    const res = await fetch(new URL("/api/issues", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = await res.json();
    assert.equal(body.error, null);
    assert.equal(body.issues.length, 2);
    assert.equal(body.prs.length, 1);
    assert.equal(body.issues[0].priority, "P1");
    assert.equal(body.issues[1].priority, null);
    assert.equal(body.prs[0].track, "overnight");
    assert.equal(body.prs[0].priority, "P0");
  });

  it("POST /api/issues é rejeitado com 405 — nenhuma rota de mutação existe", async () => {
    const res = await fetch(new URL("/api/issues", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });

  it("DELETE /api/issues é rejeitado com 405 — reforça o guard read-only pra esta rota", async () => {
    const res = await fetch(new URL("/api/issues", server.url), { method: "DELETE" });
    assert.equal(res.status, 405);
  });

  it("resposta de /api/issues não inclui nenhum token/segredo — só o shape normalizado", async () => {
    const res = await fetch(new URL("/api/issues", server.url));
    const raw = await res.text();
    assert.ok(!/ghp_|gho_|github_pat_/.test(raw), "resposta não deve conter padrão de token do GitHub");
  });

  it("(#4004): GET /api/waves não existe mais (rota removida junto da seção de wave preview)", async () => {
    const res = await fetch(new URL("/api/waves", server.url));
    assert.equal(res.status, 404);
  });

  it("(#5175) filtro unificado: 1 único <select id=filter-dispatch-track> com <optgroup> Issues/PRs — não os 2 <select> separados de antes", async () => {
    const res = await fetch(new URL("/triagem", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="filter-dispatch-track"'), "select unificado precisa existir");
    assert.ok(!body.includes('id="filter-track"'), "select separado de Trilha (PRs) não deveria mais existir");
    assert.ok(!body.includes('id="filter-dispatch"'), "select separado de Classificação (issues) não deveria mais existir");
    assert.ok(body.includes('<optgroup label="Issues">'), "optgroup Issues ausente");
    assert.ok(body.includes('<optgroup label="PRs">'), "optgroup PRs ausente");
  });

  it("(#5175) colunas: header 'Classificação' aparece nas DUAS tabelas, na mesma posição (3ª coluna) — 'Trilha' não existe mais", async () => {
    const res = await fetch(new URL("/triagem", server.url));
    const body = await res.text();
    assert.ok(!body.includes("<th>Trilha</th>"), "header 'Trilha' deveria ter sido renomeado pra 'Classificação'");
    const classificacaoCount = (body.match(/<th>Classificação<\/th>/g) ?? []).length;
    assert.equal(classificacaoCount, 2, "'Classificação' precisa aparecer 1x em cada tabela (issues + PRs)");
  });

  it("(#5212) toda opção do <select> de Classificação carrega o escopo (Issues/PRs) no texto visível — sobrevive ao <select> fechado", async () => {
    const res = await fetch(new URL("/triagem", server.url));
    const body = await res.text();
    // #5462: o grupo Issues passou de elegível/bloqueada/ambígua pros 4
    // valores de execTrack. O prefixo de escopo continua obrigatório — sem
    // ele, "Overnight" apareceria 2x no <select> fechado (issue E pr) sem
    // nenhuma pista de qual tabela é afetada.
    // #5462: os 4 rótulos do grupo Issues são EXATAMENTE os de
    // `EXEC_TRACK_LABELS` — mesma capitalização do badge, pra que o valor
    // escolhido no `<select>` fechado case com o que a tabela mostra.
    for (const label of Object.values(EXEC_TRACK_LABELS)) {
      assert.ok(body.includes(`>Issues · ${label}<`), `opção "Issues · ${label}" ausente`);
    }
    assert.ok(body.includes(">PRs · overnight<"));
    assert.ok(body.includes(">PRs · develop<"));
    assert.ok(body.includes(">PRs · other<"));
    // nenhuma opção deve ter sobrado sem o prefixo de escopo (regressão do #5212)
    assert.ok(!body.includes('value="issue:overnight">Overnight<'), "opção não deveria ter perdido o prefixo 'Issues ·'");
    assert.ok(!body.includes('value="pr:overnight">overnight<'), "opção não deveria ter perdido o prefixo 'PRs ·'");
  });

  it("(#5212) chip de escopo (<h2>) e aviso de escopo (não afeta esta lista) existem no markup pras duas tabelas", async () => {
    const res = await fetch(new URL("/triagem", server.url));
    const body = await res.text();
    assert.ok(body.includes('id="issues-filter-chip"'));
    assert.ok(body.includes('id="prs-filter-chip"'));
    assert.ok(body.includes('id="issues-scope-notice"'));
    assert.ok(body.includes('id="prs-scope-notice"'));
  });
});

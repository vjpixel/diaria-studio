import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  collectCurrentlyReferencedEmails,
  readGroupCsvEmails,
  loadGroupCampaigns,
  findSuspendedCampaignEmails,
  main,
} from "../scripts/clarice-unblock-orphaned-selections.ts";
import { appendSentOrQueuedEmails, sentOrQueuedFilePath, type SentOrQueuedFile } from "../scripts/clarice-build-segment.ts";
import { acquireEnvioLock, lockPathForCycle } from "../scripts/lib/clarice-envio-lock.ts";
import { clariceSegmentsDir } from "../scripts/lib/clarice-paths.ts";

function makeJsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: () => "application/json" },
  } as unknown as Response);
}

const CYCLE = "2608-09";

// #8038 — collectCurrentlyReferencedEmails: universo de "quem ainda está em
// alguma onda viva do ciclo" (todo *.csv do diretório de segments).

test("collectCurrentlyReferencedEmails: une o email (1ª coluna) de todos os CSVs do diretório", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-"));
  writeFileSync(resolve(dir, "daily.csv"), "email,NOME\na@x.com,A\nb@x.com,B\n", "utf8");
  writeFileSync(resolve(dir, "novos.csv"), "email,NOME\nc@x.com,C\n", "utf8");
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out].sort(), ["a@x.com", "b@x.com", "c@x.com"]);
});

test("collectCurrentlyReferencedEmails: normaliza pra lowercase, ignora colunas além do email", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-norm-"));
  writeFileSync(resolve(dir, "engajados-priority-snapshot.csv"), "email,priority_points,cohort,priority_optin\nA@X.com,20,ex-assinantes,0\n", "utf8");
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out], ["a@x.com"]);
});

test("collectCurrentlyReferencedEmails: diretório ausente -> Set vazio, não lança", () => {
  const dir = resolve(tmpdir(), "unblock-collect-does-not-exist-" + Date.now());
  assert.deepEqual(collectCurrentlyReferencedEmails(dir), new Set());
});

test("collectCurrentlyReferencedEmails: arquivos não-CSV no diretório são ignorados", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-noncsv-"));
  writeFileSync(resolve(dir, "daily.csv"), "email\na@x.com\n", "utf8");
  writeFileSync(resolve(dir, "sent-or-queued.json"), '{"cycle":"x","emails":[],"history":[]}', "utf8");
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out], ["a@x.com"]);
});

test("collectCurrentlyReferencedEmails: subdiretório aninhado (ex: .mv-cache) não quebra a varredura — só lê arquivos, não recursa", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-collect-subdir-"));
  writeFileSync(resolve(dir, "daily.csv"), "email\na@x.com\n", "utf8");
  mkdirSync(resolve(dir, "subpasta"));
  const out = collectCurrentlyReferencedEmails(dir);
  assert.deepEqual([...out], ["a@x.com"]);
});

// ---------------------------------------------------------------------------
// #8117 — readGroupCsvEmails / loadGroupCampaigns / findSuspendedCampaignEmails
// (--check-suspended: cruza group-campaigns.json contra status ao vivo).
// ---------------------------------------------------------------------------

test("readGroupCsvEmails: lê a coluna email do CSV do grupo, normaliza lowercase", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-readcsv-"));
  writeFileSync(resolve(dir, "d3-qui03-A.csv"), "email,NOME\nA@X.com,A\nb@x.com,B\n", "utf8");
  assert.deepEqual(readGroupCsvEmails(dir, "d3-qui03-A"), ["a@x.com", "b@x.com"]);
});

test("readGroupCsvEmails: CSV ausente -> [], não lança", () => {
  const dir = resolve(tmpdir(), "unblock-readcsv-missing-" + Date.now());
  assert.deepEqual(readGroupCsvEmails(dir, "nunca-existiu"), []);
});

test("loadGroupCampaigns: lê group-campaigns.json (array de CampaignEntry)", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "unblock-loadcamp-"));
  writeFileSync(
    resolve(dir, "group-campaigns.json"),
    JSON.stringify([{ key: "d3-qui03-A", campaignId: 214, listId: 206, subject: "x", status: "scheduled" }]),
    "utf8",
  );
  const campaigns = loadGroupCampaigns(dir);
  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].campaignId, 214);
});

test("loadGroupCampaigns: ausente ou corrompido -> [], não lança", () => {
  const dirMissing = resolve(tmpdir(), "unblock-loadcamp-missing-" + Date.now());
  assert.deepEqual(loadGroupCampaigns(dirMissing), []);

  const dirCorrupt = mkdtempSync(resolve(tmpdir(), "unblock-loadcamp-corrupt-"));
  writeFileSync(resolve(dirCorrupt, "group-campaigns.json"), "{ não é json válido", "utf8");
  assert.deepEqual(loadGroupCampaigns(dirCorrupt), []);
});

test("findSuspendedCampaignEmails: só campanhas cujo campaignId está no Set ao vivo entram", () => {
  const groupCampaigns = [
    { key: "d3-qui03-A", campaignId: 214 },
    { key: "d3-qui03-B", campaignId: 215 },
    { key: "d10-sab10-A", campaignId: 250 }, // não suspensa
  ];
  const liveSuspended = new Set([214, 215]);
  const csvsByKey: Record<string, string[]> = {
    "d3-qui03-A": ["a@x.com", "b@x.com"],
    "d3-qui03-B": ["c@x.com"],
  };
  const found = findSuspendedCampaignEmails(groupCampaigns, liveSuspended, (key) => csvsByKey[key] ?? []);
  assert.deepEqual(found, [
    { key: "d3-qui03-A", campaignId: 214, emails: ["a@x.com", "b@x.com"] },
    { key: "d3-qui03-B", campaignId: 215, emails: ["c@x.com"] },
  ]);
});

test("findSuspendedCampaignEmails: campanha suspensa cujo CSV sumiu -> emails: [], não quebra", () => {
  const found = findSuspendedCampaignEmails([{ key: "sumiu", campaignId: 1 }], new Set([1]), () => []);
  assert.deepEqual(found, [{ key: "sumiu", campaignId: 1, emails: [] }]);
});

test("findSuspendedCampaignEmails: nenhuma campanha suspensa -> []", () => {
  const found = findSuspendedCampaignEmails([{ key: "d10-sab10-A", campaignId: 250 }], new Set(), () => ["a@x.com"]);
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------
// main() — CLI fim-a-fim (dry-run, --apply, lock), mesma técnica de
// withMockedExit de test/clarice-build-segment.test.ts.
// ---------------------------------------------------------------------------

async function withMockedExit<T>(
  fn: () => T | Promise<T>,
): Promise<{ result: T | undefined; exitCode: number | undefined; errors: string[] }> {
  const origExit = process.exit;
  const origErr = console.error;
  const errors: string[] = [];
  console.error = (...a: unknown[]) => { errors.push(a.map(String).join(" ")); };
  let exitCode: number | undefined;
  process.exit = (code?: number) => {
    exitCode = code;
    throw Object.assign(new Error(`__mock_exit__:${code}`), { __mockExit: true });
  };
  let result: T | undefined;
  try {
    result = await fn();
  } catch (e) {
    if (!(e instanceof Error && (e as Error & { __mockExit?: boolean }).__mockExit)) throw e;
  } finally {
    process.exit = origExit;
    console.error = origErr;
  }
  return { result, exitCode, errors };
}

test("main: --cycle ausente (#8117) -> usa computeExpectedEnvioCycle(hoje), não aborta", async () => {
  // #8117: --cycle deixou de ser obrigatório (task diária precisa resolver
  // "o ciclo de hoje" sem argumento dinâmico no registry). --base-dir
  // continua explícito aqui pra NUNCA tocar o data/ real de produção (esta
  // máquina tem o junction OneDrive montado) — só a resolução de `cycle` em
  // si está sob teste.
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-main-nocycle-seg-"));
  const { errors } = await withMockedExit(() => main(["--base-dir", baseDir]));
  assert.ok(
    errors.some((e) => e.includes("--cycle não informado — usando o ciclo de hoje:")),
    "avisa qual ciclo foi assumido",
  );
});

test("main --apply: desbloqueia órfãos de verdade e adquire/libera o lock (isolado via --lock-root-dir)", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-main-seg-"));
  const segDir = clariceSegmentsDir(CYCLE, baseDir);
  mkdirSync(segDir, { recursive: true });
  const lockRoot = mkdtempSync(resolve(tmpdir(), "unblock-main-lock-"));
  appendSentOrQueuedEmails(segDir, CYCLE, "engajados", ["orfao@x.com", "vivo@x.com"]);
  writeFileSync(resolve(segDir, "daily.csv"), "email\nvivo@x.com\n", "utf8"); // vivo@x.com ainda numa onda real

  await main(["--cycle", CYCLE, "--base-dir", baseDir, "--lock-root-dir", lockRoot, "--apply"]);

  const parsed = JSON.parse(readFileSync(sentOrQueuedFilePath(segDir), "utf8")) as SentOrQueuedFile;
  assert.deepEqual(parsed.emails, ["vivo@x.com"], "só o órfão sai; quem ainda está numa onda real permanece");

  // Lock foi liberado ao final — uma 2ª chamada consegue adquirir de novo.
  const lockPath = lockPathForCycle(lockRoot, CYCLE);
  assert.ok(!existsSync(lockPath), "lock liberado após a operação");
});

test("main --apply: lock JÁ SEGURO por outro processo -> aborta sem tocar sent-or-queued.json (exit 1)", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-main-heldlock-seg-"));
  const segDir = clariceSegmentsDir(CYCLE, baseDir);
  mkdirSync(segDir, { recursive: true });
  const lockRoot = mkdtempSync(resolve(tmpdir(), "unblock-main-heldlock-lock-"));
  appendSentOrQueuedEmails(segDir, CYCLE, "engajados", ["orfao@x.com"]);
  const before = readFileSync(sentOrQueuedFilePath(segDir), "utf8");

  acquireEnvioLock(lockRoot, CYCLE, "outra-sessao-simulada", new Date());

  const { exitCode, errors } = await withMockedExit(() =>
    main(["--cycle", CYCLE, "--base-dir", baseDir, "--lock-root-dir", lockRoot, "--apply"]),
  );
  assert.equal(exitCode, 1);
  assert.ok(errors.some((e) => e.includes("outra-sessao-simulada")), "mensagem nomeia quem segura o lock");
  assert.equal(readFileSync(sentOrQueuedFilePath(segDir), "utf8"), before, "sent-or-queued.json intocado — lock bloqueou ANTES da escrita");
});

test("main --dry-run: NÃO adquire lock (só leitura) — não interfere com uma rodada real em curso", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-main-dryrun-seg-"));
  const segDir = clariceSegmentsDir(CYCLE, baseDir);
  mkdirSync(segDir, { recursive: true });
  const lockRoot = mkdtempSync(resolve(tmpdir(), "unblock-main-dryrun-lock-"));
  appendSentOrQueuedEmails(segDir, CYCLE, "engajados", ["orfao@x.com"]);
  acquireEnvioLock(lockRoot, CYCLE, "rodada-real-em-curso", new Date()); // lock JÁ seguro

  // dry-run (sem --apply) não deve tentar adquirir o lock, então não deve lançar/abortar.
  await main(["--cycle", CYCLE, "--base-dir", baseDir, "--lock-root-dir", lockRoot]);

  const parsed = JSON.parse(readFileSync(sentOrQueuedFilePath(segDir), "utf8")) as SentOrQueuedFile;
  assert.deepEqual(parsed.emails, ["orfao@x.com"], "dry-run não escreve, mesmo com lock livre/seguro");
});

// ---------------------------------------------------------------------------
// main --check-suspended (#8117) — fim-a-fim com fetch mockado, mesmo padrão
// de test/brevo-committed-campaigns-3682.test.ts.
// ---------------------------------------------------------------------------

test("main --check-suspended --apply: campanha suspensa na Brevo libera seus contatos, mesmo com CSV intacto no disco", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-suspended-seg-"));
  const segDir = clariceSegmentsDir(CYCLE, baseDir);
  mkdirSync(segDir, { recursive: true });
  const lockRoot = mkdtempSync(resolve(tmpdir(), "unblock-suspended-lock-"));

  // d3-qui03-A: CSV continua no disco (não é órfão por presença) — mas a
  // campanha que ele alimentou virou "suspended" na Brevo.
  writeFileSync(resolve(segDir, "d3-qui03-A.csv"), "email,NOME\na@x.com,A\nb@x.com,B\n", "utf8");
  writeFileSync(
    resolve(segDir, "group-campaigns.json"),
    JSON.stringify([{ key: "d3-qui03-A", campaignId: 214, listId: 206, subject: "x", status: "scheduled" }]),
    "utf8",
  );
  appendSentOrQueuedEmails(segDir, CYCLE, "d3-qui03-A", ["a@x.com", "b@x.com", "c@x.com"]);
  writeFileSync(resolve(segDir, "outra-onda.csv"), "email\nc@x.com\n", "utf8"); // c@x.com segue numa onda VIVA

  const origFetch = globalThis.fetch;
  const origKey = process.env.BREVO_CLARICE_API_KEY;
  process.env.BREVO_CLARICE_API_KEY = "fake-key";
  globalThis.fetch = (async (url: string | URL) => {
    assert.ok(String(url).includes("status=suspended"), "deve consultar status=suspended");
    return makeJsonResponse({ campaigns: [{ id: 214, name: "Clarice 2608-09 d3-qui03-A" }] });
  }) as unknown as typeof fetch;

  try {
    await main(["--cycle", CYCLE, "--base-dir", baseDir, "--lock-root-dir", lockRoot, "--check-suspended", "--apply"]);
  } finally {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origKey;
  }

  const parsed = JSON.parse(readFileSync(sentOrQueuedFilePath(segDir), "utf8")) as SentOrQueuedFile;
  assert.deepEqual(
    parsed.emails,
    ["c@x.com"],
    "a@x.com e b@x.com (campanha suspensa) saem; c@x.com (onda viva) permanece",
  );
});

test("main --check-suspended sem BREVO_CLARICE_API_KEY -> aborta (exit 1), não degrada pra 'nada encontrado'", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-suspended-nokey-seg-"));
  const segDir = clariceSegmentsDir(CYCLE, baseDir);
  mkdirSync(segDir, { recursive: true });
  const lockRoot = mkdtempSync(resolve(tmpdir(), "unblock-suspended-nokey-lock-"));
  appendSentOrQueuedEmails(segDir, CYCLE, "d3-qui03-A", ["a@x.com"]);

  const origKey = process.env.BREVO_CLARICE_API_KEY;
  delete process.env.BREVO_CLARICE_API_KEY;
  try {
    const { exitCode } = await withMockedExit(() =>
      main(["--cycle", CYCLE, "--base-dir", baseDir, "--lock-root-dir", lockRoot, "--check-suspended", "--apply"]),
    );
    assert.equal(exitCode, 1);
  } finally {
    if (origKey === undefined) delete process.env.BREVO_CLARICE_API_KEY;
    else process.env.BREVO_CLARICE_API_KEY = origKey;
  }

  // nada foi desbloqueado — abortou antes de qualquer escrita.
  const parsed = JSON.parse(readFileSync(sentOrQueuedFilePath(segDir), "utf8")) as SentOrQueuedFile;
  assert.deepEqual(parsed.emails, ["a@x.com"]);
});

test("main SEM --check-suspended: comportamento inalterado, mesmo com campanha suspensa na Brevo (flag é opt-in)", async () => {
  const baseDir = mkdtempSync(resolve(tmpdir(), "unblock-suspended-optin-seg-"));
  const segDir = clariceSegmentsDir(CYCLE, baseDir);
  mkdirSync(segDir, { recursive: true });
  const lockRoot = mkdtempSync(resolve(tmpdir(), "unblock-suspended-optin-lock-"));
  writeFileSync(resolve(segDir, "d3-qui03-A.csv"), "email\na@x.com\n", "utf8");
  writeFileSync(
    resolve(segDir, "group-campaigns.json"),
    JSON.stringify([{ key: "d3-qui03-A", campaignId: 214, listId: 206, subject: "x", status: "scheduled" }]),
    "utf8",
  );
  appendSentOrQueuedEmails(segDir, CYCLE, "d3-qui03-A", ["a@x.com"]);

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch não deveria ser chamado sem --check-suspended");
  }) as unknown as typeof fetch;

  try {
    // a@x.com está referenciado no próprio CSV do grupo -> não é órfão por
    // presença, e sem --check-suspended a checagem viva nem roda.
    await main(["--cycle", CYCLE, "--base-dir", baseDir, "--lock-root-dir", lockRoot, "--apply"]);
  } finally {
    globalThis.fetch = origFetch;
  }

  const parsed = JSON.parse(readFileSync(sentOrQueuedFilePath(segDir), "utf8")) as SentOrQueuedFile;
  assert.deepEqual(parsed.emails, ["a@x.com"], "sem a flag, nada muda — a@x.com continua bloqueado");
});

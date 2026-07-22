/**
 * test/studio-apoios.test.ts (#3602) — cobertura de
 * scripts/studio-ui/studio-apoios.ts: CRUD puro de contato, derivação de
 * status (apoiando/não apoia/apoiou e parou, cruzando múltiplos emails),
 * agregação de campanha, parsing/serialização de `contacts.jsonl`, e a
 * orquestração fail-soft de `buildApoiosData` (data/ ausente, credenciais
 * ausentes, 401 da apoia.se) — tudo sem tocar rede real: `fetchImpl` é sempre
 * mockado.
 *
 * #3844: a maquinaria de follow-up/outreach (tipos, funções, campo
 * `outreach[]` do contato) foi removida do módulo — os testes correspondentes
 * saíram daqui junto. O que sobra: a mesma disciplina de campo legado do
 * #3611 (`circle`) agora também cobre `outreach` (ver describe de
 * `parseContactsJsonl` abaixo).
 *
 * #3844 parte 2: `computeRewardGroup`/`computeRewardGroups` — partição de
 * valor pago no mês em nível de recompensa (Amigo/Apoiador/Mantenedor/
 * Patrono), com casos de fronteira exatos nos limiares confirmados pelo
 * editor (R$5/10/25/50).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseContactsJsonl,
  serializeContactsJsonl,
  createContact,
  applyContactUpdate,
  findContact,
  upsertContact,
  deriveContactStatus,
  deriveOpenRate,
  loadOpenRateCache,
  openRateCachePath,
  computeCampaignSummary,
  emptyCampaignSummary,
  computeRewardGroup,
  computeRewardGroups,
  emptyRewardGroupsView,
  contactsFilePath,
  checkDataDirAvailable,
  loadContacts,
  saveContacts,
  readPastMonthSnapshots,
  fetchCurrentStatuses,
  buildApoiosData,
  refreshApoiosData,
  importNewApoiadoresFromGmail,
  addContact,
  updateContactById,
  parseCreateContactBody,
  parseUpdateContactBody,
  type ApoioContact,
  type ContactWithStatus,
  type OpenRateInfo,
  type OpenRateCache,
} from "../scripts/studio-ui/studio-apoios.ts";
import type { ApoiaSeEnv, BackerStatus } from "../scripts/lib/apoia-se.ts";
import type { DrainApoiaSeResult } from "../scripts/lib/apoia-se-gmail-drain.ts";

const FIXED_NOW = new Date("2026-07-16T12:00:00Z");
const TEST_ENV: ApoiaSeEnv = { apiKey: "k", apiSecret: "s", campaign: "diaria-test" };

/** Drain Gmail neutro (sem notificações novas) — injetado nos testes de
 * `refreshApoiosData` que focam exclusivamente na metade 2 (force-refresh de
 * pagamento, #3859), pra não depender de rede/credenciais Gmail reais. */
const NOOP_GMAIL_DRAIN = async (): Promise<DrainApoiaSeResult> => ({
  notifications: [],
  most_recent_iso: null,
  skipped: false,
});

function makeContact(overrides: Partial<ApoioContact> = {}): ApoioContact {
  return {
    id: "c1",
    name: "Fulano",
    emails: ["fulano@x.com"],
    notes: "",
    createdAt: FIXED_NOW.toISOString(),
    updatedAt: FIXED_NOW.toISOString(),
    ...overrides,
  };
}

// ─── parsing / serialização ─────────────────────────────────────────────

describe("parseContactsJsonl / serializeContactsJsonl (#3602)", () => {
  it("roundtrip preserva os campos", () => {
    const contacts = [makeContact(), makeContact({ id: "c2", name: "Beltrana", emails: ["b@x.com", "b2@x.com"] })];
    const raw = serializeContactsJsonl(contacts);
    const parsed = parseContactsJsonl(raw);
    assert.deepEqual(parsed, contacts);
  });

  it("ignora linhas vazias", () => {
    const raw = `${JSON.stringify(makeContact())}\n\n\n`;
    assert.equal(parseContactsJsonl(raw).length, 1);
  });

  it("array vazio serializa pra string vazia", () => {
    assert.equal(serializeContactsJsonl([]), "");
  });

  it("normaliza emails pra lowercase/trim e dedup na leitura", () => {
    const raw = JSON.stringify({ ...makeContact(), emails: [" Fulano@X.com ", "fulano@x.com"] });
    const parsed = parseContactsJsonl(raw);
    assert.deepEqual(parsed[0].emails, ["fulano@x.com"]);
  });

  it("regressão (#3844): linha legada com campo 'outreach[]' (schema removido) não quebra o parse, e o campo não é lido nem propagado", () => {
    const raw = JSON.stringify({
      ...makeContact(),
      outreach: [
        { date: "2026-07-01", channel: "email", responded: false, followupPending: true },
      ],
    });
    const parsed = parseContactsJsonl(raw);
    assert.equal(parsed.length, 1);
    assert.equal("outreach" in parsed[0], false);
    // roundtrip (parse -> serialize) também não reintroduz o campo.
    assert.equal(serializeContactsJsonl(parsed).includes("outreach"), false);
  });

  it("regressão (#3611): linha legada com campo 'circle' não quebra o parse, e o campo não é lido", () => {
    const raw = JSON.stringify({ ...makeContact(), circle: "import inicial 260716" });
    const parsed = parseContactsJsonl(raw);
    assert.equal(parsed.length, 1);
    assert.equal("circle" in parsed[0], false);
    // roundtrip (parse -> serialize) também não reintroduz o campo.
    assert.equal(serializeContactsJsonl(parsed).includes("circle"), false);
  });
});

// ─── CRUD puro ──────────────────────────────────────────────────────────

describe("createContact (#3602)", () => {
  it("cria contato com id/timestamps determinísticos quando injetados", () => {
    const c = createContact({ name: "Fulano", emails: ["Fulano@X.com"] }, { id: "fixed-id", now: FIXED_NOW });
    assert.equal(c.id, "fixed-id");
    assert.equal(c.name, "Fulano");
    assert.deepEqual(c.emails, ["fulano@x.com"]);
    assert.equal(c.createdAt, FIXED_NOW.toISOString());
    assert.equal("outreach" in c, false);
  });

  it("lança sem nome", () => {
    assert.throws(() => createContact({ name: "  ", emails: ["a@x.com"] }));
  });

  it("lança sem ao menos 1 email", () => {
    assert.throws(() => createContact({ name: "Fulano", emails: [] }));
  });

  it("dedup emails repetidos (case-insensitive)", () => {
    const c = createContact({ name: "F", emails: ["a@x.com", "A@X.COM"] });
    assert.deepEqual(c.emails, ["a@x.com"]);
  });
});

describe("applyContactUpdate (#3602)", () => {
  it("atualiza só os campos passados, preserva o resto", () => {
    const c = makeContact();
    const updated = applyContactUpdate(c, { notes: "nova nota" }, FIXED_NOW);
    assert.equal(updated.notes, "nova nota");
    assert.equal(updated.name, c.name);
    assert.deepEqual(updated.emails, c.emails);
    assert.equal(updated.updatedAt, FIXED_NOW.toISOString());
  });

  it("permite adicionar email à lista existente", () => {
    const c = makeContact({ emails: ["a@x.com"] });
    const updated = applyContactUpdate(c, { emails: ["a@x.com", "b@x.com"] });
    assert.deepEqual(updated.emails, ["a@x.com", "b@x.com"]);
  });

  it("lança se 'emails' for passado vazio", () => {
    assert.throws(() => applyContactUpdate(makeContact(), { emails: [] }));
  });

  it("lança se 'name' for passado vazio", () => {
    assert.throws(() => applyContactUpdate(makeContact(), { name: "   " }));
  });
});

describe("findContact / upsertContact (#3602)", () => {
  it("upsert adiciona quando id não existe", () => {
    const list = upsertContact([makeContact()], makeContact({ id: "c2" }));
    assert.equal(list.length, 2);
  });
  it("upsert substitui quando id já existe (imutável)", () => {
    const original = [makeContact()];
    const updated = upsertContact(original, makeContact({ id: "c1", notes: "mudou" }));
    assert.equal(updated[0].notes, "mudou");
    assert.equal(original[0].notes, ""); // array original intocado
  });
  it("findContact acha por id", () => {
    assert.equal(findContact([makeContact({ id: "x" })], "x")?.id, "x");
    assert.equal(findContact([makeContact({ id: "x" })], "y"), undefined);
  });
});

// ─── status derivado ────────────────────────────────────────────────────

describe("deriveContactStatus (#3602)", () => {
  it("apoiando quando QUALQUER email do contato paga este mês", () => {
    const status = deriveContactStatus(
      ["a@x.com", "b@x.com"],
      { "b@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 } },
      [],
    );
    assert.equal(status.label, "apoiando");
    assert.equal(status.monthlyValue, 25);
    assert.equal(status.matchedEmail, "b@x.com");
  });

  it("apoiou_e_parou quando não paga este mês mas pagou em mês passado", () => {
    const status = deriveContactStatus(
      ["a@x.com"],
      { "a@x.com": { isBacker: true, isPaidThisMonth: false } },
      [
        { month: "2026-06", statuses: { "a@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 10 } } },
      ],
    );
    assert.equal(status.label, "apoiou_e_parou");
    assert.equal(status.lastPaidMonth, "2026-06");
  });

  it("usa o mês passado MAIS RECENTE quando há múltiplos matches (snapshots ordenados desc)", () => {
    const status = deriveContactStatus(
      ["a@x.com"],
      {},
      [
        { month: "2026-06", statuses: { "a@x.com": { isBacker: true, isPaidThisMonth: true } } },
        { month: "2026-05", statuses: { "a@x.com": { isBacker: true, isPaidThisMonth: true } } },
      ],
    );
    assert.equal(status.lastPaidMonth, "2026-06");
  });

  it("nao_apoia quando nunca encontrado pagando", () => {
    const status = deriveContactStatus(["a@x.com"], { "a@x.com": { isBacker: false, isPaidThisMonth: false } }, []);
    assert.equal(status.label, "nao_apoia");
  });

  it("nao_apoia quando email não está em nenhum cache", () => {
    assert.equal(deriveContactStatus(["a@x.com"], {}, []).label, "nao_apoia");
  });
});

// ─── taxa de abertura Beehiiv (#3612) ───────────────────────────────────

function makeOpenRateInfo(overrides: Partial<OpenRateInfo> = {}): OpenRateInfo {
  return {
    subscriptionId: "sub-1",
    totalDelivered: 10,
    totalUniqueOpened: 5,
    openRatePct: 50,
    clickRatePct: 10,
    fetchedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("deriveOpenRate (#3612)", () => {
  it("1 email do contato bate no cache -> retorna os stats certos", () => {
    const contact = makeContact({ emails: ["fulano@x.com"] });
    const cache: OpenRateCache = { "fulano@x.com": makeOpenRateInfo({ openRatePct: 82 }) };
    const result = deriveOpenRate(contact, cache);
    assert.equal(result?.openRatePct, 82);
    assert.equal(result?.subscriptionId, "sub-1");
  });

  it("múltiplos emails, mais de 1 bate no cache -> retorna o de MAIOR totalDelivered", () => {
    const contact = makeContact({ emails: ["a@x.com", "b@x.com"] });
    const cache: OpenRateCache = {
      "a@x.com": makeOpenRateInfo({ subscriptionId: "sub-a", totalDelivered: 8 }),
      "b@x.com": makeOpenRateInfo({ subscriptionId: "sub-b", totalDelivered: 40 }),
    };
    const result = deriveOpenRate(contact, cache);
    assert.equal(result?.subscriptionId, "sub-b");
    assert.equal(result?.totalDelivered, 40);
  });

  it("nenhum email do contato está no cache -> null", () => {
    const contact = makeContact({ emails: ["nao-cadastrado@x.com"] });
    const cache: OpenRateCache = { "outro@x.com": makeOpenRateInfo() };
    assert.equal(deriveOpenRate(contact, cache), null);
  });

  it("cache vazio -> null, sem lançar", () => {
    const contact = makeContact({ emails: ["fulano@x.com"] });
    assert.equal(deriveOpenRate(contact, {}), null);
  });

  it("casa email em maiúscula/com espaço via normalização (mesmo padrão de deriveContactStatus)", () => {
    const contact = makeContact({ emails: ["fulano@x.com"] }); // já normalizado na leitura
    const cache: OpenRateCache = { "fulano@x.com": makeOpenRateInfo() };
    assert.notEqual(deriveOpenRate(contact, cache), null);
  });
});

describe("loadOpenRateCache (#3612)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-apoios-openrate-"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("arquivo ausente -> {} (sem lançar)", () => {
    const dir = join(root, "missing");
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(loadOpenRateCache(dir), {});
  });

  it("JSON corrompido -> {} (sem lançar)", () => {
    const dir = join(root, "corrupted");
    mkdirSync(join(dir, "data", "apoia-se"), { recursive: true });
    writeFileSync(openRateCachePath(dir), "{ nao é json válido");
    assert.deepEqual(loadOpenRateCache(dir), {});
  });

  it("array no lugar de objeto -> {} (shape inesperado)", () => {
    const dir = join(root, "array-shape");
    mkdirSync(join(dir, "data", "apoia-se"), { recursive: true });
    writeFileSync(openRateCachePath(dir), JSON.stringify([1, 2, 3]));
    assert.deepEqual(loadOpenRateCache(dir), {});
  });

  it("arquivo válido -> parseia e normaliza chaves (lowercase/trim)", () => {
    const dir = join(root, "valid");
    mkdirSync(join(dir, "data", "apoia-se"), { recursive: true });
    writeFileSync(
      openRateCachePath(dir),
      JSON.stringify({ " Fulano@X.com ": makeOpenRateInfo({ openRatePct: 91 }) }),
    );
    const cache = loadOpenRateCache(dir);
    assert.equal(cache["fulano@x.com"]?.openRatePct, 91);
  });

  it("entrada individual malformada é descartada, resto do cache sobrevive", () => {
    const dir = join(root, "partial-malformed");
    mkdirSync(join(dir, "data", "apoia-se"), { recursive: true });
    writeFileSync(
      openRateCachePath(dir),
      JSON.stringify({
        "bom@x.com": makeOpenRateInfo({ openRatePct: 70 }),
        "ruim@x.com": { openRatePct: "not-a-number" }, // faltam campos + tipo errado
      }),
    );
    const cache = loadOpenRateCache(dir);
    assert.equal(cache["bom@x.com"]?.openRatePct, 70);
    assert.equal("ruim@x.com" in cache, false);
  });
});

// ─── agregação de campanha ──────────────────────────────────────────────

describe("computeCampaignSummary (#3602)", () => {
  it("agrega totalContacts/Converted/valor", () => {
    const entries: ContactWithStatus[] = [
      { ...makeContact({ id: "c1" }), status: { label: "apoiando", monthlyValue: 20 }, openRate: null },
      { ...makeContact({ id: "c2" }), status: { label: "nao_apoia" }, openRate: null },
      { ...makeContact({ id: "c3" }), status: { label: "apoiando", monthlyValue: 10 }, openRate: null },
    ];
    const summary = computeCampaignSummary(entries);
    assert.equal(summary.totalContacts, 3);
    assert.equal(summary.totalConverted, 2);
    assert.equal(summary.monthlyValueSum, 30);
  });

  it("emptyCampaignSummary zera tudo", () => {
    assert.deepEqual(emptyCampaignSummary(), { totalContacts: 0, totalConverted: 0, monthlyValueSum: 0 });
  });
});

// ─── visão por grupo / nível de recompensa (#3844 parte 2) ─────────────

describe("computeRewardGroup (#3844 parte 2)", () => {
  it("undefined -> nenhum grupo", () => {
    assert.equal(computeRewardGroup(undefined), null);
  });

  it("0 -> nenhum grupo (abaixo do piso de R$5)", () => {
    assert.equal(computeRewardGroup(0), null);
  });

  it("negativo -> nenhum grupo (defensivo, nunca deveria ocorrer na prática)", () => {
    assert.equal(computeRewardGroup(-10), null);
  });

  it("R$4.99 -> nenhum grupo (abaixo do piso de R$5)", () => {
    assert.equal(computeRewardGroup(4.99), null);
  });

  it("R$5 -> amigo (piso exato)", () => {
    assert.equal(computeRewardGroup(5), "amigo");
  });

  it("R$9.99 -> amigo (fronteira abaixo do próximo nível)", () => {
    assert.equal(computeRewardGroup(9.99), "amigo");
  });

  it("R$10 -> apoiador (piso exato)", () => {
    assert.equal(computeRewardGroup(10), "apoiador");
  });

  it("R$24.99 -> apoiador (fronteira abaixo do próximo nível)", () => {
    assert.equal(computeRewardGroup(24.99), "apoiador");
  });

  it("R$15/R$20 (valores fora do valor-base, vistos em produção) -> apoiador", () => {
    assert.equal(computeRewardGroup(15), "apoiador");
    assert.equal(computeRewardGroup(20), "apoiador");
  });

  it("R$25 -> mantenedor (piso exato)", () => {
    assert.equal(computeRewardGroup(25), "mantenedor");
  });

  it("R$49.99 -> mantenedor (fronteira abaixo do próximo nível)", () => {
    assert.equal(computeRewardGroup(49.99), "mantenedor");
  });

  it("R$50 -> patrono (piso exato)", () => {
    assert.equal(computeRewardGroup(50), "patrono");
  });

  it("R$500 -> patrono (patrono é o teto, sem nível acima)", () => {
    assert.equal(computeRewardGroup(500), "patrono");
  });
});

describe("computeRewardGroups (#3844 parte 2)", () => {
  it("emptyRewardGroupsView zera as 4 chaves", () => {
    assert.deepEqual(emptyRewardGroupsView(), { amigo: [], apoiador: [], mantenedor: [], patrono: [] });
  });

  it("particiona uma lista de ContactWithStatus reproduzindo a distribuição de aceitação da issue (#3844)", () => {
    const entries: ContactWithStatus[] = [
      { ...makeContact({ id: "c1", name: "Patrono" }), status: { label: "apoiando", monthlyValue: 50 }, openRate: null },
      { ...makeContact({ id: "c2", name: "Mantenedor" }), status: { label: "apoiando", monthlyValue: 25 }, openRate: null },
      { ...makeContact({ id: "c3", name: "Apoiador1" }), status: { label: "apoiando", monthlyValue: 20 }, openRate: null },
      { ...makeContact({ id: "c4", name: "Apoiador2" }), status: { label: "apoiando", monthlyValue: 10 }, openRate: null },
      { ...makeContact({ id: "c5", name: "Amigo" }), status: { label: "apoiando", monthlyValue: 5 }, openRate: null },
    ];
    const groups = computeRewardGroups(entries);
    assert.deepEqual(groups.patrono.map((c) => c.name), ["Patrono"]);
    assert.deepEqual(groups.mantenedor.map((c) => c.name), ["Mantenedor"]);
    assert.deepEqual(groups.apoiador.map((c) => c.name), ["Apoiador1", "Apoiador2"]);
    assert.deepEqual(groups.amigo.map((c) => c.name), ["Amigo"]);
  });

  it("contato 'nao_apoia'/'apoiou_e_parou'/'sem_dados' nunca cai em nenhum grupo (só apoiando este mês entra)", () => {
    const entries: ContactWithStatus[] = [
      { ...makeContact({ id: "c1", name: "NaoApoia" }), status: { label: "nao_apoia" }, openRate: null },
      { ...makeContact({ id: "c2", name: "Parou" }), status: { label: "apoiou_e_parou", lastPaidMonth: "2026-06" }, openRate: null },
      { ...makeContact({ id: "c3", name: "SemDados" }), status: { label: "sem_dados" }, openRate: null },
    ];
    const groups = computeRewardGroups(entries);
    assert.deepEqual(groups, emptyRewardGroupsView());
  });

  it("contato 'apoiando' sem monthlyValue (não deveria ocorrer, mas defensivo) não cai em grupo algum", () => {
    const entries: ContactWithStatus[] = [
      { ...makeContact({ id: "c1", name: "SemValor" }), status: { label: "apoiando" }, openRate: null },
    ];
    assert.deepEqual(computeRewardGroups(entries), emptyRewardGroupsView());
  });
});

// ─── I/O: contacts.jsonl + snapshots mensais ────────────────────────────

describe("loadContacts / saveContacts / checkDataDirAvailable (#3602)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-apoios-io-"));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("checkDataDirAvailable erra quando data/ não existe", () => {
    const noData = join(root, "no-data-dir");
    mkdirSync(noData, { recursive: true });
    assert.match(checkDataDirAvailable(noData) ?? "", /junction OneDrive/);
  });

  it("loadContacts retorna [] quando o arquivo ainda não existe (mas data/ existe)", () => {
    const withData = join(root, "with-data-dir");
    mkdirSync(join(withData, "data"), { recursive: true });
    assert.equal(checkDataDirAvailable(withData), null);
    assert.deepEqual(loadContacts(withData), []);
  });

  it("saveContacts + loadContacts fazem roundtrip", () => {
    const dir = join(root, "roundtrip");
    mkdirSync(join(dir, "data"), { recursive: true });
    const contacts = [makeContact()];
    saveContacts(dir, contacts);
    assert.ok(existsSync(contactsFilePath(dir)));
    assert.deepEqual(loadContacts(dir), contacts);
  });

  it("loadContacts lança com mensagem clara em JSON corrompido", () => {
    const dir = join(root, "corrupted");
    mkdirSync(join(dir, "data", "apoia-se"), { recursive: true });
    writeFileSync(contactsFilePath(dir), "{ nao é json válido\n");
    assert.throws(() => loadContacts(dir), /corrompido/);
  });
});

describe("readPastMonthSnapshots (#3602)", () => {
  let cacheDir: string;

  before(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-cache-"));
    writeFileSync(join(cacheDir, "2026-06.json"), JSON.stringify({ "a@x.com": { isBacker: true, isPaidThisMonth: true } }));
    writeFileSync(join(cacheDir, "2026-05.json"), JSON.stringify({ "a@x.com": { isBacker: true, isPaidThisMonth: true } }));
    writeFileSync(join(cacheDir, "2026-07.json"), JSON.stringify({ "a@x.com": { isBacker: true, isPaidThisMonth: true } })); // mês corrente — deve ser excluído
    writeFileSync(join(cacheDir, "not-a-month.json"), "{}");
    writeFileSync(join(cacheDir, "2026-04.json"), "{ corrompido");
  });
  after(() => rmSync(cacheDir, { recursive: true, force: true }));

  it("exclui o mês corrente, ordena desc, ignora arquivo corrompido", () => {
    const snaps = readPastMonthSnapshots(cacheDir, "2026-07");
    assert.deepEqual(snaps.map((s) => s.month), ["2026-06", "2026-05"]);
  });

  it("retorna [] quando o diretório não existe", () => {
    assert.deepEqual(readPastMonthSnapshots(join(cacheDir, "nope"), "2026-07"), []);
  });
});

// ─── fetchCurrentStatuses (fetchImpl mockado, nunca rede real) ─────────

describe("fetchCurrentStatuses (#3602)", () => {
  let cacheDir: string;

  before(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-fetch-"));
  });
  after(() => rmSync(cacheDir, { recursive: true, force: true }));

  it("resolve sequencialmente e preenche o map por email", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 15 }), { status: 200 });
    }) as typeof fetch;

    const { statuses, error } = await fetchCurrentStatuses(["a@x.com", "b@x.com"], {
      env: TEST_ENV,
      cacheDir: join(cacheDir, "seq"),
      now: FIXED_NOW,
      fetchImpl,
    });
    assert.equal(error, null);
    assert.equal(calls.length, 2);
    assert.equal(statuses["a@x.com"].isPaidThisMonth, true);
    assert.equal(statuses["b@x.com"].thisMonthPaidValue, 15);
  });

  it("pára cedo (fail-fast) em erro de auth — não tenta os emails restantes", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    }) as typeof fetch;

    const { statuses, error } = await fetchCurrentStatuses(["a@x.com", "b@x.com", "c@x.com"], {
      env: TEST_ENV,
      cacheDir: join(cacheDir, "auth-fail"),
      now: FIXED_NOW,
      fetchImpl,
    });
    assert.equal(calls, 1);
    assert.match(error ?? "", /401|unauthorized|não autorizado/i);
    assert.deepEqual(statuses, {});
  });

  it("erro pontual (não-auth) num email não impede os demais", async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes("bad")) {
        return new Response("boom", { status: 500 });
      }
      return new Response(JSON.stringify({ isBacker: false, isPaidThisMonth: false }), { status: 200 });
    }) as typeof fetch;

    const { statuses, error } = await fetchCurrentStatuses(["bad@x.com", "ok@x.com"], {
      env: TEST_ENV,
      cacheDir: join(cacheDir, "partial"),
      now: FIXED_NOW,
      fetchImpl,
    });
    assert.equal(error, null);
    assert.equal("bad@x.com" in statuses, false);
    assert.equal(statuses["ok@x.com"].isPaidThisMonth, false);
  });
});

// ─── buildApoiosData (orquestração fail-soft) ───────────────────────────

describe("buildApoiosData (#3602)", () => {
  it("data/ ausente -> error preenchido, contacts vazio", async () => {
    const root = mkdtempSync(join(tmpdir(), "studio-apoios-nodatadir-"));
    try {
      const result = await buildApoiosData(root, { now: FIXED_NOW });
      assert.match(result.error ?? "", /junction OneDrive/);
      assert.deepEqual(result.contacts, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("credenciais ausentes (env vars limpas) -> status sem_dados, error explica variável faltante", async () => {
    const saved = {
      key: process.env.APOIA_SE_API_KEY,
      secret: process.env.APOIA_SE_API_SECRET,
      campaign: process.env.APOIA_SE_CAMPAIGN,
    };
    delete process.env.APOIA_SE_API_KEY;
    delete process.env.APOIA_SE_API_SECRET;
    delete process.env.APOIA_SE_CAMPAIGN;
    try {
      const contacts = [makeContact()];
      const result = await buildApoiosData("irrelevant-root", { now: FIXED_NOW, contacts });
      assert.match(result.error ?? "", /APOIA_SE_API_KEY/);
      assert.equal(result.contacts[0].status.label, "sem_dados");
      assert.deepEqual(result.campaign.totalContacts, 1);
    } finally {
      if (saved.key !== undefined) process.env.APOIA_SE_API_KEY = saved.key;
      if (saved.secret !== undefined) process.env.APOIA_SE_API_SECRET = saved.secret;
      if (saved.campaign !== undefined) process.env.APOIA_SE_CAMPAIGN = saved.campaign;
    }
  });

  it("regressão (self-review #3608): falha de auth NO MEIO do loop marca contato não-checado como sem_dados, não nao_apoia", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-authfail-cache-"));
    try {
      const contacts = [
        makeContact({ id: "checked", name: "Checado", emails: ["a@x.com"] }),
        makeContact({ id: "unchecked", name: "Não checado", emails: ["b@x.com"] }),
      ];
      // "a@x.com" resolve com sucesso (não paga); "b@x.com" nunca chega a ser
      // tentado de verdade — a chamada pra ele estoura 401 (credencial
      // rotacionada no meio da sessão), o que aborta o loop antes de resolver
      // qualquer email subsequente.
      const fetchImpl = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("a%40x.com") || u.includes("a@x.com")) {
          return new Response(JSON.stringify({ isBacker: false, isPaidThisMonth: false }), { status: 200 });
        }
        return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
      }) as typeof fetch;

      const result = await buildApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
      });

      const byId = Object.fromEntries(result.contacts.map((c) => [c.id, c.status]));
      // Resolvido com sucesso (checkBacker respondeu) -> "nao_apoia" de fato correto.
      assert.equal(byId.checked.label, "nao_apoia");
      // NUNCA resolvido (abortado por auth) -> "sem_dados", NÃO "nao_apoia".
      assert.equal(byId.unchecked.label, "sem_dados");
      assert.match(result.error ?? "", /401|unauthorized|não autorizado/i);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("caminho feliz: cruza status ao vivo (fetchImpl mockado) + histórico do cacheDir", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-happy-cache-"));
    try {
      writeFileSync(
        join(cacheDir, "2026-06.json"),
        JSON.stringify({ "parou@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 5 } }),
      );
      const contacts = [
        makeContact({ id: "c1", name: "Ativo", emails: ["ativo@x.com"] }),
        makeContact({ id: "c2", name: "Parou", emails: ["parou@x.com"] }),
        makeContact({ id: "c3", name: "Nunca", emails: ["nunca@x.com"] }),
      ];
      const fetchImpl = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("ativo")) {
          return new Response(JSON.stringify({ isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 20 }), { status: 200 });
        }
        return new Response(JSON.stringify({ isBacker: false, isPaidThisMonth: false }), { status: 200 });
      }) as typeof fetch;

      const result = await buildApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
      });

      assert.equal(result.error, null);
      const byId = Object.fromEntries(result.contacts.map((c) => [c.id, c.status]));
      assert.equal(byId.c1.label, "apoiando");
      assert.equal(byId.c1.monthlyValue, 20);
      assert.equal(byId.c2.label, "apoiou_e_parou");
      assert.equal(byId.c2.lastPaidMonth, "2026-06");
      assert.equal(byId.c3.label, "nao_apoia");
      assert.equal(result.campaign.totalContacts, 3);
      assert.equal(result.campaign.totalConverted, 1);
      assert.equal(result.campaign.monthlyValueSum, 20);
      // #3844 parte 2: rewardGroups reusa o MESMO ContactWithStatus[] já
      // montado acima — c1 (R$20, apoiando) cai em "apoiador"; c2/c3 (não
      // apoiando este mês) não aparecem em grupo algum.
      assert.deepEqual(result.rewardGroups.apoiador.map((c) => c.id), ["c1"]);
      assert.deepEqual(result.rewardGroups.amigo, []);
      assert.deepEqual(result.rewardGroups.mantenedor, []);
      assert.deepEqual(result.rewardGroups.patrono, []);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  // ── #3612: cache de taxa de abertura Beehiiv é ortogonal ao status de
  // apoio — cobre os 2 caminhos de retorno que constroem ContactWithStatus
  // (credenciais ausentes E caminho feliz), garantindo fail-soft total.

  it("cache de open-rate ausente/vazio -> TODOS os contatos com openRate: null (mesmo sem credenciais apoia.se)", async () => {
    const saved = {
      key: process.env.APOIA_SE_API_KEY,
      secret: process.env.APOIA_SE_API_SECRET,
      campaign: process.env.APOIA_SE_CAMPAIGN,
    };
    delete process.env.APOIA_SE_API_KEY;
    delete process.env.APOIA_SE_API_SECRET;
    delete process.env.APOIA_SE_CAMPAIGN;
    try {
      const contacts = [makeContact({ id: "c1", emails: ["fulano@x.com"] })];
      const result = await buildApoiosData("irrelevant-root", { now: FIXED_NOW, contacts, openRateCache: {} });
      assert.equal(result.contacts[0].status.label, "sem_dados"); // credenciais ausentes
      assert.equal(result.contacts[0].openRate, null); // cache vazio, sem lançar
    } finally {
      if (saved.key !== undefined) process.env.APOIA_SE_API_KEY = saved.key;
      if (saved.secret !== undefined) process.env.APOIA_SE_API_SECRET = saved.secret;
      if (saved.campaign !== undefined) process.env.APOIA_SE_CAMPAIGN = saved.campaign;
    }
  });

  it("caminho feliz: openRate populado via cache injetado, independente do status de apoio", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-openrate-happy-cache-"));
    try {
      const contacts = [
        makeContact({ id: "c1", name: "Ativo", emails: ["ativo@x.com"] }),
        makeContact({ id: "c2", name: "SemAbertura", emails: ["sem-abertura@x.com"] }),
      ];
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ isBacker: false, isPaidThisMonth: false }), { status: 200 })) as typeof fetch;
      const openRateCache: OpenRateCache = {
        "ativo@x.com": makeOpenRateInfo({ subscriptionId: "sub-ativo", openRatePct: 77 }),
      };

      const result = await buildApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        openRateCache,
      });

      const byId = Object.fromEntries(result.contacts.map((c) => [c.id, c.openRate]));
      assert.equal(byId.c1?.openRatePct, 77);
      assert.equal(byId.c2, null);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

// ─── refreshApoiosData — force-refresh seletivo (#3859 metade 2) ───────

describe("refreshApoiosData (#3859)", () => {
  it("cenário exato da issue: apoiador paga dia 15, cache tinha false do dia 1º — force-refresh corrige e mostra 'apoiando'", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-day15-"));
    try {
      // Simula o que o cache já tinha gravado no dia 1º (checkBacker normal,
      // sem force): apoiador registrado, mas ainda não tinha pago.
      writeFileSync(
        join(cacheDir, "2026-07.json"),
        JSON.stringify({ "late@x.com": { isBacker: true, isPaidThisMonth: false } }),
      );
      const contacts = [makeContact({ id: "c1", name: "Pagou dia 15", emails: ["late@x.com"] })];
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(
          JSON.stringify({ isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 30 }),
          { status: 200 },
        );
      }) as typeof fetch;

      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain: NOOP_GMAIL_DRAIN,
      });

      assert.equal(result.error, null);
      assert.equal(calls, 1, "1 request pro único email não-confirmado");
      assert.equal(result.contacts[0].status.label, "apoiando");
      assert.equal(result.contacts[0].status.monthlyValue, 30);
      assert.equal(result.campaign.totalConverted, 1);

      // O cache em disco reflete o valor fresco (persistido por checkBacker).
      const onDisk = JSON.parse(readFileSync(join(cacheDir, "2026-07.json"), "utf-8"));
      assert.equal(onDisk["late@x.com"].isPaidThisMonth, true);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("teto de 5.000 req/mês: NUNCA re-checa contato já confirmado 'apoiando' — zero requests pros já pagantes", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-cap-"));
    try {
      writeFileSync(
        join(cacheDir, "2026-07.json"),
        JSON.stringify({
          "pagante1@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 10 },
          "pagante2@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 20 },
        }),
      );
      const contacts = [
        makeContact({ id: "confirmado1", name: "Confirmado 1", emails: ["pagante1@x.com"] }),
        makeContact({ id: "confirmado2", name: "Confirmado 2", emails: ["pagante2@x.com"] }),
        makeContact({ id: "novo", name: "Não confirmado", emails: ["novo@x.com"] }),
      ];
      const calledUrls: string[] = [];
      const fetchImpl = (async (url: string | URL) => {
        calledUrls.push(String(url));
        return new Response(JSON.stringify({ isBacker: false, isPaidThisMonth: false }), { status: 200 });
      }) as typeof fetch;

      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain: NOOP_GMAIL_DRAIN,
      });

      assert.equal(result.error, null);
      // Só o contato não-confirmado gera request — os 2 já pagantes nunca
      // são tocados (nem no path da fetch, nem no resultado final).
      assert.equal(calledUrls.length, 1);
      assert.ok(calledUrls[0].includes("novo") || calledUrls[0].toLowerCase().includes("novo%40x.com"));
      const byId = Object.fromEntries(result.contacts.map((c) => [c.id, c.status]));
      assert.equal(byId.confirmado1.label, "apoiando");
      assert.equal(byId.confirmado1.monthlyValue, 10);
      assert.equal(byId.confirmado2.label, "apoiando");
      assert.equal(byId.confirmado2.monthlyValue, 20);
      assert.equal(byId.novo.label, "nao_apoia");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("contato com múltiplos emails já confirmado por UM email pula TODOS os emails do contato (mesmo os nunca vistos no cache)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-multiemail-"));
    try {
      writeFileSync(
        join(cacheDir, "2026-07.json"),
        JSON.stringify({ "principal@x.com": { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 15 } }),
      );
      const contacts = [
        makeContact({ id: "c1", name: "Multi-email", emails: ["principal@x.com", "secundario@x.com"] }),
      ];
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(JSON.stringify({ isBacker: false, isPaidThisMonth: false }), { status: 200 });
      }) as typeof fetch;

      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain: NOOP_GMAIL_DRAIN,
      });

      assert.equal(calls, 0, "contato já confirmado (por qualquer email) não gera NENHUMA request nova");
      assert.equal(result.contacts[0].status.label, "apoiando");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("contato nunca visto (cache vazio) é tratado como não-confirmado e resolvido normalmente", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-brandnew-"));
    try {
      const contacts = [makeContact({ id: "c1", name: "Novato", emails: ["brand-new@x.com"] })];
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 5 }), { status: 200 })) as typeof fetch;

      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain: NOOP_GMAIL_DRAIN,
      });

      assert.equal(result.contacts[0].status.label, "apoiando");
      assert.equal(result.contacts[0].status.monthlyValue, 5);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("falha de auth NO MEIO do force-refresh marca contato não-checado como sem_dados (mesmo guard de buildApoiosData)", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-authfail-"));
    try {
      const contacts = [
        makeContact({ id: "resolvido", name: "Resolvido", emails: ["a@x.com"] }),
        makeContact({ id: "nao-resolvido", name: "Não resolvido", emails: ["b@x.com"] }),
      ];
      const fetchImpl = (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("a%40x.com") || u.includes("a@x.com")) {
          return new Response(JSON.stringify({ isBacker: false, isPaidThisMonth: false }), { status: 200 });
        }
        return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
      }) as typeof fetch;

      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain: NOOP_GMAIL_DRAIN,
      });

      const byId = Object.fromEntries(result.contacts.map((c) => [c.id, c.status]));
      assert.match(result.error ?? "", /401|unauthorized|não autorizado/i);
      // "a" foi de fato resolvido (respondeu, ainda que negativo) -> nao_apoia.
      assert.equal(byId.resolvido.label, "nao_apoia");
      // "b" nunca foi resolvido (abortado por auth) -> sem_dados, nunca nao_apoia.
      assert.equal(byId["nao-resolvido"].label, "sem_dados");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("data/ ausente -> error preenchido, contacts vazio (mesmo fail-soft de buildApoiosData)", async () => {
    const root = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-nodatadir-"));
    try {
      const result = await refreshApoiosData(root, { now: FIXED_NOW });
      assert.match(result.error ?? "", /junction OneDrive/);
      assert.deepEqual(result.contacts, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("credenciais ausentes -> status sem_dados pra todos, sem nenhuma tentativa de rede", async () => {
    const saved = {
      key: process.env.APOIA_SE_API_KEY,
      secret: process.env.APOIA_SE_API_SECRET,
      campaign: process.env.APOIA_SE_CAMPAIGN,
    };
    delete process.env.APOIA_SE_API_KEY;
    delete process.env.APOIA_SE_API_SECRET;
    delete process.env.APOIA_SE_CAMPAIGN;
    try {
      const contacts = [makeContact()];
      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        gmailDrain: NOOP_GMAIL_DRAIN,
      });
      assert.match(result.error ?? "", /APOIA_SE_API_KEY/);
      assert.equal(result.contacts[0].status.label, "sem_dados");
    } finally {
      if (saved.key !== undefined) process.env.APOIA_SE_API_KEY = saved.key;
      if (saved.secret !== undefined) process.env.APOIA_SE_API_SECRET = saved.secret;
      if (saved.campaign !== undefined) process.env.APOIA_SE_CAMPAIGN = saved.campaign;
    }
  });

  // ── #3859 metade 1: import automático via e-mail apoia.se ─────────────

  it("import via e-mail: notificação de apoiador NOVO cria contato automaticamente antes do force-refresh", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-gmailimport-new-"));
    const root = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-gmailimport-new-root-"));
    try {
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 }), { status: 200 })) as typeof fetch;
      const gmailDrain = async (): Promise<DrainApoiaSeResult> => ({
        notifications: [{ name: "ALMIR", email: "alalmas@gmail.com", value: 25 }],
        most_recent_iso: "2026-07-16T10:00:00Z",
        skipped: false,
      });

      const result = await refreshApoiosData(root, {
        now: FIXED_NOW,
        contacts: [],
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain,
      });

      assert.equal(result.error, null);
      assert.equal(result.contacts.length, 1);
      assert.equal(result.contacts[0].name, "ALMIR");
      assert.deepEqual(result.contacts[0].emails, ["alalmas@gmail.com"]);
      assert.equal(result.contacts[0].notes, "importado automaticamente via e-mail apoia.se");
      assert.equal(result.contacts[0].status.label, "apoiando");

      // Persistido em contacts.jsonl (rootDir real, não injetado) — não só em memória.
      const persisted = JSON.parse(
        readFileSync(join(root, "data", "apoia-se", "contacts.jsonl"), "utf-8").trim(),
      );
      assert.equal(persisted.emails[0], "alalmas@gmail.com");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("import via e-mail: notificação de apoiador JÁ EXISTENTE não duplica contato", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-gmailimport-dup-"));
    try {
      const existing = makeContact({ id: "c1", name: "Almir Original", emails: ["alalmas@gmail.com"] });
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 }), { status: 200 })) as typeof fetch;
      const gmailDrain = async (): Promise<DrainApoiaSeResult> => ({
        notifications: [{ name: "ALMIR", email: "alalmas@gmail.com", value: 25 }],
        most_recent_iso: "2026-07-16T10:00:00Z",
        skipped: false,
      });

      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts: [existing],
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain,
      });

      // Continua com 1 único contato — o existente, com o nome ORIGINAL
      // preservado (import automático nunca sobrescreve um contato já
      // cadastrado, só cria quando o email é genuinamente novo).
      assert.equal(result.contacts.length, 1);
      assert.equal(result.contacts[0].id, "c1");
      assert.equal(result.contacts[0].name, "Almir Original");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("import via e-mail: falha do drain (fail-soft) NÃO trava o force-refresh de pagamento", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-gmailimport-failsoft-"));
    try {
      const contacts = [makeContact({ id: "c1", name: "Fulano", emails: ["fulano@x.com"] })];
      let calls = 0;
      const fetchImpl = (async () => {
        calls++;
        return new Response(JSON.stringify({ isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 40 }), { status: 200 });
      }) as typeof fetch;
      const gmailDrain = async (): Promise<DrainApoiaSeResult> => {
        throw new Error("token expirado (invalid_grant)");
      };

      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain,
      });

      // Force-refresh de pagamento roda normalmente mesmo com o drain falhando.
      assert.equal(calls, 1);
      assert.equal(result.contacts[0].status.label, "apoiando");
      assert.equal(result.contacts[0].status.monthlyValue, 40);
      // Falha do drain é reportada (fail-soft), não engolida silenciosamente.
      assert.match(result.error ?? "", /import automático via e-mail apoia\.se falhou/);
      assert.match(result.error ?? "", /invalid_grant/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("import via e-mail: drain 'skipped' (ex: auth expirado) também NÃO trava o force-refresh, error documenta o motivo", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-gmailimport-skipped-"));
    try {
      const contacts = [makeContact({ id: "c1", name: "Fulano", emails: ["fulano@x.com"] })];
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ isBacker: false, isPaidThisMonth: false }), { status: 200 })) as typeof fetch;
      const gmailDrain = async (): Promise<DrainApoiaSeResult> => ({
        notifications: [],
        most_recent_iso: null,
        skipped: true,
        reason: "auth_expired",
        auth_expired: true,
      });

      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain,
      });

      assert.equal(result.contacts[0].status.label, "nao_apoia");
      assert.match(result.error ?? "", /import automático via e-mail apoia\.se pulado/);
      assert.match(result.error ?? "", /auth_expired/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("import via e-mail: erro do force-refresh de pagamento (mais crítico) NUNCA é sobrescrito pelo erro do drain", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "studio-apoios-refresh-gmailimport-priority-"));
    try {
      const contacts = [makeContact({ id: "c1", name: "Fulano", emails: ["fulano@x.com"] })];
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 })) as typeof fetch;
      const gmailDrain = async (): Promise<DrainApoiaSeResult> => {
        throw new Error("gmail indisponível");
      };

      const result = await refreshApoiosData("irrelevant-root", {
        now: FIXED_NOW,
        contacts,
        env: TEST_ENV,
        cacheDir,
        fetchImpl,
        gmailDrain,
      });

      // O erro de auth da apoia.se (força-refresh) é mais crítico e prevalece
      // sobre o erro (fail-soft) do drain de e-mail.
      assert.match(result.error ?? "", /401|unauthorized|não autorizado/i);
      assert.doesNotMatch(result.error ?? "", /gmail indisponível/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

// ─── importNewApoiadoresFromGmail — aplicação pura das notificações ────

describe("importNewApoiadoresFromGmail (#3859 metade 1)", () => {
  it("email novo (nenhum contato existente tem ele) cria 1 contato com a nota padrão", () => {
    const { contacts, mutated, imported } = importNewApoiadoresFromGmail(
      [],
      [{ name: "Monica", email: "sintetica@gmail.com", value: 5 }],
    );
    assert.equal(mutated, true);
    assert.equal(imported, 1);
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].name, "Monica");
    assert.deepEqual(contacts[0].emails, ["sintetica@gmail.com"]);
    assert.equal(contacts[0].notes, "importado automaticamente via e-mail apoia.se");
  });

  it("email já cadastrado em QUALQUER contato não gera duplicata", () => {
    const existing = makeContact({ id: "c1", name: "Já Existe", emails: ["ja@x.com", "outro@x.com"] });
    const { contacts, mutated, imported } = importNewApoiadoresFromGmail(
      [existing],
      [{ name: "Nome Diferente", email: "OUTRO@X.COM", value: 10 }],
    );
    assert.equal(mutated, false);
    assert.equal(imported, 0);
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0].name, "Já Existe");
  });

  it("2 notificações pra MESMO email novo dentro do mesmo lote não duplicam entre si", () => {
    const { contacts, imported } = importNewApoiadoresFromGmail(
      [],
      [
        { name: "Luis", email: "lfangerami@usp.br", value: 5 },
        { name: "Luis", email: "lfangerami@usp.br", value: 5 },
      ],
    );
    assert.equal(imported, 1);
    assert.equal(contacts.length, 1);
  });

  it("lista vazia de notificações -> mutated false, contatos inalterados", () => {
    const existing = [makeContact()];
    const { contacts, mutated, imported } = importNewApoiadoresFromGmail(existing, []);
    assert.equal(mutated, false);
    assert.equal(imported, 0);
    assert.deepEqual(contacts, existing);
  });
});

// ─── mutações de I/O (read-modify-write do jsonl) ───────────────────────

describe("addContact / updateContactById (#3602)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-apoios-mutations-"));
    mkdirSync(join(root, "data"), { recursive: true });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("addContact grava no jsonl e retorna o contato criado", () => {
    const result = addContact(root, { name: "Fulano", emails: ["fulano@x.com"] });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.contact.name, "Fulano");
      const loaded = loadContacts(root);
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].id, result.contact.id);
    }
  });

  it("addContact com input inválido retorna ok:false sem escrever", () => {
    const before = loadContacts(root).length;
    const result = addContact(root, { name: "", emails: [] });
    assert.equal(result.ok, false);
    assert.equal(loadContacts(root).length, before);
  });

  it("updateContactById atualiza contato existente", () => {
    const created = addContact(root, { name: "Beltrana", emails: ["b@x.com"] });
    assert.ok(created.ok);
    const id = created.ok ? created.contact.id : "";
    const updated = updateContactById(root, id, { notes: "nota nova" });
    assert.equal(updated.ok, true);
    if (updated.ok) assert.equal(updated.contact.notes, "nota nova");
  });

  it("updateContactById em id inexistente retorna erro 'não encontrado'", () => {
    const result = updateContactById(root, "does-not-exist", { notes: "x" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /não encontrado/);
  });

});

// ─── parsing de corpo de request (puro) ─────────────────────────────────

describe("parseCreateContactBody / parseUpdateContactBody (#3602)", () => {
  it("parseCreateContactBody aceita shape válido", () => {
    const result = parseCreateContactBody(JSON.stringify({ name: "F", emails: ["f@x.com"] }));
    assert.equal(result.ok, true);
  });
  it("parseCreateContactBody rejeita sem name", () => {
    const result = parseCreateContactBody(JSON.stringify({ emails: ["f@x.com"] }));
    assert.equal(result.ok, false);
  });
  it("parseCreateContactBody rejeita emails vazio", () => {
    const result = parseCreateContactBody(JSON.stringify({ name: "F", emails: [] }));
    assert.equal(result.ok, false);
  });
  it("parseCreateContactBody rejeita JSON inválido", () => {
    const result = parseCreateContactBody("{ not json");
    assert.equal(result.ok, false);
  });
  it("regressão (#3611): 'circle' no corpo é ignorado, nunca aparece no value parseado", () => {
    const result = parseCreateContactBody(JSON.stringify({ name: "F", emails: ["f@x.com"], circle: "lista VJs" }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal("circle" in result.value, false);
  });

  it("parseUpdateContactBody aceita patch parcial", () => {
    const result = parseUpdateContactBody(JSON.stringify({ notes: "x" }));
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value, { notes: "x" });
  });
  it("parseUpdateContactBody rejeita tipo errado", () => {
    const result = parseUpdateContactBody(JSON.stringify({ name: 123 }));
    assert.equal(result.ok, false);
  });
  it("regressão (#3611): 'circle' no patch é ignorado, nunca aparece no value parseado", () => {
    const result = parseUpdateContactBody(JSON.stringify({ notes: "x", circle: "lista VJs" }));
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal("circle" in result.value, false);
      assert.deepEqual(result.value, { notes: "x" });
    }
  });
});

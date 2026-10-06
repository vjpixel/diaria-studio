/**
 * test/kit-worker-custom-fields-guard-9663.test.ts (#9663)
 *
 * Regressão: o worker `reativar` gravava `confirmou_via` (KIT_CONFIRMOU_VIA_FIELD)
 * num custom field que não existia no Kit; o Kit descarta a chave em silêncio
 * (2xx), e nada acusava. O guard compara todo `KIT_*_FIELD` dos
 * `workers/*\/wrangler.toml` contra `GET /v4/custom_fields`.
 *
 * O cenário REAL da issue está reproduzido no 1º teste: a lista de 15 fields
 * medida ao vivo em 05/10/2026 contra o wrangler.toml REAL do repo — o guard
 * tem que apontar exatamente `reativar:KIT_CONFIRMOU_VIA_FIELD=confirmou_via`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorkerKitFieldVars,
  collectWorkerKitFieldVars,
  findMissingKitCustomFields,
  fetchKitCustomFieldKeys,
  runKitWorkerFieldsGuard,
  missingFieldsFingerprint,
  buildMissingKitFieldsAlarmBody,
  kitReadConfigError,
  type KitWorkerFieldsCheckResult,
} from "../scripts/lib/kit-worker-custom-fields-guard.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";
import { kitWorkerFieldsGuardPreflight } from "../scripts/check-kit-worker-custom-fields.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `GET /v4/custom_fields` ao vivo em 05/10/2026 (corpo da #9663). */
const KIT_FIELDS_20261005 = [
  "origem_external_id", "voto_token", "origem_click_id", "origem_referrer", "origem_paga",
  "atribuicao_fonte", "referring_site", "utm_content", "utm_term", "utm_channel",
  "utm_campaign", "utm_medium", "utm_source", "origem_cadastro", "apoio_nivel",
];

test("#9663 cenário real: wrangler.toml do repo × fields do Kit de 05/10 → só confirmou_via do reativar falta", () => {
  const configured = collectWorkerKitFieldVars(join(ROOT, "workers"));
  assert.ok(configured.some((v) => v.worker === "reativar" && v.varName === "KIT_CONFIRMOU_VIA_FIELD"));
  const missing = findMissingKitCustomFields(configured, KIT_FIELDS_20261005);
  assert.deepEqual(
    missing.map((m) => `${m.worker}:${m.varName}=${m.fieldKey}`),
    ["reativar:KIT_CONFIRMOU_VIA_FIELD=confirmou_via"],
  );
});

test("depois de criar o field no Kit, o guard fica limpo", () => {
  const configured = collectWorkerKitFieldVars(join(ROOT, "workers"));
  assert.deepEqual(findMissingKitCustomFields(configured, [...KIT_FIELDS_20261005, "confirmou_via"]), []);
});

test("parse: ignora comentário, valor vazio e vars que não são KIT_*_FIELD", () => {
  const toml = [
    "[vars]",
    '# KIT_COMENTADO_FIELD = "x"',
    'KIT_DOI_FORM_ID = "9897918"',
    'KIT_A_FIELD = "a"',
    '  KIT_B_FIELD="b"   # comentário de linha',
    'KIT_VAZIO_FIELD = ""',
    'OUTRA_FIELD = "z"',
  ].join("\n");
  assert.deepEqual(parseWorkerKitFieldVars("w", toml), [
    { worker: "w", varName: "KIT_A_FIELD", fieldKey: "a" },
    { worker: "w", varName: "KIT_B_FIELD", fieldKey: "b" },
  ]);
});

test("collect: varre só diretórios com wrangler.toml", () => {
  const dir = mkdtempSync(join(tmpdir(), "kit-fields-9663-"));
  mkdirSync(join(dir, "a"));
  mkdirSync(join(dir, "b"));
  writeFileSync(join(dir, "a", "wrangler.toml"), 'KIT_X_FIELD = "x"\n');
  assert.deepEqual(collectWorkerKitFieldVars(dir), [{ worker: "a", varName: "KIT_X_FIELD", fieldKey: "x" }]);
});

test("fetch: pagina por cursor até has_next_page=false", async () => {
  const calls: string[] = [];
  const keys = await fetchKitCustomFieldKeys(async (path) => {
    calls.push(path);
    if (!path.includes("after=")) {
      return { custom_fields: [{ key: "a" }, { key: "b" }], pagination: { has_next_page: true, end_cursor: "C1" } };
    }
    return { custom_fields: [{ key: "c" }, { label: "sem key" }], pagination: { has_next_page: false, end_cursor: null } };
  });
  assert.deepEqual(keys, ["a", "b", "c"]);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /after=C1/);
});

test("fetch: resposta sem custom_fields LANÇA (nunca vira 'nenhum field existe')", async () => {
  await assert.rejects(() => fetchKitCustomFieldKeys(async () => ({})), /ilegível/);
  await assert.rejects(() => fetchKitCustomFieldKeys(async () => undefined), /ilegível/);
});

function fakeResult(missingKeys: string[]): KitWorkerFieldsCheckResult {
  const configured = [
    { worker: "reativar", varName: "KIT_CONFIRMOU_VIA_FIELD", fieldKey: "confirmou_via" },
    { worker: "poll", varName: "KIT_UTM_SOURCE_FIELD", fieldKey: "utm_source" },
  ];
  return { configured, missing: configured.filter((c) => missingKeys.includes(c.fieldKey)), existingKeys: [] };
}

test("runKitWorkerFieldsGuard: field ausente alarma e devolve a contagem", async () => {
  const alarmed: string[][] = [];
  const logs: string[] = [];
  const n = await runKitWorkerFieldsGuard({
    check: async () => fakeResult(["confirmou_via"]),
    alarm: async (m) => void alarmed.push(m.map((x) => x.fieldKey)),
    isDryRun: false,
    log: (s) => logs.push(s),
  });
  assert.equal(n, 1);
  assert.deepEqual(alarmed, [["confirmou_via"]]);
  assert.ok(logs.some((l) => l.includes("confirmou_via") && l.includes("NÃO existe")));
});

test("runKitWorkerFieldsGuard: --dry-run não alarma; tudo ok não alarma", async () => {
  let alarms = 0;
  const base = { alarm: async () => void alarms++, log: () => {} };
  assert.equal(await runKitWorkerFieldsGuard({ ...base, check: async () => fakeResult(["confirmou_via"]), isDryRun: true }), 1);
  assert.equal(await runKitWorkerFieldsGuard({ ...base, check: async () => fakeResult([]), isDryRun: false }), 0);
  assert.equal(alarms, 0);
});

test("runKitWorkerFieldsGuard: falha de leitura vira null + AVISO, nunca lança nem diz 'OK'", async () => {
  const logs: string[] = [];
  const n = await runKitWorkerFieldsGuard({
    check: async () => {
      throw new Error("KIT_API_KEY não definida");
    },
    alarm: async () => assert.fail("não deveria alarmar"),
    isDryRun: false,
    log: (s) => logs.push(s),
  });
  assert.equal(n, null);
  assert.ok(logs.some((l) => l.startsWith("AVISO") && l.includes("NÃO rodou")));
  assert.ok(!logs.some((l) => l.includes("OK")));
});

test("runKitWorkerFieldsGuard: config ausente (preflight) alarma 'desarmado' e não lê o Kit (review #9665)", async () => {
  const disarmed: string[] = [];
  const logs: string[] = [];
  const n = await runKitWorkerFieldsGuard({
    check: async () => assert.fail("não deveria ler o Kit sem config"),
    alarm: async () => assert.fail("não é alarme de field ausente"),
    preflight: () => "KIT_API_KEY ausente no ambiente",
    alarmDisarmed: async (r) => void disarmed.push(r),
    isDryRun: false,
    log: (s) => logs.push(s),
  });
  assert.equal(n, null);
  assert.deepEqual(disarmed, ["KIT_API_KEY ausente no ambiente"]);
  assert.ok(logs.some((l) => l.startsWith("ERRO") && l.includes("DESARMADO")));
  // dry-run: loga, não alarma
  const n2 = await runKitWorkerFieldsGuard({
    check: async () => assert.fail("não deveria ler o Kit"),
    alarm: async () => {},
    preflight: () => "x",
    alarmDisarmed: async () => assert.fail("dry-run não alarma"),
    isDryRun: true,
    log: () => {},
  });
  assert.equal(n2, null);
});

test("#9670 runKitWorkerFieldsGuard: key presente mas revogada (KitApiError 401/403) alarma 'desarmado', não fica AVISO eterno", async () => {
  for (const status of [401, 403]) {
    const disarmed: string[] = [];
    const logs: string[] = [];
    const n = await runKitWorkerFieldsGuard({
      check: async () => {
        throw new KitApiError("/custom_fields?per_page=500", status, '{"errors":["The access token is invalid"]}');
      },
      alarm: async () => assert.fail("não é alarme de field ausente"),
      preflight: () => null,
      alarmDisarmed: async (r) => void disarmed.push(r),
      isDryRun: false,
      log: (s) => logs.push(s),
    });
    assert.equal(n, null);
    assert.equal(disarmed.length, 1, `HTTP ${status} precisa alarmar desarmado`);
    assert.match(disarmed[0], new RegExp(`HTTP ${status}`));
    assert.ok(logs.some((l) => l.startsWith("ERRO") && l.includes("DESARMADO")));
    assert.ok(!logs.some((l) => l.startsWith("AVISO") && l.includes("NÃO rodou")));
  }
  // dry-run: loga ERRO, não alarma
  const n2 = await runKitWorkerFieldsGuard({
    check: async () => {
      throw new KitApiError("/custom_fields", 401, "unauthorized");
    },
    alarm: async () => {},
    alarmDisarmed: async () => assert.fail("dry-run não alarma"),
    isDryRun: true,
    log: () => {},
  });
  assert.equal(n2, null);
});

test("#9670 runKitWorkerFieldsGuard: rede, 5xx e 429 seguem AVISO transitório, sem alarme", async () => {
  const transient: Error[] = [
    new TypeError("fetch failed"),
    new KitApiError("/custom_fields", 500, "boom"),
    new KitApiError("/custom_fields", 503, "unavailable"),
    new KitApiError("/custom_fields", 429, "rate limited"),
    new Error("GET /custom_fields não devolveu `custom_fields` como array"),
  ];
  for (const err of transient) {
    const logs: string[] = [];
    const n = await runKitWorkerFieldsGuard({
      check: async () => {
        throw err;
      },
      alarm: async () => assert.fail("não deveria alarmar"),
      preflight: () => null,
      alarmDisarmed: async () => assert.fail(`${err.message} é transitório, não desarma`),
      isDryRun: false,
      log: (s) => logs.push(s),
    });
    assert.equal(n, null);
    assert.ok(logs.some((l) => l.startsWith("AVISO") && l.includes("NÃO rodou")));
  }
});

test("#9670 kitReadConfigError: só 401/403 de KitApiError são config", () => {
  assert.ok(kitReadConfigError(new KitApiError("/x", 401, "")));
  assert.ok(kitReadConfigError(new KitApiError("/x", 403, "")));
  for (const st of [400, 404, 429, 500, 502]) assert.equal(kitReadConfigError(new KitApiError("/x", st, "")), null);
  assert.equal(kitReadConfigError(new Error("401")), null);
  assert.equal(kitReadConfigError("401"), null);
});

test("kitWorkerFieldsGuardPreflight: acusa KIT_API_KEY ausente/vazia, aceita presente", () => {
  assert.match(kitWorkerFieldsGuardPreflight({}) ?? "", /KIT_API_KEY/);
  assert.match(kitWorkerFieldsGuardPreflight({ KIT_API_KEY: "  " }) ?? "", /KIT_API_KEY/);
  assert.equal(kitWorkerFieldsGuardPreflight({ KIT_API_KEY: "k" }), null);
});

test("runKitWorkerFieldsGuard: falha do alarme não lança", async () => {
  const n = await runKitWorkerFieldsGuard({
    check: async () => fakeResult(["confirmou_via"]),
    alarm: async () => {
      throw new Error("gh fora");
    },
    isDryRun: false,
    log: () => {},
  });
  assert.equal(n, 1);
});

test("fingerprint estável independente da ordem; corpo traz o POST de correção", () => {
  const a = { worker: "a", varName: "KIT_X_FIELD", fieldKey: "x" };
  const b = { worker: "b", varName: "KIT_Y_FIELD", fieldKey: "y" };
  assert.equal(missingFieldsFingerprint([a, b]), missingFieldsFingerprint([b, a]));
  assert.match(buildMissingKitFieldsAlarmBody([a], "2026-10-05T00:00:00Z"), /POST \/v4\/custom_fields \{"label":"x"\}/);
});

test("guard está ARMADO no check-brevo-diaria-guardrail, antes do exit(2) do guard de seed (#8516)", () => {
  const src = readFileSync(join(ROOT, "scripts/check-brevo-diaria-guardrail.ts"), "utf8");
  const mainBody = src.slice(src.indexOf("async function main(): Promise<void> {"));
  const guardIdx = mainBody.indexOf("await runKitWorkerFieldsGuard(");
  const seedIdx = mainBody.indexOf("await checkSeedEmailsBlacklisted(");
  assert.ok(guardIdx >= 0, "runKitWorkerFieldsGuard não é chamado em main()");
  assert.ok(seedIdx >= 0);
  assert.ok(guardIdx < seedIdx, "guard do #9663 precisa rodar antes do guard de seed, que pode exit(2)");
});

test("guard roda ANTES de toda precondição Brevo que faz exit(2) — config/brevo_diaria/key ausente não desarma o Kit (#9757)", () => {
  const src = readFileSync(join(ROOT, "scripts/check-brevo-diaria-guardrail.ts"), "utf8");
  const mainBody = src.slice(src.indexOf("async function main(): Promise<void> {"));
  const guardIdx = mainBody.indexOf("await runKitWorkerFieldsGuard(");
  assert.ok(guardIdx >= 0, "runKitWorkerFieldsGuard não é chamado em main()");
  const configIdx = mainBody.indexOf("loadPlatformConfig(");
  assert.ok(configIdx >= 0, "loadPlatformConfig não encontrado em main()");
  assert.ok(guardIdx < configIdx, "guard do Kit precisa rodar antes de carregar a config Brevo");
  const firstExit2 = mainBody.indexOf("process.exit(2)");
  assert.ok(firstExit2 >= 0);
  assert.ok(
    guardIdx < firstExit2,
    "guard do Kit precisa rodar antes do 1º process.exit(2) de main() — senão uma precondição " +
      "Brevo quebrada (key sumida do .env/Doppler) desliga a vigilância do Kit em silêncio (#9757)",
  );
});

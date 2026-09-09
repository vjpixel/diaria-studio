/**
 * test/kit-doi-todos-os-workers-7723.test.ts (#7723)
 *
 * O double opt-in passou a valer nos TRÊS workers que criam assinante no Kit
 * (`poll`, `cursos`, `reativar`), por instrução direta do editor — "habilita
 * DOI em todos os lugares", 09/09/2026.
 *
 * O que estes testes protegem não é "o DOI funciona" (isso o
 * `doi-form-guard-7723` já cobre), é a classe de bug do próprio #7723:
 * **um worker ficar para trás em silêncio**. Por isso o foco é
 * (a) a regra viver num lugar só, (b) todo worker que cria assinante estar na
 * flag, e (c) as fontes de config concordarem entre si.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DOUBLE_OPT_IN_FLAG,
  resolveKitCreateState,
  vincularKitDoiForm,
} from "../scripts/lib/shared/kit-doi.ts";

const WORKERS_COM_CADASTRO = ["poll", "cursos", "reativar"] as const;

test("os 3 workers que criam assinante estão no rollout", () => {
  for (const w of WORKERS_COM_CADASTRO) {
    assert.ok(
      DOUBLE_OPT_IN_FLAG.enabledForWorkers.includes(w),
      `worker "${w}" cria assinante e ficou fora do DOI — é exatamente assim que um caminho fica sem confirmação em silêncio`,
    );
  }
});

test("cada worker tem KIT_DOI_FORM_ID no wrangler.toml, e todos apontam para o MESMO form", () => {
  const ids = new Map<string, string>();
  for (const w of WORKERS_COM_CADASTRO) {
    const toml = readFileSync(new URL(`../workers/${w}/wrangler.toml`, import.meta.url), "utf8");
    const m = toml.match(/^KIT_DOI_FORM_ID\s*=\s*"([^"]*)"/m);
    assert.ok(m, `workers/${w}/wrangler.toml não define KIT_DOI_FORM_ID — o worker cria assinante sem caminho de confirmação`);
    ids.set(w, m[1]);
  }
  const distintos = new Set(ids.values());
  assert.equal(
    distintos.size,
    1,
    `os workers apontam para forms diferentes (${JSON.stringify(Object.fromEntries(ids))}) — divergir aqui manda metade dos cadastros para um form e metade para outro`,
  );
});

test("o form configurado nos workers bate com platform.config.json", () => {
  const cfg = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
  const toml = readFileSync(new URL("../workers/poll/wrangler.toml", import.meta.url), "utf8");
  const doWorker = toml.match(/^KIT_DOI_FORM_ID\s*=\s*"([^"]*)"/m)?.[1];
  assert.equal(cfg.kit.doiFormId, doWorker, "config duplicada de propósito (worker lê env, scripts leem o JSON) precisa andar junta");
});

test("resolveKitCreateState: worker no rollout + form utilizável ⇒ inactive", () => {
  for (const w of WORKERS_COM_CADASTRO) {
    assert.equal(resolveKitCreateState("9897918", w, () => {}), "inactive", `worker ${w}`);
  }
});

test("resolveKitCreateState: form de SISTEMA ⇒ active, mesmo com o worker no rollout", () => {
  const logs: string[] = [];
  assert.equal(resolveKitCreateState("9839463", "cursos", (m) => logs.push(m)), "active");
  assert.equal(logs.length, 1, "config errada tem que LOGAR — foi a ausência de sinal que escondeu o bug por 2 semanas");
  assert.match(logs[0], /9839463/);
  assert.match(logs[0], /cursos/, "a mensagem precisa dizer QUAL worker, senão não dá pra achar a config errada");
});

test("resolveKitCreateState: id ausente ⇒ active em silêncio (caminho documentado, não anomalia)", () => {
  const logs: string[] = [];
  assert.equal(resolveKitCreateState(undefined, "reativar", (m) => logs.push(m)), "active");
  assert.equal(resolveKitCreateState("   ", "reativar", (m) => logs.push(m)), "active");
  assert.equal(logs.length, 0);
});

test("resolveKitCreateState: worker FORA do rollout ⇒ active mesmo com form bom", () => {
  assert.equal(resolveKitCreateState("9897918", "worker-inexistente", () => {}), "active");
});

test("vincularKitDoiForm é best-effort — erro do Kit nunca lança (a assinatura não pode ser desfeita)", async () => {
  const logs: string[] = [];
  await vincularKitDoiForm({
    apiKey: "k",
    base: "https://api.kit.test/v4",
    formId: "9897918",
    subscriberId: 1,
    referrer: "https://diar.ia.br/",
    fetchImpl: async () => new Response("boom", { status: 500 }),
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 1, "falha silenciosa aqui é o bug original — precisa logar");
  assert.match(logs[0], /500/);

  logs.length = 0;
  await vincularKitDoiForm({
    apiKey: "k",
    base: "https://api.kit.test/v4",
    formId: "9897918",
    subscriberId: 1,
    referrer: "https://diar.ia.br/",
    fetchImpl: async () => { throw new Error("rede caiu"); },
    log: (m) => logs.push(m),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /rede caiu/);
});

test("vincularKitDoiForm sem formId não chama a rede", async () => {
  let chamou = false;
  await vincularKitDoiForm({
    apiKey: "k",
    base: "https://api.kit.test/v4",
    formId: undefined,
    subscriberId: 1,
    referrer: "https://diar.ia.br/",
    fetchImpl: async () => { chamou = true; return new Response("{}"); },
  });
  assert.equal(chamou, false);
});

test("vincularKitDoiForm bate no endpoint certo, com o subscriber no PATH", async () => {
  let url = "";
  let body: unknown = null;
  await vincularKitDoiForm({
    apiKey: "k",
    base: "https://api.kit.test/v4",
    formId: "9897918",
    subscriberId: 4242,
    referrer: "https://cursos.diar.ia.br/?utm_source=x",
    fetchImpl: async (u, init) => {
      url = String(u);
      body = JSON.parse(String((init as RequestInit).body));
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(url, "https://api.kit.test/v4/forms/9897918/subscribers/4242");
  assert.deepEqual(body, { referrer: "https://cursos.diar.ia.br/?utm_source=x" });
});

test("a base já ATIVA nunca é reconfirmada retroativamente", () => {
  assert.equal(
    DOUBLE_OPT_IN_FLAG.scopeExcludesLegacyBase,
    true,
    "reconfirmar quem já consentiu derrubaria gente que nunca pediu para sair",
  );
});

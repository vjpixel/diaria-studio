/**
 * test/google-ads-swap-pmax-capacidade-cooldown-9017-9024.test.ts
 *
 * Regressão de 2 achados do review consolidado no swap PMax (#8550):
 *
 *   #9017 — a Fase 1 linkava 5 LONG_HEADLINE / 5 DESCRIPTION novos (= máximo
 *   do PMax) ANTES de remover os antigos, estourando o máximo por fieldType.
 *   O mock da API abaixo impõe o máximo por fieldType sobre o estado do grupo
 *   (antigos + novos), então o cenário real da issue reprova sem o fix.
 *
 *   #9024 — `checkSwapCooldown` herdava o fail-open de `isAcaoAdiadaAtiva`:
 *   `pedido_em` inválido/no futuro liberava `--send`.
 *   (O caso "bloqueio-execucao posterior desarma" está no teste do #8960,
 *   invertido para o comportamento correto.)
 *
 * Nenhum teste chama a API do Google Ads nem o `gh` de verdade — `fetch` e o
 * leitor de comentários são injetados.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAssetGroupAssetRows,
  classifyAssetGroupAssets,
  planTextFieldLinks,
  buildSwapAssetGroupAssetsPayload,
  NEW_HEADLINES,
  NEW_LONG_HEADLINES,
  NEW_DESCRIPTIONS,
  PMAX_TEXT_FIELD_MAX,
  type AssetGroupAssetApiRow,
} from "../scripts/lib/google-ads-asset-group-assets.ts";
import { formatAcaoAdiadaMarker, formatExecutionBlockMarker } from "../scripts/lib/issue-decisions.ts";
import { main as swapMain, checkSwapCooldown } from "../scripts/google-ads-swap-asset-group-creatives.ts";

const CUSTOMER = "2369219639";
const GROUP = `customers/${CUSTOMER}/assetGroups/6642889160`;

const AUTH_ENV = {
  GOOGLE_ADS_CLIENT_ID: "client-id",
  GOOGLE_ADS_CLIENT_SECRET: "client-secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh-token",
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev-token",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "6236094249",
  GOOGLE_ADS_CUSTOMER_ID: CUSTOMER,
};

async function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let rowCounter = 0;
function textRow(fieldType: string, text: string): AssetGroupAssetApiRow {
  const id = String(++rowCounter);
  return {
    asset: { resourceName: `customers/${CUSTOMER}/assets/${id}`, id, type: "TEXT", textAsset: { text } },
    assetGroupAsset: {
      resourceName: `customers/${CUSTOMER}/assetGroupAssets/6642889160~${id}~${fieldType}`,
      asset: `customers/${CUSTOMER}/assets/${id}`,
      fieldType,
      status: "ENABLED",
    },
  };
}

/** Estado mínimo de um grupo PMax servindo: ≥1 long headline e ≥2
 *  descriptions ENABLED (aqui 3 e 2, todos genéricos antigos = stale). */
function servingGroupRows(): AssetGroupAssetApiRow[] {
  return [
    textRow("HEADLINE", "Newsletter de IA"),
    textRow("HEADLINE", "Dicas de IA"),
    textRow("HEADLINE", "diar.ia.br"), // keep
    textRow("LONG_HEADLINE", "As notícias mais importantes sobre IA, resumidas para você."),
    textRow("LONG_HEADLINE", "Receba atualizações diárias sobre as últimas novidades em IA."),
    textRow("LONG_HEADLINE", "A newsletter de IA para pessoas ocupadas."),
    textRow("DESCRIPTION", "Sua dose diária de notícias de IA."),
    textRow("DESCRIPTION", "Cursos de IA gratuitos para assinantes."),
  ];
}

const NEW_COUNTS = { HEADLINE: NEW_HEADLINES.length, LONG_HEADLINE: NEW_LONG_HEADLINES.length, DESCRIPTION: NEW_DESCRIPTIONS.length };

// ---------------------------------------------------------------------------
// #9017 — planTextFieldLinks (puro)
// ---------------------------------------------------------------------------

describe("#9017 — planTextFieldLinks valida antigos + novos contra o máximo", () => {
  it("grupo servindo: LONG_HEADLINE e DESCRIPTION removem o mínimo de stale no mesmo mutate; HEADLINE cabe sem remover", () => {
    const items = parseAssetGroupAssetRows(servingGroupRows());
    const plan = planTextFieldLinks(items, classifyAssetGroupAssets(items), NEW_COUNTS);
    assert.equal(plan.ok, true);
    const by = Object.fromEntries(plan.plans.map((p) => [p.fieldType, p]));
    assert.equal(by.HEADLINE.removeInSameMutate.length, 0); // 3 + 4 <= 15
    assert.equal(by.LONG_HEADLINE.removeInSameMutate.length, 3); // 3 + 5 - 5
    assert.equal(by.DESCRIPTION.removeInSameMutate.length, 2); // 2 + 5 - 5
    // Resultado final nunca passa do máximo nem fica abaixo do novo conjunto.
    for (const p of plan.plans) {
      assert.ok(p.existingEnabled - p.removeInSameMutate.length + p.newCount <= p.max, `${p.fieldType} estoura o máximo`);
    }
  });

  it("remove só o MÍNIMO — o stale que cabe fica para a Fase 2", () => {
    const rows = [
      ...servingGroupRows().filter((r) => r.assetGroupAsset?.fieldType !== "LONG_HEADLINE"),
      textRow("LONG_HEADLINE", "A newsletter de IA para pessoas ocupadas."),
    ];
    const items = parseAssetGroupAssetRows(rows);
    const plan = planTextFieldLinks(items, classifyAssetGroupAssets(items), { HEADLINE: 0, LONG_HEADLINE: 4, DESCRIPTION: 0 });
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.plans.map((p) => [p.fieldType, p.removeInSameMutate.length]), [["LONG_HEADLINE", 0]]); // 1 + 4 <= 5
  });

  it("inviável quando keep/needsReview + novos > máximo (nem removendo todo o stale cabe) — erro, nunca remove item não-stale", () => {
    const rows = [...servingGroupRows(), textRow("LONG_HEADLINE", "Um texto recente que ninguém classificou ainda")];
    const items = parseAssetGroupAssetRows(rows);
    const plan = planTextFieldLinks(items, classifyAssetGroupAssets(items), NEW_COUNTS);
    assert.equal(plan.ok, false);
    assert.ok(!plan.ok && plan.errors.some((e) => e.startsWith("LONG_HEADLINE")));
  });

  it("etapa já linkada numa tentativa anterior é pulada (os novos já no grupo não tornam o retry falsamente inviável)", () => {
    const rows = [
      ...servingGroupRows().filter((r) => r.assetGroupAsset?.fieldType !== "LONG_HEADLINE"),
      ...NEW_LONG_HEADLINES.map((t) => textRow("LONG_HEADLINE", t)), // já trocados na tentativa 1
    ];
    const items = parseAssetGroupAssetRows(rows);
    const semSkip = planTextFieldLinks(items, classifyAssetGroupAssets(items), NEW_COUNTS);
    assert.equal(semSkip.ok, false, "sanidade: sem o skip, os 5 novos já linkados contariam como needsReview");
    const comSkip = planTextFieldLinks(items, classifyAssetGroupAssets(items), NEW_COUNTS, new Set(["LONG_HEADLINE"]));
    assert.equal(comSkip.ok, true);
    assert.ok(!comSkip.plans.some((p) => p.fieldType === "LONG_HEADLINE"));
  });

  it("PMAX_TEXT_FIELD_MAX deriva de PMAX_TEXT_LIMITS (5/5/15)", () => {
    assert.deepEqual(PMAX_TEXT_FIELD_MAX, { HEADLINE: 15, LONG_HEADLINE: 5, DESCRIPTION: 5 });
  });

  it("buildSwapAssetGroupAssetsPayload põe os remove ANTES dos create", () => {
    const p = buildSwapAssetGroupAssetsPayload(GROUP, ["customers/1/assets/10"], "LONG_HEADLINE", ["customers/1/assetGroupAssets/x"]);
    assert.deepEqual(p.operations, [
      { remove: "customers/1/assetGroupAssets/x" },
      { create: { assetGroup: GROUP, asset: "customers/1/assets/10", fieldType: "LONG_HEADLINE" } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// #9017 — CLI --send contra um mock que IMPÕE o máximo por fieldType
// ---------------------------------------------------------------------------

describe("#9017 — CLI --send: Fase 1 nunca estoura o máximo por fieldType", () => {
  function makeManifest(dir: string): string {
    const img = (name: string) => {
      const p = join(dir, name);
      writeFileSync(p, Buffer.from(`fake-${name}`));
      return p;
    };
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        SQUARE_MARKETING_IMAGE: [img("d1-1x1.jpg")],
        MARKETING_IMAGE: [img("d1-191x1.jpg")],
        PORTRAIT_MARKETING_IMAGE: [img("d1-4x5.jpg")],
      }),
    );
    return manifestPath;
  }

  /** Mock da API com estado: aplica remove+create de cada
   *  `assetGroupAssets:mutate` e responde 400 (sem aplicar nada — atômico)
   *  se algum fieldType de texto passar do máximo. */
  function makeStatefulApi(rows: AssetGroupAssetApiRow[]) {
    const enabled = new Map<string, string>(); // assetGroupAsset resourceName -> fieldType
    for (const r of rows) enabled.set(r.assetGroupAsset!.resourceName!, r.assetGroupAsset!.fieldType!);
    let assetCounter = 10_000;
    let linkCounter = 0;
    const calls = { assetsMutate: 0, linkBodies: [] as Array<{ operations: Array<Record<string, unknown>> }>, rejected: 0 };
    const fetchMock = async (input: string, init?: RequestInit) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: rows });
      if (input.endsWith("assetGroupAssets:mutate")) {
        const body = JSON.parse(String(init?.body));
        calls.linkBodies.push(body);
        const next = new Map(enabled);
        for (const op of body.operations) {
          if (typeof op.remove === "string") next.delete(op.remove);
          else next.set(`${GROUP}/new-${++linkCounter}`, op.create.fieldType);
        }
        for (const [fieldType, max] of Object.entries(PMAX_TEXT_FIELD_MAX)) {
          const count = [...next.values()].filter((ft) => ft === fieldType).length;
          if (count > max) {
            calls.rejected++;
            return jsonResponse(400, { error: { message: `RESOURCE_LIMIT: ${fieldType} ${count} > ${max}` } });
          }
        }
        for (const k of [...enabled.keys()]) enabled.delete(k);
        for (const [k, v] of next) enabled.set(k, v);
        return jsonResponse(200, { results: body.operations.map(() => ({ resourceName: "customers/x/assetGroupAssets/y" })) });
      }
      if (input.endsWith("assets:mutate")) {
        calls.assetsMutate++;
        const body = JSON.parse(String(init?.body));
        return jsonResponse(200, { results: body.operations.map(() => ({ resourceName: `customers/${CUSTOMER}/assets/${assetCounter++}` })) });
      }
      throw new Error(`chamada inesperada: ${input}`);
    };
    return { fetchMock, calls, enabled };
  }

  it("grupo servindo (3 long headlines + 2 descriptions antigos): Fase 1 conclui, troca atômica, nenhuma rejeição de limite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-9017-"));
    try {
      const rows = servingGroupRows();
      const api = makeStatefulApi(rows);
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", CUSTOMER, "--send", "--images-manifest", makeManifest(dir), "--progress-file", join(dir, "progress.json")],
          api.fetchMock as unknown as typeof fetch,
          () => [],
        ),
      );
      assert.equal(api.calls.rejected, 0, "nenhum mutate pode estourar o máximo por fieldType");
      assert.equal(code, 0);
      const longHeadlineCall = api.calls.linkBodies.find((b) => b.operations.some((op) => (op.create as { fieldType?: string } | undefined)?.fieldType === "LONG_HEADLINE"))!;
      assert.equal(longHeadlineCall.operations.filter((op) => "remove" in op).length, 3);
      assert.equal(longHeadlineCall.operations.filter((op) => "create" in op).length, 5);
      assert.ok("remove" in longHeadlineCall.operations[0], "remove vem antes do create");
      const counts = (ft: string) => [...api.enabled.values()].filter((v) => v === ft).length;
      assert.equal(counts("LONG_HEADLINE"), 5);
      assert.equal(counts("DESCRIPTION"), 5);
      assert.equal(counts("HEADLINE"), 7); // 3 antigos (Fase 2 remove) + 4 novos
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plano inviável (texto não-stale ocupa a vaga): --send recusa ANTES de criar qualquer asset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-9017-inviavel-"));
    try {
      const rows = [...servingGroupRows(), textRow("DESCRIPTION", "Texto recente não classificado")];
      const api = makeStatefulApi(rows);
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", CUSTOMER, "--send", "--images-manifest", makeManifest(dir), "--progress-file", join(dir, "progress.json")],
          api.fetchMock as unknown as typeof fetch,
          () => [],
        ),
      );
      assert.equal(code, 1);
      assert.equal(api.calls.assetsMutate, 0, "nenhum asset pode ser criado com o plano inviável");
      assert.equal(api.calls.linkBodies.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #9024 — checkSwapCooldown fail-closed também depois da leitura
// ---------------------------------------------------------------------------

describe("#9024 — checkSwapCooldown não herda o fail-open de isAcaoAdiadaAtiva", () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const adiada = (pedido_em: string) => formatAcaoAdiadaMarker({ pedido_em, acao: "google-ads-swap --send", motivo: "ainda não", sessao: "develop" });

  it("pedido_em inválido -> cooldown ATIVO", () => {
    const r = checkSwapCooldown([adiada("ontem de manhã")], now);
    assert.equal(r.active, true);
    assert.match(r.motivo ?? "", /inválido/);
  });

  it("pedido_em no futuro -> cooldown ATIVO", () => {
    const r = checkSwapCooldown([adiada("2027-09-28T09:00:00Z")], now);
    assert.equal(r.active, true);
    assert.match(r.motivo ?? "", /futuro/);
  });

  it("bloqueio-execucao gravado em dia posterior ao adiamento não desarma o cooldown", () => {
    const bloco = formatExecutionBlockMarker({
      recorded_at: "2026-09-29",
      motivo: "imagens ainda não geradas",
      sessao: "overnight",
      condicao: { tipo: "externo", descricao: "gerar as 12 imagens" },
    });
    assert.equal(checkSwapCooldown([adiada("2026-09-28T09:00:00Z"), bloco], now).active, true);
  });

  it("expiração por tempo continua liberando (pedido_em válido, > 7 dias)", () => {
    assert.equal(checkSwapCooldown([adiada("2026-09-10T09:00:00Z")], now).active, false);
  });

  it("CLI: --send recusa antes de qualquer rede com pedido_em no futuro", async () => {
    const fetchMock = async () => {
      throw new Error("não deveria chamar fetch — cooldown precisa recusar antes");
    };
    const code = await withEnv(AUTH_ENV, () =>
      swapMain(["--customer-id", CUSTOMER, "--send"], fetchMock as unknown as typeof fetch, () => [adiada("2099-01-01T00:00:00Z")]),
    );
    assert.equal(code, 1);
  });
});

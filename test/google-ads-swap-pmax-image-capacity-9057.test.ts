/**
 * test/google-ads-swap-pmax-image-capacity-9057.test.ts
 *
 * Regressão do #9057: o plano de capacidade da Fase 1 do swap PMax (#9017,
 * `planTextFieldLinks`) só cobria os fieldTypes de TEXTO. As imagens do PMax
 * também têm máximo por fieldType (20 por tipo — Google Ads API, "Performance
 * Max asset requirements"), e um manifesto que, somado às imagens já ENABLED,
 * passasse do máximo só falhava na mutação — no meio da Fase 1, com textos já
 * linkados e imagens criadas órfãs.
 *
 * O teste de CLI abaixo reprova no código antigo: sem o plano de imagem,
 * `--send` cria os assets (texto + imagem) antes de a API recusar o link.
 *
 * Nenhum teste chama a API do Google Ads nem o `gh` de verdade.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAssetGroupAssetRows,
  classifyAssetGroupAssets,
  planImageFieldLinks,
  PMAX_IMAGE_FIELD_MAX,
  type AssetGroupAssetApiRow,
} from "../scripts/lib/google-ads-asset-group-assets.ts";
import { main as swapMain } from "../scripts/google-ads-swap-asset-group-creatives.ts";

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
function row(fieldType: string, type: "TEXT" | "IMAGE", value: string): AssetGroupAssetApiRow {
  const id = String(++rowCounter);
  return {
    asset: {
      resourceName: `customers/${CUSTOMER}/assets/${id}`,
      id,
      type,
      ...(type === "TEXT" ? { textAsset: { text: value } } : { name: value }),
    },
    assetGroupAsset: {
      resourceName: `customers/${CUSTOMER}/assetGroupAssets/6642889160~${id}~${fieldType}`,
      asset: `customers/${CUSTOMER}/assets/${id}`,
      fieldType,
      status: "ENABLED",
    },
  };
}

const staleImage = (ft: string, i: number) => row(ft, "IMAGE", `Generated image - 2025-12-27 ${i}.png`);
const keepImage = (ft: string, i: number) => row(ft, "IMAGE", `recente-${i}.jpg`);

/** Textos mínimos de um grupo servindo (mesmo cenário do teste do #9017). */
function servingTextRows(): AssetGroupAssetApiRow[] {
  return [
    row("HEADLINE", "TEXT", "Newsletter de IA"),
    row("HEADLINE", "TEXT", "Dicas de IA"),
    row("HEADLINE", "TEXT", "diar.ia.br"),
    row("LONG_HEADLINE", "TEXT", "A newsletter de IA para pessoas ocupadas."),
    row("DESCRIPTION", "TEXT", "Sua dose diária de notícias de IA."),
    row("DESCRIPTION", "TEXT", "Cursos de IA gratuitos para assinantes."),
  ];
}

const NEW4 = { SQUARE_MARKETING_IMAGE: 4, MARKETING_IMAGE: 4, PORTRAIT_MARKETING_IMAGE: 4 };

describe("#9057 — planImageFieldLinks valida imagens antigas + novas contra o máximo", () => {
  it("PMAX_IMAGE_FIELD_MAX = 20 por tipo (Google Ads API, Performance Max asset requirements)", () => {
    assert.deepEqual(PMAX_IMAGE_FIELD_MAX, { SQUARE_MARKETING_IMAGE: 20, MARKETING_IMAGE: 20, PORTRAIT_MARKETING_IMAGE: 20 });
  });

  it("cabe sem remover nada quando existentes + novas <= 20", () => {
    const rows = Array.from({ length: 16 }, (_, i) => staleImage("SQUARE_MARKETING_IMAGE", i));
    const items = parseAssetGroupAssetRows(rows);
    const plan = planImageFieldLinks(items, classifyAssetGroupAssets(items), NEW4);
    assert.equal(plan.ok, true);
    for (const p of plan.plans) assert.equal(p.removeInSameMutate.length, 0);
  });

  it("estouro com stale suficiente: remove o MÍNIMO de stale no mesmo mutate", () => {
    const rows = [
      ...Array.from({ length: 18 }, (_, i) => staleImage("SQUARE_MARKETING_IMAGE", i)),
      keepImage("SQUARE_MARKETING_IMAGE", 99),
    ];
    const items = parseAssetGroupAssetRows(rows);
    const plan = planImageFieldLinks(items, classifyAssetGroupAssets(items), NEW4);
    assert.equal(plan.ok, true);
    const sq = plan.plans.find((p) => p.fieldType === "SQUARE_MARKETING_IMAGE")!;
    assert.equal(sq.existingEnabled, 19);
    assert.equal(sq.removeInSameMutate.length, 3); // 19 + 4 - 20
    assert.ok(sq.existingEnabled - sq.removeInSameMutate.length + sq.newCount <= sq.max);
  });

  it("inviável quando imagens não-stale (keep / logo_1.jpg needsReview) + novas > 20 — erro, nunca remove não-stale", () => {
    const rows = [
      ...Array.from({ length: 16 }, (_, i) => keepImage("MARKETING_IMAGE", i)),
      row("MARKETING_IMAGE", "IMAGE", "logo_1.jpg"),
      staleImage("MARKETING_IMAGE", 1),
    ];
    const items = parseAssetGroupAssetRows(rows);
    const plan = planImageFieldLinks(items, classifyAssetGroupAssets(items), NEW4);
    assert.equal(plan.ok, false);
    assert.ok(!plan.ok && plan.errors.some((e) => e.startsWith("MARKETING_IMAGE")));
  });

  it("etapa de imagem já linkada numa tentativa anterior é pulada", () => {
    const rows = Array.from({ length: 20 }, (_, i) => keepImage("PORTRAIT_MARKETING_IMAGE", i));
    const items = parseAssetGroupAssetRows(rows);
    const cls = classifyAssetGroupAssets(items);
    assert.equal(planImageFieldLinks(items, cls, NEW4).ok, false);
    const comSkip = planImageFieldLinks(items, cls, NEW4, new Set(["PORTRAIT_MARKETING_IMAGE"]));
    assert.equal(comSkip.ok, true);
    assert.ok(!comSkip.plans.some((p) => p.fieldType === "PORTRAIT_MARKETING_IMAGE"));
  });
});

describe("#9057 — CLI --send: Fase 1 nunca estoura o máximo de imagem", () => {
  function makeManifest(dir: string, perType: number): string {
    const img = (name: string) => {
      const p = join(dir, name);
      writeFileSync(p, Buffer.from(`fake-${name}`));
      return p;
    };
    const list = (suffix: string) => Array.from({ length: perType }, (_, i) => img(`d${i + 1}-${suffix}.jpg`));
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ SQUARE_MARKETING_IMAGE: list("1x1"), MARKETING_IMAGE: list("191x1"), PORTRAIT_MARKETING_IMAGE: list("4x5") }),
    );
    return manifestPath;
  }

  /** Mock com estado: aplica remove+create de cada `assetGroupAssets:mutate`
   *  e responde 400 (sem aplicar nada) se algum fieldType de imagem passar
   *  do máximo. */
  function makeStatefulApi(rows: AssetGroupAssetApiRow[]) {
    const enabled = new Map<string, string>();
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
        for (const [fieldType, max] of Object.entries(PMAX_IMAGE_FIELD_MAX)) {
          const count = [...next.values()].filter((ft) => ft === fieldType).length;
          if (count > max) {
            calls.rejected++;
            return jsonResponse(400, { error: { message: `RESOURCE_LIMIT: ${fieldType} ${count} > ${max}` } });
          }
        }
        enabled.clear();
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

  it("imagens não-stale ocupam a vaga: --send recusa ANTES de criar qualquer asset (reprova no código antigo)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-9057-inviavel-"));
    try {
      const rows = [...servingTextRows(), ...Array.from({ length: 18 }, (_, i) => keepImage("SQUARE_MARKETING_IMAGE", i))];
      const api = makeStatefulApi(rows);
      const errors: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(" "));
      };
      let code: number;
      try {
        code = await withEnv(AUTH_ENV, () =>
          swapMain(
            ["--customer-id", CUSTOMER, "--send", "--images-manifest", makeManifest(dir, 4), "--progress-file", join(dir, "progress.json")],
            api.fetchMock as unknown as typeof fetch,
            () => [],
          ),
        );
      } finally {
        console.error = origError;
      }
      assert.equal(code, 1);
      // A recusa tem que vir do plano de IMAGEM (não de texto inviável por acaso).
      assert.ok(
        errors.some((e) => e.includes("SQUARE_MARKETING_IMAGE") && e.includes("máximo 20")),
        `esperava erro de capacidade de SQUARE_MARKETING_IMAGE, veio: ${errors.join(" | ")}`,
      );
      assert.ok(!errors.some((e) => /\b(HEADLINE|LONG_HEADLINE|DESCRIPTION):/.test(e)), "plano de texto deveria ser viável neste cenário");
      assert.equal(api.calls.assetsMutate, 0, "nenhum asset pode ser criado com o plano de imagem inviável");
      assert.equal(api.calls.linkBodies.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imagens stale sobrando: troca atômica no link da imagem, Fase 1 conclui sem rejeição de limite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-9057-swap-"));
    try {
      const rows = [...servingTextRows(), ...Array.from({ length: 19 }, (_, i) => staleImage("MARKETING_IMAGE", i))];
      const api = makeStatefulApi(rows);
      const code = await withEnv(AUTH_ENV, () =>
        swapMain(
          ["--customer-id", CUSTOMER, "--send", "--images-manifest", makeManifest(dir, 4), "--progress-file", join(dir, "progress.json")],
          api.fetchMock as unknown as typeof fetch,
          () => [],
        ),
      );
      assert.equal(api.calls.rejected, 0, "nenhum mutate pode estourar o máximo de imagem");
      assert.equal(code, 0);
      const call = api.calls.linkBodies.find((b) =>
        b.operations.some((op) => (op.create as { fieldType?: string } | undefined)?.fieldType === "MARKETING_IMAGE"),
      )!;
      assert.equal(call.operations.filter((op) => "remove" in op).length, 3); // 19 + 4 - 20
      assert.ok("remove" in call.operations[0], "remove vem antes do create");
      assert.equal([...api.enabled.values()].filter((v) => v === "MARKETING_IMAGE").length, 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

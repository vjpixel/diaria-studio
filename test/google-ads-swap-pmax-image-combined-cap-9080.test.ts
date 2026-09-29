/**
 * test/google-ads-swap-pmax-image-combined-cap-9080.test.ts
 *
 * Regressão do #9080 (achados da PR #9078/#9057):
 *   1. Teto COMBINADO de 20 imagens por asset group (premissa conservadora,
 *      `PMAX_IMAGE_COMBINED_MAX`). Antes, `planImageFieldLinks` só olhava o
 *      teto por tipo: 19 imagens ENABLED (o estado ao vivo do grupo em
 *      29/09/2026) + 12 novas passavam no plano e, se o teto combinado
 *      existir, a Fase 1 falharia no meio. Os testes do plano abaixo
 *      reprovam no código antigo (nenhuma remoção extra, `ok: true`).
 *   3. Bordas que faltavam: vários tipos estourando juntos, borda 20/21,
 *      retomada com imagem criada e não linkada, dry-run com plano inviável.
 *
 * Nenhum teste chama a API do Google Ads nem o `gh` de verdade.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseAssetGroupAssetRows,
  classifyAssetGroupAssets,
  planImageFieldLinks,
  PMAX_IMAGE_FIELD_MAX,
  PMAX_IMAGE_COMBINED_MAX,
  PMAX_IMAGE_FIELD_MIN,
  type AssetGroupAssetApiRow,
  type AssetGroupAssetItem,
  type ImageFieldType,
  type ImageLinkPlanResult,
  type SwapProgress,
} from "../scripts/lib/google-ads-asset-group-assets.ts";
import { main as swapMain } from "../scripts/google-ads-swap-asset-group-creatives.ts";

const CUSTOMER = "2369219639";
const GROUP = `customers/${CUSTOMER}/assetGroups/6642889160`;
const IMAGE_TYPES = Object.keys(PMAX_IMAGE_FIELD_MAX) as ImageFieldType[];

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

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  try {
    return { result: await fn(), out, err };
  } finally {
    console.log = origLog;
    console.error = origError;
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
const staleN = (ft: string, n: number) => Array.from({ length: n }, (_, i) => staleImage(ft, i));
const keepN = (ft: string, n: number) => Array.from({ length: n }, (_, i) => keepImage(ft, i));

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

/** Estado ao vivo do grupo 6642889160 no dry-run de 29/09/2026: 7 stale
 *  quadradas + `logo_1.jpg` (needsReview), 5 paisagem, 6 retrato = 19. */
function liveImageRows(): AssetGroupAssetApiRow[] {
  return [
    ...staleN("SQUARE_MARKETING_IMAGE", 7),
    row("SQUARE_MARKETING_IMAGE", "IMAGE", "logo_1.jpg"),
    ...staleN("MARKETING_IMAGE", 5),
    ...staleN("PORTRAIT_MARKETING_IMAGE", 6),
  ];
}

const counts = (sq: number, mk: number, pt: number): Record<ImageFieldType, number> => ({
  SQUARE_MARKETING_IMAGE: sq,
  MARKETING_IMAGE: mk,
  PORTRAIT_MARKETING_IMAGE: pt,
});

/** Simula os mutates do plano na ordem, checando os DOIS tetos e o piso em
 *  CADA passo (não só no estado final). Devolve o estado final por tipo. */
function simulate(items: AssetGroupAssetItem[], plan: ImageLinkPlanResult): Record<ImageFieldType, number> {
  const byRn = new Map(items.filter((i) => i.status === "ENABLED").map((i) => [i.assetGroupAssetResourceName, i.fieldType]));
  const state = counts(0, 0, 0);
  for (const ft of byRn.values()) if (ft in state) state[ft as ImageFieldType]++;
  // Piso só vale para o que o plano derrubaria — fixture que já começa abaixo
  // (grupo sem paisagem) não é culpa do plano.
  const floor = Object.fromEntries(IMAGE_TYPES.map((ft) => [ft, Math.min(state[ft], PMAX_IMAGE_FIELD_MIN[ft])])) as Record<ImageFieldType, number>;
  const removed = new Set<string>();
  for (const p of plan.plans) {
    for (const rn of p.removeInSameMutate) {
      assert.ok(!removed.has(rn), `remoção duplicada: ${rn}`);
      removed.add(rn);
      const ft = byRn.get(rn) as ImageFieldType;
      assert.ok(ft, `remoção de recurso que não é imagem ENABLED: ${rn}`);
      state[ft]--;
    }
    state[p.fieldType] += p.newCount;
    for (const ft of IMAGE_TYPES) {
      assert.ok(state[ft] <= PMAX_IMAGE_FIELD_MAX[ft], `${ft} passou do teto por tipo após linkar ${p.fieldType}`);
      assert.ok(state[ft] >= floor[ft], `${ft} ficou abaixo do piso após linkar ${p.fieldType}`);
    }
    const total = IMAGE_TYPES.reduce((a, ft) => a + state[ft], 0);
    assert.ok(total <= PMAX_IMAGE_COMBINED_MAX, `total ${total} passou do teto combinado após linkar ${p.fieldType}`);
  }
  return state;
}

const totalRemovals = (plan: ImageLinkPlanResult) => plan.plans.reduce((a, p) => a + p.removeInSameMutate.length, 0);

describe("#9080 — teto combinado de imagens por asset group", () => {
  it("constantes: 20 combinado; piso 1 nos obrigatórios (quadrada/paisagem), 0 no retrato", () => {
    assert.equal(PMAX_IMAGE_COMBINED_MAX, 20);
    assert.deepEqual(PMAX_IMAGE_FIELD_MIN, counts(1, 1, 0));
  });

  it("estado ao vivo (19) + 12 novas: remove 11 stale, nunca logo_1.jpg, total nunca passa de 20 em nenhum passo (reprova no código antigo)", () => {
    const items = parseAssetGroupAssetRows(liveImageRows());
    const plan = planImageFieldLinks(items, classifyAssetGroupAssets(items), counts(4, 4, 4));
    assert.equal(plan.ok, true);
    assert.equal(totalRemovals(plan), 11); // 19 + 12 - 20
    const logo = items.find((i) => i.imageName === "logo_1.jpg")!;
    assert.ok(!plan.plans.some((p) => p.removeInSameMutate.includes(logo.assetGroupAssetResourceName)));
    const final = simulate(items, plan);
    assert.equal(IMAGE_TYPES.reduce((a, ft) => a + final[ft], 0), 20);
  });

  it("borda: 8 existentes + 12 novas = 20 exatos cabe sem remover; 9 + 12 = 21 remove exatamente 1", () => {
    const i20 = parseAssetGroupAssetRows(staleN("MARKETING_IMAGE", 8));
    const p20 = planImageFieldLinks(i20, classifyAssetGroupAssets(i20), counts(4, 4, 4));
    assert.equal(p20.ok, true);
    assert.equal(totalRemovals(p20), 0);

    const i21 = parseAssetGroupAssetRows(staleN("MARKETING_IMAGE", 9));
    const p21 = planImageFieldLinks(i21, classifyAssetGroupAssets(i21), counts(4, 4, 4));
    assert.equal(p21.ok, true);
    assert.equal(totalRemovals(p21), 1);
    simulate(i21, p21);
  });

  it("borda do teto por tipo: 16 + 4 = 20 cabe; 17 + 4 = 21 remove 1 (só um tipo recebe novas)", () => {
    const a = parseAssetGroupAssetRows(staleN("SQUARE_MARKETING_IMAGE", 16));
    const pa = planImageFieldLinks(a, classifyAssetGroupAssets(a), counts(4, 0, 0));
    assert.equal(totalRemovals(pa), 0);
    const b = parseAssetGroupAssetRows(staleN("SQUARE_MARKETING_IMAGE", 17));
    const pb = planImageFieldLinks(b, classifyAssetGroupAssets(b), counts(4, 0, 0));
    assert.equal(pb.ok, true);
    assert.equal(totalRemovals(pb), 1);
    simulate(b, pb);
  });

  it("vários tipos estourando o teto combinado juntos: remoções distribuídas, cada passo ≤ 20", () => {
    const items = parseAssetGroupAssetRows([
      ...staleN("SQUARE_MARKETING_IMAGE", 6),
      ...staleN("MARKETING_IMAGE", 6),
      ...staleN("PORTRAIT_MARKETING_IMAGE", 6),
    ]);
    const plan = planImageFieldLinks(items, classifyAssetGroupAssets(items), counts(4, 4, 4));
    assert.equal(plan.ok, true);
    assert.equal(totalRemovals(plan), 10); // 18 + 12 - 20
    for (const p of plan.plans) assert.ok(p.removeInSameMutate.length > 0, `${p.fieldType} também precisa abrir vaga`);
    simulate(items, plan);
  });

  it("teto por tipo E combinado estourando juntos em 2 tipos: tudo planejado, cada passo dentro dos dois tetos", () => {
    const items = parseAssetGroupAssetRows([...staleN("SQUARE_MARKETING_IMAGE", 19), ...staleN("PORTRAIT_MARKETING_IMAGE", 19)]);
    const plan = planImageFieldLinks(items, classifyAssetGroupAssets(items), counts(4, 0, 4));
    assert.equal(plan.ok, true);
    const final = simulate(items, plan);
    assert.ok(final.SQUARE_MARKETING_IMAGE >= 4 && final.PORTRAIT_MARKETING_IMAGE >= 4);
  });

  it("inviável: imagens não-stale + novas > 20 somando os tipos — erro, nenhum não-stale removido", () => {
    const items = parseAssetGroupAssetRows([...keepN("SQUARE_MARKETING_IMAGE", 5), ...keepN("MARKETING_IMAGE", 5), ...staleN("PORTRAIT_MARKETING_IMAGE", 3)]);
    const plan = planImageFieldLinks(items, classifyAssetGroupAssets(items), counts(4, 4, 4));
    assert.equal(plan.ok, false);
    assert.ok(!plan.ok && plan.errors.some((e) => e.includes("teto combinado") && e.includes("20")));
    const staleRns = new Set(classifyAssetGroupAssets(items).stale.map((i) => i.assetGroupAssetResourceName));
    for (const p of plan.plans) for (const rn of p.removeInSameMutate) assert.ok(staleRns.has(rn));
  });

  it("piso: nunca remove a última paisagem obrigatória para abrir vaga, mesmo stale", () => {
    // 1 paisagem stale (única) + 15 retrato keep; novas só quadradas.
    const items = parseAssetGroupAssetRows([staleImage("MARKETING_IMAGE", 1), ...keepN("PORTRAIT_MARKETING_IMAGE", 15)]);
    const plan = planImageFieldLinks(items, classifyAssetGroupAssets(items), counts(5, 0, 0));
    assert.equal(plan.ok, false, "16 + 5 = 21 e o único stale é a última paisagem — inviável");
    for (const p of plan.plans) assert.equal(p.removeInSameMutate.length, 0);
  });

  it("etapa já linkada (retomada) conta como ENABLED e o teto combinado segue valendo para as restantes", () => {
    // Retomada: as 4 quadradas novas já foram linkadas (aparecem ENABLED como keep).
    const items = parseAssetGroupAssetRows([...keepN("SQUARE_MARKETING_IMAGE", 4), ...liveImageRows()]);
    const plan = planImageFieldLinks(items, classifyAssetGroupAssets(items), counts(4, 4, 4), new Set(["SQUARE_MARKETING_IMAGE"]));
    assert.equal(plan.ok, true);
    assert.ok(!plan.plans.some((p) => p.fieldType === "SQUARE_MARKETING_IMAGE"));
    assert.equal(totalRemovals(plan), 23 + 8 - 20);
    simulate(items, plan);
  });
});

describe("#9080 — CLI", () => {
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

  /** Mock com estado REAL entre execuções: o `:search` devolve o que está
   *  ENABLED agora (inclusive os links novos), os mutates aplicam remove +
   *  create e recusam (400, nada aplicado) quando passam do teto por tipo ou
   *  combinado. `failLinkOnce` derruba (HTTP 500) o 1º link do fieldType dado. */
  function makeApi(initial: AssetGroupAssetApiRow[], opts: { failLinkOnce?: string } = {}) {
    const enabled = new Map<string, AssetGroupAssetApiRow>();
    for (const r of initial) enabled.set(r.assetGroupAsset!.resourceName!, r);
    const assetNames = new Map<string, string>();
    let assetCounter = 50_000;
    let failPending = opts.failLinkOnce;
    const calls = { assetsMutate: 0, linkBodies: [] as Array<{ operations: Array<Record<string, unknown>> }>, rejected: 0 };
    const fetchMock = async (input: string, init?: RequestInit) => {
      if (input === "https://oauth2.googleapis.com/token") return jsonResponse(200, { access_token: "tok" });
      if (input.endsWith(":search")) return jsonResponse(200, { results: [...enabled.values()] });
      if (input.endsWith("assetGroupAssets:mutate")) {
        const body = JSON.parse(String(init?.body));
        calls.linkBodies.push(body);
        const createFt = body.operations.find((op: { create?: { fieldType: string } }) => op.create)?.create?.fieldType;
        if (failPending && createFt === failPending) {
          failPending = undefined;
          return jsonResponse(500, { error: { message: "INTERNAL" } });
        }
        const next = new Map(enabled);
        for (const op of body.operations) {
          if (typeof op.remove === "string") next.delete(op.remove);
          else {
            const assetRn: string = op.create.asset;
            const id = assetRn.split("/").pop()!;
            const rn = `${GROUP.replace("assetGroups/", "assetGroupAssets/")}~${id}~${op.create.fieldType}`;
            next.set(rn, {
              asset: { resourceName: assetRn, id, type: "IMAGE", name: assetNames.get(assetRn) ?? `novo-${id}.jpg` },
              assetGroupAsset: { resourceName: rn, asset: assetRn, fieldType: op.create.fieldType, status: "ENABLED" },
            });
          }
        }
        const fts = [...next.values()].map((r) => r.assetGroupAsset!.fieldType!);
        const imgs = fts.filter((ft) => ft in PMAX_IMAGE_FIELD_MAX);
        const perTypeOver = IMAGE_TYPES.some((ft) => imgs.filter((x) => x === ft).length > PMAX_IMAGE_FIELD_MAX[ft]);
        if (perTypeOver || imgs.length > PMAX_IMAGE_COMBINED_MAX) {
          calls.rejected++;
          return jsonResponse(400, { error: { message: `RESOURCE_LIMIT imagens=${imgs.length}` } });
        }
        enabled.clear();
        for (const [k, v] of next) enabled.set(k, v);
        return jsonResponse(200, { results: body.operations.map(() => ({ resourceName: "customers/x/assetGroupAssets/y" })) });
      }
      if (input.endsWith("assets:mutate")) {
        calls.assetsMutate++;
        const body = JSON.parse(String(init?.body));
        return jsonResponse(200, {
          results: body.operations.map((op: { create?: { name?: string } }) => {
            const rn = `customers/${CUSTOMER}/assets/${assetCounter++}`;
            if (op.create?.name) assetNames.set(rn, op.create.name);
            return { resourceName: rn };
          }),
        });
      }
      throw new Error(`chamada inesperada: ${input}`);
    };
    const imageCount = () => [...enabled.values()].filter((r) => r.assetGroupAsset!.fieldType! in PMAX_IMAGE_FIELD_MAX).length;
    return { fetchMock, calls, imageCount };
  }

  it("--send no estado ao vivo: Fase 1 conclui sem nenhuma rejeição de limite e termina com 20 imagens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-9080-live-"));
    try {
      const api = makeApi([...servingTextRows(), ...liveImageRows()]);
      const { result: code } = await captureConsole(() =>
        withEnv(AUTH_ENV, () =>
          swapMain(
            ["--customer-id", CUSTOMER, "--send", "--images-manifest", makeManifest(dir, 4), "--progress-file", join(dir, "progress.json")],
            api.fetchMock as unknown as typeof fetch,
            () => [],
          ),
        ),
      );
      assert.equal(api.calls.rejected, 0);
      assert.equal(code, 0);
      assert.equal(api.imageCount(), 20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retomada com imagem criada e não linkada: não recria assets, linka o que falta, teto respeitado", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-9080-resume-"));
    const progressFile = join(dir, "progress.json");
    try {
      const api = makeApi([...servingTextRows(), ...liveImageRows()], { failLinkOnce: "MARKETING_IMAGE" });
      const manifestPath = makeManifest(dir, 4);
      const argv = ["--customer-id", CUSTOMER, "--send", "--images-manifest", manifestPath, "--progress-file", progressFile];
      const run1 = await captureConsole(() => withEnv(AUTH_ENV, () => swapMain(argv, api.fetchMock as unknown as typeof fetch, () => [])));
      assert.equal(run1.result, 1, "1ª execução falha no link de MARKETING_IMAGE");
      const progress: SwapProgress = JSON.parse(readFileSync(progressFile, "utf8"));
      assert.equal(progress.steps.SQUARE_MARKETING_IMAGE?.linked, true);
      assert.equal(progress.steps.MARKETING_IMAGE?.linked, false, "MARKETING criada e não linkada");
      assert.equal(progress.steps.MARKETING_IMAGE?.resourceNames.length, 4);

      const assetsBefore = api.calls.assetsMutate;
      const run2 = await captureConsole(() => withEnv(AUTH_ENV, () => swapMain(argv, api.fetchMock as unknown as typeof fetch, () => [])));
      assert.equal(run2.result, 0, `retomada deveria concluir: ${run2.err.join(" | ")}`);
      assert.equal(api.calls.assetsMutate, assetsBefore, "retomada não pode recriar nenhum asset");
      assert.equal(api.calls.rejected, 0);
      assert.ok(api.imageCount() <= PMAX_IMAGE_COMBINED_MAX);
      assert.equal(existsSync(progressFile), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dry-run com plano inviável: sai 0, reporta o erro de capacidade e não faz nenhuma mutação", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gads-pmax-9080-dry-"));
    try {
      const api = makeApi([...servingTextRows(), ...keepN("SQUARE_MARKETING_IMAGE", 5), ...keepN("MARKETING_IMAGE", 5)]);
      const { result: code, err, out } = await captureConsole(() =>
        withEnv(AUTH_ENV, () =>
          swapMain(
            ["--customer-id", CUSTOMER, "--images-manifest", makeManifest(dir, 4), "--progress-file", join(dir, "progress.json")],
            api.fetchMock as unknown as typeof fetch,
            () => [],
          ),
        ),
      );
      assert.equal(code, 0);
      assert.ok(err.some((e) => e.includes("teto combinado")), `esperava erro do teto combinado: ${err.join(" | ")}`);
      assert.ok(out.some((l) => l.includes("teto combinado de imagens: 10 ENABLED hoje + 12")));
      assert.equal(api.calls.assetsMutate, 0);
      assert.equal(api.calls.linkBodies.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

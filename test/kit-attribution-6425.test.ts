/**
 * test/kit-attribution-6425.test.ts (#6425)
 *
 * Regressão das 3 partes da issue #6425:
 *
 * - Parte A: recuperação da atribuição NATIVA de quem entrou pelo form
 *   hospedado no Kit (`buildNativeFormAttributionFields`/`montarPlanoNativo`,
 *   `scripts/lib/kit-attribution.ts`) e o `include[]=attribution` na
 *   listagem (`scripts/lib/kit-subscribers.ts`).
 * - Parte B: `promoteKitSubscription` (`scripts/evaluate-brevo-diaria.ts`)
 *   e o sync em lote (`scripts/sync-beehiiv-subscribers-kit.ts`) passam a
 *   mandar `fields` — antes iam sem nenhum.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildNativeFormAttributionFields,
  montarPlanoNativo,
  ATRIBUICAO_FONTE_KIT_NATIVO_FORM,
} from "../scripts/lib/kit-attribution.ts";
import { listKitSubscribersPage } from "../scripts/lib/kit-subscribers.ts";
import {
  KIT_SCORE_PROMOTION_SIGNUP_MARKER,
  KIT_BEEHIIV_SYNC_SIGNUP_MARKER,
  KIT_ORIGEM_CADASTRO_FIELD_NAME,
} from "../scripts/lib/shared/kit-signup-origin.ts";
import { promoteKitSubscription } from "../scripts/evaluate-brevo-diaria.ts";
import { buildBeehiivSyncKitFields } from "../scripts/sync-beehiiv-subscribers-kit.ts";
import { BREVO_DIARIA_PROMOCAO_SCORE_UTM } from "../scripts/lib/shared/utm-registry.ts";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── Parte A ──────────────────────────────────────────────────────────────

describe("buildNativeFormAttributionFields (#6425 Parte A)", () => {
  it("copia referrer + utm_* quando presentes, marca atribuicao_fonte proprio", () => {
    const fields = buildNativeFormAttributionFields({
      referrer: "https://diar-ia-br.kit.com/",
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: "post-x",
      source_type: "form_subscription",
      source_name: "Newsletter site",
      source_mechanism: "newsletter",
    });
    assert.deepEqual(fields, {
      referring_site: "https://diar-ia-br.kit.com/",
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: "post-x",
      atribuicao_fonte: ATRIBUICAO_FONTE_KIT_NATIVO_FORM,
    });
  });

  it("form sem UTM/referrer nenhum: devolve null (visita legitimamente sem atribuicao, nao erro)", () => {
    assert.equal(
      buildNativeFormAttributionFields({
        referrer: null,
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        source_type: "form_subscription",
        source_name: "Newsletter site",
        source_mechanism: "newsletter",
      }),
      null,
    );
  });

  it("campo vazio/whitespace e OMITIDO, nunca gravado como string vazia", () => {
    const fields = buildNativeFormAttributionFields({
      referrer: "  https://diar-ia-br.kit.com/  ",
      utm_source: "",
      utm_medium: "   ",
      utm_campaign: null,
    });
    assert.deepEqual(fields, {
      referring_site: "https://diar-ia-br.kit.com/",
      atribuicao_fonte: ATRIBUICAO_FONTE_KIT_NATIVO_FORM,
    });
  });
});

describe("montarPlanoNativo (#6425 Parte A)", () => {
  it("separa: a gravar, ja feitos, sem bloco attribution, attribution vazia", () => {
    const plano = montarPlanoNativo([
      { id: 1, email_address: "form@x.com", attribution: { referrer: "https://diar-ia-br.kit.com/" } },
      { id: 2, email_address: "ja-feito@x.com", fields: { atribuicao_fonte: ATRIBUICAO_FONTE_KIT_NATIVO_FORM }, attribution: { referrer: "https://diar-ia-br.kit.com/" } },
      { id: 3, email_address: "via-api@x.com", attribution: null },
      { id: 4, email_address: "form-sem-utm@x.com", attribution: { referrer: null, utm_source: null } },
    ]);
    assert.equal(plano.aplicar.length, 1);
    assert.equal(plano.aplicar[0].subscriberId, 1);
    assert.equal(plano.jaFeitos, 1);
    assert.deepEqual(plano.semOrigem, ["via-api@x.com"]);
    assert.deepEqual(plano.origemVazia, ["form-sem-utm@x.com"]);
  });

  it("--force reprocessa quem ja tinha o marcador", () => {
    const plano = montarPlanoNativo(
      [{ id: 2, email_address: "ja-feito@x.com", fields: { atribuicao_fonte: ATRIBUICAO_FONTE_KIT_NATIVO_FORM }, attribution: { referrer: "https://diar-ia-br.kit.com/" } }],
      { force: true },
    );
    assert.equal(plano.aplicar.length, 1);
    assert.equal(plano.jaFeitos, 0);
  });
});

describe("listKitSubscribersPage — include[]=attribution (#6425 Parte A)", () => {
  it("includeAttribution:true adiciona include[]=attribution na query", async () => {
    let capturedUrl = "";
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return jsonResponse(200, { subscribers: [], pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 } });
    }) as typeof fetch;
    try {
      await listKitSubscribersPage({ includeAttribution: true, config: { apiKey: "k" } });
    } finally {
      globalThis.fetch = orig;
    }
    assert.match(capturedUrl, /include%5B%5D=attribution|include\[\]=attribution/);
  });

  it("sem includeAttribution: nao manda o parametro", async () => {
    let capturedUrl = "";
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return jsonResponse(200, { subscribers: [], pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 } });
    }) as typeof fetch;
    try {
      await listKitSubscribersPage({ config: { apiKey: "k" } });
    } finally {
      globalThis.fetch = orig;
    }
    assert.doesNotMatch(capturedUrl, /attribution/);
  });
});

// ── Parte B ──────────────────────────────────────────────────────────────

describe("promoteKitSubscription monta fields a partir do registry (#6425 Parte B)", () => {
  it("POST /v4/subscribers carrega o UTM de BREVO_DIARIA_PROMOCAO_SCORE_UTM + origem_cadastro", async () => {
    let body: unknown;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_u: string | URL, init?: RequestInit) => {
      body = JSON.parse(init!.body as string);
      return jsonResponse(200, { subscriber: { id: 999, email_address: "score@b.com", state: "active", created_at: "x" } });
    }) as typeof fetch;
    try {
      const result = await promoteKitSubscription("score@b.com", "kkey");
      assert.equal(result.id, 999);
    } finally {
      globalThis.fetch = orig;
    }
    const b = body as { email_address: string; state: string; fields: Record<string, string> };
    assert.equal(b.email_address, "score@b.com");
    assert.equal(b.state, "active");
    assert.deepEqual(b.fields, {
      utm_source: BREVO_DIARIA_PROMOCAO_SCORE_UTM.source,
      utm_medium: BREVO_DIARIA_PROMOCAO_SCORE_UTM.medium,
      utm_campaign: BREVO_DIARIA_PROMOCAO_SCORE_UTM.campaign,
      referring_site: BREVO_DIARIA_PROMOCAO_SCORE_UTM.referringSite,
      [KIT_ORIGEM_CADASTRO_FIELD_NAME]: KIT_SCORE_PROMOTION_SIGNUP_MARKER,
    });
  });
});

describe("buildBeehiivSyncKitFields (#6425 Parte B — sync-beehiiv-subscribers-kit.ts)", () => {
  it("grava o marcador origem_cadastro proprio do sync em lote", () => {
    assert.deepEqual(buildBeehiivSyncKitFields(), {
      [KIT_ORIGEM_CADASTRO_FIELD_NAME]: KIT_BEEHIIV_SYNC_SIGNUP_MARKER,
    });
  });
});

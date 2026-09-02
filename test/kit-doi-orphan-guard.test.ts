/**
 * test/kit-doi-orphan-guard.test.ts (#6810)
 *
 * Cobre o miolo puro (`scripts/lib/kit-doi-orphan-guard.ts`) — nenhuma
 * chamada de rede. Cenários da regra do órfão exigidos pela issue:
 *   1. inactive > 48h sem vínculo ao form → detectado como órfão
 *   2. inactive < 48h (ainda dentro da janela normal) → NÃO órfão
 *   3. inactive vinculado ao form → NÃO órfão, mesmo velho
 *   4. active → NÃO órfão, mesmo sem vínculo/velho
 *
 * Um 5º bloco ("regressão #6810 — falso positivo sistemático") cobre o
 * SEAM de I/O que a suíte acima não exercita: como `formSubscriberIds` é
 * MONTADO a partir de `listAllFormSubscribers` (`scripts/lib/kit-
 * subscribers.ts`), com `globalThis.fetch` mockado pra simular o
 * comportamento REAL medido do Kit (`GET /forms/{id}/subscribers` sem
 * `status` devolve só `active`) — reproduz o falso positivo relatado ao
 * vivo (`maribmgv@uol.com.br`/`jessicadantasx@gmail.com`, ambos
 * `inactive` e vinculados ao form, acusados como órfãos pela versão sem
 * `status: "all"`) e confirma que o fix (`status: "all"` na chamada em
 * `scripts/kit-doi-orphan-guard.ts`) resolve.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isKitDoiOrphan,
  findKitDoiOrphans,
  computeKitDoiOrphanFingerprint,
  kitDoiOrphanFindingKey,
  shouldAlarmKitDoiOrphans,
  advanceKitDoiOrphanState,
  emptyKitDoiOrphanAlarmState,
  buildKitDoiOrphanAlarmEmail,
  ORPHAN_THRESHOLD_HOURS,
  type KitDoiOrphan,
} from "../scripts/lib/kit-doi-orphan-guard.ts";
import { toAlarmFinding } from "../scripts/kit-doi-orphan-guard.ts";
import { listAllFormSubscribers } from "../scripts/lib/kit-subscribers.ts";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function hoursAgo(h: number): string {
  return new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
}

describe("isKitDoiOrphan — regra do órfão (#6810)", () => {
  it("inactive há mais de 48h, ausente do form → órfão", () => {
    const s = { id: 1, state: "inactive", created_at: hoursAgo(72) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), true);
  });

  it("inactive há menos de 48h (ainda dentro da janela normal) → NÃO órfão", () => {
    const s = { id: 2, state: "inactive", created_at: hoursAgo(10) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), false);
  });

  it("exatamente no limiar (48h) conta como órfão — inclusivo", () => {
    const s = { id: 3, state: "inactive", created_at: hoursAgo(ORPHAN_THRESHOLD_HOURS) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), true);
  });

  it("inactive há mais de 48h MAS vinculado ao form → NÃO órfão", () => {
    const s = { id: 4, state: "inactive", created_at: hoursAgo(100) };
    assert.equal(isKitDoiOrphan(s, new Set([4]), NOW), false);
  });

  it("active, mesmo sem vínculo e velho → NÃO órfão (regra só se aplica a inactive)", () => {
    const s = { id: 5, state: "active", created_at: hoursAgo(1000) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), false);
  });

  it("cancelled/bounced (qualquer state != inactive) → NÃO órfão", () => {
    const s = { id: 6, state: "cancelled", created_at: hoursAgo(1000) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), false);
  });

  it("created_at ilegível → NÃO lança, trata como não-órfão (fail-soft)", () => {
    const s = { id: 7, state: "inactive", created_at: "not-a-date" };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW), false);
  });

  it("threshold custom é respeitado (override do default de 48h)", () => {
    const s = { id: 8, state: "inactive", created_at: hoursAgo(5) };
    assert.equal(isKitDoiOrphan(s, new Set(), NOW, 4), true);
    assert.equal(isKitDoiOrphan(s, new Set(), NOW, 6), false);
  });
});

describe("findKitDoiOrphans", () => {
  it("filtra e ordena por created_at crescente (mais antigo primeiro)", () => {
    const subs = [
      { id: 1, email_address: "recente@x.com", state: "inactive", created_at: hoursAgo(49) },
      { id: 2, email_address: "antigo@x.com", state: "inactive", created_at: hoursAgo(200) },
      { id: 3, email_address: "vinculado@x.com", state: "inactive", created_at: hoursAgo(300) },
      { id: 4, email_address: "muito-novo@x.com", state: "inactive", created_at: hoursAgo(1) },
      { id: 5, email_address: "confirmado@x.com", state: "active", created_at: hoursAgo(500) },
    ];
    const orphans = findKitDoiOrphans(subs, new Set([3]), NOW);
    assert.deepEqual(
      orphans.map((o) => o.email_address),
      ["antigo@x.com", "recente@x.com"],
    );
    assert.ok(orphans[0].ageHours > orphans[1].ageHours);
  });

  it("lista vazia → nenhum órfão", () => {
    assert.deepEqual(findKitDoiOrphans([], new Set(), NOW), []);
  });
});

describe("computeKitDoiOrphanFingerprint / shouldAlarmKitDoiOrphans", () => {
  const orphan1: KitDoiOrphan = { id: 1, email_address: "a@x.com", created_at: hoursAgo(72), ageHours: 72 };
  const orphan2: KitDoiOrphan = { id: 2, email_address: "b@x.com", created_at: hoursAgo(60), ageHours: 60 };

  it("fingerprint é determinístico independente da ordem de chegada", () => {
    assert.equal(computeKitDoiOrphanFingerprint([orphan1, orphan2]), computeKitDoiOrphanFingerprint([orphan2, orphan1]));
  });

  it("fingerprint muda quando o conjunto muda", () => {
    assert.notEqual(computeKitDoiOrphanFingerprint([orphan1]), computeKitDoiOrphanFingerprint([orphan1, orphan2]));
  });

  it("sem órfão pendente → nunca alarma", () => {
    assert.equal(shouldAlarmKitDoiOrphans(emptyKitDoiOrphanAlarmState(), []), false);
  });

  it("órfão novo, estado vazio → alarma", () => {
    assert.equal(shouldAlarmKitDoiOrphans(emptyKitDoiOrphanAlarmState(), [orphan1]), true);
  });

  it("mesmo conjunto já alarmado → NÃO alarma de novo (idempotência)", () => {
    const fp = computeKitDoiOrphanFingerprint([orphan1]);
    const state = advanceKitDoiOrphanState(fp, NOW);
    assert.equal(shouldAlarmKitDoiOrphans(state, [orphan1]), false);
  });

  it("conjunto mudou (novo órfão apareceu) → alarma de novo", () => {
    const fp = computeKitDoiOrphanFingerprint([orphan1]);
    const state = advanceKitDoiOrphanState(fp, NOW);
    assert.equal(shouldAlarmKitDoiOrphans(state, [orphan1, orphan2]), true);
  });

  it("conjunto esvaziou e depois reapareceu (mesmo fingerprint) → re-arma e alarma de novo", () => {
    const fp = computeKitDoiOrphanFingerprint([orphan1]);
    const alarmed = advanceKitDoiOrphanState(fp, NOW);
    const rearmed = advanceKitDoiOrphanState(null, NOW); // conjunto esvaziou
    assert.equal(shouldAlarmKitDoiOrphans(alarmed, []), false);
    assert.equal(shouldAlarmKitDoiOrphans(rearmed, [orphan1]), true);
  });
});

describe("buildKitDoiOrphanAlarmEmail", () => {
  const orphan: KitDoiOrphan = { id: 42, email_address: "preso@x.com", created_at: hoursAgo(72), ageHours: 72 };

  it("assunto cita a contagem, corpo lista o e-mail e o id", () => {
    const { subject, body } = buildKitDoiOrphanAlarmEmail([orphan], NOW);
    assert.match(subject, /1 cadastro/);
    assert.match(body, /preso@x\.com/);
    assert.match(body, /id 42/);
    assert.match(body, /#6810/);
  });

  it("issueRefs presente → corpo cita o número da issue daquele órfão", () => {
    const issueRefs = new Map([
      [kitDoiOrphanFindingKey(orphan), { issueNumber: 9001, url: "https://github.com/x/y/issues/9001", action: "created" }],
    ]);
    const { body } = buildKitDoiOrphanAlarmEmail([orphan], NOW, issueRefs);
    assert.match(body, /#9001/);
  });

  it("issueRefs com action failed → corpo cita a falha, não um número inventado", () => {
    const issueRefs = new Map([
      [kitDoiOrphanFindingKey(orphan), { issueNumber: null, url: null, action: "failed", error: "gh não autenticado" }],
    ]);
    const { body } = buildKitDoiOrphanAlarmEmail([orphan], NOW, issueRefs);
    assert.match(body, /falha ao criar\/reusar/);
    assert.match(body, /gh não autenticado/);
  });

  it("2 órfãos, só 1 com issueRef → issue citada só na linha certa", () => {
    const orphan2: KitDoiOrphan = { id: 43, email_address: "outro@x.com", created_at: hoursAgo(60), ageHours: 60 };
    const issueRefs = new Map([
      [kitDoiOrphanFindingKey(orphan2), { issueNumber: 777, url: "https://github.com/x/y/issues/777", action: "created" }],
    ]);
    const { body } = buildKitDoiOrphanAlarmEmail([orphan, orphan2], NOW, issueRefs);
    assert.match(body, /#777/);
    const orphanIssueLine = body.split("\n").findIndex((l) => l.includes("id 42"));
    assert.equal(body.split("\n")[orphanIssueLine + 1].includes("Issue:"), false);
  });
});

describe("kitDoiOrphanFindingKey — estável por órfão individual", () => {
  const orphan1: KitDoiOrphan = { id: 1, email_address: "a@x.com", created_at: hoursAgo(72), ageHours: 72 };
  const orphan2: KitDoiOrphan = { id: 2, email_address: "b@x.com", created_at: hoursAgo(60), ageHours: 60 };

  it("2 ids distintos → chaves distintas", () => {
    assert.notEqual(kitDoiOrphanFindingKey(orphan1), kitDoiOrphanFindingKey(orphan2));
  });

  it("mesmo id em execuções diferentes (idade mudou) → mesma chave", () => {
    const laterRun: KitDoiOrphan = { ...orphan1, ageHours: 96 };
    assert.equal(kitDoiOrphanFindingKey(orphan1), kitDoiOrphanFindingKey(laterRun));
  });
});

describe("toAlarmFinding (scripts/kit-doi-orphan-guard.ts) — 1 finding por órfão (#6993 review)", () => {
  const orphan1: KitDoiOrphan = { id: 1, email_address: "a@x.com", created_at: hoursAgo(72), ageHours: 72 };
  const orphan2: KitDoiOrphan = { id: 2, email_address: "b@x.com", created_at: hoursAgo(60), ageHours: 60 };

  it("2 órfãos → 2 findings com fingerprints distintos", () => {
    const findings = [orphan1, orphan2].map(toAlarmFinding);
    assert.equal(findings.length, 2);
    assert.notEqual(findings[0].fingerprint, findings[1].fingerprint);
    assert.equal(findings[0].fingerprint, "kit-doi-orphan:1");
    assert.equal(findings[1].fingerprint, "kit-doi-orphan:2");
  });

  it("check == fingerprint (chave por órfão, não um valor constante compartilhado)", () => {
    const finding = toAlarmFinding(orphan1);
    assert.equal(finding.check, finding.fingerprint);
  });

  it("mesmo órfão em duas execuções (só ageHours muda) → mesmo fingerprint — issue permanece estável", () => {
    const run1 = toAlarmFinding(orphan1);
    const run2 = toAlarmFinding({ ...orphan1, ageHours: 96 });
    assert.equal(run1.fingerprint, run2.fingerprint);
  });

  it("um 3º órfão aparecendo não muda o fingerprint dos 2 já existentes", () => {
    const before = [orphan1, orphan2].map(toAlarmFinding);
    const orphan3: KitDoiOrphan = { id: 3, email_address: "c@x.com", created_at: hoursAgo(50), ageHours: 50 };
    const after = [orphan1, orphan2, orphan3].map(toAlarmFinding);
    assert.equal(before[0].fingerprint, after[0].fingerprint);
    assert.equal(before[1].fingerprint, after[1].fingerprint);
  });

  it("priority P1, family estado", () => {
    const finding = toAlarmFinding(orphan1);
    assert.equal(finding.priority, "P1");
    assert.equal(finding.family, "estado");
  });
});

describe("regressão #6810 — falso positivo sistemático (formSubscriberIds mal-formado sem status=all)", () => {
  /** Simula o backend real do Kit: `GET /forms/{id}/subscribers` só devolve
   *  quem está em `activeIds` A MENOS que a chamada passe `status=all` na
   *  querystring — é exatamente o comportamento documentado
   *  (developers.kit.com/api-reference/forms/list-subscribers-for-a-form.md,
   *  "By default only `active` subscribers are returned") e medido ao vivo
   *  (achado 01/09/2026: 23 `active` no form, 0 `inactive`, mesmo com
   *  `inactive` de fato vinculados). */
  function fakeKitForm(allSubscribers: { id: number; email_address: string; state: string }[]) {
    return (async (url: string) => {
      const includesAll = /status=all/.test(url);
      const filtered = includesAll ? allSubscribers : allSubscribers.filter((s) => s.state === "active");
      return new Response(
        JSON.stringify({
          subscribers: filtered.map((s) => ({ ...s, created_at: "2026-08-01T00:00:00.000Z" })),
          pagination: { has_previous_page: false, has_next_page: false, start_cursor: null, end_cursor: null, per_page: 500 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
  }

  async function withMockFetch<T>(handler: typeof fetch, fn: () => Promise<T>): Promise<T> {
    const orig = globalThis.fetch;
    globalThis.fetch = handler;
    try {
      return await fn();
    } finally {
      globalThis.fetch = orig;
    }
  }

  // Cenário do achado ao vivo (01/09/2026): 1 inactive VINCULADO ao form
  // (aguardando clique — legítimo, é o "maribmgv@uol.com.br" do relato) e 1
  // inactive NUNCA vinculado (órfão de verdade). Os dois `inactive`, os
  // dois > 48h.
  const allFormLinks = [
    { id: 100, email_address: "vinculado-aguardando-clique@x.com", state: "inactive" },
    { id: 200, email_address: "confirmado-de-outro-jeito@x.com", state: "active" },
  ];
  // orphan real (id 999) nunca aparece em `allFormLinks` — NUNCA foi
  // vinculado ao form, em NENHUM cenário de status.
  const inactiveSubscribers = [
    { id: 100, email_address: "vinculado-aguardando-clique@x.com", state: "inactive", created_at: hoursAgo(72) },
    { id: 999, email_address: "nunca-vinculado@x.com", state: "inactive", created_at: hoursAgo(72) },
  ];

  it("SEM status=all (comportamento pré-fix): o vinculado-mas-inactive vira falso positivo", async () => {
    const formSubscribers = await withMockFetch(fakeKitForm(allFormLinks), () =>
      // Reproduz a chamada ORIGINAL do #6993 (sem opts.status) — o mock
      // acima devolve só os `active` do form, então id 100 (inactive,
      // vinculado) fica FORA do set, exatamente como a API real fez.
      listAllFormSubscribers(9839463, { apiKey: "kit_test_key" }),
    );
    const formSubscriberIds = new Set(formSubscribers.map((s) => s.id));
    assert.equal(formSubscriberIds.has(100), false, "pré-fix: o vinculado-mas-inactive não aparece no set (bug)");

    const orphans = findKitDoiOrphans(inactiveSubscribers, formSubscriberIds, NOW);
    const orphanIds = orphans.map((o) => o.id).sort();
    // Reproduz o bug relatado: os 2 acusados, incluindo o legítimo (100).
    assert.deepEqual(orphanIds, [100, 999]);
  });

  it("COM status='all' (fix): o vinculado-mas-inactive NÃO é mais falso positivo, e o órfão real continua detectado", async () => {
    const formSubscribers = await withMockFetch(fakeKitForm(allFormLinks), () =>
      // Chamada corrigida — `scripts/kit-doi-orphan-guard.ts` passa isto.
      listAllFormSubscribers(9839463, { apiKey: "kit_test_key" }, { status: "all" }),
    );
    const formSubscriberIds = new Set(formSubscribers.map((s) => s.id));
    assert.equal(formSubscriberIds.has(100), true, "pós-fix: o vinculado-mas-inactive aparece no set");

    const orphans = findKitDoiOrphans(inactiveSubscribers, formSubscriberIds, NOW);
    const orphanIds = orphans.map((o) => o.id);
    // Só o órfão de verdade (999) — o falso positivo (100) sumiu.
    assert.deepEqual(orphanIds, [999]);
  });
});

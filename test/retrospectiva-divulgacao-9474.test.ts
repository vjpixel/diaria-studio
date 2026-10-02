/**
 * test/retrospectiva-divulgacao-9474.test.ts (#9474)
 *
 * Regressão do loop de divulgação da Retrospectiva do Mês em
 * `/diaria-mensal-apoiadores`: state por canal, `--skip`, URL/mês do ciclo,
 * regra de CTA dos posts públicos (nunca a URL paywalled), projeção do canal
 * email a partir do state do publisher Kit, agenda com data-base explícita,
 * marcação de canal e veredito da verificação da página.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RETROSPECTIVA_PUBLIC_CTA,
  contentMonthLabel,
  deriveEmailChannelState,
  parseRetrospectivaSkip,
  publicPostCtaProblems,
  readRetrospectivaDivulgacaoState,
  retrospectivaDivulgacaoStatePath,
  retrospectivaUrl,
  writeRetrospectivaDivulgacaoState,
} from "../scripts/lib/mensal/retrospectiva-divulgacao.ts";
import { decideChannelAction, withChannelState, buildDoneChannelState } from "../scripts/lib/artigo-especial-state.ts";
import { normalizeBaseDate } from "../scripts/lib/artigo-especial-schedule.ts";
import { resolveRetrospectivaScheduledAts } from "../scripts/lib/mensal/retrospectiva-schedule.ts";
import { runMarkRetrospectivaChannel, runSyncEmailChannel } from "../scripts/mark-retrospectiva-channel.ts";
import { classifyPublicBody, decidePageVerdict, verifyRetrospectivaPage } from "../scripts/verify-retrospectiva-page.ts";
import { checkRetrospectivaDivulgacaoTexts } from "../scripts/check-retrospectiva-divulgacao.ts";
import type { ApoiadoresState } from "../scripts/lib/mensal/monthly-apoiadores-state.ts";

process.env.DIARIA_QUIET_SCHEDULE_LOG = "1";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "retro-9474-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("state por canal (divulgacao-published.json)", () => {
  it("path fica em _internal/ do ciclo", () => {
    assert.match(retrospectivaDivulgacaoStatePath(tmp).replace(/\\/g, "/"), /_internal\/divulgacao-published\.json$/);
  });

  it("ausente → vazio; round-trip preserva os 6 canais", () => {
    const p = retrospectivaDivulgacaoStatePath(tmp);
    assert.deepEqual(readRetrospectivaDivulgacaoState(p, "2609-10"), { cycle: "2609-10", channels: {} });
    let s = readRetrospectivaDivulgacaoState(p, "2609-10");
    for (const ch of ["pagina", "apoiase", "linkedin_pagina", "linkedin_perfil", "box", "email"] as const) {
      s = withChannelState(s, ch, buildDoneChannelState("2026-10-02T00:00:00Z", null));
    }
    writeRetrospectivaDivulgacaoState(p, s);
    assert.equal(Object.keys(readRetrospectivaDivulgacaoState(p, "2609-10").channels).length, 6);
  });

  it("arquivo corrompido é copiado pra .corrupt-* antes de virar vazio (o próximo write não apaga a evidência)", () => {
    const p = retrospectivaDivulgacaoStatePath(tmp);
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    writeFileSync(p, '{"cycle":"2609-10","channels":{"apoiase":{"status":"done","url":"https://apoia.se/x"');
    assert.deepEqual(readRetrospectivaDivulgacaoState(p, "2609-10").channels, {});
    const backups = readdirSync(join(tmp, "_internal")).filter((f) => f.includes(".corrupt-"));
    assert.equal(backups.length, 1);
    assert.match(readFileSync(join(tmp, "_internal", backups[0]), "utf8"), /apoia\.se\/x/);
  });

  it("corrompido / de outro ciclo / status inválido → fail-soft (vazio ou canal descartado)", () => {
    const p = retrospectivaDivulgacaoStatePath(tmp);
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    writeFileSync(p, "{nao json");
    assert.deepEqual(readRetrospectivaDivulgacaoState(p, "2609-10").channels, {});
    writeFileSync(p, JSON.stringify({ cycle: "2608-09", channels: { box: { status: "done" } } }));
    assert.deepEqual(readRetrospectivaDivulgacaoState(p, "2609-10").channels, {});
    writeFileSync(p, JSON.stringify({ cycle: "2609-10", channels: { box: { status: "feito" }, email: { status: "done" } } }));
    const st = readRetrospectivaDivulgacaoState(p, "2609-10");
    assert.equal(st.channels.box, undefined);
    assert.equal(st.channels.email?.status, "done");
  });

  it("decideChannelAction (genérico) — done pula sem --force, failed sempre retenta", () => {
    const s = withChannelState(readRetrospectivaDivulgacaoState("x", "2609-10"), "box", buildDoneChannelState("t", null));
    assert.equal(decideChannelAction(s, "box", false).action, "skip");
    assert.equal(decideChannelAction(s, "box", true).action, "run");
    assert.equal(decideChannelAction(s, "pagina", false).action, "run");
  });
});

describe("parseRetrospectivaSkip", () => {
  it("linkedin cobre página e perfil; vazio = nada", () => {
    assert.deepEqual([...parseRetrospectivaSkip(undefined)], []);
    const s = parseRetrospectivaSkip("pagina, linkedin,email");
    assert.deepEqual([...s].sort(), ["email", "linkedin_pagina", "linkedin_perfil", "pagina"]);
  });
  it("token desconhecido lança (typo nunca vira 'não pulou nada')", () => {
    assert.throws(() => parseRetrospectivaSkip("apoiase,linkdin"), /linkdin/);
  });
});

describe("URL e mês do ciclo (mês de CONTEÚDO, não de envio)", () => {
  it("2609-10 → retrospectiva.diar.ia.br/2609 e Setembro", () => {
    assert.equal(retrospectivaUrl("2609-10"), "https://retrospectiva.diar.ia.br/2609");
    assert.equal(contentMonthLabel("2609-10"), "Setembro");
    assert.equal(contentMonthLabel("2612-01"), "Dezembro");
  });
  it("ciclo malformado lança", () => {
    assert.throws(() => retrospectivaUrl("2609"));
  });
});

describe("CTA dos posts públicos — nunca a URL paywalled", () => {
  const ok = `A Retrospectiva de setembro olha o mês por três ângulos.\n\n${RETROSPECTIVA_PUBLIC_CTA}`;
  it("texto com a linha literal e sem URL direta passa", () => {
    assert.deepEqual(publicPostCtaProblems(ok), []);
  });
  it("URL direta (host canônico ou legado) reprova, mesmo com o CTA", () => {
    assert.equal(publicPostCtaProblems(`${ok}\nhttps://retrospectiva.diar.ia.br/2609`).length, 1);
    assert.equal(publicPostCtaProblems(`${ok}\nartigo.diar.ia.br/2609-10`).length, 1);
  });
  it("sem a linha literal de CTA reprova", () => {
    assert.match(publicPostCtaProblems("Leia em apoia.se/diaria").join(), /linha literal/);
  });
  it("o CTA literal em si nunca contém a URL paywalled", () => {
    assert.ok(!/retrospectiva\.diar\.ia\.br/.test(RETROSPECTIVA_PUBLIC_CTA));
    assert.match(RETROSPECTIVA_PUBLIC_CTA, /apoia\.se\/diaria$/);
  });
});

function apoiadores(over: Partial<ApoiadoresState>): ApoiadoresState {
  return {
    cycle: "2609-10",
    status: "draft_prepared",
    preparedAt: "2026-10-02T10:00:00Z",
    sentAt: null,
    htmlPath: "x.html",
    subject: "s",
    segments: [],
    brevoCampaignId: null,
    kitBroadcastId: null,
    kitAudienceVerified: null,
    ...over,
  } as ApoiadoresState;
}

describe("deriveEmailChannelState — projeção do state do publisher Kit", () => {
  it("sem state ou sem broadcast → null (pendente)", () => {
    assert.equal(deriveEmailChannelState(null), null);
    assert.equal(deriveEmailChannelState(apoiadores({})), null);
  });
  it("broadcast com audiência confirmada → done", () => {
    assert.equal(deriveEmailChannelState(apoiadores({ kitBroadcastId: 1, kitAudienceVerified: true }))?.status, "done");
  });
  it("sent (agendado / --mark-sent) → done", () => {
    assert.equal(deriveEmailChannelState(apoiadores({ status: "sent", sentAt: "2026-10-03T09:00:00Z", kitBroadcastId: 1, kitAudienceVerified: true }))?.status, "done");
  });
  it("audiência não confirmada (null) → failed, nunca 'ok'", () => {
    const r = deriveEmailChannelState(apoiadores({ kitBroadcastId: 7, kitAudienceVerified: null }));
    assert.equal(r?.status, "failed");
    assert.match(r!.reason!, /não foi confirmada/);
  });
  it("AGENDADO (sent via --schedule) com audiência não confirmada → failed, nunca done (#6126)", () => {
    const r = deriveEmailChannelState(apoiadores({ status: "sent", sentAt: "2026-10-03T09:00:00Z", kitBroadcastId: 7, kitAudienceVerified: null }));
    assert.equal(r?.status, "failed");
    assert.match(r!.reason!, /AGENDADO/);
  });
  it("state legado sem a chave kitBroadcastId: draft → null; --mark-sent → done", () => {
    const legacy = apoiadores({}) as unknown as Record<string, unknown>;
    delete legacy.kitBroadcastId;
    assert.equal(deriveEmailChannelState(legacy as unknown as ApoiadoresState), null);
    assert.equal(deriveEmailChannelState({ ...(legacy as unknown as ApoiadoresState), status: "sent", sentAt: "2026-08-04T10:00:00Z" })?.status, "done");
  });
  it("audiência divergente → failed MESMO marcado sent (incidente)", () => {
    const r = deriveEmailChannelState(apoiadores({ status: "sent", kitBroadcastId: 7, kitAudienceVerified: false }));
    assert.equal(r?.status, "failed");
    assert.match(r!.reason!, /DIVERGIU/);
  });
});

describe("agenda (#9474) — D+1 09:00 / D+2 09:30 relativos à data do ENVIO", () => {
  const CONFIG = { publishing: { social: { fallback_schedule: { d3_time: "17:30", day_offset: 0 }, timezone: "America/Sao_Paulo" } } };
  const now = Date.parse("2026-10-01T10:00:00-03:00");

  it("baseDate explícita (1º sábado 03/10) ancora a agenda, não o 'hoje'", () => {
    const r = resolveRetrospectivaScheduledAts(CONFIG, { baseDate: "2026-10-03", now });
    assert.equal(r.pagina, "2026-10-04T09:00:00-03:00");
    assert.equal(r.perfil, "2026-10-05T09:30:00-03:00");
  });
  it("AAMMDD também é aceito e equivale ao ISO", () => {
    assert.deepEqual(resolveRetrospectivaScheduledAts(CONFIG, { baseDate: "261003", now }), resolveRetrospectivaScheduledAts(CONFIG, { baseDate: "2026-10-03", now }));
  });
  it("sem baseDate: hoje (mesmo default do Artigo Especial)", () => {
    const r = resolveRetrospectivaScheduledAts(CONFIG, { now });
    assert.equal(r.pagina, "2026-10-02T09:00:00-03:00");
  });
  it("--at explícito vale pros dois e é validado (passado lança)", () => {
    const r = resolveRetrospectivaScheduledAts(CONFIG, { at: "2026-10-10T08:00:00-03:00", now });
    assert.equal(r.pagina, r.perfil);
    assert.throws(() => resolveRetrospectivaScheduledAts(CONFIG, { at: "2026-09-01T08:00:00-03:00", now }), /passado/);
  });
  it("baseDate no passado LANÇA (nunca vira post daqui a 15 min pelo shift de slot-no-passado)", () => {
    const later = Date.parse("2026-10-10T10:00:00-03:00");
    assert.throws(() => resolveRetrospectivaScheduledAts(CONFIG, { baseDate: "2026-10-03", now: later }), /já passaram/);
    // perfil (D+2 09:30) já passou mesmo com a página no futuro? também lança.
    const between = Date.parse("2026-10-05T10:00:00-03:00");
    assert.throws(() => resolveRetrospectivaScheduledAts(CONFIG, { baseDate: "2026-10-03", now: between }), /pagina=.*perfil=|já passaram/);
  });
  it("normalizeBaseDate rejeita formato e data inexistente", () => {
    assert.equal(normalizeBaseDate("2026-10-03"), "261003");
    assert.throws(() => normalizeBaseDate("03/10/2026"), /inválida/);
    assert.throws(() => normalizeBaseDate("2026-02-30"), /calendário/);
  });
});

describe("mark-retrospectiva-channel", () => {
  it("grava done/failed; failed sem reason lança", () => {
    runMarkRetrospectivaChannel({ cycle: "2609-10", cycleDir: tmp, channel: "apoiase", status: "done", url: "https://apoia.se/diaria/contents/view/x" });
    const s = readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10");
    assert.equal(s.channels.apoiase?.url, "https://apoia.se/diaria/contents/view/x");
    assert.throws(() => runMarkRetrospectivaChannel({ cycle: "2609-10", cycleDir: tmp, channel: "linkedin_perfil", status: "failed" }), /--reason/);
  });

  it("--sync-email preserva o done marcado à mão quando a releitura só diz 'não confirmável'; divergência sobrescreve", () => {
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    const apPath = join(tmp, "_internal", "beehiiv-apoiadores-state.json");
    writeFileSync(apPath, JSON.stringify(apoiadores({ kitBroadcastId: 5, kitAudienceVerified: null })));
    assert.equal(runSyncEmailChannel("2609-10", tmp).action, "written");
    runMarkRetrospectivaChannel({ cycle: "2609-10", cycleDir: tmp, channel: "email", status: "done" });
    assert.deepEqual(runSyncEmailChannel("2609-10", tmp), { action: "kept-manual-done" });
    assert.equal(readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels.email?.status, "done");
    writeFileSync(apPath, JSON.stringify(apoiadores({ kitBroadcastId: 5, kitAudienceVerified: false })));
    assert.equal(runSyncEmailChannel("2609-10", tmp).action, "written");
    assert.equal(readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels.email?.status, "failed");
  });

  it("--sync-email lê beehiiv-apoiadores-state.json e projeta no canal email (sem tocar o state do publisher)", () => {
    assert.deepEqual(runSyncEmailChannel("2609-10", tmp), { action: "nothing" });
    mkdirSync(join(tmp, "_internal"), { recursive: true });
    const apPath = join(tmp, "_internal", "beehiiv-apoiadores-state.json");
    const raw = JSON.stringify(apoiadores({ kitBroadcastId: 99, kitAudienceVerified: true }));
    writeFileSync(apPath, raw);
    const r = runSyncEmailChannel("2609-10", tmp);
    assert.equal(r.action, "written");
    assert.equal(readRetrospectivaDivulgacaoState(retrospectivaDivulgacaoStatePath(tmp), "2609-10").channels.email?.status, "done");
    assert.equal(readFileSync(apPath, "utf8"), raw, "state do publisher Kit não pode ser reescrito");
  });
});

describe("verify-retrospectiva-page — 200 sozinho não prova publicação", () => {
  const TEASER = '<html><body>trecho<div id="retrospectiva-paywall">x</div></body></html>';
  const SECO = "<html><body><h1>Este artigo é exclusivo para apoiadores</h1></body></html>";

  it("classifyPublicBody distingue trecho de paywall seco", () => {
    assert.equal(classifyPublicBody(TEASER), "teaser");
    assert.equal(classifyPublicBody(SECO), "paywall_seco");
  });

  it("matriz do veredito", () => {
    assert.equal(decidePageVerdict({ httpStatus: 200, publicKind: "teaser", kvArticle: true }).verdict, "live");
    assert.equal(decidePageVerdict({ httpStatus: 200, publicKind: "paywall_seco", kvArticle: true }).warnings.length, 1);
    assert.equal(decidePageVerdict({ httpStatus: 200, publicKind: "teaser", kvArticle: false }).verdict, "not_live");
    assert.equal(decidePageVerdict({ httpStatus: 200, publicKind: "teaser", kvArticle: null }).verdict, "live_unconfirmed");
    assert.equal(decidePageVerdict({ httpStatus: 200, publicKind: "paywall_seco", kvArticle: null }).verdict, "not_live");
    assert.equal(decidePageVerdict({ httpStatus: 405, publicKind: null, kvArticle: true }).verdict, "not_live");
    assert.equal(decidePageVerdict({ httpStatus: null, publicKind: null, kvArticle: null }).verdict, "not_live");
    // KV TENTADO com erro nunca vira live_unconfirmed (o --accept-teaser não pode aceitar 403/5xx)
    assert.equal(decidePageVerdict({ httpStatus: 200, publicKind: "teaser", kvArticle: null, kvError: "403" }).verdict, "not_live");
    // 200 com corpo ilegível não é "erro de rede"
    assert.match(decidePageVerdict({ httpStatus: 200, publicKind: null, kvArticle: true, fetchError: "aborted" }).reason!, /corpo não pôde ser lido.*aborted/);
  });

  it("faz GET (nunca HEAD — o Worker devolve 405) na URL do mês de conteúdo e lê article:{AAMM}", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method });
      return new Response(TEASER, { status: 200 });
    }) as unknown as typeof fetch;
    const keys: string[] = [];
    const v = await verifyRetrospectivaPage("2609-10", {
      fetchImpl,
      readKv: async (k) => {
        keys.push(k);
        return "<html>completo</html>";
      },
    });
    assert.deepEqual(calls, [{ url: "https://retrospectiva.diar.ia.br/2609", method: "GET" }]);
    assert.deepEqual(keys, ["article:2609"]);
    assert.equal(v.verdict, "live");
  });

  it("erro de rede e erro de KV nunca lançam — viram not_live / KV não consultado", async () => {
    const boom = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const v = await verifyRetrospectivaPage("2609-10", { fetchImpl: boom, readKv: null });
    assert.equal(v.verdict, "not_live");
    const ok = (async () => new Response(TEASER, { status: 200 })) as unknown as typeof fetch;
    const v2 = await verifyRetrospectivaPage("2609-10", {
      fetchImpl: ok,
      readKv: async () => {
        throw new Error("403");
      },
    });
    assert.equal(v2.verdict, "not_live");
    assert.match(v2.reason!, /403/);
    assert.match(v.reason!, /ECONNRESET/);
  });
});

describe("check-retrospectiva-divulgacao — CTA nos DOIS posts públicos (o do perfil é colado à mão)", () => {
  function write(file: string, text: string) {
    mkdirSync(join(tmp, "divulgacao"), { recursive: true });
    writeFileSync(join(tmp, "divulgacao", file), text);
  }
  const OK = `Chamada.\n\n${RETROSPECTIVA_PUBLIC_CTA}\n`;

  it("perfil com a URL paywalled reprova, mesmo com a página ok", () => {
    write("linkedin-pagina.md", OK);
    write("linkedin-perfil.md", `${OK}https://retrospectiva.diar.ia.br/2609\n`);
    const r = checkRetrospectivaDivulgacaoTexts(tmp, undefined);
    assert.equal(r.length, 2);
    assert.equal(r[0].problems.length, 0);
    assert.match(r[1].problems.join(), /paywalled/);
  });
  it("arquivo ausente reprova; --skip linkedin não checa nada; token inválido lança", () => {
    write("linkedin-pagina.md", OK);
    assert.match(checkRetrospectivaDivulgacaoTexts(tmp, undefined)[1].problems.join(), /ausente/);
    assert.deepEqual(checkRetrospectivaDivulgacaoTexts(tmp, "linkedin"), []);
    assert.throws(() => checkRetrospectivaDivulgacaoTexts(tmp, "linkdin"), /linkdin/);
  });
  it("CTA tolera CRLF e espaços em volta; host sem esquema e maiúsculas também reprovam", () => {
    assert.deepEqual(publicPostCtaProblems(`Texto.\r\n\r\n  ${RETROSPECTIVA_PUBLIC_CTA}  \r\n`), []);
    assert.equal(publicPostCtaProblems(`${OK}veja RETROSPECTIVA.DIAR.IA.BR/2609`).length, 1);
    assert.equal(publicPostCtaProblems(`${OK}outra.diar.ia.br/x`).length, 0);
  });
});

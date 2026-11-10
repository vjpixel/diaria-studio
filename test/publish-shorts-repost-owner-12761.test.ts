/**
 * test/publish-shorts-repost-owner-12761.test.ts (#12761)
 *
 * Achado da edição 261111: com o `linkedin_profile` entregue ao timer do 300
 * (`skip_delegated`), o `linkedin_page_repost` saía `skip_invalid` e o
 * `owners[]` não trazia dono nenhum para ele — o repost dependia de a sessão
 * lembrar de rodar o plano de novo depois do horário do perfil, contra a regra
 * do #11550 ("todo destino tem dono automático"). Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LINKEDIN_TIMER_DETAIL,
  PROFILE_REPOST_CHAIN_MAX_MS,
  assignShortsDestinationOwners,
  isProfileRepostChainStale,
  planShortsPublish,
  type ShortsPlanItem,
} from "../scripts/publish-shorts.ts";
import { LINKEDIN_REPOST_MIN_DELAY_MINUTES } from "../scripts/lib/diaria/short-video.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const SCHEDULE = { rotation_times: ["12:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };
const REVIEWED = `DESTAQUE 1 | 🔐 SEGURANÇA

[Você já viu IA mentir. Já viu roubar?](https://alignment.openai.com/x)

Um modelo da OpenAI gastou o saldo de terceiros. O caso foi descoberto depois.

Por que isso importa: porque sim.
`;
const li = {
  facebook_pages: [],
  instagram: false,
  linkedin_profile: true,
  linkedin_page_repost: true,
  x: false,
  threads_profile: false,
  schedule: SCHEDULE,
};
const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
const base = {
  aammdd: "261022",
  reviewedMd: REVIEWED,
  pages: [page("diaria")],
  instagramReady: false,
  published: { aammdd: "261022", entries: [] },
  video: { path: "v.mp4", exists: true, sizeBytes: 10 },
  editionUrl: "https://diar.ia.br/p/voce-ja-viu-ia-mentir-ja-viu-roubar",
  threadsPersonal: { ready: true } as const,
  linkedinPersonal: { ready: true } as const,
  publicVideo: { ready: true } as const,
};
const BEFORE = new Date("2026-10-22T03:00:00Z"); // 00:00 BRT, antes do vertical (12:00)
const LATE = new Date("2026-10-22T20:00:00Z"); // 17:00 BRT, 5 h depois
const PROFILE_AT = Date.parse("2026-10-22T15:00:00Z"); // 12:00 BRT, horário do vertical
const ownerOf = (p: ReturnType<typeof planShortsPublish>, d: string) => p.owners.find((o) => o.destination === d);
const itemOf = (p: ReturnType<typeof planShortsPublish>, d: string) => p.items.find((i) => i.destination === d) as any;
const REPOST_CMD = "npx tsx scripts/publish-shorts.ts 261022 --only linkedin_profile,linkedin_page_repost --publish --confirm-publish 261022";

describe("#12761 repost da página com o perfil pelo timer do 300", () => {
  const config = { publishing: { shorts: { ...li, linkedin_profile_via_timer: true } } };

  it("cenário da issue: perfil skip_delegated, repost skip_invalid COM dono agendado depois do perfil", () => {
    const p = planShortsPublish({ ...base, config, now: BEFORE });
    assert.equal(itemOf(p, "linkedin_profile").action, "skip_delegated");
    assert.equal(itemOf(p, "linkedin_profile").detail, LINKEDIN_TIMER_DETAIL);
    const repost = itemOf(p, "linkedin_page_repost");
    assert.equal(repost.action, "skip_invalid");
    assert.ok(repost.retryAt, "repost bloqueado pelo perfil pendente leva o horário da re-execução");
    assert.ok(
      Date.parse(repost.retryAt) >= PROFILE_AT + LINKEDIN_REPOST_MIN_DELAY_MINUTES * 60_000,
      `retryAt ${repost.retryAt} precisa ficar >= 30 min depois do perfil`,
    );
    const o = ownerOf(p, "linkedin_page_repost");
    assert.ok(o, "o repost tem dono em owners[] (#11550)");
    assert.equal(o!.by, "agent-scheduled-task");
    assert.equal(o!.at, repost.retryAt);
    assert.equal(o!.command, REPOST_CMD);
    // Os donos dos outros destinos seguem como antes.
    assert.equal(ownerOf(p, "linkedin_profile")?.task, "Diaria-Shorts-LinkedIn-Profile");
  });

  it("o motivo do bloqueio continua no detail (o plano não esconde que o repost espera o perfil)", () => {
    const p = planShortsPublish({ ...base, config, now: BEFORE });
    assert.match(itemOf(p, "linkedin_page_repost").detail, /repost só depois que o vídeo do perfil sair/);
  });
});

describe("#12761 perfil em skip_late (o agente publica com --now)", () => {
  it("o repost ganha dono para depois do --now do perfil", () => {
    const p = planShortsPublish({ ...base, config: { publishing: { shorts: li } }, now: LATE });
    assert.equal(itemOf(p, "linkedin_profile").action, "skip_late");
    const repost = itemOf(p, "linkedin_page_repost");
    assert.equal(repost.action, "skip_invalid");
    assert.ok(Date.parse(repost.retryAt) >= LATE.getTime() + LINKEDIN_REPOST_MIN_DELAY_MINUTES * 60_000);
    const o = ownerOf(p, "linkedin_page_repost")!;
    assert.equal(o.by, "agent-scheduled-task");
    assert.equal(o.command, REPOST_CMD);
  });
});

describe("#12761 bloqueios sem saída automática continuam sem dono", () => {
  it("perfil em send_unknown: repost espera o editor conferir, sem retryAt nem dono", () => {
    const published = {
      aammdd: "261022",
      entries: [{ destination: "linkedin_profile", status: "send_unknown", id: "x", url: null, at: "2026-10-22T15:00:00Z", scheduled_at: null }],
    };
    const p = planShortsPublish({ ...base, config: { publishing: { shorts: li } }, published: published as any, now: BEFORE });
    const repost = itemOf(p, "linkedin_page_repost");
    assert.equal(repost.action, "skip_invalid");
    assert.equal(repost.retryAt, undefined);
    assert.equal(ownerOf(p, "linkedin_page_repost"), undefined);
  });

  it("perfil sem credencial: sem retryAt nem dono", () => {
    const p = planShortsPublish({
      ...base,
      config: { publishing: { shorts: { ...li, linkedin_profile_via_timer: true } } },
      linkedinPersonal: { ready: false, reason: "sem token" },
      now: BEFORE,
    });
    const repost = itemOf(p, "linkedin_page_repost");
    assert.equal(repost.action, "skip_invalid");
    assert.equal(repost.retryAt, undefined);
    assert.equal(ownerOf(p, "linkedin_page_repost"), undefined);
  });
});

describe("#12761 assignShortsDestinationOwners", () => {
  const item = (retryAt: string): ShortsPlanItem => ({ destination: "linkedin_page_repost", mode: "guided", action: "skip_invalid", detail: "d", retryAt });

  it("retryAt no futuro: task agendada one-shot", () => {
    const [o] = assignShortsDestinationOwners([item("2026-10-22T15:30:00Z")], { aammdd: "261022", now: BEFORE, instagramViaTimer: false });
    assert.deepEqual({ by: o.by, at: o.at, command: o.command }, { by: "agent-scheduled-task", at: "2026-10-22T15:30:00Z", command: REPOST_CMD });
  });

  it("retryAt já passou: o agente re-executa nesta rodada", () => {
    const [o] = assignShortsDestinationOwners([item("2026-10-22T15:30:00Z")], { aammdd: "261022", now: LATE, instagramViaTimer: false });
    assert.equal(o.by, "agent");
    assert.equal(o.command, REPOST_CMD);
  });

  it("skip_invalid sem retryAt (ou de outro destino) segue sem dono", () => {
    const owners = assignShortsDestinationOwners(
      [
        { destination: "linkedin_page_repost", mode: "guided", action: "skip_invalid", detail: "d" },
        { destination: "x", mode: "guided", action: "skip_invalid", detail: "d", retryAt: "2026-10-22T15:30:00Z" },
      ],
      { aammdd: "261022", now: BEFORE, instagramViaTimer: false },
    );
    assert.deepEqual(owners, []);
  });
});

describe("#12761 (review) teto da cadeia de re-agendamento do repost", () => {
  // Perfil planejado 12:00 BRT; 13 h depois passa do teto de 12 h.
  const STALE = new Date(PROFILE_AT + PROFILE_REPOST_CHAIN_MAX_MS + 60 * 60_000);

  it("isProfileRepostChainStale: só acima do teto, contado do horário planejado do perfil", () => {
    const at = new Date(PROFILE_AT).toISOString();
    assert.equal(isProfileRepostChainStale(at, new Date(PROFILE_AT + PROFILE_REPOST_CHAIN_MAX_MS)), false);
    assert.equal(isProfileRepostChainStale(at, new Date(PROFILE_AT + PROFILE_REPOST_CHAIN_MAX_MS + 1)), true);
    assert.equal(isProfileRepostChainStale("lixo", STALE), false);
  });

  it("perfil skip_delegated (timer do 300 falhou) passado o teto: repost sem retryAt nem dono, plano pede o editor", () => {
    const config = { publishing: { shorts: { ...li, linkedin_profile_via_timer: true } } };
    const p = planShortsPublish({ ...base, config, now: STALE });
    assert.equal(itemOf(p, "linkedin_profile").action, "skip_delegated");
    const repost = itemOf(p, "linkedin_page_repost");
    assert.equal(repost.action, "skip_invalid");
    assert.equal(repost.retryAt, undefined, "a cadeia termina: sem horário de re-execução");
    assert.equal(ownerOf(p, "linkedin_page_repost"), undefined);
    assert.match(repost.detail, /falta intervenção do editor/);
  });

  it("perfil skip_late passado o teto: a re-execução não reagenda o repost de novo", () => {
    const p = planShortsPublish({ ...base, config: { publishing: { shorts: li } }, now: STALE });
    assert.equal(itemOf(p, "linkedin_profile").action, "skip_late");
    const repost = itemOf(p, "linkedin_page_repost");
    assert.equal(repost.retryAt, undefined);
    assert.equal(ownerOf(p, "linkedin_page_repost"), undefined);
    assert.match(repost.detail, /falta intervenção do editor/);
  });
});

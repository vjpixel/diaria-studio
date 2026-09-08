/**
 * test/monthly-poll-brand-contract-7633.test.ts (#7633)
 *
 * Trava mecânica do contrato entre os perfis de UTM da MENSAL
 * (`scripts/lib/mensal/*-render.ts`) e o `BRAND_INFO` do worker do "É IA?"
 * (`workers/poll/src/lib.ts`) — hoje só garantido por um comentário
 * copiado à mão em cada entrada de brand.
 *
 * ## O que está sendo travado, e por que um comentário não bastava
 *
 * Toda edição mensal tem `edition` em formato de CICLO (`YYMM-MM`), e
 * `vote.ts` rejeita com 400 qualquer voto em formato de ciclo cujo brand
 * tenha `leaderboardPeriod !== "year"` (guard do #4435). Ou seja: um brand
 * novo para uma audiência mensal que esqueça esse campo compila, passa no
 * `Record<Brand, ...>` (que só exige a entrada existir) e quebra **100% dos
 * votos daquele canal** em produção — foi exatamente o que motivou o #4510 e
 * a nota repetida em 3 entradas seguidas de `BRAND_INFO`.
 *
 * Esta é a 3ª vez que a mesma regra é copiada como prosa (`mensal-beehiiv` →
 * `mensal-apoiadores-brevo` → `mensal-apoiadores-kit`), e a lista tende a
 * crescer a cada troca de canal. O teste transforma a nota em verificação:
 * qualquer perfil mensal novo entra automaticamente no escopo, porque a
 * fonte é a lista de perfis, não uma cópia dela.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLARICE_UTM_PROFILE, type MonthlyUtmProfile } from "../scripts/lib/mensal/monthly-render.ts";
import { APOIADORES_BREVO_UTM_PROFILE } from "../scripts/lib/mensal/monthly-apoiadores-brevo-render.ts";
import { APOIADORES_KIT_UTM_PROFILE } from "../scripts/lib/mensal/monthly-apoiadores-kit-render.ts";
import { BRAND_INFO, parseBrandParam } from "../workers/poll/src/lib.ts";

/**
 * Todo perfil de UTM da mensal existente no repo. Um perfil novo (próxima
 * troca de canal) precisa ser adicionado aqui — e é justamente aí que o
 * autor lê o motivo, em vez de descobrir pelo 400 em produção.
 */
const MONTHLY_PROFILES: readonly { nome: string; profile: MonthlyUtmProfile }[] = [
  { nome: "CLARICE_UTM_PROFILE", profile: CLARICE_UTM_PROFILE },
  { nome: "APOIADORES_BREVO_UTM_PROFILE", profile: APOIADORES_BREVO_UTM_PROFILE },
  { nome: "APOIADORES_KIT_UTM_PROFILE", profile: APOIADORES_KIT_UTM_PROFILE },
];

describe("#7633 — contrato perfil mensal ↔ BRAND_INFO do worker poll", () => {
  for (const { nome, profile } of MONTHLY_PROFILES) {
    it(`${nome}: pollBrand existe em BRAND_INFO`, () => {
      assert.ok(
        profile.pollBrand in BRAND_INFO,
        `pollBrand "${profile.pollBrand}" não existe em BRAND_INFO — os votos deste canal iriam pro brand errado ou seriam rejeitados.`,
      );
    });

    it(`${nome}: leaderboardPeriod é "year" (edição mensal usa formato de ciclo, #4435)`, () => {
      assert.equal(
        BRAND_INFO[profile.pollBrand].leaderboardPeriod,
        "year",
        `brand "${profile.pollBrand}" com leaderboardPeriod != "year" faz vote.ts rejeitar com 400 TODO voto ` +
          "de edição mensal (formato de ciclo YYMM-MM) — 100% dos votos do canal quebrados.",
      );
    });

    it(`${nome}: parseBrandParam faz round-trip (não cai no default "diaria")`, () => {
      assert.equal(
        parseBrandParam(profile.pollBrand),
        profile.pollBrand,
        `parseBrandParam("${profile.pollBrand}") não devolveu o próprio brand — o voto cairia no leaderboard da diária.`,
      );
    });
  }

  it("cada perfil mensal tem um pollBrand distinto (leaderboards isolados por audiência)", () => {
    const brands = MONTHLY_PROFILES.map((p) => p.profile.pollBrand);
    assert.equal(new Set(brands).size, brands.length, `pollBrand duplicado entre perfis: ${brands.join(", ")}`);
  });
});

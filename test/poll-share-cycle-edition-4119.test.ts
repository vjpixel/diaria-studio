/**
 * test/poll-share-cycle-edition-4119.test.ts (#4119)
 *
 * "É IA? — token de share é AAMMDD-only, quebra 100% dos shares da Clarice"
 * (P1). O round-trip do token de compartilhamento de voto único
 * (`serializeSharePayload`/`deserializeSharePayload`, share.ts) só aceitava
 * edição no formato AAMMDD (6 dígitos) — o formato de ciclo Clarice
 * (`YYMM-MM`, ex: "2606-07", usado por `brand=clarice`) codificava/assinava
 * normalmente no ENCODE (sem validação lá), mas NUNCA decodificava de volta:
 *
 *   serialize({edition:"2606-07", correct:true}) → "2606-07.1"
 *   deserialize("2606-07.1")                     → null
 *   GET /share/2606-07.1.{sig} → 302 /jogar   (resultado compartilhado some)
 *   GET /og/2606-07.1.{sig}    → 404          (link sem thumbnail no WhatsApp)
 *
 * Cobre:
 *   - round-trip serialize/deserialize com edição de CICLO e com AAMMDD
 *     (back-compat — tokens AAMMDD já emitidos continuam decodificando).
 *   - encodeShareToken/decodeShareToken fim-a-fim com edição de ciclo.
 *   - GET /share/{token} e GET /og/{token} com edição de ciclo → 200 (não
 *     mais 302/404).
 *   - renderShareCardSvg/renderSharePageHtml NÃO vazam o slug cru ("2606-07")
 *     pro leitor quando a edição é de ciclo — formatam como "mês de ano"
 *     (mesmo racional de `formatEditionDateForBrand(edition, "clarice")"),
 *     inferido da FORMA do edition (o token não carrega brand).
 *   - integração /vote?brand=clarice com edição de ciclo: card embutido
 *     decodifica, e os links /og//share gerados a partir dele funcionam.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeShareToken,
  deserializeSharePayload,
  encodeShareToken,
  formatShareEditionDate,
  renderShareCardSvg,
  renderSharePageHtml,
  serializeSharePayload,
  type SharePayload,
} from "../workers/poll/src/share.ts";
import worker, { type Env } from "../workers/poll/src/index.ts";
import { anonEmailForToken } from "../workers/poll/src/jogar.ts";
import { makeTrackedKv } from "./_helpers/make-tracked-kv.ts";

const makeEnv = (seed: Record<string, string> = {}): Env => ({
  POLL: makeTrackedKv(seed) as unknown as Env["POLL"],
  POLL_SECRET: "poll-secret",
  ADMIN_SECRET: "admin-secret",
  ALLOWED_ORIGINS: "*",
});

describe("serializeSharePayload / deserializeSharePayload (#4119) — ciclo Clarice além de AAMMDD", () => {
  it("round-trip com edição de CICLO Clarice (YYMM-MM) — antes retornava null (bug da issue)", () => {
    for (const correct of [true, false, null] as const) {
      const payload: SharePayload = { edition: "2606-07", correct };
      const body = serializeSharePayload(payload);
      assert.deepEqual(deserializeSharePayload(body), payload, `falhou para correct=${correct}`);
    }
  });

  it("round-trip com AAMMDD legado CONTINUA funcionando idêntico (back-compat — links já circulando)", () => {
    for (const correct of [true, false, null] as const) {
      const payload: SharePayload = { edition: "260716", correct };
      const body = serializeSharePayload(payload);
      assert.deepEqual(deserializeSharePayload(body), payload, `regressão AAMMDD para correct=${correct}`);
    }
  });

  it("corpo serializado de ciclo é exatamente {edition}.{correctChar} — mesmo formato do AAMMDD, sem separador extra", () => {
    assert.equal(serializeSharePayload({ edition: "2606-07", correct: true }), "2606-07.1");
    assert.equal(serializeSharePayload({ edition: "2606-07", correct: false }), "2606-07.0");
    assert.equal(serializeSharePayload({ edition: "2606-07", correct: null }), "2606-07.-");
  });

  it("continua rejeitando forma inválida (nem AAMMDD nem ciclo) — validação estrita preservada", () => {
    assert.equal(deserializeSharePayload("26-07.1"), null, "ciclo mal-formado (ano de 2 dígitos) deve ser rejeitado");
    assert.equal(deserializeSharePayload("2606-7.1"), null, "mês de 1 dígito deve ser rejeitado");
    assert.equal(deserializeSharePayload("2606-070.1"), null, "mês de 3 dígitos deve ser rejeitado");
    assert.equal(deserializeSharePayload("lixo-invalido.1"), null);
  });
});

describe("encodeShareToken / decodeShareToken (#4119) — fim-a-fim com edição de ciclo", () => {
  it("round-trip: token de edição de ciclo decodifica de volta ao payload original", async () => {
    const payload: SharePayload = { edition: "2606-07", correct: true };
    const token = await encodeShareToken("secret-a", payload);
    const decoded = await decodeShareToken("secret-a", token);
    assert.deepEqual(decoded, payload);
  });

  it("token de ciclo adulterado (sig trocado) continua rejeitado — retorna null, não lança", async () => {
    const token = await encodeShareToken("secret-a", { edition: "2606-07", correct: true });
    const [body] = token.split(".").slice(0, -1);
    const tampered = `${body}.0000000000000000`;
    assert.equal(await decodeShareToken("secret-a", tampered), null);
  });
});

describe("GET /share/{token} e GET /og/{token} (#4119) — edição de ciclo Clarice", () => {
  it("GET /share/{token de ciclo} → 200 (antes: 302 pra /jogar, resultado compartilhado sumia)", async () => {
    const env = makeEnv();
    const token = await encodeShareToken(env.POLL_SECRET, { edition: "2606-07", correct: true });
    const res = await worker.fetch(new Request(`https://poll.test/share/${token}`), env);
    assert.equal(res.status, 200, "token de ciclo válido não pode mais cair no fallback de token inválido");
    const html = await res.text();
    assert.match(html, /property="og:image"/);
  });

  it("GET /og/{token de ciclo} → 200 image/svg+xml (antes: 404, sem thumbnail no WhatsApp)", async () => {
    const env = makeEnv();
    const token = await encodeShareToken(env.POLL_SECRET, { edition: "2606-07", correct: false });
    const res = await worker.fetch(new Request(`https://poll.test/og/${token}`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /image\/svg\+xml/);
  });
});

describe("formatShareEditionDate (#4119) — auto-descreve o formato pela FORMA do edition, sem precisar de brand", () => {
  it("edição de ciclo formata como 'mês de ANO' (mês de ENVIO, mesmo racional de formatEditionDateForBrand p/ clarice) — nunca o slug cru", () => {
    // "2606-07": conteúdo = jun/2026, envio = jul/2026 (conteúdo+1, #3464).
    const label = formatShareEditionDate("2606-07");
    assert.equal(label, "julho de 2026");
    assert.doesNotMatch(label, /2606-07/);
  });

  it("AAMMDD continua formatando como data completa (comportamento pré-#4119 preservado)", () => {
    assert.equal(formatShareEditionDate("260716"), "16 de julho de 2026");
  });
});

describe("renderShareCardSvg / renderSharePageHtml (#4119) — nunca vazam o slug cru de ciclo pro leitor", () => {
  it("renderShareCardSvg: watermark de data mostra 'mês de ano', não '2606-07'", () => {
    const svg = renderShareCardSvg({ edition: "2606-07", correct: true });
    assert.match(svg, /Edição de julho de 2026/);
    assert.doesNotMatch(svg, /2606-07/);
  });

  it("renderSharePageHtml: texto de compartilhamento cita 'mês de ano', não o slug de ciclo cru", () => {
    const html = renderSharePageHtml({ token: "t", payload: { edition: "2606-07", correct: true }, utmMedium: "link" });
    assert.match(html, /julho de 2026/);
    assert.doesNotMatch(html, /2606-07/);
  });

  it("regressão: edição AAMMDD continua mostrando data completa (dia incluso) — #4119 só ESTENDE o alfabeto aceito", () => {
    const svg = renderShareCardSvg({ edition: "260716", correct: true });
    assert.match(svg, /Edição de 16 de julho de 2026/);
  });
});

describe("integração /vote?brand=clarice com edição de ciclo (#4119) — card embutido produz link de share funcional", () => {
  it("voto em brand=clarice com edition de ciclo embute #jogar-share-card cujo token resolve /og e /share com 200", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://poll.test/vote?email=leitor@example.com&edition=2606-07&choice=A&brand=clarice"),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    const match = /data-share-url="https:\/\/eia\.diar\.ia\.br\/share\/([^"?]+)\?/.exec(html);
    assert.ok(match, "share URL com token não encontrada no HTML de resultado do voto clarice");
    const token = decodeURIComponent(match![1]);

    const decoded = await decodeShareToken(env.POLL_SECRET, token);
    assert.ok(decoded, "#4119: token de edição de ciclo embutido no voto clarice deve decodificar");
    assert.equal(decoded!.edition, "2606-07");

    const shareRes = await worker.fetch(new Request(`https://poll.test/share/${token}`), env);
    assert.equal(shareRes.status, 200, "#4119: link de share do voto clarice não pode mais cair no fallback 302");

    const ogRes = await worker.fetch(new Request(`https://poll.test/og/${token}`), env);
    assert.equal(ogRes.status, 200, "#4119: imagem OG do voto clarice não pode mais 404");
  });

  it("regressão: voto em brand=web (AAMMDD) continua funcionando igual (não afetado pela extensão do #4119)", async () => {
    const env = makeEnv();
    const anonEmail = anonEmailForToken("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    const res = await worker.fetch(
      new Request(`https://poll.test/vote?email=${encodeURIComponent(anonEmail)}&edition=260716&choice=A&brand=web`),
      env,
    );
    assert.equal(res.status, 200);
    const html = await res.text();
    const match = /data-share-url="https:\/\/eia\.diar\.ia\.br\/share\/([^"?]+)\?/.exec(html);
    assert.ok(match);
    const token = decodeURIComponent(match![1]);
    const decoded = await decodeShareToken(env.POLL_SECRET, token);
    assert.equal(decoded!.edition, "260716");
  });
});

/**
 * test/vote-url-percent-encoded-at-4692.test.ts (#4692)
 *
 * Regressão do achado da investigação #4692: os 2 envios seguidos do canal
 * `brevo_diaria` posteriores à introdução do token opaco (#4517) tiveram
 * uniqueClicks=0 em 289 entregas somadas, contra 5 cliques na campanha
 * anterior — a única diferença de código entre elas foi o `@` LITERAL
 * colado direto depois da chave `}}` do merge tag
 * (`{{ contact.POLL_TOKEN }}@vote.eia.diaria.local`), suspeito de fazer a
 * Brevo tratar o link como um e-mail cru e pular o click-tracking (ou algo
 * na mesma família — o motivo exato é opaco, mas a correlação entre as 3
 * campanhas é exata). O fix percent-encoda o `@` (`%40`); `URL.searchParams.get`
 * decodifica de volta pra `@` no Worker antes de qualquer validação, então o
 * comportamento de resolução do token não muda — só o texto bruto do link
 * deixa de parecer um e-mail pro parser da Brevo.
 *
 * Este teste é o guard MÍNIMO e direto: garante que o `@` cru nunca volta a
 * ficar colado na chave `}}` do merge tag Brevo. As regressões mais amplas
 * (URL final decodificada resolve pro mesmo token, isValidVoteEmailFormat
 * aceita o resultado) já são cobertas por test/vote-token-e2e-4512.test.ts —
 * este arquivo não duplica esse trabalho, só trava o sintoma específico do
 * #4692 num lugar nomeado pela issue, fácil de achar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderEIA, type EIA } from "../scripts/lib/newsletter-render-html.ts";

const baseEia: EIA = {
  credit: "Foto: Author / CC BY-SA 4.0.",
  imageA: "01-eia-A.jpg",
  imageB: "01-eia-B.jpg",
  edition: "260999",
};

describe('renderEIA(eia, "brevo") — @ do token percent-encoded (#4692)', () => {
  it("usa %40 em vez de @ cru entre a chave }} e o domínio do token", () => {
    const html = renderEIA(baseEia, "brevo");
    assert.match(html, /\{\{ contact\.POLL_TOKEN \}\}%40vote\.eia\.diaria\.local/);
    assert.ok(
      !html.includes("{{ contact.POLL_TOKEN }}@"),
      "#4692: @ cru colado na chave }} é o padrão correlacionado com uniqueClicks=0 nas campanhas #13/#14",
    );
  });

  it("%40 decodifica de volta pro mesmo pseudo-email que o Worker espera (URL.searchParams como no Worker real)", () => {
    const html = renderEIA(baseEia, "brevo");
    const m = html.match(/href="[^"]*[?&]email=([^&"]+)&amp;edition=/);
    assert.ok(m, "href de voto não encontrado");
    const rawParam = m![1]; // ainda com o merge tag não substituído
    // Simula a substituição de merge tag (Brevo) + o parse real do Worker
    // (URL.searchParams.get decodifica %XX automaticamente).
    const afterMergeTag = rawParam.replace("{{ contact.POLL_TOKEN }}", "abc123token");
    const decoded = new URL(`https://example.test/vote?email=${afterMergeTag}`).searchParams.get("email");
    assert.equal(decoded, "abc123token@vote.eia.diaria.local");
  });
});

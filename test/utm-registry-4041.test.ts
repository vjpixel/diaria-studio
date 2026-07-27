/**
 * test/utm-registry-4041.test.ts (#4041, regressão #633)
 *
 * O registry (`scripts/lib/shared/utm-registry.ts`) é a fonte única dos
 * valores de UTM. Duas classes de bug que este teste trava:
 *
 *   1. **Drift do espelho do Worker.** `workers/poll/src/utm-registry.ts` é
 *      uma CÓPIA (o bundle do Worker não alcança `scripts/**` — mesmo motivo
 *      de `ds-tokens.generated.ts`). Editar um lado sem o outro tem que
 *      quebrar o CI, senão a cópia vira drift silencioso.
 *   2. **Emissor com literal solto.** Cada emissor tem que DERIVAR do
 *      registry; se alguém reintroduzir um literal no call site, o valor
 *      exportado deixa de bater com a entrada correspondente do inventário.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as shared from "../scripts/lib/shared/utm-registry.ts";
import * as mirror from "../workers/poll/src/utm-registry.ts";

import {
  EIA_ARCHIVE_UTM_SOURCE,
  EIA_ARCHIVE_UTM_MEDIUM,
  EIA_ARCHIVE_UTM_CAMPAIGN,
} from "../scripts/lib/newsletter-render-html.ts";
import {
  SUBSCRIBE_UTM_SOURCE,
  SUBSCRIBE_UTM_MEDIUM,
  SUBSCRIBE_UTM_CAMPAIGN,
  QUIZ_SUBSCRIBE_UTM_SOURCE,
  QUIZ_SUBSCRIBE_UTM_MEDIUM,
  QUIZ_SUBSCRIBE_UTM_CAMPAIGN,
} from "../workers/poll/src/jogar.ts";
import {
  EMAIL_ARCHIVE_UTM_SOURCE,
  EMAIL_ARCHIVE_UTM_MEDIUM,
  EMAIL_ARCHIVE_UTM_CAMPAIGN,
} from "../workers/poll/src/lib.ts";
import {
  INLINE_SUBSCRIBE_UTM_MEDIUM,
  INLINE_SUBSCRIBE_UTM_CAMPAIGN,
  resolveSubscribeUtm,
} from "../workers/poll/src/subscribe.ts";
import {
  EMBED_UTM_SOURCE,
  EMBED_UTM_MEDIUM,
  EMBED_DEFAULT_PARTNER,
} from "../workers/poll/src/embed.ts";

/** Chaves de VALOR que os dois módulos precisam declarar identicamente. */
const MIRRORED = [
  "EIA_STANDALONE_SOURCE",
  "EIA_ARCHIVE_UTM",
  "JOGAR_POSVOTO_UTM",
  "QUIZ_POSVOTO_UTM",
  "JOGAR_INLINE_UTM",
  "EMBED_UTM",
  "SHARE_UTM_CAMPAIGN",
  "QUIZ_SHARE_UTM_CAMPAIGN",
  "LIVROS_INLINE_UTM",
] as const;

describe("#4041 — espelho do registry dentro do Worker não pode driftar", () => {
  for (const key of MIRRORED) {
    it(`${key} é idêntico entre shared/ e workers/poll/src/`, () => {
      assert.deepEqual(
        (mirror as Record<string, unknown>)[key],
        (shared as Record<string, unknown>)[key],
        `${key} divergiu — edite os DOIS arquivos (scripts/lib/shared/utm-registry.ts e workers/poll/src/utm-registry.ts).`,
      );
    });
  }

  it("o espelho não exporta nada que o shared não tenha (cópia só de valores)", () => {
    const extra = Object.keys(mirror).filter((k) => !(k in shared));
    assert.deepEqual(extra, [], `espelho tem export órfão: ${extra.join(", ")}`);
  });
});

describe("#4041 — emissores derivam do registry (sem literal solto no call site)", () => {
  it("newsletter-render-html (arquivo É IA?, e-mail diário)", () => {
    assert.equal(EIA_ARCHIVE_UTM_SOURCE, shared.EIA_ARCHIVE_UTM.source);
    assert.equal(EIA_ARCHIVE_UTM_MEDIUM, shared.EIA_ARCHIVE_UTM.medium);
    assert.equal(EIA_ARCHIVE_UTM_CAMPAIGN, shared.EIA_ARCHIVE_UTM.campaign);
  });

  it("workers/poll/lib.ts (duplicata deliberada do #3524) usa o MESMO triplo", () => {
    assert.equal(EMAIL_ARCHIVE_UTM_SOURCE, EIA_ARCHIVE_UTM_SOURCE);
    assert.equal(EMAIL_ARCHIVE_UTM_MEDIUM, EIA_ARCHIVE_UTM_MEDIUM);
    assert.equal(EMAIL_ARCHIVE_UTM_CAMPAIGN, EIA_ARCHIVE_UTM_CAMPAIGN);
  });

  it("jogar.ts — CTA pós-voto e quiz", () => {
    assert.equal(SUBSCRIBE_UTM_SOURCE, shared.JOGAR_POSVOTO_UTM.source);
    assert.equal(SUBSCRIBE_UTM_MEDIUM, shared.JOGAR_POSVOTO_UTM.medium);
    assert.equal(SUBSCRIBE_UTM_CAMPAIGN, shared.JOGAR_POSVOTO_UTM.campaign);
    assert.equal(QUIZ_SUBSCRIBE_UTM_SOURCE, shared.QUIZ_POSVOTO_UTM.source);
    assert.equal(QUIZ_SUBSCRIBE_UTM_MEDIUM, shared.QUIZ_POSVOTO_UTM.medium);
    assert.equal(QUIZ_SUBSCRIBE_UTM_CAMPAIGN, shared.QUIZ_POSVOTO_UTM.campaign);
  });

  it("subscribe.ts — cadastro inline do jogo e das páginas de livros", () => {
    assert.equal(INLINE_SUBSCRIBE_UTM_MEDIUM, shared.JOGAR_INLINE_UTM.medium);
    assert.equal(INLINE_SUBSCRIBE_UTM_CAMPAIGN, shared.JOGAR_INLINE_UTM.campaign);
    assert.deepEqual(resolveSubscribeUtm("livros-hero"), {
      source: shared.LIVROS_INLINE_UTM.source,
      medium: shared.LIVROS_INLINE_UTM.hero.medium,
      campaign: shared.LIVROS_INLINE_UTM.campaign,
    });
    assert.deepEqual(resolveSubscribeUtm("livros-footer"), {
      source: shared.LIVROS_INLINE_UTM.source,
      medium: shared.LIVROS_INLINE_UTM.footer.medium,
      campaign: shared.LIVROS_INLINE_UTM.campaign,
    });
  });

  it("embed.ts — funil do widget de parceiro", () => {
    assert.equal(EMBED_UTM_SOURCE, shared.EMBED_UTM.source);
    assert.equal(EMBED_UTM_MEDIUM, shared.EMBED_UTM.medium);
    assert.equal(EMBED_DEFAULT_PARTNER, shared.EMBED_UTM.defaultPartner);
  });
});

describe("#4041 — inventário coerente e utilizável pela página /utms", () => {
  it("todo emissor tem id único, arquivo de origem e descrição não-vazia", () => {
    const ids = shared.UTM_EMITTERS.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "id duplicado no inventário");
    for (const e of shared.UTM_EMITTERS) {
      assert.ok(e.source.length > 0, `${e.id}: source vazio`);
      assert.ok(e.campaignPattern.length > 0, `${e.id}: campaignPattern vazio`);
      assert.ok(e.originFile.includes("/"), `${e.id}: originFile não parece um path`);
      assert.ok(e.description.length > 10, `${e.id}: descrição curta demais`);
      assert.ok(["ativo", "aposentado"].includes(e.status), `${e.id}: status inválido`);
    }
  });

  it("knownUtmSources cobre os sources reais (detector de drift do /utms)", () => {
    const sources = shared.knownUtmSources();
    for (const s of ["clarice", "newsletter", "eia-standalone", "embed", "livros"]) {
      assert.ok(sources.includes(s), `faltou ${s}`);
    }
    // `sendinblue` (auto-tag do Brevo, #2975) NUNCA é emitido pelo código — é
    // exatamente o caso que a página deve sinalizar como origem não-catalogada.
    assert.ok(!sources.includes("sendinblue"));
  });

  it("campaignPatternToRegExp casa valores concretos e rejeita os de outro emissor", () => {
    const mensal = shared.campaignPatternToRegExp("clarice-{ciclo}-{posicao}");
    assert.ok(mensal.test("clarice-2606-07-cta"));
    assert.ok(mensal.test("clarice-2606-07-wordmark-radar"));
    assert.ok(!mensal.test("eia-arquivo"));

    const fixo = shared.campaignPatternToRegExp("eia-arquivo");
    assert.ok(fixo.test("eia-arquivo"));
    assert.ok(!fixo.test("eia-arquivo-2"));
  });

  it("findUtmEmitter resolve por id e devolve undefined pra id desconhecido", () => {
    assert.equal(shared.findUtmEmitter("mensal-clarice")?.source, "clarice");
    assert.equal(shared.findUtmEmitter("nao-existe"), undefined);
  });
});

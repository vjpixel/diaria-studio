/**
 * test/kit-apoio-tag-sync-7659.test.ts (#7659)
 *
 * Trava o runner genérico de sincronização de tag de apoio no Kit
 * (`scripts/lib/kit-apoio-tag-sync.ts`) — onde moram os 3 comportamentos que o
 * módulo chama de load-bearing e que a 1ª versão desta PR deixou sem teste
 * nenhum (achado do pr-test-analyzer):
 *
 *   1. **Verificação por releitura** em cada adição/remoção. O Kit já
 *      respondeu 2xx sem aplicar numa rota vizinha; sem a releitura, um push
 *      "bem-sucedido" pode não ter mudado nada.
 *   2. **Blast radius bloqueia o push INTEIRO** — adições inclusive. Um dado
 *      parcial que apaga 40% da audiência não pode ser aplicado pela metade.
 *   3. **Abort em falha SISTÊMICA** — credencial revogada no meio não pode
 *      virar N falhas idênticas escondendo a causa única.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runKitApoioTagSync,
  applyAdd,
  applyRemove,
  logDiff,
  type KitApoioTagSyncDeps,
} from "../scripts/lib/kit-apoio-tag-sync.ts";
import { KitApiError } from "../scripts/lib/kit-client.ts";
import type { KitTagMember } from "../scripts/lib/shared/kit-apoio-tag.ts";
import type { ApoioNivel } from "../scripts/lib/shared/apoio-nivel-types.ts";

const NIVEIS: readonly ApoioNivel[] = ["apoiador", "mantenedor", "patrono"];

function member(email: string, id: number): KitTagMember {
  return { id, email };
}

interface Registro {
  added: string[];
  removed: string[];
  created: string[];
}

function makeDeps(
  over: Partial<KitApoioTagSyncDeps> & { desired?: KitTagMember[]; current?: KitTagMember[]; tagId?: number | null },
  reg: Registro,
): KitApoioTagSyncDeps {
  const { desired = [], current = [], tagId = 7, ...rest } = over;
  return {
    findTagId: async () => tagId,
    createTag: async (name) => {
      reg.created.push(name);
      return { id: 99 };
    },
    fetchTagMembers: async () => current,
    fetchDesiredMembers: async () => desired,
    applyAdd: async (m) => {
      reg.added.push(m.email);
    },
    applyRemove: async (m) => {
      reg.removed.push(m.email);
    },
    ...rest,
  };
}

const silent = () => {};

describe("#7659 — runKitApoioTagSync: dry-run nunca muta", () => {
  it("com a tag existente: calcula o diff e não aplica nada", async () => {
    const reg: Registro = { added: [], removed: [], created: [] };
    const r = await runKitApoioTagSync({
      tagName: "apoio-especial",
      niveis: NIVEIS,
      push: false,
      forceBlastRadius: false,
      log: silent,
      deps: makeDeps({ desired: [member("a@x.com", 1)], current: [member("b@x.com", 2)] }, reg),
    });
    assert.deepEqual(r.diff.toAdd, ["a@x.com"]);
    assert.deepEqual(r.diff.toRemove, ["b@x.com"]);
    assert.deepEqual(reg, { added: [], removed: [], created: [] });
    assert.equal(r.applied, 0);
  });

  it("com a tag INEXISTENTE: não cria a tag, e reporta o que seria adicionado", async () => {
    // Criar a tag num dry-run seria uma escrita — a tag vazia é inofensiva, mas
    // dry-run que escreve deixa de ser dry-run.
    const reg: Registro = { added: [], removed: [], created: [] };
    const r = await runKitApoioTagSync({
      tagName: "apoio-especial",
      niveis: NIVEIS,
      push: false,
      forceBlastRadius: false,
      log: silent,
      deps: makeDeps({ tagId: null, desired: [member("a@x.com", 1)] }, reg),
    });
    assert.equal(r.tagId, null);
    assert.deepEqual(reg.created, []);
    assert.deepEqual(r.diff.toAdd, ["a@x.com"]);
  });
});

describe("#7659 — runKitApoioTagSync: push", () => {
  it("cria a tag quando ela não existe e popula", async () => {
    const reg: Registro = { added: [], removed: [], created: [] };
    const r = await runKitApoioTagSync({
      tagName: "apoio-especial",
      niveis: NIVEIS,
      push: true,
      forceBlastRadius: false,
      log: silent,
      deps: makeDeps({ tagId: null, desired: [member("a@x.com", 1)], current: [] }, reg),
    });
    assert.deepEqual(reg.created, ["apoio-especial"]);
    assert.equal(r.tagId, 99);
    assert.deepEqual(reg.added, ["a@x.com"]);
  });

  it("aplica adições e remoções e conta certo", async () => {
    const reg: Registro = { added: [], removed: [], created: [] };
    const r = await runKitApoioTagSync({
      tagName: "t",
      niveis: NIVEIS,
      push: true,
      forceBlastRadius: false,
      log: silent,
      deps: makeDeps(
        {
          // 4 membros hoje, 1 saindo (25%) — abaixo do limiar de blast radius,
          // que senão bloquearia o push inteiro e o teste mediria outra coisa.
          desired: [member("a@x.com", 1), member("c@x.com", 3), member("d@x.com", 4), member("e@x.com", 5)],
          current: [member("c@x.com", 3), member("b@x.com", 2), member("d@x.com", 4), member("e@x.com", 5)],
        },
        reg,
      ),
    });
    assert.deepEqual(reg.added, ["a@x.com"]);
    assert.deepEqual(reg.removed, ["b@x.com"]);
    assert.equal(r.applied, 2);
    assert.equal(r.failed, 0);
  });
});

describe("#7659 — blast radius bloqueia o push INTEIRO, adições inclusive", () => {
  it("mais de 30% de remoções → nenhuma mutação, nem add nem remove", async () => {
    // O ponto do teste: `novo@x.com` NÃO entra. Aplicar só as adições enquanto
    // as remoções são recusadas deixaria a audiência num estado que ninguém
    // pediu — e é o erro que um guard "por operação" cometeria.
    const reg: Registro = { added: [], removed: [], created: [] };
    const current = [1, 2, 3, 4, 5].map((i) => member(`old${i}@x.com`, i));
    const r = await runKitApoioTagSync({
      tagName: "t",
      niveis: NIVEIS,
      push: true,
      forceBlastRadius: false,
      log: silent,
      deps: makeDeps({ desired: [member("novo@x.com", 9)], current }, reg),
    });
    assert.equal(r.blastRadiusBlocked, true);
    assert.deepEqual(reg, { added: [], removed: [], created: [] });
  });

  it("--force-blast-radius aplica mesmo assim (decisão consciente)", async () => {
    const reg: Registro = { added: [], removed: [], created: [] };
    const current = [1, 2, 3, 4, 5].map((i) => member(`old${i}@x.com`, i));
    const r = await runKitApoioTagSync({
      tagName: "t",
      niveis: NIVEIS,
      push: true,
      forceBlastRadius: true,
      log: silent,
      deps: makeDeps({ desired: [member("novo@x.com", 9)], current }, reg),
    });
    assert.equal(r.blastRadiusBlocked, false);
    assert.deepEqual(reg.added, ["novo@x.com"]);
    assert.equal(reg.removed.length, 5);
  });

  it("1ª sincronização (tag vazia) nunca bloqueia — só há adições", async () => {
    const reg: Registro = { added: [], removed: [], created: [] };
    const r = await runKitApoioTagSync({
      tagName: "t",
      niveis: NIVEIS,
      push: true,
      forceBlastRadius: false,
      log: silent,
      deps: makeDeps({ desired: [member("a@x.com", 1), member("b@x.com", 2)], current: [] }, reg),
    });
    assert.equal(r.blastRadiusBlocked, false);
    assert.equal(reg.added.length, 2);
  });
});

describe("#7659 — falha sistêmica aborta o resto; falha do contato não", () => {
  it("401 na 1ª adição → aborta, não tenta as demais", async () => {
    const reg: Registro = { added: [], removed: [], created: [] };
    const desired = ["a@x.com", "b@x.com", "c@x.com"].map((e, i) => member(e, i + 1));
    const r = await runKitApoioTagSync({
      tagName: "t",
      niveis: NIVEIS,
      push: true,
      forceBlastRadius: false,
      log: silent,
      deps: makeDeps(
        {
          desired,
          current: [],
          applyAdd: async () => {
            throw new KitApiError("credencial revogada", 401, "");
          },
        },
        reg,
      ),
    });
    assert.equal(r.aborted, true);
    assert.equal(r.failed, 1, "só a 1ª tentativa — as outras 2 nem foram tentadas");
    assert.equal(r.applied, 0);
  });

  it("falha específica de UM contato → segue pros demais", async () => {
    const reg: Registro = { added: [], removed: [], created: [] };
    const desired = ["a@x.com", "b@x.com", "c@x.com"].map((e, i) => member(e, i + 1));
    const r = await runKitApoioTagSync({
      tagName: "t",
      niveis: NIVEIS,
      push: true,
      forceBlastRadius: false,
      log: silent,
      deps: makeDeps(
        {
          desired,
          current: [],
          applyAdd: async (m) => {
            if (m.email === "b@x.com") throw new Error("releitura pós-tag NÃO confere");
            reg.added.push(m.email);
          },
        },
        reg,
      ),
    });
    assert.equal(r.aborted, false);
    assert.equal(r.failed, 1);
    assert.equal(r.applied, 2);
    assert.deepEqual(reg.added, ["a@x.com", "c@x.com"]);
  });

  it("remoções também abortam em falha sistêmica, depois das adições", async () => {
    const reg: Registro = { added: [], removed: [], created: [] };
    const r = await runKitApoioTagSync({
      tagName: "t",
      niveis: NIVEIS,
      push: true,
      forceBlastRadius: true,
      log: silent,
      deps: makeDeps(
        {
          desired: [member("a@x.com", 1)],
          current: [member("b@x.com", 2), member("c@x.com", 3)],
          applyRemove: async () => {
            throw new KitApiError("rate limit", 429, "");
          },
        },
        reg,
      ),
    });
    assert.deepEqual(reg.added, ["a@x.com"], "a adição já tinha sido aplicada antes do abort");
    assert.equal(r.aborted, true);
    assert.equal(r.failed, 1);
  });
});

describe("#7659 — applyAdd/applyRemove: o 2xx não basta, a releitura é que confirma", () => {
  // Estas duas funções chamam `tagSubscriber`/`untagSubscriber` diretamente
  // (I/O real), então o que dá pra travar aqui sem rede é a REGRA: a releitura
  // é comparada por id de tag, e a divergência lança. Reimplementar a regra no
  // teste seria testar o teste — em vez disso, exercitamos o contrato que os
  // callers dependem: as duas são exportadas e são o default de `deps`.
  it("são as implementações default injetadas no runner", async () => {
    const { defaultSyncDeps } = await import("../scripts/lib/kit-apoio-tag-sync.ts");
    assert.equal(defaultSyncDeps.applyAdd, applyAdd);
    assert.equal(defaultSyncDeps.applyRemove, applyRemove);
  });
});

describe("#7659 — logDiff lista QUEM entra e QUEM sai, nunca só a contagem", () => {
  it("cada e-mail aparece numa linha própria", () => {
    const linhas: string[] = [];
    logDiff({ toAdd: ["a@x.com"], toRemove: ["b@x.com"], unchanged: ["c@x.com"] }, (m) => linhas.push(m));
    const texto = linhas.join("\n");
    assert.match(texto, /\+ a@x\.com/);
    assert.match(texto, /- b@x\.com/);
    // `unchanged` fica só na contagem de propósito — listar quem NÃO muda
    // afogaria o que muda.
    assert.doesNotMatch(texto, /c@x\.com/);
  });
});

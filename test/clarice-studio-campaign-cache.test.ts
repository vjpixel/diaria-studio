import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalFileCampaignCache } from "../scripts/lib/clarice-studio-campaign-cache.ts";

// #6720 Fatia A: cache local (arquivo por chave) que substitui `skipKvCache:
// true` no caminho ao vivo do painel Clarice do Studio. Cobre exatamente os 4
// comportamentos exigidos pela issue: (1) só imutável (sem TTL) vai a disco;
// (2) recente (com TTL) nunca é cacheado em disco; (3) invalidação por bump
// de versão do shape; (4) write-once (nunca reescreve).

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarice-campaign-cache-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createLocalFileCampaignCache", () => {
  it("grava em disco uma chave imutável (put sem expirationTtl)", async () => {
    const cache = createLocalFileCampaignCache({ dir, version: 1 });
    await cache.put("stats:123", JSON.stringify({ gs: { sent: 10 } }));

    const files = readdirSync(dir);
    assert.equal(files.length, 1, "esperava exatamente 1 arquivo persistido");
    assert.match(files[0], /^stats_123\.v1\.json$/);
  });

  it("sobrevive a um 'restart' — nova instância no mesmo dir lê o valor persistido", async () => {
    const first = createLocalFileCampaignCache({ dir, version: 1 });
    await first.put("stats:123", JSON.stringify({ gs: { sent: 10 } }));

    // Nova instância = processo novo (Map em memória zerado) — só disco resta.
    const second = createLocalFileCampaignCache({ dir, version: 1 });
    const value = await second.get("stats:123", "json");
    assert.deepEqual(value, { gs: { sent: 10 } });
  });

  it("NUNCA persiste em disco uma chave recente (put com expirationTtl)", async () => {
    const cache = createLocalFileCampaignCache({ dir, version: 1 });
    await cache.put("stats:999", JSON.stringify({ gs: { sent: 1 } }), { expirationTtl: 1800 });

    // Disponível dentro do MESMO processo (hit em memória)...
    const value = await cache.get("stats:999", "json");
    assert.deepEqual(value, { gs: { sent: 1 } });

    // ...mas nada foi escrito em disco — requisito central da Fatia A (só
    // campanha imutável, >7 dias / isImmutableCampaign, vira arquivo).
    assert.equal(existsSync(dir) ? readdirSync(dir).length : 0, 0);

    // "Restart": nova instância não vê a chave — ela nunca existiu fora da
    // memória do processo anterior.
    const restarted = createLocalFileCampaignCache({ dir, version: 1 });
    assert.equal(await restarted.get("stats:999", "json"), null);
  });

  it("write-once: um 2º put() com conteúdo diferente NÃO reescreve o arquivo", async () => {
    const cache = createLocalFileCampaignCache({ dir, version: 1 });
    await cache.put("stats:123", JSON.stringify({ gs: { sent: 10 } }));
    await cache.put("stats:123", JSON.stringify({ gs: { sent: 999 } }));

    // Nova instância força a leitura vir do disco (não do Map em memória do
    // primeiro `cache`, que teria o valor sobrescrito de propósito).
    const fresh = createLocalFileCampaignCache({ dir, version: 1 });
    const value = await fresh.get("stats:123", "json");
    assert.deepEqual(value, { gs: { sent: 10 } }, "o disco deveria manter a 1ª escrita");
  });

  it("bump de versão invalida o cache anterior sem precisar migrar/apagar nada", async () => {
    const v1 = createLocalFileCampaignCache({ dir, version: 1 });
    await v1.put("stats:123", JSON.stringify({ gs: { sent: 10 } }));

    const v2 = createLocalFileCampaignCache({ dir, version: 2 });
    assert.equal(await v2.get("stats:123", "json"), null, "v2 não deve enxergar o arquivo .v1.json");

    // O arquivo v1 antigo continua no diretório (órfão, inofensivo) — v2
    // escreve o seu próprio arquivo, sob outro nome.
    await v2.put("stats:123", JSON.stringify({ gs: { sent: 20 } }));
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ["stats_123.v1.json", "stats_123.v2.json"]);
  });

  it("fail-soft: erro de FS (dir é na verdade um arquivo) degrada pra memória sem lançar", async () => {
    // Simula "data/ inacessível": aponta `dir` para um caminho que já existe
    // como ARQUIVO — mkdirSync(recursive:true) falha, ensureDir() retorna false.
    const blockedPath = join(dir, "blocked-as-file");
    writeFileSync(blockedPath, "not a directory");
    const cache = createLocalFileCampaignCache({ dir: blockedPath, version: 1 });

    // put/get não devem lançar, e o valor segue disponível em memória.
    await assert.doesNotReject(cache.put("stats:1", JSON.stringify({ gs: { sent: 1 } })));
    const value = await cache.get("stats:1", "json");
    assert.deepEqual(value, { gs: { sent: 1 } });
  });

  it("delete remove tanto a entrada em memória quanto o arquivo em disco", async () => {
    const cache = createLocalFileCampaignCache({ dir, version: 1 });
    await cache.put("stats:123", JSON.stringify({ gs: { sent: 10 } }));
    assert.equal(readdirSync(dir).length, 1);

    await cache.delete("stats:123");
    assert.equal(readdirSync(dir).length, 0);
    assert.equal(await cache.get("stats:123", "json"), null);
  });
});

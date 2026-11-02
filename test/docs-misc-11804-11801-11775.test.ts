/**
 * test/docs-misc-11804-11801-11775.test.ts
 *
 * Travas do lote docs-misc (overnight 261102):
 *  - #11804: a dica de `publish-instagram.ts` aponta para o token de usuário
 *    do sistema (não para o Graph Explorer, cujo token expira em horas) e
 *    `docs/secret-rotation.md` documenta onde gerar, as permissões e os 3
 *    destinos.
 *  - #11801: `restore-kit-sem-abertura-frio.ts` não diz mais que a API não
 *    reativa `cancelled` nem manda reativar no painel; registra o vínculo ao
 *    form de sistema e a exigência de consentimento.
 *  - #11775: sobras Beehiiv removidas não voltam (gap check, medição de
 *    entrega, scripts de slug, auditoria da partição Beehiiv×Kit).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("#11804 — token do Instagram é de usuário do sistema", () => {
  it("a dica do script não manda para o Graph Explorer e cita a doc de rotação", () => {
    const src = read("scripts/publish-instagram.ts");
    const hint = src.slice(src.indexOf("INSTAGRAM_ACCESS_TOKEN: "), src.indexOf("return 0;", src.indexOf("INSTAGRAM_ACCESS_TOKEN: ")));
    assert.doesNotMatch(hint, /tools\/explorer/);
    assert.match(hint, /usuário do sistema/);
    assert.match(hint, /instagram_manage_comments/);
    assert.match(hint, /docs\/secret-rotation\.md/);
  });

  it("docs/secret-rotation.md tem a seção com onde gerar, permissões e os 3 destinos", () => {
    const doc = read("docs/secret-rotation.md");
    const start = doc.indexOf("### `INSTAGRAM_ACCESS_TOKEN`");
    assert.ok(start >= 0, "seção do Instagram ausente");
    const section = doc.slice(start, doc.indexOf("\n### ", start + 1));
    assert.match(section, /Usuários do sistema/);
    assert.match(section, /Vigil\.ia\.br/);
    assert.match(section, /instagram_manage_comments/);
    assert.match(section, /Doppler/);
    assert.match(section, /\.env` do Neo e do 300/);
    assert.match(section, /wrangler secret put INSTAGRAM_ACCESS_TOKEN/);
    assert.match(section, /NÃO gerar:\*\* no Graph API Explorer/);
  });
});

describe("#11801 — cancelled reativa pelo vínculo ao form de sistema, com consentimento", () => {
  const src = read("scripts/restore-kit-sem-abertura-frio.ts");
  it("não afirma mais que a API não reativa nem manda ao painel", () => {
    assert.doesNotMatch(src, /Reativar `cancelled` pela API: NÃO/);
    assert.doesNotMatch(src, /a API não reativa — reativar no PAINEL/);
    assert.doesNotMatch(src, /reativar à mão no painel do Kit/);
  });
  it("registra o vínculo ao form de sistema e a exigência de consentimento", () => {
    assert.match(src, /POST \/v4\/forms\/9839463\/subscribers\/\{id\}/);
    assert.match(src, /208\s+\* de 208/);
    assert.match(src, /exige consentimento: nunca em opt-out da própria pessoa/);
    assert.match(src, /nunca em opt-out da própria pessoa/);
  });
});

describe("#11775 — sobras Beehiiv removidas não voltam", () => {
  it("gap check e medição de entrega da Beehiiv saíram", () => {
    assert.doesNotMatch(read("scripts/lib/beehiiv-kit-reconcile.ts"), /export function checkBeehiivDeliveryGap/);
    const reconcile = read("scripts/reconcile-send-audiences.ts");
    assert.doesNotMatch(reconcile, /measureBeehiivRecentDelivery/);
    assert.doesNotMatch(reconcile, /Kit \(tag\) × Beehiiv \(ativos\)/);
  });

  for (const removed of [
    "scripts/check-whatsapp-slug-guard.ts",
    "scripts/fix-post-slug.ts",
    "scripts/lib/whatsapp-slug-guard.ts",
    "scripts/audit-kit-diaria-exclusivity.ts",
    "scripts/lib/kit-diaria-audience-exclusivity.ts",
  ]) {
    it(`${removed} não existe mais`, () => {
      assert.equal(existsSync(resolve(ROOT, removed)), false);
    });
  }

  it("publish-newsletter-kit.ts não tipa mais publishing.newsletter.backend", () => {
    const src = read("scripts/publish-newsletter-kit.ts");
    const iface = src.slice(src.indexOf("export interface PlatformConfig {"), src.indexOf("}\n", src.indexOf("export interface PlatformConfig {")) + 2);
    assert.doesNotMatch(iface, /backend\?: string/);
  });

  it("o playbook da Beehiiv abre declarando que é arquivo histórico", () => {
    const head = read("context/publishers/beehiiv-playbook.md").slice(0, 600);
    assert.match(head, /ARQUIVO HISTÓRICO/);
  });
});

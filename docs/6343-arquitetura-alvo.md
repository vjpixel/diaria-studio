# Referência: Migração diar.ia.br (issue #6343) — estado verificado

Status: REATIVADA (24/08/2026, decisão do editor confirmada ao vivo na edição 260827).
Esta não é a migração completa — é o registro de arquitetura alvo e sequência segura, conforme decidido no #6343.

## Estado atual confirmado ao vivo (260827)

- `diar.ia.br` (apex) ainda é custom hostname da Beehiiv (Cloudflare for SaaS).
- Nenhum Worker/interceptação nosso funciona enquanto isso persistir (`data/` junction; ver `docs/beehiiv-vs-kit-migration.md`).
- `_dmarc.news.diar.ia.br` → `p=none`; `_report._dmarc.diar.ia.br` existe (autorização externa RFC 7489 §7.1).
- Kit já publica a edição (`publishing.newsletter.backend` → `kit` em `platform.config.json`); o `public_url` só resolve após o broadcast sair de `draft` (Etapa 6), diferente da Beehiiv que monta a URL a partir do slug do título assim que o rascunho existe.
- `resolve-edition-url.ts` precisa de substituto — o `public_url` do Kit nunca resolve a tempo da Etapa 5; a solução é `diar.ia.br/p/{slug}` servido por Worker próprio (KV + HTML da Etapa 4/5), unificando Kit e Beehiiv na mesma URL canônica.

## Arquitetura alvo (decisão confirmada no #6343)

1. `diar.ia.br` sai do custom hostname da Beehiiv → nossa zona Cloudflare.
2. `diar.ia.br/p/{slug}` → URL canônica única (Kit + Beehiiv), servida por Worker nosso a partir do HTML (`newsletter-final.html`) já gerado na Etapa 4/5, armazenado no KV (mesmo padrão de `eia.diar.ia.br`).
3. `arquivo.diar.ia.br` mantém papel (índice por tema/mês), passa a linkar `diar.ia.br/p/*` em vez do link Beehiiv.
4. `/` (home) e `/subscribe` precisam de substituto próprio (Worker + form inline via `poll` já existe, `POST /jogar/subscribe`).
5. `/sitemap.xml` precisa ser gerado (padrão já existe em `workers/arquivo`).
6. `news.diar.ia.br` fica só como domínio de envio do Kit (SPF/DKIM via Cloudflare Email Routing já configurados) — sem relação com hospedagem web.
7. Antes de qualquer corte de DNS: paridade completa verificada; edições antigas (~236) precisam ser migradas (exportar conteúdo da Beehiiv, popular KV).

## Sequência segura (não cortar DNS sem paridade)

Ver `docs/beehiiv-vs-kit-migration.md` §4 (Fase 0–4) e #6343. A sequência resumida:
- Fase 1: `/p/{slug}` construído (resolve o #6323 imediatamente, sem depender do resto).
- Fase 2: migração das edições antigas.
- Fase 3: substitutos `/` e `/subscribe`.
- Fase 4: `/sitemap.xml` próprio.
- Fase 5: validação de paridade completa.
- Fase 6 (só após Fase 5): tirar `diar.ia.br` do custom hostname Beehiiv; atualizar `resolve-edition-url.ts`/`publish-newsletter-kit.ts`.

## Dependências registradas no #6343

- Nenhuma dependência externa de conta/plataforma além do que já existe (`data/` junction, KV, Workers, Cloudflare zone).
- O `public_url` do Kit (não resolve até Etapa 6) é o motivo técnico que justifica esta migração, não apenas um desejo editorial.
- `docs/beehiiv-vs-kit-migration.md` continua válido como referência histórica; este arquivo é o plano vigente (confirmado pelo editor em 26/08/2026).

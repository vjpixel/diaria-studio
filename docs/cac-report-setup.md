# Custo por leitor por canal (`scripts/cac-report.ts`) + `/ads` no Studio

Issue: [#5236](https://github.com/vjpixel/diaria-studio/issues/5236). Depende de `leitor-v1` + mapa de origem recuperada (#5235, ver `docs/definicao-leitor.md`).

## O que isto responde

Onde botar o orçamento de aquisição (R$ 4.000+/mês, decisão do editor 260814 — teto de CAC revogado, o custo **ranqueia**, não reprova). A tela `/ads` do Studio responde em 5 segundos:

1. Qual canal traz leitor mais barato, e com que `n`?
2. A coorte de cada canal lê mais ou menos que a base?
3. Quanto do orçamento do mês já foi consumido?
4. Algum canal degradou desde o último período?

## Parte 1 — `data/aquisicao/spend.csv`

Import manual, cinco colunas: `canal,mes,moeda,valor,fonte`. `valor` é sempre um número com **ponto** decimal (`956.21`), nunca vírgula — a coluna `moeda` já carrega o código separadamente. Ver `scripts/lib/aquisicao-spend.ts` (`parseSpendCsv`) pro parser (tolerante mas barulhento: header faltando lança, célula vazia/valor inválido vira `errors[]` visível, nunca `null` silencioso).

Seed inicial (as 3 linhas do histórico conhecido em 260814 — Google Ads R$ 956,21, Beehiiv Boosts R$ 397,08, LinkedIn R$ 0):

```bash
npx tsx scripts/seed-spend-csv.ts        # recusa sobrescrever se já existir
npx tsx scripts/seed-spend-csv.ts --force
```

`data/` é a junction OneDrive (`.gitignore` blanket) — o CSV em si nunca vai pro repo; `SPEND_SEED_ROWS` (`scripts/lib/aquisicao-spend.ts`) é a fonte versionada do conteúdo do seed, com o rationale completo de `mes`/`fonte` documentado ali.

## Parte 2 — `scripts/cac-report.ts`

```bash
npx tsx scripts/cac-report.ts                       # snapshot mais recente, registra em /relatorios
npx tsx scripts/cac-report.ts --json
npx tsx scripts/cac-report.ts --snapshot 2026-08-14 --no-register
```

Insumos: `data/aquisicao/spend.csv`, snapshot mais recente de `data/beehiiv-backup/`, e (opcional) `data/aquisicao/origem-original.json` — sem ele, roda com aviso explícito usando `utm_source` cru.

Núcleo puro em `scripts/lib/cac.ts` (reusa `resolveGroupKey`/`computeGroupEngagement` de `scripts/cohort-engagement.ts`, nunca reimplementa):

- **Filtra contas internas/teste antes de agrupar** (`filterInternalAndTestSubscribers` — endereça o achado do self-review de #5235: `build-origem-map.ts` não fazia esse filtro nem normalizava email).
- **Google Ads / LinkedIn** são canais MEDIDOS — agrupados por `utm_source`/`referring_site` conhecidos (`CHANNEL_GROUP_KEYS`). Google Ads confirmado em #4466/#5254 (`android.googlequicksearchbox`, `googlesyndication`, `googleadservices`); LinkedIn ainda sem campanha real rodada (spend R$0), chaves são convenção especulativa a confirmar quando uma campanha real rodar.
- **Beehiiv Boosts** é ESTIMADO, nunca medido por grupo (sem chave de atribuição estável no snapshot) — faixa mín-máx pela proporção 157 leads faturados / 233 leads totais (`BOOST_ESTIMATE_ANCHOR`), nunca soma no total "medido" do relatório.
- **leitor-v1** (`scripts/lib/leitor.ts`) é contado separadamente — nunca o campo `.leitores` de `GroupEngagement` (que depende de `open_rate` por assinante, ausente nos snapshots locais).
- Sinal de **degradação**: compara a abertura agregada do canal no snapshot mais recente contra o snapshot ANTERIOR disponível (queda ≥5pp → `degradado: true`); sem 2º snapshot, fica `null` (nunca `false` por omissão).

## Parte 3 — `/ads` no Studio

`scripts/studio-ui/studio-ads.ts` (`buildAdsData`) — mesmo padrão de `studio-tasks.ts`: cache 10min + `forceRefresh`, fail-soft por camada (spend/snapshot/origem cada um com seu próprio `error`, nunca derruba a página). Sessão cloud (`data/` ausente) mostra "sem dados" — nunca lança.

`GET /api/ads` → `scripts/studio-ui/public/ads.html`/`ads.js`/`ads.css`. Read-only nesta versão — sem edição de `spend.csv` pela UI (import manual continua fora do Studio).

## Achados de self-review (não corrigidos nesta unidade — ver comentários inline do PR)

- `CHANNEL_GROUP_KEYS["LinkedIn"]` é especulativo (nenhuma campanha real rodou ainda) — confirmar/ajustar quando houver dado real.
- A fórmula de `computeBoostRange` (escalar `ativosAnchor`/`leitoresAnchor` pela razão `233/157`) é uma interpretação razoável de "estimados pela proporção 157/233", mas não está pinada a uma derivação explícita na issue — vale confirmação do editor.
- `DEGRADATION_THRESHOLD_PCT = 5` (pontos percentuais) é um default arbitrário, não especificado pela issue.
- Canal em `spend.csv` que não seja literalmente `"Google Ads"`, `"LinkedIn"` ou `"Beehiiv Boosts"` (typo, canal novo) cai silenciosamente como `measured` com `n=0/vazio` — nunca desaparece, mas também não alerta "canal desconhecido, precisa de mapeamento".

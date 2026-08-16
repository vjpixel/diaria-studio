# Candidatas a página de entidade (#5125 item 4)

Levantamento mecânico do corpus (`data/beehiiv-cache/posts/*.json`, 249
edições, auditado 14/08/2026) para identificar candidatas de **cauda
longa** ao formato "página por entidade" (`scripts/lib/shared/entity-page.ts`,
critérios completos na docstring desse módulo — piso `MIN_ENTITY_MENTIONS =
5`). Reusa exatamente o mesmo mecanismo que `HUB_KEYWORD_PATTERNS`
(`scripts/generate-hub-sources.ts`) já usa para hubs: `collectHubSources()`
com um regex por candidata, testado contra `título + subtítulo` de cada
edição `status: "confirmed"`.

**Leitura do dispatch "~20 posts" (registrada também na issue e no PR):** o
comentário do editor de 14/08 dizia "~20 posts". A única infraestrutura
pronta no repo é a de **página de entidade** (`entity-page.ts`,
`build-entity-page.ts`, 1 PoC publicada — Perplexity, #5195). "Espelhar ~20
edições inteiras" contradiria a política de canônica já decidida na própria
#5125 (opção C, 12/08 — "não espelhar o acervo"). Este documento trata
"~20" como aproximação de ESCALA do formato de entidade (~20 páginas de
entidade, não 20 edições espelhadas), não como número exato a bater.

## Metodologia

1. Lista de ~70 candidatas (empresas/produtos de IA recorrentes em
   cobertura de tecnologia — mesma base de `AI_COMPANIES` em
   `scripts/lib/entity-dedup.ts`, mais ~35 nomes adicionais de produtos/
   ferramentas de IA generativa).
2. Para cada candidata, regex de word-boundary (case-insensitive) contra
   `título + subtítulo` de cada edição confirmada — mesmo padrão de
   `HUB_KEYWORD_PATTERNS`.
3. Candidatas com contagem **abaixo de 5**: thin content certo, descartadas
   sem verificação manual (mesmo piso de `MIN_ENTITY_MENTIONS`).
4. Candidatas com contagem **muito alta** (≥ ~15): risco de ler como início
   de hub temático em vez de página de entidade modesta — descartadas desta
   rodada (`Microsoft/Copilot` 21, `Nvidia` 20). Mesmo critério já usado na
   docstring de `perplexity.ts` para descartar essas duas.
5. Para as candidatas na faixa 5-14 ("banda de cauda longa"), **leitura
   manual do corpo real** (`content.free.web`) de cada edição matched —
   nunca confiar só na contagem do título/subtítulo. Esse passo pegou 1
   falso-positivo real (ver "Achados de verificação" abaixo).
6. Checagem de overlap contra os 6 hubs temáticos publicados
   (`HUB_KEYWORD_PATTERNS`) e contra a Perplexity (já publicada) — nenhuma
   candidata da banda final colide.

## Ranking (banda de cauda longa, 3 ≤ contagem ≤ 15)

Contagem bruta por regex (antes da leitura manual), do maior para o menor:

| Candidata | Contagem | Status |
|---|---|---|
| Microsoft/Copilot | 21 | excluída — volume de hub, não de entidade |
| Nvidia | 20 | excluída — volume de hub, não de entidade |
| xAI/Grok | 9 | **✅ implementada nesta rodada** |
| Amazon/AWS | 8 | **✅ implementada nesta rodada** |
| Perplexity | 8 | já publicada (#5195), fora desta rodada |
| Apple | 7 | verificada, boa candidata pra próxima rodada (ver nota abaixo) |
| Samsung | 6 | **✅ implementada nesta rodada** |
| DeepSeek | 6 → 5 real (5 distintas após +1 pesquisa) | **✅ implementada em rodada seguinte (15/08/2026 continuo)** |
| Alibaba | 3 → 6 real | **✅ implementada em rodada seguinte (16/08/2026 continuo)** |
| AMD | 3 | verificada, abaixo do piso mesmo com pesquisa de corpo completo (3 reais) |
| Oracle | 3 → 5 real | **✅ implementada em rodada seguinte (16/08/2026 continuo)** |

Candidatas com contagem 0-2 (abaixo do piso, não verificadas — thin content
certo): Manus, IBM, Salesforce, ByteDance/TikTok, SpaceX, LinkedIn, Mistral,
Adobe/Firefly, Uber, Spotify, Sony, Intel, Qualcomm, Slack, GitHub, PayPal,
Softbank, Reddit, Midjourney, ElevenLabs, Character.AI, Runway, Suno,
Cursor, Replit, Hugging Face, Stability AI, Cohere, Ideogram, Luma, Notion,
Canva, Genspark, Baidu, Tencent, Databricks, Palantir, Tesla, Netflix,
Disney, TSMC, SAP, Zoom, Figma, Airbnb, Coinbase, Walmart, Boeing, Waymo,
Snap/Snapchat, Foxconn, Huawei, Xiaomi, Waze, Grammarly, Roblox, Epic Games,
Pinterest, Zapier, Shopify, Klarna, Duolingo.

## Achados de verificação (leitura manual do corpo)

**Amazon — 1 mention substituída.** A edição de 2025-09-22 casava a regex
via "OpenAI pode desenvolver rival do Amazon Echo" (manchete secundária),
mas esse item nunca ganhou parágrafo próprio no corpo — sem
desenvolvimento além do título. A MESMA edição tinha um parágrafo real e
substantivo sobre a Amazon (um estudo da AWS sobre adoção de IA no Brasil,
casado pela mesma regex via `\baws\b`), usado no lugar. Sem essa
substituição, a contagem real de Amazon cairia pra 7 sem perder cobertura —
a substituição preserva as 8 menções com conteúdo genuíno em vez de reduzir
a página.

**DeepSeek — 1 falso-positivo confirmado, contagem real cai pra 5 (no
piso).** A edição de 2026-04-06 casava a regex via "A aposta do Google
contra Meta e DeepSeek" (título de seção), mas o corpo do parágrafo NUNCA
menciona a DeepSeek especificamente — só cita Moonshot, Alibaba e Z.AI como
os concorrentes chineses de pressão, mais o Llama da Meta. É o mesmo padrão
de risco que a docstring de `entity-page.ts` describe como "scaled content
abuse": um título que menciona a entidade sem o corpo sustentar. Excluída.
Restam 5 menções reais (piso exato de `MIN_ENTITY_MENTIONS`), com 2 delas
(07/08 e 07/09) cobrindo o mesmo desenvolvimento — "DeepSeek desenvolve
chip próprio" — via fontes distintas (Reuters vs. CNN) em dias
consecutivos, o que deixa o arco mais fino e repetitivo que as demais
candidatas da banda. Por isso NÃO foi escolhida entre as 3 desta rodada,
mas seria a próxima com \+1 pesquisa (achar mais 1-2 menções em edições
fora da janela já auditada, ou aceitar a redundância) esclareceria se vale
a pena.

**Apple — verificada, 7 menções reais e substanciais, publicada em
15/08/2026 (#5125, `scripts/lib/entities/apple.ts`).** Todas as 7 menções
(busca com IA no Siri, chip do iPhone 17 Air, chip M5, MacBook Air/iPad
Air, Apple Foundation Models 3ª geração, transcrição de IA no Genius Bar,
mais o processo antitruste da xAI/X contra Apple/OpenAI) são reais e
substantivas — nenhum falso-positivo. Havia sido preterida na rodada
anterior em favor de Samsung porque o arco de Apple é mais repetitivo
("mais um recurso de IA embarcado" em quase toda entrada); publicada nesta
unidade porque era a "melhor candidata única pra próxima rodada" já
registrada aqui, e o dispatch de #5125 pediu explicitamente 1 página nova
(não reabrir o levantamento). Dos 10 matches brutos por regex
(`\bapple\b|\bsiri\b|tim cook`), 3 foram lidos e excluídos de propósito —
registrados em `ENTITY_EXCLUDED_EDITIONS.apple`
(`scripts/lib/entities/patterns.ts`) pra que
`scripts/regenerate-entity-pages.ts` nunca os re-alarme como pendência:
"Siri agora terá Gemini" (redundante com a menção já incluída de "busca
com IA no Siri"), "Siri vs Claude vs ChatGPT no iOS" (sobre a escolha do
usuário entre assistentes, não um desenvolvimento de produto da Apple), e
"Apple aposta em IA silenciosa para comandos" (aquisição da Q.ai —
desenvolvimento real, mas redundante em tema com as demais menções).

## As 3 escolhidas nesta rodada

Critério do dispatch: "as 3 MELHORES candidatas do ranking (arco narrativo
completo, evita genérico)". Escolhidas, em ordem de força do arco:

1. **xAI** (`scripts/lib/entities/xai.ts`, 9 edições / 10 menções) — arco
   mais dramático e completo: disputas judiciais corporativas (Apple/
   OpenAI, ex-engenheiro) → lançamentos de produto (Grok 4 Fast, Grok 4.1)
   → parceria de infraestrutura na Arábia Saudita → escândalo global de
   segurança (imagens sexualizadas de crianças, investigações em >6
   países, ultimato do Brasil) → fragilidade financeira revelada (US$ 7,8
   bi de queima em 2025) → novo processo judicial (Minnesota). Nenhuma
   sobreposição com hub existente.
2. **Amazon** (`scripts/lib/entities/amazon.ts`, 8 edições) — arco de
   infraestrutura: de fornecedora silenciosa de nuvem a vítima de uma
   queda que expôs a fragilidade da internet global, depois financiadora
   bilionária de 2 das maiores rivais de IA (OpenAI, Anthropic) e parte
   interessada numa disputa sobre até onde um assistente agêntico pode
   operar dentro do próprio site da empresa.
3. **Samsung** (`scripts/lib/entities/samsung.ts`, 6 edições) — arco com
   virada de tom genuína (evita o padrão genérico que o dispatch pediu pra
   evitar): de fabricante que investe em educação/hardware/parcerias de IA
   a vítima do próprio boom de infraestrutura que ajuda a abastecer,
   registrando o primeiro prejuízo trimestral da história da divisão de
   celulares por causa do preço de memória.

Cada `summary` foi escrito depois de ler `content.free.web` da edição
correspondente — nunca reformulação da manchete (mesma disciplina de
`perplexity.ts`, ver docstring de `entity-page.ts` seção "Critério
anti-thin-content").

## Estado após esta rodada (16/08/2026, sessão `/diaria-continuo`)

8 de ~20 páginas de entidade planejadas (Perplexity + xAI + Amazon +
Samsung + Apple + DeepSeek + **Oracle** + **Alibaba** = 8 publicadas no
total, contando o PoC do #5195). Escala reduzida de propósito — cada
página exige leitura+síntese editorial real do corpo de cada edição, não
é mecânico (ver dispatch #5125).

**Oracle e Alibaba publicadas nesta rodada** (`scripts/lib/entities/oracle.ts`,
`scripts/lib/entities/alibaba.ts`), aplicando a MESMA técnica que
desbloqueou DeepSeek na rodada anterior às 3 candidatas que tinham ficado
abaixo do piso na auditoria original (regex só contra título+subtítulo):
grep de "corpo completo" (`content.free.web`) de TODAS as ~251 edições
confirmadas do corpus, seguido de leitura manual de cada match pra separar
desenvolvimento real de bullet/menção de passagem sem parágrafo próprio
(mesmo critério anti-thin-content de `entity-page.ts`).

- **Oracle: 3 → 5 menções reais, todas distintas.** Arco raro entre as
  entidades já publicadas — a mesma empresa muda de protagonista do boom
  (contrato de US$ 300 bi com a OpenAI, ação +40% num dia) pra símbolo do
  risco do boom (sell-off por dívida, resultados que reacendem o medo de
  bolha, nova rodada de captação mesmo assim, e o desfecho pessoal de
  Larry Ellison exposto à própria aposta). Cruza o piso de
  `MIN_ENTITY_MENTIONS` exatamente, com margem editorial (nenhuma das 5 é
  redundante — datas de setembro/2025 a agosto/2026, cada uma um fato
  novo). Ver docstring de `oracle.ts` pro detalhamento de cada exclusão.
- **Alibaba: 3 → 6 menções reais, todas distintas.** Arco de ambição
  tecnológica (chip próprio, liderança em open source, entrada em
  wearables) seguido de controvérsia (acusação da Anthropic de 25 mil
  contas falsas extraindo dados do Claude) e retorno à corrida de modelos
  já sob essa sombra (Qwen 3.8-Max). Acima do piso com folga. Ver
  docstring de `alibaba.ts`.
- **AMD: continua abaixo do piso mesmo com a pesquisa de corpo completo —
  achado NEGATIVO desta rodada.** 11 edições casam a regex no corpo, mas
  só 3 têm parágrafo próprio com desenvolvimento real: o acordo AMD-OpenAI
  de infraestrutura (6 GW, opção de ações, out/2025), a projeção de
  crescimento de 35%/ano da AMD (nov/2025), e o acordo bilionário
  AMD-Anthropic (jul/2026). As outras 8 são ou bullets de "OUTRAS
  NOTÍCIAS" sem corpo (parceria Meta-AMD, parceria com o Departamento de
  Energia dos EUA) ou menções de passagem em matérias sobre OUTRA empresa
  (AMD citada como concorrente da Nvidia num texto sobre Arm, Qualcomm ou
  a própria Nvidia, sem desenvolvimento específico da AMD). 3 reais < 5 do
  piso — a pesquisa não desbloqueou a candidata desta vez; comentário
  registrado na #5125 com este achado pra não reabrir o mesmo território
  numa rodada futura sem sinal novo.

**Regeneração automática (#5125, condição do editor 14/08/2026) validada
para as 2 entidades novas nesta unidade:** `npx tsx scripts/regenerate-entity-pages.ts --dry-run`
roda no-op limpo (0 divergência mecânica, 0 stale) já incluindo Oracle e
Alibaba em `ENTITY_LOADERS` — nenhuma intervenção manual adicional
necessária além do que a task diária `Diaria-Entity-Pages-Regen` já cobre
(09:40, ver `docs/entity-pages-regen-setup.md`).

Candidatas prontas pra próxima rodada, sem precisar re-rodar o
levantamento inteiro: nenhuma — a lista de "contagem 0-2, não verificadas"
segue como thin content certo (ver seção "Ranking" acima), e as 3
candidatas de contagem 3 já foram todas verificadas nesta rodada (2
publicadas, 1 descartada com achado negativo registrado). Reabrir esse
território exige sinal novo (mais edições publicadas expandindo o corpus,
ou pedido explícito do editor pra escala além do critério "valor próprio
pro leitor" já documentado).

Item 4 da issue #5125 original (decisão de escala pros 247 posts) segue
dependendo da janela de medição de 3 semanas da PoC de Perplexity
(checkpoint 03/09/2026, ver comentário do editor de 14/08/2026 na issue).

# Scoping Tier 2 — orquestradores determinísticos (#5192)

Continuação de #5191 (Tier 1). Trabalho de **scoping puro** — nenhum código
implementado nesta unidade (2 das 4 candidatas já foram implementadas por
outras unidades paralelas da sessão `/diaria-continuo`; ver nota em cada
seção). Padrão-alvo (citado pela própria issue): `scripts/clarice-novos-run.ts`
(#4941) — um `spawnSync` por sub-script, nunca `import`, contrato de exit
code + JSON em stdout, kill switch antes de qualquer chamada externa.

Metodologia: para cada skill, separar 3 camadas —

- **(a) glue determinístico** — sequência fixa de `npx tsx` sem julgamento
  editorial no meio, hoje reimplementada em prosa no SKILL.md (o LLM extrai
  valor de stdout/JSON de um passo e injeta no próximo).
- **(b) gate humano genuíno** — decisão do editor que muda o que o leitor
  final vê ou que autoriza gasto/mutação irreversível. Fica como está.
- **(c) dispatch de subagente/MCP** — depende de uma tool MCP sem
  equivalente REST público, só invocável de sessão/subagente com a tool
  declarada. Não determinizável por definição (script TS não tem acesso a
  MCP).

---

## 1. `/diaria-atualiza-audiencia` — JÁ IMPLEMENTADO (PR #5298, merged)

**Recomendação da issue:** "a mais fácil, provavelmente 100% script."
**Veredito real, confirmado pela implementação já mergeada:** quase, mas
não 100% — sobra 1 chamada MCP genuinamente não-determinizável.

| Camada | Conteúdo |
|---|---|
| (a) glue determinístico | Resolver `publicationId` (REST, `GET /publications`, existe de verdade) e `profileSurveyId` (confirma o já persistido em `platform.config.json`); validar/normalizar cada resposta de survey (fail-soft — item malformado é logado e pulado, nunca trava o lote); gravar `data/audience-raw.json` no formato esperado; disparar `scripts/update-audience.ts` (arquiva o profile atual + gera o novo `context/audience-profile.md`). Tudo isso virou `scripts/audience-run.ts` (555 linhas). |
| (b) gate humano | Nenhum de fato — a única decisão humana é a ambiguidade rara "mais de 1 survey candidata", resolvida **uma vez** e persistida em `platform.config.json` → `beehiiv.profileSurveyId` (não é um gate recorrente, é resolução de config). |
| (c) subagente/MCP | 2 chamadas MCP **permanecem** fora do script: `mcp__claude_ai_Beehiiv__list_surveys` (resolução inicial do `profileSurveyId`, só quando ainda não está em config) e `mcp__claude_ai_Beehiiv__list_survey_responses` (paginação das respostas em si). Achado documentado no próprio SKILL.md: sondagem HTTP sem key confirmou que toda variante de rota REST para surveys devolve 404 — o recurso não existe fora do MCP, mesma classe de `list_post_clicks`/`list_post_subscriber_engagement` (`beehiiv-clicks-enricher`). Não é meramente "foi escrito assim" — é limitação real da API pública da Beehiiv. |

**Por que compensou virar `*-run.ts` mesmo sem fechar 100%:** o volume de
glue determinístico (resolução de config + validação + gravação + disparo
do script seguinte) era grande o bastante pra justificar isolar num
orquestrador — o que sobra de MCP (2 chamadas, ambas em fases separadas e
bem delimitadas: `--resolve-only` e depois `--responses <arquivo>`) é pouco
e já vem com uma interface limpa (arquivo JSON intermediário) em vez de
"o LLM decide tudo".

---

## 2. `/diaria-brevo-diaria` — JÁ IMPLEMENTADO (PR #5353, merged, parcial)

**Recomendação da issue:** "maior retorno, mas maior — 10 invocações
encadeadas." **Veredito real:** retorno alto, mas só nos Passos 1-4 — os
Passos 5-8 foram avaliados e conscientemente deixados de fora.

| Camada | Conteúdo |
|---|---|
| (a) glue determinístico | Passos 1-4 (contatos + rampa): sequência fixa de 5 sub-scripts (`evaluate-brevo-diaria.ts`, `refresh-pending-pool.ts`, `score-pending-origin.ts`, `verify-pending-emails-mv.ts`, `sync-pending-to-brevo.ts`) em ordem que **precisa** ser respeitada (Passo 1 libera slots antes do Passo 3 contar candidatos; Passo 2 precisa rodar antes do Passo 3 enxergar os novos). A ordem em si não tem julgamento editorial — só risco de erro humano/LLM esquecer um passo ou invertê-lo numa sequência que muta contatos reais. Virou `scripts/brevo-diaria-run.ts` (644 linhas, 2 modos: `--preflight` dry-run / `--apply --max-add N` mutação real). |
| (b) gate humano | **Passo 4** (quantos contatos acrescentar, `--max-add N` — decisão numérica mas editorial, considera abertura agregada/composição da fila) **fica no script como parâmetro explícito**, decidido pelo humano antes de invocar `--apply`. **Passos 6 e 8** (revisão de copy da campanha; confirmação de `scheduledAt` — agendamento é imutável na Brevo) são gates genuínos que **não foram tocados** — cada um já é 1 única invocação de `publish-daily-brevo.ts` cercada de confirmação humana, sem JSON de um passo alimentando o próximo. |
| (c) subagente/MCP | Nenhuma nesta skill — todos os 8 passos são scripts TS com API REST direta (Beehiiv/Brevo/MillionVerifier), nenhum depende de MCP-only tool. |

**Por que os Passos 5-8 ficaram de fora conscientemente:** cada passo já é
uma única chamada de script (`publish-daily-brevo.ts` com flags
diferentes: `--dry-run`, `--i-reviewed-the-copy`, `--send-test`) sem
encadeamento de múltiplos sub-scripts — não há "glue" a remover, só
indireção sobre um comando de 1 linha já cercado de gate. Escrever um
wrapper ali não eliminaria julgamento nenhum, só adicionaria uma camada.
Documentado explicitamente em "Fora de escopo desta skill" no SKILL.md.

---

## 3. `/diaria-mensal-apoiadores` — AVALIADO, NÃO COMPENSA

**Recomendação da issue:** "mesma forma [de `brevo-diaria`], menor
porte." **Veredito desta análise:** a analogia de PORTE se confirma, mas
não a de FORMA — a skill não tem o padrão "N sub-scripts encadeados por
JSON" que justificou `clarice-novos-run.ts`/`audience-run.ts`/
`brevo-diaria-run.ts`. É 3 invocações **independentes** do mesmo par de
scripts, cada uma já auto-contida por `--cycle`.

| Camada | Conteúdo |
|---|---|
| (a) glue determinístico | Quase nenhum. Passo 1 (`send-monthly-apoiadores.ts --cycle $CYCLE`) e Passo 2 (`publish-monthly-apoiadores-brevo.ts --cycle $CYCLE [--dry-run]`) **não trocam dado entre si via stdout/JSON** — os dois leem/gravam o MESMO state file (`beehiiv-apoiadores-state.json`) de forma independente, e o próprio Passo 2 já lê esse state sozinho para o guard de idempotência (`decidePublishBrevoAction`, fechado no #4572 develop). Não há valor extraído de um passo e injetado manualmente no próximo — cada script só precisa do `--cycle`, que já vem do humano. O único "encadeamento" é ordem recomendada (Passo 1 antes do Passo 2), mas o próprio SKILL.md documenta que o Passo 2 funciona sem o Passo 1 ter rodado. |
| (b) gate humano | Real e central: o Passo 2 SEMPRE cria a campanha como rascunho — test email, escolha de dia sem edição pesada, e Schedule/Send final são sempre ação manual do editor na UI da Brevo (decisão de produto do #4482, não um gate técnico que possa virar script). O Passo 3 (`--mark-sent`) é o humano confirmando que enviou de verdade pela UI — não há como determinizar "o editor clicou Send no painel Brevo". |
| (c) subagente/MCP | Nenhuma — os 2 scripts usam REST direto (Brevo `POST /emailCampaigns`, `sync-apoio-nivel-brevo.ts` via apoia.se API). |

**Recomendação: NÃO vira `*-run.ts`.** Não sobra orquestrador — os 2
passos já são scripts standalone que um humano/LLM invoca em sequência
óbvia (Passo 1 opcional, Passo 2 obrigatório, Passo 3 pós-envio manual),
sem JSON de um alimentando o outro e sem risco real de ordem errada (o
guard de idempotência do Passo 2 já impede duplicar campanha mesmo se
rodado fora de ordem ou 2x). Escrever um `mensal-apoiadores-run.ts` que
apenas chama os 2 scripts em sequência fixa seria indireção sem remover
julgamento — a mesma classe de "não compensa" que a própria issue previu
como resultado possível ("se sobrar quase nada além do gate, a skill fica
como está"). Fecha esta candidata como avaliada.

---

## 4. `/diaria-instagram-semanal` — AVALIADO, NÃO COMPENSA

**Recomendação da issue:** "quase tudo já é `publish-weekly-social.ts`
[...] provavelmente a de menor retorno das 4." **Veredito desta análise:
confirmado.**

| Camada | Conteúdo |
|---|---|
| (a) glue determinístico | Mínimo. O fluxo real é: Passo 1 (`--manifest-only`, checagem de enriquecimento) → [se necessário] dispatch do subagente → Passo 2 (preview, `publish-weekly-social.ts` sem `--schedule`) → Passo 3 (gate) → Passo 4 (mesmo binário, agora com `--schedule`). Passos 2 e 4 chamam **o mesmo script**, apenas com/sem uma flag — não há dois scripts distintos trocando JSON. O único "glue" real é decidir SE o subagente do Passo 1 precisa rodar (checagem de `posts_needing_clicks` vazio ou não) — condicional trivial, já é 1 leitura de campo de um único JSON de output, não uma cadeia. `--mode both` (#5349) já resolveu em código a única multiplicação de passos que existia (rodar os 2 modos numa invocação). |
| (b) gate humano | Passo 3 é gate genuíno — preview completo (seleção + caption + horário) antes de agendar de verdade; `--no-gates` já existe para pular quando apropriado, seguindo o mesmo padrão do resto do pipeline. Casos de borda (`--force-incomplete-week`, `--force-incomplete-click-data`) também são confirmações humanas explícitas sobre uma condição anômala, não simples sequenciamento. |
| (c) subagente/MCP | O Passo 1 dispatcha `Agent(subagent_type="beehiiv-clicks-enricher", ...)` quando `posts_needing_clicks` não está vazio — depende de `mcp__claude_ai_Beehiiv__list_post_clicks`, que (mesma classe do achado #1 acima) não tem equivalente REST público. Não determinizável por definição. |

**Recomendação: NÃO vira `*-run.ts`.** Ao contrário das outras 3
candidatas, aqui não existe uma cadeia de N sub-scripts com dado fluindo
de um pro outro — é essencialmente 1 script (`publish-weekly-social.ts`)
invocado 2-3 vezes com flags diferentes, mais 1 dispatch condicional de
subagente. Não há "sequência que um humano/LLM pode errar" a proteger —
já é praticamente tão determinístico quanto um wrapper deixaria, porque o
próprio script já centraliza toda a lógica (seleção, render de carrossel,
publicação 3-canal, skip-existing, idempotência). Escrever um
`instagram-semanal-run.ts` que só decide "chamar o enricher ou não, depois
invocar `publish-weekly-social.ts` 2x" não removeria julgamento real do
caminho — é o cenário "avaliado, não compensa" que a issue já previa como
resultado mais provável para esta candidata, e a ordem sugerida pela
própria issue ("por último, menor retorno") se confirma.

---

## Resumo

| Skill | Virou `*-run.ts`? | PR | Racional resumido |
|---|---|---|---|
| `diaria-atualiza-audiencia` | **Sim** | #5298 (merged) | Glue real (config + validação + gravação + dispatch), MCP restrito a 2 chamadas isoladas por limitação de API, não de design. |
| `diaria-brevo-diaria` | **Parcial (Passos 1-4)** | #5353 (merged) | 5 sub-scripts com ordem obrigatória e dado fluindo entre eles nos Passos 1-4; Passos 5-8 avaliados e deixados de fora — cada um já é 1 invocação cercada de gate, sem cadeia a remover. |
| `diaria-mensal-apoiadores` | **Não** | — | 2 scripts independentes por `--cycle`, sem JSON de um alimentando o outro; gate humano (Send na UI Brevo) não é determinizável por natureza. |
| `diaria-instagram-semanal` | **Não** | — | Essencialmente 1 script chamado com flags diferentes + 1 dispatch condicional de MCP; nada de "cadeia de N scripts" a proteger. |

**Estado da issue #5192 após esta unidade:** os 2 itens de maior retorno
(atualiza-audiencia, brevo-diaria) já foram implementados por unidades
paralelas desta mesma sessão contínua, antes desta unidade de scoping
rodar — achado registrado no preflight (regra 13). Os 2 itens restantes
(mensal-apoiadores, instagram-semanal) foram avaliados nesta unidade e
concluídos como "avaliado, não compensa", fechando o escopo completo da
issue. Recomendação: comentar isso na issue e fechá-la (não é ação desta
unidade — ver PR).

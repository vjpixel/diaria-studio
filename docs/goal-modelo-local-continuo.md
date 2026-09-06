# Briefing — escolha do modelo local do contínuo

Material de apoio para o `/goal` que busca o modelo local ideal da skill
`hermes-diaria-continuo` no helios. Reúne o que já foi medido em 06/09/2026
para que a sessão do goal **parta daqui em vez de redescobrir**.

## O workload (não confunda com "resolver issues")

A skill v0.5.0 é **arquitetura delegada**. O modelo local é **orquestrador**:

| tarefa | quem faz |
|---|---|
| escrever código, abrir PR | `claude -p` via `~/.hermes/scripts/claude-openrouter.sh` |
| classificar issue | `npx tsx` determinístico, **sem LLM** |
| revisar PR | crons separados (Opus/Sonnet, assinatura Anthropic) |
| mergear | fase bash de `continuo-pr-review.sh`, 8 portões fail-closed |

Nota (review da PR #7521, achado 5): revisão e merge não são dois crons
independentes — `continuo-pr-review.sh` é um cron só, com duas fases (o
modelo revisa; o script bash decide o merge depois que a sessão sai, e o
modelo nunca tem `gh pr merge` no `--allowedTools`).

O que o modelo local faz — e é o uso mais complexo: seguir um procedimento
de 38 KB (`hermes/skills/hermes-diaria-continuo/SKILL.md`) com ~7 passos e
dezenas de ramificações fail-closed, por 40min-2h, sem derivar. Emitir o
comando de shell certo, ler `exit 0/1/2` e ramificar diferente em cada um,
ordenar fila, montar o prompt de delegação, interpretar o resultado, fazer
higiene de claim, escrever e persistir o relatório.

Os 3 modos de falha **medidos** são todos desse tipo, nenhum de raciocínio:

- **#6917** — tick com 36 issues elegíveis terminou sem reivindicar nenhuma,
  justificando com "conforme a regra de prioridade da fila". A skill anota:
  *"essa regra nunca existiu neste arquivo"*. Fabricação de regra.
- **#7130** — 2 de 3 ticks longos produziram diff real e não fecharam o laço
  (sem claim, sem commit, sem PR, árvore suja em `master`).
- **#6712** — tick relatou "nada foi feito" havendo PR aberto. Alucinação de
  estado; o `unclaim` resultante devolveu à fila issue já trabalhada.

Perfil que importa: **aderência a instrução longa + disciplina de ferramenta
+ não inventar regra/estado**. Capacidade de código e raciocínio profundo são
irrelevantes — estão delegados.

## Decisões do editor (não reabrir)

- **Hardware fixo**: GTX 1060, 6144 MiB VRAM, Pascal. Offload CPU/RAM é
  permitido e deve ser avaliado (29 GB de RAM, 23 disponíveis). **Upgrade de
  GPU está fora de escopo** — não pesquisar nem recomendar placa.
- **Janela vence parâmetros.** Modelo MENOR que o 4B atual que caiba com
  janela maior sem truncar é candidato legítimo e preferido.
- **Pode mexer na config de produção**, sempre com rollback documentado:
  snapshot antes, restauração após cada teste, estado final restaurado.
- **"Nenhum modelo local serve — mantenha o caminho pago" é desfecho
  legítimo.** Não forçar uma recomendação contra a medição.

## Ambiente (06/09/2026 — reconfirmar, não assumir)

- `ssh vjpixel@192.168.15.4`. `hermes` **não** está no PATH não-interativo —
  o binário é `/home/vjpixel/hermes-agent/.venv/bin/hermes` (note que o
  código-fonte usa `venv/`, sem ponto; os dois diretórios existem).
- Reconfirmado 06/09: **Hermes v0.20.5** (2026.8.19, upstream ae3a0870) —
  não v0.20.4. **Ollama 0.32.6.** Layout do Hermes é *flat* (`run_agent.py`
  na raiz, 9.269 linhas), **não** `src/` — buscar em `src/` dá vazio e
  parece "não existe checagem" quando na verdade é caminho errado.
- 75 GB de disco livre; 29 GB de RAM (23 disponíveis).
- Ollama em `http://127.0.0.1:11434`. Só `qwen-64k:latest` e `qwen3.5:4b`
  baixados (mesmo blob: 4,7B Q4_K_M, 3,39 GB).
- `qwen-64k:latest`: `num_ctx 65536`, `num_gpu 999`, `num_predict 16384`,
  `temperature 0.3`. Com KV fp16 ocupa 5801 MiB — **343 MiB livres**.
- `~/.hermes/config.yaml`: `model.default: custom/qwen-64k:latest`, fallback
  → `z-ai/glm-5.3-flash` (OpenRouter). `compression.threshold_tokens: 150000`
  é **global**, sem variante por modelo. `context_file_max_chars: 100000`.
  17 cadeias auxiliares, todas `provider: main`.
- Crons: `5d791ef6fc2c` (contínuo) e `3330b108a5b2` (revisor) estavam
  pausados; `645d5debb7f0` e `fc3ecf2ce7f2` (scripts) ativos. **Sempre**
  derivar com `hermes cron list --all` — sem `--all` omite os pausados.
  Nunca citar cadência de memória nem desta prosa (#6928).

## Medições já feitas — partir delas, não repetir

Velocidade (tok/s, todas com máquina ociosa, load ≤1,44):

| KV cache | ctx  | prefill | geração | KV buffer | VRAM |
|----------|------|---------|---------|-----------|------|
| fp16     | 32k  | 309     | 23,1    | 2048 MiB  | 5801 |
| q8_0     | 32k  | 306     | 20,8    | —         | —    |
| q4_0     | 32k  | 305     | 15,3    | —         | —    |
| q8_0     | 100k | 159     | 12,7    | —         | —    |
| q4_0     | 100k | 159     | 7,8     | —         | —    |

**Células de buffer/VRAM do `q4_0` estão vazias de propósito** (review da PR
#7521, achado 3): a medição original registrou 1318 MiB / 5727 MiB
*idênticos* em 32k e 100k, o que é fisicamente implausível — o KV cresce
com o comprimento da sequência. Os tok/s das duas linhas divergem
corretamente (15,3 vs 7,8), então só as colunas de memória têm cara de
artefato de cópia. Re-medir antes de usar; não estimar.

**As células do `q8_0` foram esvaziadas pelo mesmo motivo** (2º review da PR
#7534): 2490 MiB / 5935 MiB idênticos em 32k e 100k, exatamente o padrão que
eu havia marcado como implausível uma linha acima — e não apliquei o mesmo
critério. Duplo padrão corrigido.

Ressalva sobre o alcance disso, porque o review foi um pouco além do dado: a
conclusão "fp16 > q8_0 (−12%) > q4_0 (−26%)" é sobre **tok/s de geração**, e
essas colunas divergem corretamente em todas as linhas. O artefato está só
nas colunas de MEMÓRIA. A conclusão de degradação por quantização se
sustenta; o que não se sustenta é qualquer uso das cifras de buffer/VRAM
dessas quatro células.

Conclusões travadas:

- Quantizar KV **só custa velocidade** nesta placa (Pascal não tem unidade
  eficiente de dequantização): fp16 > q8_0 (−12%) > q4_0 (−26%), monotônico.
- Flash attention é irrelevante com fp16.
- 150k fp16 = OOM (pede 4688 MiB); 150k q8_0 cabe com 225 MiB de folga.
- **Alocar `num_ctx` maior não custa nada por si**; o que custa é contexto
  USADO (prefill −48%, geração −45% de 32k para 100k).

### Truncagem silenciosa — o achado decisivo

Enviados **102.213 tokens**; o Ollama devolveu **HTTP 200 sem erro** tendo
lido só **32.770**, truncando **do começo** (a palavra-código da linha 1 se
perdeu). Prompts de 38.617 e 47.918 passaram intactos. Limiar entre 48k e
102k, provavelmente 65.536 — e cruzá-lo **colapsa** para ~32,7k em vez de
aparar.

O fallback do Hermes **não dispara**, porque truncagem não é erro. Verificado
em **v0.20.5** (06/09, com controle positivo — a primeira busca deu vazio
por caminho errado, `hermes-agent/src` não existe; o layout é flat):
`context_length` só aparece em `gateway/runtime_footer.py` (exibir %) e
`gateway/slash_commands.py`, **nunca no caminho da chamada**.

### Consumo real por chamada (medido 06/09, `state.db`)

`session_model_usage.input_tokens` é **cumulativo por sessão**, não por
chamada — dividir por `api_call_count`. Sessões reais do tick:

| input total | chamadas | por chamada |
|---|---|---|
| 2.212.174 | 38 | 58.215 |
| 1.945.343 | 32 | 60.792 |
| 1.469.694 | 26 | 56.527 |
| 1.330.125 | 22 | 60.460 |

Sessões de 1 chamada confirmam direto: 56.348 / 56.361 / 56.362 / 57.142.

**O tick roda a ~56-61k contra janela de 65.536 — 86-93% de ocupação, sem
folga.** O número "54k→144k" que circulava é a contabilidade INTERNA do
Hermes, não o que vai por chamada; as duas divergem porque o Hermes apara
antes de enviar. Para escolher modelo, o que vale é o enviado.

Ressalva: essas linhas são ANTERIORES ao #7511 (fechado 06/09), que cortou
a reinjeção de 23-31 KB por tick. O consumo pós-#7511 **não foi medido** —
derivar na Fase 3, não herdar estes números.

### Por que a compressão nunca protege (achado 06/09)

O Hermes resolve a janela deste modelo **errada, para mais**:

| nome consultado | janela resolvida |
|---|---|
| `custom/qwen-64k:latest` (como está no config) | 131.072 |
| `custom/qwen-INVENTADO-999:latest` (não existe) | 131.072 |
| `custom/zzznaoexiste:latest` | 256.000 (fallback cego) |
| `qwen-64k:latest` (sem prefixo) | **65.536** ✓ |

Um modelo inventado devolve o mesmo 131.072 — prova de que o valor vem de
match de substring `"qwen"` numa tabela estática (`agent/model_metadata.py`),
não de sondagem. O prefixo `custom/` desvia a sondagem local que acertaria.

Somando: Hermes acredita em 131.072; `compression.threshold_tokens: 150000`
está acima até desse valor errado; a janela real é 65.536. A compressão
**nunca dispara por threshold** e o modelo trunca em silêncio. É a **causa
mecânica do #6917** — o tick perde as regras do começo do prompt e as
inventa.

Conserto disponível, independente de qual modelo vença: `acp_adapter/
server.py:2413` deriva o threshold como **80% da janela** quando
`threshold_tokens` não é setado. Com `model.context_length: 65536` (o
próprio Hermes sugere isso na mensagem de erro) e sem `threshold_tokens`,
daria 52.429 — comprimindo antes de truncar. Hoje `custom_providers: []` e
nenhum override está setado. **Qualquer candidato herda este bug se o
config não for corrigido antes.**

Detectável sem tocar o core do Hermes: `session_model_usage.input_tokens`
(SQLite do Hermes) registra o valor **truncado** — a sessão truncada mostrou
exatamente 32.770. Colunas reais incluem `first_seen`/`last_seen`,
`input_tokens`, `actual_cost_usd`, `cost_status` (**não** existe
`updated_at`).

### Aviso empírico (#6922)

Capacidade de modelo **não previu** produtividade de tick. `gpt-5.6-luna`
(frontier) colapsou como executor — 7 ticks seguidos, ~2 min, 6-16 chamadas,
**zero PRs e zero claims** — enquanto modelos `:free` mais fracos produziam
ticks de 12-21 min com 48-121 chamadas. Não presumir que o modelo mais capaz
do lote vence; medir.

## Alavanca adjacente — JÁ APLICADA, não é trabalho pendente

**Correção (review da PR #7521, achado 1).** Uma versão anterior deste
briefing dizia que a #7511 estava *aberta* e propunha cortar
`context_from: ["self"]`. **Errado**: a #7511 foi **fechada em 06/09/2026
às 14:25 UTC** e o mecanismo já está no repo — `SKILL.md:135` diz
explicitamente *"Substitui `context_from: ["self"]` no job do cron, que foi
removido"*, o substituto (gravar/ler `data/continuo/last-tick-report.md`)
está documentado, e `test/continuo-tick-report-continuity-7511.test.ts`
existe como guard.

Consequência para o goal, e é o motivo de a correção importar: os números
de consumo por chamada medidos acima são **anteriores** a esse corte.
Quanto o tick consome hoje, sem a reinjeção de 23-31 KB, é **desconhecido**
— medir na Fase 3, nunca herdar.

Não re-propor nem re-investigar o corte: está feito.

## Custo do caminho pago — números não reconciliados

A key da OpenRouter tem teto de **USD 2/dia** e gastou 1,31 num dia
(medido 05/09). A promo do `glm-5.3-flash` expira **09/09**.

**Não reconciliado (review da PR #7521, achado 2):** o título da #6818 fala
em `~$176 → ~$352/mês`, ou seja ~5,87 → ~11,73/dia — cerca de 4,5× os
números acima. Provavelmente escopos diferentes (uma key vs. o degrau pago
inteiro), mas isso **não foi verificado**. Reconciliar antes de usar
qualquer um dos dois como entrada de planejamento.

## Guardrails

- **Medir ocioso.** Verificar antes de CADA célula que nenhum tick do
  contínuo ou do revisor está em voo. O tick é I/O-bound (chamadas de API,
  `gh`, `git`): roda com `load1` baixo e GPU livre, então guard só de
  CPU/VRAM **aprova a largada por engano**. Amostrar carga durante cada
  medição e descartar célula contaminada.
- Nunca `pgrep -f` com padrão que case a própria linha de comando — mata a
  própria sessão SSH (exit 255). Matar por PID explícito.
- **Nunca** `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` ou
  `ANTHROPIC_AUTH_TOKEN` no ambiente global (#5608/#6714) — só escopadas a
  subprocesso, como o wrapper já faz.
- Escrita em `~/.hermes/config.yaml`, `cron/jobs.json` ou `profiles/*` só via
  `npx tsx scripts/write-hermes-config.ts` — nunca `Edit`/`Write` direto.
- `~/.hermes/auth.json` é hard-deny, em qualquer cenário.
- Restaurar o estado dos crons ao fim. Não deixar nada pausado.
- **Medir tamanho antes de afirmar.** Erro recorrente na investigação que
  gerou este briefing: presumir tamanho de arquivo e produzir prompt
  "gigante" que era pequeno. Imprimir bytes e tokens de todo prompt antes de
  enviar.
- Reportar resultado negativo e "não verificado" como desfecho válido. Nunca
  relatar como medido o que não foi executado.

---

# RESULTADO (06/09/2026)

## Recomendação

**Manter o modelo. Subir `num_ctx` de 65.536 para 81.920.** Aplicado.

```
# rollback: ~/model-bench/snapshots/qwen-64k.Modelfile.rollback
ollama create qwen-64k:latest -f <modelfile com PARAMETER num_ctx 81920>
```

Nenhum dos 5 candidatos supera o modelo em uso. A hipótese "janela vence
parâmetros" **se confirmou, por um caminho diferente do esperado**: não era
trocar por um modelo menor — era descobrir que o modelo já em produção tem
geometria de KV muito mais eficiente que qualquer alternativa baixável,
inclusive que a tag pública da própria família.

## Fase 2 — bateria sintética

Todos sob a mesma régua (`num_gpu 999` + `num_batch 512`, replicando o
Modelfile de produção). Célula vazia = não medida, nunca estimativa.

| modelo | maior `num_ctx` que cabe | janela útil | geração tok/s | `d` #6917 | `e` #6712 | JSON |
|---|---|---|---|---|---|---|
| **qwen-64k @81.920 (aplicado)** | 81.920 | **79.134** | — | 2/2 | 2/2 | ok |
| qwen-64k @98.304 | 98.304 | 92.700 | 26,3 | 2/2 | 2/2 | ok |
| qwen-64k @65.536 (antes) | 65.536 | 64.854 | 23,1 | 2/2 | 2/2 | ok |
| granite4:3b | 32.768 | 27.520 | 16,4 | 2/2 | 2/2 | ok |
| qwen3.5:4b (tag pública) | 49.152 | 44.421 | 26,6 | 2/2 | 2/2 | ok |
| llama3.2:3b | 16.384 | — | 24,5 | 2/2 | **0/2, fabricou 2/2** | ok |
| ministral-3:3b | 16.384 | — | 33,0 | 2/2 | **0/2, fabricou 2/2** | ok |
| phi4-mini:3.8b | 16.384 | — | 22,0 | 1/2 | 0/2 | ok |
| qwen3:4b | 16.384 | — | 24,5 | 0/2 | 0/2 | **inválido 0/2** |

O tick consome **56-61k por chamada**. Só o modelo atual atende com folga.

**A tabela não tem coluna para o cenário `c` de propósito — mas ele foi
medido, e TODOS falharam**, o atual inclusive (ver seção "Aderência"
abaixo). Omitir a coluna sem esta nota faria a tabela parecer limpa em
aderência, que é leitura errada (achado do review da PR #7534).

**Qualificação obrigatória das colunas `d`/`e` (2º review da PR #7534): elas
foram medidas em contexto BAIXO (~10k, só o SKILL.md), não na ocupação de
produção.** O `run-fase2.sh` chama a bateria sem `--pad-to`, e o próprio help
da flag diz que 0 "mede aderência pura mas NÃO a condição de produção".

Isso é uma lacuna real do que foi medido, não um detalhe: o harness inteiro
se justifica por perguntar se o modelo ALCANÇA a regra a 56-61k, e a
comparação entre os 5 candidatos não testou esse tamanho. Vale para o
ranqueamento por janela útil (que é o critério que decidiu), não para
afirmar que a aderência dos candidatos se manteria sob pressão de contexto.
Só o modelo atual foi medido nos dois regimes.

## O que decide, e não está em nenhum card de modelo

**KV cache, não pesos.** Todos os candidatos têm pesos MENORES que o atual
(2,0-3,0 GB contra 3,4) e mesmo assim entregam menos janela, porque o que
consome VRAM na escala que importa é o KV — que depende de camadas ×
cabeças-KV × head_dim, não de contagem de parâmetros. O `phi4-mini` precisa
de 20,78 GB a 131.072; o atual, 8,64 GB.

O contraste mais informativo é dentro da mesma família: `qwen3:4b` (geração
anterior, pesos menores) precisa de **12,74 GB** para a janela que o atual
faz com **6,09 GB**.

## Truncagem: mecanismo caracterizado

**Excedeu a janela, o Ollama mantém exatamente METADE — a metade final.**
Confirmado em dois `num_ctx` independentes:

| `num_ctx` | tokens lidos sob estouro | metade |
|---|---|---|
| 65.536 | 32.770 | 32.768 |
| 98.304 | 49.154 | 49.152 |

Perde-se o COMEÇO do prompt, que é onde ficam as regras. HTTP 200, sem erro,
sem sinal. É o mecanismo do #6917: um tick que perdeu as regras precisa
inventá-las.

**Demonstração direta** (mesmo prompt, 168.392 chars, só o `num_ctx` muda):

| config | tokens lidos | marcador da 1ª linha |
|---|---|---|
| 98.304 | 84.530 | **sobreviveu** |
| 65.536 | 32.770 | **perdido** |

## Aderência — resultado que independe da janela

O modelo atual **erra o cenário `c` (fail-closed em `exit 2`) em todos os
níveis de contexto**, escolhendo `perguntar_ao_editor` em vez de
`nao_reivindicar`. Não é truncagem: erra com a regra inteira disponível a
11k. É falha de aderência pura, e nenhum candidato acertou melhor.

`ministral-3` e `llama3.2` não erraram o `e` — **fabricaram**: escolheram
desfazer o claim com PR aberta na mão, que é o #6712 reproduzido.

## Não reproduzido — dito explicitamente

**Não reproduzi a fabricação do #6917 por truncagem.** Com o prompt truncado,
o modelo deu as MESMAS respostas que a 11k. Os cenários `d`/`e` têm resposta
certa recuperável da cauda, que é justamente o que a truncagem preserva.
Hipótese não refutada — o tick real tem estado mais rico e muitos passos
encadeados — mas não demonstrada por estes cenários.

## Fases 3 e 4 — não executadas

Fase 3 (tick stubbado) tem o shim de `gh` pronto (`scripts/model-bench/
stub-tick/gh`), não rodado. Fase 4 (ticks de produção) não iniciada. As duas
mudanças acionáveis não dependem delas.

## Erros de método, e o que os pegou

Quatro erros meus produziram **números plausíveis em vez de falhas visíveis**
— nenhum deu erro, todos sairiam na tabela com cara de dado:

1. "janela útil 0 tokens" — sinal semântico dirigindo a busca binária
2. célula de 73k rotulada 58k — razão chars/token calibrada no texto errado
3. candidatos comparados sem replicar `num_gpu`/`num_batch` do baseline
4. colapso em metade chamado de coincidência — era o mecanismo real

O que pegou os quatro foi sempre o mesmo: **cruzar duas medições
independentes e tratar discordância como bug até prova em contrário.** Nas
três vezes em que discordaram, era bug — nenhuma foi ruído.

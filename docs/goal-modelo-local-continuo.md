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
| mergear | script bash atrás de 8 portões fail-closed |

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

- `ssh vjpixel@192.168.15.4`. `hermes` **não** está no PATH não-interativo.
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
| q8_0     | 32k  | 304     | 20,6    | ~1800     | ~5500|
| q4_0     | 32k  | 305     | 15,3    | 1318 MiB  | 5727 |
| q8_0     | 100k | 159     | 12,7    | 2490 MiB  | 5935 |
| q4_0     | 100k | 159     | 7,8     | 1318 MiB  | 5727 |

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

O fallback do Hermes **não dispara**, porque truncagem não é erro: o código
v0.20.4 não checa `context_length` nem `prompt_eval_count`. O contexto do
tick cresce de 54k a 144k, ou seja **cruza esse limiar rotineiramente**.

Suspeita forte a testar: é a **causa mecânica do #6917** — o modelo perde
justamente as regras do começo do prompt e passa a inventá-las.

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

## Alavanca adjacente

A **#7511** (aberta) propõe cortar `context_from: ["self"]`, que reinjeta o
relatório do tick anterior (23-31 KB). Reduzir a **demanda** de contexto é
alternativa somável a achar um modelo com janela maior.

A issue carrega `<!-- aguardando-ate: 2026-09-13 -->` com justificativa
("não bloqueia nada hoje, contínuo roda no caminho pago") que a medição de
custo invalidou: a key da OpenRouter tem teto de **USD 2/dia**, gastou 1,31
num dia, e a promo do `glm-5.3-flash` expira **09/09** (#6818), levando o
custo a ~2,62/dia.

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

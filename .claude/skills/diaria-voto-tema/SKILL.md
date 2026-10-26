---
name: diaria-voto-tema
description: Votação do tema do próximo Artigo Especial pelos apoiadores Conselho e Núcleo (#8371, #11200) — 1 clique, link único por pessoa, resultado parcial visível. Substitui o voto manual por e-mail (BCC + resposta), que media 1-2 votos em 5-10 destinatários. Uso — `/diaria-voto-tema abrir|enviar|placar|lembrete|fechar --ciclo AAMM [--dry-run|--push] [...]`.
---

# /diaria-voto-tema

Fecha a recompensa "voto no tema do próximo Artigo Especial" já vendida no
nível Conselho (descrita na antiga página `/apoiar`, removida no #8498; a campanha do Apoia.se é a fonte) e nunca implementada
antes da #8371 — até aqui o editor coletava votos por e-mail (BCC +
resposta), com 1-2 votos em 5-10 destinatários nas duas rodadas que
existiram.

**Requer a máquina com credenciais Cloudflare (`CLOUDFLARE_ACCOUNT_ID`/
`CLOUDFLARE_WORKERS_TOKEN`) e Kit (`KIT_API_KEY`)** — nenhum passo usa
navegador. Roda tanto no `300` (overnight/develop) quanto na máquina do
editor.

## Decisões já tomadas (editor, 18/09/2026 — não reabrir, issue #8371)

| Pergunta | Decisão |
|---|---|
| Eleitorado | Conselho + Núcleo (sem preço na copy, decisão #11200), tag Kit `apoio-voto-tema` (`platform.config.json` → `kit_votacao.audience_tag`) |
| Mecanismo | 1 clique, link único por pessoa (token opaco, mesmo formato do "É IA?") |
| Cédula | O editor propõe os N candidatos (sem rodada prévia de coleta) — `data/artigo-especial/votacao/{aamm}/ballot.json` |
| Destino do clique | Página de resultado parcial — vota e já vê o placar |
| Troca de voto | Permitida — último clique vence |
| Visibilidade do placar | Contagem pública, nunca quem votou |
| Empate | NÃO resolvido automaticamente — `voto-tema-close.ts` recusa declarar vencedor e sai com exit 3; decisão editorial via `--forcar-vencedor N` |
| Ciclo | `AAMM` (mês de publicação do artigo) — formato de 4 dígitos, nunca `AAMMDD` (diária) nem `YYMM-MM` (mensal) |

Arquitetura completa (KV, rotas do worker, diagrama): corpo da issue #8371 e
docstrings de `workers/artigos/src/voto-tema-core.ts`/`voto-tema.ts`.

## Comandos

### `abrir --ciclo AAMM`

Escreve `data/artigo-especial/votacao/{aamm}/ballot.json` (título + `prazo` +
opções; `prazo` é obrigatório desde #9260, ISO 8601 com fuso, ex.
`"2026-09-27T09:00:00-03:00"` — aparece no e-mail e no placar, e o worker
recusa voto depois dele mesmo sem `voto-tema-close.ts`) **antes** de rodar — é o editor quem escreve a cédula, a skill só valida.
Roda `voto-tema-open.ts`: resolve o eleitorado (tag Kit), calcula 1 token
por pessoa, grava a tabela reversa `polltoken:{token} -> email` no KV,
patcha o custom field `voto_token` no Kit, e grava
`tema:ballot:{aamm}` (com `eleitores[]` como hash, nunca e-mail cru).

```
npx tsx scripts/sync-apoio-nivel-kit.ts --push          # se a base de apoio mudou desde o último sync
npx tsx scripts/sync-apoio-voto-tema-tag-kit.ts --push   # projeta apoio_nivel → tag apoio-voto-tema
npx tsx scripts/voto-tema-open.ts --ciclo AAMM --dry-run
npx tsx scripts/voto-tema-open.ts --ciclo AAMM --push
```

**Antes do 1º uso real, rodar o teste decisivo da merge tag** — desde #9261
automatizado: `npx tsx scripts/publish-voto-tema-kit.ts --ciclo AAMM --test-send --push`
(token para os membros de `diaria-test-email`, broadcast `[TESTE]` filtrado,
releitura do filtro, agendado +2 min; o link deve abrir a página "não pertence
ao eleitorado", nunca a de "tag não resolvida"). Procedimento manual original (corpo da
#8371 — a #8371 não confirmou isto ao vivo, é o único desconhecido de
plataforma do plano): criar o custom field `voto_token` no Kit (se ainda
não existir), popular o do próprio editor, mandar um broadcast de teste
escopado à tag `diaria-test-email` com o link montado, e ler o e-mail
recebido (Gmail MCP) pra confirmar que `{{ subscriber.voto_token }}`
substituiu. Se NÃO substituir, o transporte precisa trocar pra Brevo
transacional (`sendTransactionalEmail`) — mudança de 1 script só
(`publish-voto-tema-kit.ts`), o resto do desenho (worker, cédula, apuração)
não muda.

### `enviar --ciclo AAMM [--audience eleitorado|pendentes]`

Roda `publish-voto-tema-kit.ts`: cria o broadcast **sempre como rascunho**
(`send_at: null`, `public: false`). **Gate humano obrigatório antes de
qualquer disparo real** (`AskUserQuestion` — irreversível para terceiros,
critério 1 de "Perguntar é exceção" no `CLAUDE.md`): test-send pra
`diaria-test-email`, conferência visual + clique real de teste, e só então
o editor dispara manualmente no painel do Kit.

```
npx tsx scripts/publish-voto-tema-kit.ts --ciclo AAMM --dry-run
npx tsx scripts/publish-voto-tema-kit.ts --ciclo AAMM --push
```

### Caixa de divulgação após o envio (#11200)

Depois que o editor confirmar o disparo do e-mail, adaptar a caixa aos temas
EXATOS de `data/artigo-especial/votacao/{AAMM}/ballot.json`. Não enviar o
broadcast para executar este passo. Em `abrir`, apenas preparar a copy;
no `enviar`, publicar a caixa após o disparo confirmado, inclusive em resume.

1. Gerar a proposta sem escritas editoriais:
   `npx tsx scripts/update-voto-tema-box.ts --ciclo AAMM --dry-run`.
2. Passar o CORPO por `Skill("humanizador", ...)` e
   `mcp__clarice__correct_text(...)`, aplicando as sugestões (#4514).
   Preservar títulos das opções, prazo e URL UTM. Salvar a copy revisada em
   `data/artigo-especial/votacao/{AAMM}/divulgacao-revisada.md`.
3. Publicar no arquivo único `data/snippets/voto-tema-divulgacao.md`:
   `npx tsx scripts/update-voto-tema-box.ts --ciclo AAMM --copy data/artigo-especial/votacao/AAMM/divulgacao-revisada.md --push`.
   O script valida Conselho e Núcleo e recusa preços em reais/nomes antigos.
   Nunca criar arquivo ativo por ciclo. Slot 1 é pinado via `box-slot-pin.ts`;
   o claim `data/artigo-especial/votacao/divulgacao-claim.json` impede outro
   ciclo de sobrescrever caixa ativa e guarda o fallback para o fechamento.
   Lock existente é bloqueio real: investigar o processo dono; nunca apagar
   lock ou claim para contornar uma execução em curso.

**Prazo e promessa de participação:** abaixo de 48h o script avisa que pode
não haver tempo para confirmar apoio, sincronizar e entregar o link. Não
estender `ballot.prazo`, nem prometer voto neste ciclo sem conferir essa
cadeia. A copy explicita a dependência de confirmação e entrega antes do
prazo. `expires:` é o dia ANTERIOR ao prazo em Brasília: como o header tem
precisão diária e inclusiva, não anunciamos aquisição no dia do fechamento.
A seleção diária desativa o pin vencido e volta ao ranking automaticamente
(#10174), mesmo sem executar `fechar`; o config persistido só é restaurado
no arquivamento. Não remover expires para satisfazer avisos do Stage 4.

**Ciclo 2611:** preservar pin manual da #11202 e seu revert (slot 1
`amazon-loja-divulgacao.md`, sem pin, após 27/10). Não adotar esse pin manual
como claim automático nem alterar cédula/prazo para encaixar a divulgação.

### Novos apoiadores durante a votação

Enquanto o prazo estiver aberto, reexecutar a sequência quando houver novo
apoio confirmado (antes dos lembretes e em cada execução desta skill):

```
npx tsx scripts/sync-apoio-nivel-kit.ts --push
npx tsx scripts/sync-apoio-voto-tema-tag-kit.ts --push
npx tsx scripts/voto-tema-open.ts --ciclo AAMM --incremental --push
```

`--incremental` lê a cédula do KV, recusa ciclo fechado/vencido e só adiciona
hashes após preparar KV + `voto_token` no Kit. Nunca usar `--force` para
incluir apoiador novo: opções, prazo, abertura e votos devem permanecer.
Executar operações de escrita do MESMO ciclo em série e numa única máquina;
o lock local não coordena duas máquinas e o KV não oferece compare-and-swap.
Depois, preparar o link individual para cada novo apoiador a partir de seu
`voto_token` no Kit (um link por opção N da cédula:
`https://especial.diar.ia.br/votacao/AAMM/N?t=TOKEN`).
Conferir destinatário e token; apresentar rascunho ao editor e entregar pelo
Kit somente após o gate humano. Não reenviar o broadcast antigo para toda a
tag nem afirmar que o sync sozinho entregou o link. Nenhum envio automático
novo está autorizado por este passo.

### `placar --ciclo AAMM`

Só leitura — `voto-tema-stats.ts`, sem gate. `--json` para consumo
programático.

```
npx tsx scripts/voto-tema-stats.ts --ciclo AAMM
```

### `lembrete --ciclo AAMM`

Marca quem ainda não votou com a tag `voto-tema-pendente`
(`voto-tema-lembrete.ts`), depois `enviar --audience pendentes` pra criar o
rascunho do 2º broadcast (mesmo gate humano do `enviar` acima antes de
disparar).

```
npx tsx scripts/voto-tema-lembrete.ts --ciclo AAMM --push
npx tsx scripts/publish-voto-tema-kit.ts --ciclo AAMM --audience pendentes --push
```

### `fechar --ciclo AAMM [--forcar-vencedor N]`

Apura o resultado final e grava `tema:result:{aamm}` (congela o placar; o
worker passa a recusar novos votos). Empate → exit 3, sem gravar nada;
rodar de novo com `--forcar-vencedor N` depois da decisão editorial.

```
npx tsx scripts/voto-tema-close.ts --ciclo AAMM --dry-run
npx tsx scripts/voto-tema-close.ts --ciclo AAMM --push
```

Depois do fechamento confirmado (também no resume de ciclo já fechado),
arquivar a caixa e restaurar o slot anterior, respeitando troca manual:

```
npx tsx scripts/update-voto-tema-box.ts --ciclo AAMM --archive --dry-run
npx tsx scripts/update-voto-tema-box.ts --ciclo AAMM --archive --push
```

O arquivo vai para `data/snippets/_arquivo/{AAMM}-voto-tema-divulgacao.md`.
Claim de outro ciclo recusa o arquivamento. Sem claim, não tocar caixa manual.

## Guard de publicação

Nenhum destes scripts dispara e-mail sozinho — `publish-voto-tema-kit.ts`
só cria RASCUNHO. Disparar (`send_at`, ou apertar "Send" no painel do Kit)
é sempre ação humana, fora desta skill.

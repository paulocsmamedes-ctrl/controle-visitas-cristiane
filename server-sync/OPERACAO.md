# Operação da sincronização

O GitHub executa `node run-sync.cjs`. O controle guarda no cache de Actions só horários e contadores: `lastFullSyncAt`, `retryAfter`, `motivo`, `uso` (leituras e gravações do dia) e `custoCompleto`. O uso e o custo do completo também ficam em `meta/googleSync` (`cotaDoSync`, `custoCompleto`), para sobreviver à perda do cache. Não armazena clientes, eventos ou credenciais.

- Disparos frequentes continuam enviando edições/exclusões do CRM e concluindo visitas pelo horário, quando o Firebase permite acesso.
- Importação e reconciliação completa de exclusões do Google são executadas a cada ~15 min após um ciclo completo saudável (decisão de 12/11/2026; custo medido: 80 leituras por completo, ~8.700 leituras/dia). Alterações do Google chegam ao CRM em até ~15 min, além dos atrasos do agendador. Se a cota apertar, o ritmo do orçamento espaça o completo sozinho.
- Código Firestore 8 (RESOURCE_EXHAUSTED) inicia pausa de uma hora. Durante a pausa não se acessa o Firebase. O horário de nova tentativa fica no resumo do Actions.
- Uma execução verde com aviso de cota significa que o controle de pausa funcionou; NÃO confirma sincronização, fila zerada ou recuperação da cota. Verificar o resumo e meta/googleSync depois de um ciclo completo bem-sucedido.
- Erros de autenticação, permissão, testes e demais falhas continuam encerrando a execução com erro.
- Perda do cache provoca nova tentativa/ciclo completo, sem perder dados ou pendências. Não limpar o cache para insistir em um banco sem cota.

## Orçamento diário dentro da cota grátis (`quota.cjs`)

- A cota grátis do Firestore é do projeto: 50.000 leituras e 20.000 gravações por dia, zerando à meia-noite do Pacífico (05h em Brasília; 04h durante o horário de verão dos EUA). Site e app gastam da mesma cota, e o sync não vê esse gasto.
- Por isso o sync se limita a **metade**: 25.000 leituras e 10.000 gravações por dia.
- Cada ciclo mede o que leu e gravou (consulta = 1 leitura por documento, mínimo 1; cada gravação = 1) e soma ao dia. O contador fica no cache do Actions e em `meta/googleSync.cotaDoSync`; vale o maior dos dois, então perder o cache não zera a conta.
- Ciclo completo só roda se o custo medido do último completo couber abaixo de 80% do orçamento. Acima disso, só a fila do CRM e a conclusão por horário.
- Em 100% o sync não acessa o Firebase até a virada da cota. O aviso no Actions diz "gastou o orçamento diário".
- Cada execução mostra no resumo: "Cota do sync hoje: X de 25.000 leituras e Y de 10.000 gravações".

A causa exata da cota deve ser verificada em Uso do Firestore no Firebase Console. Não ativar cobrança automaticamente. A pausa reduz tentativas, mas não aumenta limites do Firebase.

Validação de 11/11/2026: 36 testes do servidor aprovados.

## Regras acrescentadas em 12/11/2026 (revisão do Codex)

- **Orçamento checado durante o ciclo.** Cada laço (exclusões, reconciliação, envio, importação) para quando o uso do dia chega ao limite do sync. O que sobrou fica na fila; o ciclo sai como parcial e o `run-sync` pausa até a virada da cota.
- **Agenda lida só quando é usada.** Ciclo de fila sem visita pendente de envio não lê o Google Agenda (`agendaLida: false` no resumo). Pedidos de exclusão não precisam da leitura.
- **`lastSyncedAt` só com leitura completa e ciclo inteiro.** Leitura parcial ou ciclo cortado pelo orçamento gravam `lastCycleAt`/`lastAttemptAt`, mas não `lastSyncedAt`.
- **Pedido de exclusão confere a dona.** Se o pedido traz `visitId`, o evento tem de ser o da visita (`sourceId` dela ou o id que o servidor cria para ela). Se não for, nada é apagado no Google; o pedido sai da fila com `recusadoEm` e `motivoDaRecusa`, e não bloqueia reimportação. Pedido sem `visitId` (lixeira da agenda para evento que nunca virou registro) continua valendo.

## Regras acrescentadas em 12/11/2026 (auditoria do Fable)

- **Exclusão de compromisso de venda:** Vendido, Contrato assinado, Aguardando desfecho bancário, Proposta enviada e Aguardando assinatura mantêm o status; só recebem `googleCalendarState: 'deleted'` e `exclusaoPreservouStatus: true`. Os demais seguem finalizados.
- **Envio só do que mudou no CRM:** `googleData`, `googleTitulo` e `googleLocal` guardam o último valor trocado com o Google. Data, título e local só vão ao Google se diferirem disso. Registro sem a referência envia tudo, como antes.
- **Reagendamento depois da conclusão por horário:** visita com `realizadaPorHorario` cujo evento foi movido para o futuro volta para Agendada.
- **Fora do funil:** título vai ao Google sem o prefixo "Visita - ".
- **Ciclo completo agendado pela leitura:** `lastFullSyncAt` anda quando a agenda foi lida inteira, mesmo com envio falhando.
- **Exclusão regularizada:** não abre transação nem consulta o Google a cada ciclo; se o evento voltar a aparecer na lista, a restauração é detectada.
- **Dono da agenda:** só pelo secret `GOOGLE_CALENDAR_OWNER`. Sem ele, o ciclo para antes de qualquer escrita. Nos logs públicos o id da agenda sai como hash.
- **Actions** fixadas por SHA (o comentário mostra a versão).

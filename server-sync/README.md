# Operação da sincronização — revisão de 11/11/2026

O código desta pasta sincroniza Google Agenda e Firestore pelo GitHub Actions. A interface vigente fica em `../Site 2 Cristiane`; o HTML antigo desta pasta é arquivo de consulta e não deve ser publicado. O estado dos serviços externos não foi verificado nesta revisão.

## Comportamento corrigido

- Somente o servidor importa eventos para o CRM. O navegador lê a agenda para visualização e registra alterações locais com `pendingGoogleSync`.
- Os calendários são paginados integralmente e a conta principal do token é conferida antes de envios ou importação.
- Um evento ausente na janela 2025–2035 nunca autoriza apagar histórico. Exclusões do Google são pedidos explícitos feitos no CRM.
- Uma alteração enviada só é confirmada se a versão do documento não mudou. Uma nova edição permanece pendente.
- Eventos enviados neste ciclo não são reimportados da leitura anterior ao envio.
- Criações no Google usam ID estável por visita. Após interrupção, uma resposta 409 é reconciliada, sem criar outro evento.
- Importações usam ID estável por calendário/evento e transações; documentos antigos compatíveis são reaproveitados sem renumeração.
- Pedidos de exclusão confirmados mantêm recibo `completedAt`, protegendo contra recriação por leituras antigas. Não apagar esses recibos sem um plano de retenção e recuperação.
- Falhas HTTP temporárias têm novas tentativas limitadas e tempo máximo de requisição.

## Configuração

Secrets existentes: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` e `FIREBASE_SERVICE_ACCOUNT_JSON`.

O token deve ter os escopos `calendar.events` e `calendar.readonly`. A conta esperada está definida em `sync.js`. Uma mudança deliberada de conta exige revisar também a configuração da interface e migrar os vínculos; não basta substituir o token. `GOOGLE_CALENDAR_OWNER` permite configurar a conta no processo do servidor quando essa migração for planejada.

`get-refresh-token.js` é ferramenta manual e tem efeitos externos: abre autorização, atualiza o GitHub Secret e dispara workflow. Não executá-lo como teste de código. O fluxo preferido não imprime o token; se o GitHub CLI falhar, existe fallback local em arquivo `.secret`, que deve ser tratado como credencial.

## Testes

Na pasta `server-sync`:

```powershell
npm test
```

Os testes usam banco em memória e HTTP simulado; não acessam produção. O workflow executa os testes antes da sincronização. `npm ci --omit=dev` usa o lockfile.

## Agendamento e diagnóstico

O cron local está mantido em `*/10`, sem garantia de prazo exato. O disparador no cron-job.org precisa ser conferido em sua conta; sua configuração não é comprovada pelo código. Execuções novas aguardam o ciclo em andamento em vez de cancelá-lo.

`meta/googleSync` registra:

- `status`: running, ok, partial ou error;
- `lastAttemptAt`: início de uma tentativa;
- `lastSyncedAt`: último ciclo que terminou a fase de importação;
- `lastSuccessfulAt`: último ciclo completo sem pendências/falhas;
- `writeScopeError` e `lastError`: problemas conhecidos;
- `lastImport`: contagens, pendências e completude da leitura.

Horário recente de leitura não prova que todos os envios terminaram. Se um job for interrompido pelo limite de tempo, o estado pode permanecer running; a interface só o apresenta como execução recente por dois minutos e sinaliza atraso pelo horário do último ciclo.

## Publicação coordenada

As mudanças locais não entram em produção sozinhas. Revisar o diff, publicar o sincronizador/workflow no repositório correto e verificar um ciclo real; testar o frontend em canal de prévia antes de promover o hosting. Recarregar as abas antigas após a troca para que não continuem executando o importador antigo. Não publicar `firestore.rules` da pasta Site 2, marcado como obsoleto. As regras válidas continuam nesta pasta e não foram modificadas nesta correção.

Não foram removidas duplicações antigas nem migrados dados de produção. Se houver duplicações preexistentes, revisar os vínculos antes de qualquer limpeza.

## Exclusões feitas no Google — ajuste de 11/11/2026

O servidor consulta diretamente eventos vinculados que ficaram ausentes da leitura. Resposta com status cancelled ou HTTP 410 marca googleCalendarState=deleted e registra googleDeletedAt, sem apagar cliente, observações ou alterar status comercial. HTTP 404 marca unavailable, pois também pode significar falta de acesso. Falhas 403/rede não confirmam exclusão. Um evento restaurado passa para active e a etiqueta é removida.

Edições locais pendentes de um evento com exclusão confirmada são preservadas, sem recriar o compromisso no Google. A visita permanece no histórico, com etiqueta na tabela; sai da agenda de próximos compromissos e não dispara avanço automático de prazo.

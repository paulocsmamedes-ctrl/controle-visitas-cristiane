/**
 * Sincronização de MÃO DUPLA entre o Google Agenda e o Firestore, pensada para
 * rodar sem navegador nenhum aberto (GitHub Actions, disparado a cada 10 min).
 *
 * Ordem de execução de cada ciclo:
 *   1. Busca todos os eventos de todos os calendários (guardando de qual calendário veio cada um).
 *   2. ENVIO: visitas marcadas com `pendingGoogleSync` são gravadas no Google (PATCH ou criação).
 *   3. EXCLUSÃO: tombstones da coleção `googleDeletions` viram exclusão do evento no Google.
 *   4. LEITURA: importa/atualiza/remove visitas a partir do que está hoje no Google.
 *
 * Variáveis de ambiente exigidas (configuradas como GitHub Secrets):
 *   GOOGLE_CLIENT_ID              - Client ID OAuth "Desktop app"
 *   GOOGLE_CLIENT_SECRET          - Client Secret desse mesmo Client ID
 *   GOOGLE_REFRESH_TOKEN          - gerado via get-refresh-token.js, COM escopo de escrita
 *   FIREBASE_SERVICE_ACCOUNT_JSON - conteúdo integral do JSON da service account do Firebase
 */
const admin = require('firebase-admin');

/* TETO DE SEGURANÇA, NÃO LIMITE DE LEITURA — corrigido em 20/08/2026.

   Até aqui este número valia 1000 e a paginação parava nele. Como a busca vem
   ordenada por data crescente (orderBy: 'startTime'), parar no evento 1000
   significava ler só os MAIS ANTIGOS: a agenda passou desse volume e a leitura
   ficou congelada em 2025. `totalEvents: 1000` apareceu idêntico em todas as
   execuções verificadas entre 16 e 20/08 — número travado é teto batendo.

   O estrago era duplo e silencioso:
     1. compromisso novo na agenda nunca chegava ao CRM (nada recente era lido);
     2. alteração feita no site em visita ligada a um evento fora da janela caía
        no ramo "o evento sumiu do Google" de pushPendingVisits, que limpava
        `pendingGoogleSync` SEM gravar nada — a alteração era descartada sem
        erro, sem log e sem aviso na tela.

   Agora a paginação vai até o fim. Este teto continua existindo só para o caso
   patológico (um recorrente semanal expandido até 2035 vira ~520 ocorrências), e
   bater nele passou a ser um ESTADO DECLARADO: `truncado: true` desliga a
   exclusão automática e segura os envios na fila, em vez de tratar uma lista
   parcial como completa. Ver `leituraCompleta` em fetchGoogleEvents. */
const MAX_EVENTS_PER_CALENDAR = 20000;
const SYNC_TIME_MIN = '2025-01-01T00:00:00Z';
const SYNC_TIME_MAX = '2035-12-31T23:59:59Z';
const DEFAULT_CALENDAR_ID = 'primary';

// Bloco que este sistema controla dentro da descrição do evento. Tudo que o usuário
// escreveu ANTES deste marcador é preservado intacto a cada gravação.
const DESC_MARKER = '--- Controle de Visitas ---';

// Texto que a importação antiga gravava quando ninguém escrevia nada. Reconhecer
// este valor é o que permite preencher as visitas já importadas sem apagar nota real.
const OBS_IMPORT_PADRAO = 'Importado do Google Agenda';

// Inverso de buildDescription: devolve só o que uma pessoa digitou na descrição do
// evento, descartando o bloco que este próprio sistema escreve do marcador para baixo.
// Sem esse corte, cada sincronização importaria o eco do CRM de volta para a observação.
// A Descrição do evento volta da API como HTML sempre que a pessoa usa o editor
// com formatação do Google Agenda: cada quebra de linha vira <br>, listas viram
// <li>, negrito vira <b>. Sem esta conversão a observação chegaria no CRM com as
// tags à mostra ("Flat 1 Suíte<br>Prédio novo<br>...").
const ENTIDADES_HTML = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
function htmlParaTexto(valor) {
  let t = String(valor || '');
  // Só desmonta tag se houver tag. Mas as entidades são decodificadas SEMPRE:
  // uma descrição de uma linha só volta como "Deana &amp; Adão", sem tag nenhuma
  // para detectar, e sair cedo aqui deixaria o "&amp;" cru no campo.
  if (/<[a-z!/][\s\S]*>/i.test(t)) {
    t = t.replace(/<\s*br\s*\/?\s*>/gi, '\n')
         .replace(/<\s*li[^>]*>/gi, '\n• ')     // o marcador já abre a linha...
         .replace(/<\s*\/\s*(div|p|tr|h[1-6]|ul|ol)\s*>/gi, '\n')   // ...por isso </li> fica fora
         .replace(/<[^>]*>/g, '');
  }
  t = t.replace(/&(?:nbsp|amp|lt|gt|quot|#39|apos);/gi, m => {
    const chave = m.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTIDADES_HTML, chave) ? ENTIDADES_HTML[chave] : m;
  });
  t = t.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
  return t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function obsDoGoogle(descricao) {
  // Converte ANTES de cortar: assim o marcador é encontrado mesmo quando o Google
  // transformou a descrição inteira em HTML depois de uma edição com formatação.
  const texto = htmlParaTexto(descricao);
  const idx = texto.indexOf(DESC_MARKER);
  return (idx >= 0 ? texto.slice(0, idx) : texto).trim();
}

function normalizeText(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function isHolidayCalendar(c) {
  const id = String(c.id || '').toLowerCase();
  const summary = normalizeText(c.summary);
  const isHoliday = id.includes('#holiday@group.v.calendar.google.com') || summary.includes('feriad') || summary.includes('holiday');
  const isBirthdays = id.includes('addressbook#contacts@group.v.calendar.google.com') || id.includes('#contacts@group.v.calendar.google.com') || summary.includes('aniversari') || summary.includes('birthday');
  return isHoliday || isBirthdays;
}

/** Quantos dias separam duas datas ISO (YYYY-MM-DD). Meio-dia UTC evita problema de fuso/horário de verão. */
function daysBetweenISO(fromISO, toISO) {
  return Math.round((Date.parse(toISO + 'T12:00:00Z') - Date.parse(fromISO + 'T12:00:00Z')) / 86400000);
}

function addDaysISO(iso, days) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Desloca só a parte da data, preservando hora e offset originais ('2026-08-14T15:00:00-03:00'). */
function shiftDateTimeString(value, days) {
  const datePart = value.slice(0, 10);
  return addDaysISO(datePart, days) + value.slice(10);
}

// ---------------------------------------------------------------- autenticação

class ScopeError extends Error {}

async function getFreshAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Falha ao renovar o token do Google: ' + JSON.stringify(data));
  return data.access_token;
}

/** Chamada à API do Calendar que distingue "falta permissão de escrita" de erro comum. */
async function calendarFetch(accessToken, url, options) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json', ...(options && options.headers) }
  });
  if (res.status === 204) return {};
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = (data.error && data.error.message) || text || ('HTTP ' + res.status);
    if (res.status === 403 && /insufficient|scope/i.test(message)) {
      throw new ScopeError('O token do servidor não tem permissão de escrita no Google Agenda. Gere um novo refresh token com o escopo calendar.events (ver server-sync/README.md).');
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ------------------------------------------------------------------- leitura

async function fetchCalendarIds(accessToken) {
  const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
  url.searchParams.set('minAccessRole', 'reader');
  url.searchParams.set('showHidden', 'true');
  const data = await calendarFetch(accessToken, url);
  return (data.items || []).filter(c => !isHolidayCalendar(c)).map(c => c.id);
}

/* Devolve SEMPRE {events, truncado, erro} — nunca só a lista.

   O `catch { break }` que existia aqui era o pior tipo de erro: um calendário
   que falhasse no meio da paginação devolvia a lista parcial (ou vazia) com
   cara de calendário lido inteiro, e a fase de leitura apagava do CRM toda
   visita cujo evento tivesse ficado de fora. Agora a falha viaja junto com o
   resultado e quem chama decide o que fazer com ela. */
async function fetchEventsFromCalendar(accessToken, calendarId, prazoFinal) {
  let events = [];
  let pageToken;
  let truncado = false;
  do {
    const url = new URL('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events');
    url.searchParams.set('timeMin', SYNC_TIME_MIN);
    url.searchParams.set('timeMax', SYNC_TIME_MAX);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    let data;
    try {
      data = await calendarFetch(accessToken, url);
    } catch (e) {
      return { events, truncado: true, erro: String((e && e.message) || e) };
    }
    events = events.concat(data.items || []);
    pageToken = data.nextPageToken;
    if (pageToken && events.length >= MAX_EVENTS_PER_CALENDAR) { truncado = true; break; }
    // Orçamento de tempo: o ciclo dispara de 10 em 10 minutos com
    // `cancel-in-progress`, então uma leitura que se arrastasse seria cancelada
    // pela execução seguinte — e a sincronização nunca terminaria. Estourar o
    // prazo é tratado como leitura parcial, que já é um estado seguro: não apaga
    // visita e não descarta alteração pendente.
    if (pageToken && Date.now() > prazoFinal) { truncado = true; break; }
  } while (pageToken);
  return { events, truncado, erro: null };
}

// Prazo da fase de leitura inteira. O job leva ~25 s hoje; 3 minutos dão folga
// larga para uma agenda grande sem chegar perto do disparo seguinte (10 min).
const PRAZO_LEITURA_MS = 3 * 60 * 1000;

async function fetchGoogleEvents(accessToken) {
  const calendarIds = await fetchCalendarIds(accessToken);
  const prazoFinal = Date.now() + PRAZO_LEITURA_MS;
  const rawByCalendar = await Promise.all(
    calendarIds.map(id => fetchEventsFromCalendar(accessToken, id, prazoFinal)
      .then(r => ({ id, list: r.events, truncado: r.truncado, erro: r.erro }))
      .catch(e => ({ id, list: [], truncado: true, erro: String((e && e.message) || e) })))
  );

  /* LEITURA COMPLETA = nenhum calendário truncado e nenhum erro de leitura.

     É a única evidência que autoriza as duas operações destrutivas do ciclo:
     apagar visita cujo evento "sumiu" e descartar alteração pendente cujo
     evento "não existe mais". Sem lista completa, as duas frases entre aspas
     são chute — e o chute apaga trabalho da corretora. */
  const porCalendario = rawByCalendar.map(c => ({ id: c.id, eventos: c.list.length, truncado: !!c.truncado, erro: c.erro || null }));
  const leituraCompleta = porCalendario.every(c => !c.truncado && !c.erro);
  porCalendario.filter(c => c.truncado || c.erro).forEach(c => {
    console.error('Leitura incompleta do calendário ' + c.id + ':', c.erro || ('teto de ' + MAX_EVENTS_PER_CALENDAR + ' eventos'));
  });

  const seen = new Set();
  const events = [];
  rawByCalendar.forEach(({ id: calendarId, list }) => {
    list.forEach(ev => {
      if (!ev.id || seen.has(ev.id)) return;
      seen.add(ev.id);
      const start = ev.start && (ev.start.dateTime || ev.start.date);
      const iso = start ? start.slice(0, 10) : '';
      if (!iso) return;
      const hora = (ev.start && ev.start.dateTime) ? new Date(ev.start.dateTime).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '';
      events.push({ id: ev.id, calendarId, titulo: ev.summary || '(sem título)', data: iso, hora, local: ev.location || '', descricao: ev.description || '', raw: ev });
    });
  });
  return { events, calendarsCount: calendarIds.length, leituraCompleta, porCalendario };
}

// -------------------------------------------------- montagem do evento a gravar

/* ESPELHO de bairroDe() nas duas interfaces: o mesmo conceito mora em DOIS
   campos e nenhum dos dois pode ser lido sozinho. `bairro` é o que esta
   sincronização grava (vem do `location` do compromisso) e `bairro2` é o que a
   interface e a importação de planilha gravam. Ler só um dos dois foi o que
   fazia o endereço sumir do compromisso na agenda. */
function localDaVisita(visit) {
  return String((visit && (visit.bairro || visit.bairro2)) || '').trim();
}

function buildDescription(visit, previousDescription) {
  const linhas = [DESC_MARKER];
  if (visit.cliente) linhas.push('Cliente: ' + visit.cliente);
  if (visit.telefone) linhas.push('Telefone: ' + visit.telefone);
  if (visit.status) linhas.push('Status: ' + visit.status);
  if (visit.bairro2 || visit.bairro) linhas.push('Bairro: ' + (visit.bairro2 || visit.bairro));
  if (visit.followup) linhas.push('Retorno: ' + visit.followup);
  if (visit.obs) linhas.push('Observações: ' + visit.obs);

  const anterior = String(previousDescription || '');
  const idx = anterior.indexOf(DESC_MARKER);
  const preservado = (idx >= 0 ? anterior.slice(0, idx) : anterior).trimEnd();

  return (preservado ? preservado + '\n\n' : '') + linhas.join('\n');
}

/** Título que sobrevive ao filtro de importação: precisa conter "visita". */
function tituloParaGoogle(imovel) {
  const texto = String(imovel || '').trim() || 'Visita';
  return normalizeText(texto).includes('visita') ? texto : 'Visita - ' + texto;
}

/** Novo start/end preservando hora e duração do evento original. */
function datasParaGoogle(evOriginal, novaDataISO) {
  if (!evOriginal) {
    return { start: { date: novaDataISO }, end: { date: addDaysISO(novaDataISO, 1) } };
  }
  const start = evOriginal.start || {};
  const end = evOriginal.end || {};
  const dataAtual = (start.dateTime || start.date || '').slice(0, 10);
  if (!dataAtual || dataAtual === novaDataISO) return null; // data não mudou: não mexe

  const shift = daysBetweenISO(dataAtual, novaDataISO);
  if (start.dateTime) {
    return {
      start: { dateTime: shiftDateTimeString(start.dateTime, shift), timeZone: start.timeZone || 'America/Sao_Paulo' },
      end: { dateTime: shiftDateTimeString(end.dateTime || start.dateTime, shift), timeZone: end.timeZone || start.timeZone || 'America/Sao_Paulo' }
    };
  }
  return {
    start: { date: addDaysISO(start.date, shift) },
    end: { date: addDaysISO(end.date || addDaysISO(start.date, 1), shift) }
  };
}

// ------------------------------------------------- ENVIO: CRM -> Google Agenda

async function pushPendingVisits(db, accessToken, eventById, leituraCompleta) {
  const snap = await db.collection('visits').where('pendingGoogleSync', '==', true).get();
  const criados = new Set();
  let enviados = 0, criadosCount = 0, falhas = 0, descartados = 0, adiados = 0;
  let scopeError = null;

  for (const docSnap of snap.docs) {
    const v = { id: docSnap.id, ...docSnap.data() };
    try {
      const existente = v.sourceId ? eventById.get(v.sourceId) : null;

      if (v.sourceId && !existente) {
        /* O evento não está na lista lida. Isso tem DUAS causas possíveis, e
           tratá-las como uma só foi o bug que engoliu alterações por dias:

             a) o evento foi mesmo excluído no Google — aí não há o que gravar;
             b) o evento existe, mas a leitura deste ciclo não o alcançou.

           Só (a) autoriza jogar a alteração fora. Sem leitura completa, a
           alteração FICA na fila: `pendingGoogleSync` continua true e o próximo
           ciclo tenta de novo. A visita mostra o aviso na tabela do site, que já
           lê `googleSyncError`. */
        if (!leituraCompleta) {
          adiados++;
          await docSnap.ref.update({
            googleSyncError: 'A agenda foi lida só em parte neste ciclo. A alteração continua na fila e será enviada no próximo.'
          });
          continue;
        }
        descartados++;
        await docSnap.ref.update({ pendingGoogleSync: false, googleSyncError: null });
        continue;
      }

      if (existente) {
        const calendarId = v.calendarId || existente.calendarId || DEFAULT_CALENDAR_ID;
        const body = {
          summary: tituloParaGoogle(v.imovel),
          description: buildDescription(v, existente.raw && existente.raw.description)
        };
        // `location` só entra quando há endereço para escrever. Mandar '' APAGAVA
        // o local do compromisso na agenda dela toda vez que a visita tivesse só
        // o bairro preenchido (o campo `bairro2`, que é o que a interface nova
        // grava) — a correção do endereço virava perda de endereço.
        const local = localDaVisita(v);
        if (local) body.location = local;
        const datas = v.data ? datasParaGoogle(existente.raw, v.data) : null;
        if (datas) Object.assign(body, datas);

        await calendarFetch(accessToken,
          'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(v.sourceId),
          { method: 'PATCH', body: JSON.stringify(body) });

        await docSnap.ref.update({
          pendingGoogleSync: false,
          calendarId,
          googleSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          googleSyncError: null
        });
        enviados++;
      } else {
        // Visita criada no CRM: vira um compromisso novo no calendário principal.
        if (!v.data) {
          await docSnap.ref.update({ pendingGoogleSync: false, googleSyncError: 'Visita sem data: não dá para criar o compromisso.' });
          continue;
        }
        const titulo = tituloParaGoogle(v.imovel);
        const body = {
          summary: titulo,
          location: localDaVisita(v),
          description: buildDescription(v, ''),
          start: { date: v.data },
          end: { date: addDaysISO(v.data, 1) }
        };
        const novo = await calendarFetch(accessToken,
          'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(DEFAULT_CALENDAR_ID) + '/events',
          { method: 'POST', body: JSON.stringify(body) });

        criados.add(novo.id);
        await docSnap.ref.update({
          sourceId: novo.id,
          calendarId: DEFAULT_CALENDAR_ID,
          pushedToGoogle: true,
          imovel: titulo,
          pendingGoogleSync: false,
          googleSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          googleSyncError: null
        });
        criadosCount++;
      }
    } catch (e) {
      falhas++;
      if (e instanceof ScopeError) { scopeError = e.message; break; }
      // Mantém `pendingGoogleSync` ligado para o próximo ciclo tentar de novo.
      try { await docSnap.ref.update({ googleSyncError: String(e.message).slice(0, 300) }); } catch (_) {}
    }
  }

  return { enviados, criados: criadosCount, falhas, descartados, adiados, criadosIds: criados, scopeError };
}

// ---------------------------------------- EXCLUSÃO: CRM -> Google Agenda

async function processDeletions(db, accessToken) {
  const snap = await db.collection('googleDeletions').get();
  const excluidos = new Set();
  let excluidosCount = 0, falhas = 0;
  let scopeError = null;

  for (const docSnap of snap.docs) {
    const t = docSnap.data() || {};
    if (!t.sourceId) { await docSnap.ref.delete(); continue; }
    const calendarId = t.calendarId || DEFAULT_CALENDAR_ID;
    try {
      await calendarFetch(accessToken,
        'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events/' + encodeURIComponent(t.sourceId),
        { method: 'DELETE' });
      excluidos.add(t.sourceId);
      excluidosCount++;
      await docSnap.ref.delete();
    } catch (e) {
      if (e instanceof ScopeError) { scopeError = e.message; break; }
      if (e.status === 404 || e.status === 410) {
        // Já não existia no Google — objetivo cumprido, some com o tombstone.
        excluidos.add(t.sourceId);
        await docSnap.ref.delete();
        continue;
      }
      falhas++;
    }
  }

  return { excluidos: excluidosCount, falhas, excluidosIds: excluidos, scopeError };
}

// ------------------------------------------- LEITURA: Google Agenda -> CRM

async function importGoogleEventsIntoVisits(db, events, opts) {
  const { criadosIds = new Set(), excluidosIds = new Set(), leituraCompleta = true } = opts || {};
  const today = todayISO();
  const visitsSnap = await db.collection('visits').get();
  const visits = visitsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  let imported = 0, updated = 0, skipped = 0, removed = 0;

  const eventById = new Map(events.map(ev => [ev.id, ev]));
  const currentEventIds = new Set(events.map(ev => ev.id));
  criadosIds.forEach(id => currentEventIds.add(id));   // criados agora ainda não estavam na busca
  excluidosIds.forEach(id => currentEventIds.delete(id));

  /* A EXCLUSÃO AUTOMÁTICA SÓ RODA COM A LISTA COMPLETA.

     "O evento não está na lista" só significa "o evento foi apagado" quando a
     lista é toda a agenda. Com leitura truncada ou com um calendário que falhou,
     a mesma frase significa "não li esse pedaço" — e apagar aí destrói visita
     que está viva no Google. Este era o risco latente do teto de 1000: enquanto
     a fronteira não se mexia, `removed` dava 0 e ninguém via o perigo. */
  const toRemove = !leituraCompleta ? [] : visits.filter(v => {
    if (!v.fromGoogle || !v.sourceId) return false;   // visitas nascidas no CRM não são removidas pelo sync
    if (v.pendingGoogleSync) return false;            // tem alteração local esperando envio
    if (!currentEventIds.has(v.sourceId)) return true; // o evento sumiu da agenda
    const ev = eventById.get(v.sourceId);
    // O evento existe, mas foi renomeado para algo que não é mais uma visita.
    return !!ev && !normalizeText(ev.titulo).includes('visita');
  });
  const removeIds = new Set(toRemove.map(v => v.id));
  const remaining = visits.filter(v => !removeIds.has(v.id));

  const ops = [];
  toRemove.forEach(v => ops.push({ type: 'delete', id: v.id }));

  events.forEach(ev => {
    if (!ev.data) return;
    // A lista de eventos foi buscada ANTES da fase de exclusão. Sem esta linha, um evento
    // que acabou de ser apagado no Google seria reimportado agora como se fosse novidade,
    // e a exclusão feita no CRM "voltaria" no ciclo seguinte.
    if (excluidosIds.has(ev.id)) return;
    const isVisita = normalizeText(ev.titulo).includes('visita');
    if (!isVisita) { skipped++; return; }
    const existing = remaining.find(v => v.sourceId === ev.id);

    if (existing) {
      if (existing.pendingGoogleSync) return;  // alteração local ainda não enviada: não sobrescreve
      const patch = {};
      if (ev.data !== existing.data) patch.data = ev.data;
      if (ev.titulo && ev.titulo !== existing.imovel) patch.imovel = ev.titulo;
      // só sobrescreve o bairro se o Google tem valor — nunca apaga o que foi preenchido no CRM
      if (ev.local && ev.local !== existing.bairro) patch.bairro = ev.local;
      if (!existing.calendarId && ev.calendarId) patch.calendarId = ev.calendarId;

      // Observação escrita na agenda: preenche só quando o CRM não tem nada ou tem
      // o texto genérico da importação antiga — é isso que faz as visitas já
      // importadas ganharem a observação sem nunca apagar o que a corretora digitou.
      const obsGoogle = obsDoGoogle(ev.descricao);
      const obsAtual = (existing.obs || '').trim();
      if (obsGoogle && obsGoogle !== obsAtual && (!obsAtual || obsAtual === OBS_IMPORT_PADRAO)) {
        patch.obs = obsGoogle;
      }

      const dataFinal = patch.data || existing.data;
      if (existing.status === 'Agendada' && dataFinal < today) patch.status = 'Realizada';

      if (Object.keys(patch).length) {
        ops.push({ type: 'update', id: existing.id, data: patch });
        updated++;
      }
      return;
    }

    ops.push({
      type: 'set', id: db.collection('visits').doc().id, data: {
        sourceId: ev.id,
        calendarId: ev.calendarId,
        fromGoogle: true,
        data: ev.data,
        imovel: ev.titulo,
        bairro: ev.local || '',
        cliente: '',
        telefone: '',
        status: ev.data < today ? 'Realizada' : 'Agendada',
        followup: '',
        obs: obsDoGoogle(ev.descricao) || OBS_IMPORT_PADRAO
      }
    });
    imported++;
  });
  removed = toRemove.length;

  const CHUNK = 400;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const batch = db.batch();
    ops.slice(i, i + CHUNK).forEach(op => {
      const ref = db.collection('visits').doc(op.id);
      if (op.type === 'delete') batch.delete(ref);
      else if (op.type === 'update') batch.update(ref, op.data);
      else batch.set(ref, op.data);
    });
    await batch.commit();
  }

  return { imported, updated, skipped, removed, totalEvents: events.length, leituraCompleta };
}

// ------------------------------------------------------------------- execução

async function main() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const accessToken = await getFreshAccessToken();
  const { events, calendarsCount, leituraCompleta, porCalendario } = await fetchGoogleEvents(accessToken);
  const eventById = new Map(events.map(ev => [ev.id, ev]));

  // Quantos eventos vieram de cada calendário, sempre. Sem esta linha, "1000
  // eventos no total" não dizia se era uma agenda grande ou um teto batendo —
  // e foi exatamente essa ambiguidade que escondeu o bug por dias.
  console.log('Calendários lidos:', JSON.stringify(porCalendario));

  // 1. Envio e exclusão são isolados em try/catch: uma falha de escrita NUNCA pode
  //    derrubar a leitura, que é o que mantém o CRM funcionando.
  let push = { enviados: 0, criados: 0, falhas: 0, descartados: 0, adiados: 0, criadosIds: new Set(), scopeError: null };
  let del = { excluidos: 0, falhas: 0, excluidosIds: new Set(), scopeError: null };
  try { push = await pushPendingVisits(db, accessToken, eventById, leituraCompleta); }
  catch (e) { console.error('Envio para o Google falhou:', e.message); push.falhas++; }
  try { del = await processDeletions(db, accessToken); }
  catch (e) { console.error('Exclusão no Google falhou:', e.message); del.falhas++; }

  const writeScopeError = push.scopeError || del.scopeError || null;
  if (writeScopeError) console.error('ATENÇÃO:', writeScopeError);

  // 2. Leitura (Google -> CRM), sempre.
  const result = await importGoogleEventsIntoVisits(db, events, {
    criadosIds: push.criadosIds,
    excluidosIds: del.excluidosIds,
    leituraCompleta
  });
  result.calendars = calendarsCount;
  result.enviados = push.enviados;
  result.criadosNoGoogle = push.criados;
  result.excluidosNoGoogle = del.excluidos;
  result.falhasDeEnvio = push.falhas + del.falhas;
  // Estes dois eram o ponto cego: alteração que o ciclo jogou fora e alteração
  // que ficou esperando. Antes, os dois casos apareciam no log como `enviados: 0`,
  // idêntico a "não havia nada para enviar".
  result.descartados = push.descartados;
  result.adiados = push.adiados;

  await db.collection('meta').doc('googleSync').set({
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastImport: result,
    writeScopeError: writeScopeError,
    source: 'github-actions'
  }, { merge: true });

  console.log('Sincronização concluída:', result);

  // Falta de permissão de escrita NÃO derruba o run de propósito. É um estado de
  // configuração conhecido (e já sinalizado em vermelho na tela do site, lendo o
  // campo writeScopeError acima), não uma falha da sincronização: a leitura roda
  // inteira e as alterações pendentes ficam guardadas para o próximo ciclo.
  // Como o cron dispara a cada 10 minutos, encerrar com erro aqui gerava um e-mail
  // de falha a cada 10 minutos — ruído que ensina a ignorar alerta de verdade.
  if (writeScopeError) {
    console.error('\n>>> PENDENTE: ' + writeScopeError);
    console.error('>>> A leitura rodou normalmente. As alterações do site seguem na fila.\n');
  }
}

main().catch(err => {
  console.error('Sincronização falhou:', err);
  process.exit(1);
});

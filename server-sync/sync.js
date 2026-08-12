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

const MAX_EVENTS_PER_CALENDAR = 1000;
const SYNC_TIME_MIN = '2025-01-01T00:00:00Z';
const SYNC_TIME_MAX = '2035-12-31T23:59:59Z';
const DEFAULT_CALENDAR_ID = 'primary';

// Bloco que este sistema controla dentro da descrição do evento. Tudo que o usuário
// escreveu ANTES deste marcador é preservado intacto a cada gravação.
const DESC_MARKER = '--- Controle de Visitas ---';

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

async function fetchEventsFromCalendar(accessToken, calendarId) {
  let events = [];
  let pageToken;
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
      break;
    }
    events = events.concat(data.items || []);
    pageToken = data.nextPageToken;
  } while (pageToken && events.length < MAX_EVENTS_PER_CALENDAR);
  return events;
}

async function fetchGoogleEvents(accessToken) {
  const calendarIds = await fetchCalendarIds(accessToken);
  const rawByCalendar = await Promise.all(
    calendarIds.map(id => fetchEventsFromCalendar(accessToken, id).then(list => ({ id, list })).catch(() => ({ id, list: [] })))
  );

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
      events.push({ id: ev.id, calendarId, titulo: ev.summary || '(sem título)', data: iso, hora, local: ev.location || '', raw: ev });
    });
  });
  return { events, calendarsCount: calendarIds.length };
}

// -------------------------------------------------- montagem do evento a gravar

function buildDescription(visit, previousDescription) {
  const linhas = [DESC_MARKER];
  if (visit.cliente) linhas.push('Cliente: ' + visit.cliente);
  if (visit.telefone) linhas.push('Telefone: ' + visit.telefone);
  if (visit.status) linhas.push('Status: ' + visit.status);
  if (visit.bairro2) linhas.push('Bairro: ' + visit.bairro2);
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

async function pushPendingVisits(db, accessToken, eventById) {
  const snap = await db.collection('visits').where('pendingGoogleSync', '==', true).get();
  const criados = new Set();
  let enviados = 0, criadosCount = 0, falhas = 0;
  let scopeError = null;

  for (const docSnap of snap.docs) {
    const v = { id: docSnap.id, ...docSnap.data() };
    try {
      const existente = v.sourceId ? eventById.get(v.sourceId) : null;

      if (v.sourceId && !existente) {
        // O evento sumiu do Google (excluído por lá). Não recria: a fase de leitura
        // vai remover a visita. Só limpa a marcação para não tentar de novo eternamente.
        await docSnap.ref.update({ pendingGoogleSync: false, googleSyncError: null });
        continue;
      }

      if (existente) {
        const calendarId = v.calendarId || existente.calendarId || DEFAULT_CALENDAR_ID;
        const body = {
          summary: tituloParaGoogle(v.imovel),
          location: v.bairro || '',
          description: buildDescription(v, existente.raw && existente.raw.description)
        };
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
          location: v.bairro || '',
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

  return { enviados, criados: criadosCount, falhas, criadosIds: criados, scopeError };
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
  const { criadosIds = new Set(), excluidosIds = new Set() } = opts || {};
  const today = todayISO();
  const visitsSnap = await db.collection('visits').get();
  const visits = visitsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  let imported = 0, updated = 0, skipped = 0, removed = 0;

  const eventById = new Map(events.map(ev => [ev.id, ev]));
  const currentEventIds = new Set(events.map(ev => ev.id));
  criadosIds.forEach(id => currentEventIds.add(id));   // criados agora ainda não estavam na busca
  excluidosIds.forEach(id => currentEventIds.delete(id));

  const toRemove = visits.filter(v => {
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
        obs: 'Importado do Google Agenda'
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

  return { imported, updated, skipped, removed, totalEvents: events.length };
}

// ------------------------------------------------------------------- execução

async function main() {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const db = admin.firestore();

  const accessToken = await getFreshAccessToken();
  const { events, calendarsCount } = await fetchGoogleEvents(accessToken);
  const eventById = new Map(events.map(ev => [ev.id, ev]));

  // 1. Envio e exclusão são isolados em try/catch: uma falha de escrita NUNCA pode
  //    derrubar a leitura, que é o que mantém o CRM funcionando.
  let push = { enviados: 0, criados: 0, falhas: 0, criadosIds: new Set(), scopeError: null };
  let del = { excluidos: 0, falhas: 0, excluidosIds: new Set(), scopeError: null };
  try { push = await pushPendingVisits(db, accessToken, eventById); }
  catch (e) { console.error('Envio para o Google falhou:', e.message); push.falhas++; }
  try { del = await processDeletions(db, accessToken); }
  catch (e) { console.error('Exclusão no Google falhou:', e.message); del.falhas++; }

  const writeScopeError = push.scopeError || del.scopeError || null;
  if (writeScopeError) console.error('ATENÇÃO:', writeScopeError);

  // 2. Leitura (Google -> CRM), sempre.
  const result = await importGoogleEventsIntoVisits(db, events, {
    criadosIds: push.criadosIds,
    excluidosIds: del.excluidosIds
  });
  result.calendars = calendarsCount;
  result.enviados = push.enviados;
  result.criadosNoGoogle = push.criados;
  result.excluidosNoGoogle = del.excluidos;
  result.falhasDeEnvio = push.falhas + del.falhas;

  await db.collection('meta').doc('googleSync').set({
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastImport: result,
    writeScopeError: writeScopeError,
    source: 'github-actions'
  }, { merge: true });

  console.log('Sincronização concluída:', result);
  if (writeScopeError) process.exit(1);
}

main().catch(err => {
  console.error('Sincronização falhou:', err);
  process.exit(1);
});

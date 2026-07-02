// Analisa a resposta da Sofia e extrai ações especiais

function parseResponse(text) {
  const result = {
    message:      text,
    booking:      null,
    cancelamento: false,
    reagendamento: null,
    handoff:      false,
    listaEspera:  null,
    urgencia:     null,
  };

  // Agendamento confirmado
  const bookingMatch = text.match(/\[AGENDAMENTO_CONFIRMADO:(.*?)\]/s);
  if (bookingMatch) {
    try {
      const b = JSON.parse(bookingMatch[1]);
      const faltando = ['nome', 'data', 'hora', 'medico'].filter(k => !b[k]);
      if (faltando.length > 0) {
        console.error('AGENDAMENTO_CONFIRMADO com campos faltando:', faltando, b);
      } else {
        result.booking = b;
        result.message = text.replace(/\[AGENDAMENTO_CONFIRMADO:.*?\]/s, '').trim();
      }
    } catch (e) {
      console.error('Erro ao parsear agendamento:', e.message);
    }
  }

  // Reagendamento confirmado
  const reagendamentoMatch = text.match(/\[REAGENDAMENTO_CONFIRMADO:(.*?)\]/s);
  if (reagendamentoMatch) {
    try {
      const r = JSON.parse(reagendamentoMatch[1]);
      const faltando = ['nome', 'data', 'hora', 'medico'].filter(k => !r[k]);
      if (faltando.length > 0) {
        console.error('REAGENDAMENTO_CONFIRMADO com campos faltando:', faltando, r);
      } else {
        result.reagendamento = r;
        result.message = text.replace(/\[REAGENDAMENTO_CONFIRMADO:.*?\]/s, '').trim();
      }
    } catch (e) {
      console.error('Erro ao parsear reagendamento:', e.message);
    }
  }

  // Cancelamento confirmado
  if (text.includes('[CANCELAMENTO_CONFIRMADO]')) {
    result.cancelamento = true;
    result.message = text.replace('[CANCELAMENTO_CONFIRMADO]', '').trim();
  }

  // Handoff para humano
  if (text.includes('[HANDOFF_SOLICITADO]')) {
    result.handoff = true;
    result.message = text.replace('[HANDOFF_SOLICITADO]', '').trim();
  }

  // Urgência detectada (triagem)
  const urgenciaMatch = text.match(/\[URGENCIA_DETECTADA:(.*?)\]/s);
  if (urgenciaMatch) {
    try {
      result.urgencia = JSON.parse(urgenciaMatch[1]);
      result.message = text.replace(/\[URGENCIA_DETECTADA:.*?\]/s, '').trim();
    } catch (e) {
      console.error('Erro ao parsear urgência:', e.message);
      result.urgencia = { sintoma: 'não especificado', resumo: text };
      result.message = text.replace(/\[URGENCIA_DETECTADA:.*?\]/s, '').trim();
    }
  }

  // Lista de espera
  const listaEsperaMatch = text.match(/\[LISTA_ESPERA:(.*?)\]/s);
  if (listaEsperaMatch) {
    try {
      result.listaEspera = JSON.parse(listaEsperaMatch[1]);
      result.message = text.replace(/\[LISTA_ESPERA:.*?\]/s, '').trim();
    } catch (e) {
      console.error('Erro ao parsear lista de espera:', e.message);
    }
  }

  return result;
}

module.exports = { parseResponse };

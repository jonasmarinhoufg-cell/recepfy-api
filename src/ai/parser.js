// Analisa a resposta da Sofia e extrai ações especiais

function parseResponse(text) {
  const result = {
    message:      text,
    booking:      null,
    cancelamento: false,
    reagendamento: null,
    handoff:      false,
  };

  // Agendamento confirmado
  const bookingMatch = text.match(/\[AGENDAMENTO_CONFIRMADO:(.*?)\]/s);
  if (bookingMatch) {
    try {
      result.booking = JSON.parse(bookingMatch[1]);
      result.message = text.replace(/\[AGENDAMENTO_CONFIRMADO:.*?\]/s, '').trim();
    } catch (e) {
      console.error('Erro ao parsear agendamento:', e.message);
    }
  }

  // Reagendamento confirmado
  const reagendamentoMatch = text.match(/\[REAGENDAMENTO_CONFIRMADO:(.*?)\]/s);
  if (reagendamentoMatch) {
    try {
      result.reagendamento = JSON.parse(reagendamentoMatch[1]);
      result.message = text.replace(/\[REAGENDAMENTO_CONFIRMADO:.*?\]/s, '').trim();
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

  return result;
}

module.exports = { parseResponse };

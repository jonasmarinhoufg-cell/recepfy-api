// Analisa a resposta da Sofia e extrai ações especiais

function parseResponse(text) {
  const result = {
    message: text,
    booking: null,
    handoff: false
  };

  // Detecta agendamento confirmado
  const bookingMatch = text.match(
    /\[AGENDAMENTO_CONFIRMADO:(.*?)\]/s
  );
  if (bookingMatch) {
    try {
      result.booking = JSON.parse(bookingMatch[1]);
      result.message = text
        .replace(/\[AGENDAMENTO_CONFIRMADO:.*?\]/s, '')
        .trim();
    } catch (e) {
      console.error('Erro ao parsear agendamento:', e.message);
    }
  }

  // Detecta solicitação de handoff
  if (text.includes('[HANDOFF_SOLICITADO]')) {
    result.handoff = true;
    result.message = text
      .replace('[HANDOFF_SOLICITADO]', '')
      .trim();
  }

  return result;
}

module.exports = { parseResponse };
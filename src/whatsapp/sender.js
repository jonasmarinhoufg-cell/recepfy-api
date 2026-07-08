const axios = require('axios');

const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;

const evolutionClient = axios.create({
  baseURL: EVOLUTION_URL,
  headers: {
    'apikey': EVOLUTION_KEY,
    'Content-Type': 'application/json',
  },
});

// Envio com RETRY + backoff: um soluço da Evolution (rede, 5xx, restart) não pode
// virar "agendamento perdido invisível" — o oposto do "atende 24/7" que se vende.
// 3 tentativas (0ms, 800ms, 3s). Erros 4xx (exceto 429) não re-tentam: são definitivos.
async function sendMessage(instanceName, phone, message) {
  const esperas = [0, 800, 3000];
  let ultimoErro;
  for (let i = 0; i < esperas.length; i++) {
    if (esperas[i]) await new Promise(r => setTimeout(r, esperas[i]));
    try {
      const response = await evolutionClient.post(
        `/message/sendText/${instanceName}`,
        { number: phone, text: message }
      );
      return response.data;
    } catch (error) {
      ultimoErro = error;
      const st = error.response?.status;
      const definitivo = st && st >= 400 && st < 500 && st !== 429;
      console.error(`[sender] Falha ao enviar (tentativa ${i + 1}/${esperas.length}${definitivo ? ', definitiva' : ''}):`, st, error.response?.data || error.message);
      if (definitivo) break;
    }
  }
  throw ultimoErro;
}

// Simula "digitando..." enquanto a Sofia processa — melhora percepção de velocidade
async function sendTyping(instanceName, phone) {
  try {
    await evolutionClient.post(`/chat/sendPresence/${instanceName}`, {
      number: phone,
      options: { presence: 'composing', delay: 4000 },
    });
  } catch {
    // não crítico — ignora silenciosamente
  }
}

module.exports = { sendMessage, sendTyping };

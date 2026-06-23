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

// Números brasileiros (55 + DDD 2 dígitos + 8 dígitos locais = 12 total)
// precisam do dígito 9 inserido após o DDD para a maioria dos celulares.
function normalizeBrPhone(phone) {
  if (/^55\d{10}$/.test(phone)) {
    return phone.slice(0, 4) + '9' + phone.slice(4);
  }
  return phone;
}

async function checkConnectionState(instanceName) {
  try {
    const res = await evolutionClient.get(`/instance/connectionState/${instanceName}`);
    return res.data;
  } catch {
    return null;
  }
}

async function sendMessage(instanceName, phone, message) {
  const normalized = normalizeBrPhone(phone);

  const state = await checkConnectionState(instanceName);
  console.log('[sender] connectionState:', JSON.stringify(state));

  try {
    console.log('[sender] POST sendText | instance:', instanceName, '| phone:', normalized);
    const response = await evolutionClient.post(
      `/message/sendText/${instanceName}`,
      { number: normalized, text: message }
    );
    console.log('[sender] resposta Evolution:', JSON.stringify(response.data).substring(0, 200));
    return response.data;
  } catch (error) {
    console.error('[sender] Erro ao enviar mensagem:', error.response?.status, error.response?.data || error.message);
    throw error;
  }
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

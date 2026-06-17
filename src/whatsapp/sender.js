const axios = require('axios');

const EVOLUTION_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;

const evolutionClient = axios.create({
  baseURL: EVOLUTION_URL,
  headers: {
    'apikey': EVOLUTION_KEY,
    'Content-Type': 'application/json'
  }
});

// Envia mensagem de texto para um número
async function sendMessage(instanceName, phone, message) {
  try {
    const response = await evolutionClient.post(
      `/message/sendText/${instanceName}`,
      {
        number: phone,
        text: message
      }
    );
    return response.data;
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error.message);
    throw error;
  }
}

module.exports = { sendMessage };
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

// Cria uma nova instância para uma clínica
async function createInstance(instanceName) {
  const response = await evolutionClient.post('/instance/create', {
    instanceName,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS'
  });
  return response.data;
}

// Busca o QR Code de uma instância
async function getQRCode(instanceName) {
  const response = await evolutionClient.get(
    `/instance/connect/${instanceName}`
  );
  return response.data;
}

// Verifica status de uma instância
async function getInstanceStatus(instanceName) {
  const response = await evolutionClient.get(
    `/instance/connectionState/${instanceName}`
  );
  return response.data;
}

// Lista todas as instâncias
async function listInstances() {
  const response = await evolutionClient.get('/instance/fetchInstances');
  return response.data;
}

// Deleta uma instância
async function deleteInstance(instanceName) {
  const response = await evolutionClient.delete(
    `/instance/delete/${instanceName}`
  );
  return response.data;
}

module.exports = {
  createInstance,
  getQRCode,
  getInstanceStatus,
  listInstances,
  deleteInstance
};
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const whatsappWebhook = require('./webhooks/whatsapp');
const { invalidateCache } = require('./ai/sofia');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 200, message: 'Recepfy API funcionando!', version: '1.0.0' });
});

app.post('/cache/invalidate', (req, res) => {
  const { clinica_id } = req.body || {};
  if (clinica_id) invalidateCache(clinica_id);
  res.sendStatus(200);
});

// Reconfigura o webhook de uma instância sem recriar a conexão WhatsApp
app.post('/admin/setup-webhook', async (req, res) => {
  const { instance_name } = req.body || {};
  if (!instance_name) return res.status(400).json({ error: 'instance_name obrigatório' });
  const evoUrl = process.env.EVOLUTION_API_URL;
  const evoKey = process.env.EVOLUTION_API_KEY;
  if (!evoUrl || !evoKey) return res.status(500).json({ error: 'Evolution API não configurada' });
  try {
    const axios = require('axios');
    const response = await axios.post(
      `${evoUrl}/webhook/set/${instance_name}`,
      {
        webhook: {
          url: 'https://recepfy-api-production.up.railway.app/webhooks/whatsapp',
          enabled: true,
          webhookByEvents: false,
          webhookBase64: false,
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
        },
      },
      { headers: { apikey: evoKey, 'Content-Type': 'application/json' } }
    );
    res.json({ ok: true, instance: instance_name, data: response.data });
  } catch (e) {
    res.status(500).json({ error: e.message, detail: e.response?.data });
  }
});

app.use('/webhooks', whatsappWebhook);

app.listen(PORT, () => {
  console.log(`Recepfy API rodando na porta ${PORT}`);
});

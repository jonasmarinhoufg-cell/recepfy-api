require('dotenv').config();
const express = require('express');
const cors = require('cors');

const whatsappWebhook = require('./webhooks/whatsapp');
const { invalidateCache } = require('./ai/sofia');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rota de saúde — confirma que o servidor está no ar
app.get('/', (req, res) => {
  res.json({
    status: 200,
    message: 'Recepfy API funcionando!',
    version: '1.0.0'
  });
});

// Invalida cache de configuração de uma clínica
// Chamado pelo painel web após salvar configs da Sofia
app.post('/cache/invalidate', (req, res) => {
  const { clinica_id } = req.body || {};
  if (clinica_id) invalidateCache(clinica_id);
  res.sendStatus(200);
});

// Webhook do WhatsApp
app.use('/webhooks', whatsappWebhook);

// Diagnóstico — retorna os últimos eventos processados pelo webhook
// Usar apenas para debug, remover após resolver o problema
const { getRecentEvents } = require('./webhooks/whatsapp');
app.get('/debug/events', (req, res) => res.json(getRecentEvents()));

app.listen(PORT, () => {
  console.log(`Recepfy API rodando na porta ${PORT}`);
});

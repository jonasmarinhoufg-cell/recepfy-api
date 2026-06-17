require('dotenv').config();
const express = require('express');
const cors = require('cors');

const whatsappWebhook = require('./webhooks/whatsapp');

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

// Webhook do WhatsApp
app.use('/webhooks', whatsappWebhook);

app.listen(PORT, () => {
  console.log(`Recepfy API rodando na porta ${PORT}`);
});
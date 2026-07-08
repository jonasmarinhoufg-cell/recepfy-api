require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

// Rede de segurança do processo: um erro não tratado NUNCA derruba a Sofia em silêncio.
// (O Railway reinicia o processo se cair, mas o log alto é o que permite diagnosticar.)
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason?.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err?.stack || err);
});

const whatsappWebhook = require('./webhooks/whatsapp');
const { invalidateCache, enviarNpsPendentes, enviarLembretes, enviarFollowups, enviarReengajamentos, enviarRecalls, verificarFairUse } = require('./ai/sofia');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 200, message: 'Recepfy API funcionando!', version: '1.0.0' });
});

// Probe de saúde — usado pelo teste da aba Integrações do admin (recepfy-web)
// e por monitores externos. Responde rápido e sem tocar em dependências.
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime_s: Math.round(process.uptime()) });
});

app.post('/cache/invalidate', (req, res) => {
  const { clinica_id } = req.body || {};
  if (clinica_id) invalidateCache(clinica_id);
  res.sendStatus(200);
});

// Verifica e exibe a configuração atual do webhook na Evolution API
app.get('/admin/webhook-status/:instance', async (req, res) => {
  const evoUrl = process.env.EVOLUTION_API_URL;
  const evoKey = process.env.EVOLUTION_API_KEY;
  if (!evoUrl || !evoKey) return res.status(500).json({ error: 'Evolution API não configurada' });
  try {
    const axios = require('axios');
    const r = await axios.get(`${evoUrl}/webhook/find/${req.params.instance}`, {
      headers: { apikey: evoKey },
    });
    res.json({ ok: true, raw: r.data });
  } catch (e) {
    res.status(500).json({ error: e.message, status: e.response?.status, detail: e.response?.data });
  }
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

// NPS, Lembrete D-1 e Follow-up são disparados pelos Vercel Crons do recepfy-web (FONTE ÚNICA —
// os do web trazem o link /c/<token> que alimenta a confirmação de presença, a Fila viva e o
// anti-falta). Desligados AQUI para não duplicar mensagem ao mesmo paciente (risco de ban do
// número no WhatsApp). As funções seguem exportadas para uso manual/debug se necessário.
// (Reengajamento e Recall NÃO têm equivalente no web — continuam rodando aqui, abaixo.)

// Reengajamento de pacientes dormentes — roda toda segunda às 10h BRT
cron.schedule('0 10 * * 1', () => {
  console.log('[CRON] Disparando reengajamento de dormentes...');
  enviarReengajamentos().catch(e => console.error('[CRON] Erro REENGAJAMENTO:', e.message));
}, { timezone: 'America/Sao_Paulo' });

// Recall clínico por protocolo — roda todo dia às 11h BRT (deslocado dos outros p/ espalhar a carga
// e nunca empilhar 2 mensagens no mesmo minuto). O gate recall_config.ativo é checado dentro.
cron.schedule('0 11 * * *', () => {
  console.log('[CRON] Disparando recalls de protocolo...');
  enviarRecalls().catch(e => console.error('[CRON] Erro RECALL:', e.message));
}, { timezone: 'America/Sao_Paulo' });

// Fair-use — avisa o dono ao cruzar 80%/100% do teto de conversas do plano (dedup por mês).
// As campanhas proativas (recall/reengajamento/follow-up) pausam sozinhas ao atingir 100%.
cron.schedule('0 12 * * *', () => {
  console.log('[CRON] Verificando fair-use dos planos...');
  verificarFairUse().catch(e => console.error('[CRON] Erro FAIR-USE:', e.message));
}, { timezone: 'America/Sao_Paulo' });

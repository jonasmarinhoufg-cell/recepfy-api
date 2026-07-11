const express = require('express');
const router = express.Router();
const { processarMensagem, emAtendimentoHumano, conversaComTravaHumana } = require('../ai/sofia');
const { transcribeAudioMessage } = require('../ai/transcriber');
const { sendMessage, sendTyping } = require('../whatsapp/sender');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Deduplicação: evita reprocessar o mesmo evento enviado duas vezes pela Evolution API
const processedMessageIds = new Set();

// ── GATE DE PAGAMENTO/TRIAL ──────────────────────────────────────────────────
// Clínica sem billing ativo NÃO consome IA (trial expirado/inadimplente = margem -100%:
// cada mensagem custaria tokens sem nenhuma receita). O cron billing-check (web) já vira
// trial>7d e active>30d para 'inactive' — aqui só honramos o status.
const billingCache = new Map(); // clinicaId → { status, telefone, nome, exp } (TTL 60s)
async function getBillingInfo(clinicaId) {
  const hit = billingCache.get(clinicaId);
  if (hit && hit.exp > Date.now()) return hit;
  const { data } = await supabase.from('clinicas')
    .select('billing_status, telefone, nome').eq('id', clinicaId).maybeSingle();
  const info = {
    status: data?.billing_status || 'trial',
    telefone: data?.telefone || null,
    nome: data?.nome || 'a clínica',
    exp: Date.now() + 60 * 1000,
  };
  billingCache.set(clinicaId, info);
  return info;
}

const suspensoAvisado = new Map();    // telefone → ts (aviso ao paciente no máx. 1x/6h)
const suspensoNotificado = new Map(); // clinicaId → ts (notificação ao dono no máx. 1x/24h)
async function responderSuspenso(instanceName, telefone, clinicaId, info) {
  const now = Date.now();
  if ((suspensoAvisado.get(telefone) || 0) < now - 6 * 3600 * 1000) {
    suspensoAvisado.set(telefone, now);
    await sendMessage(instanceName, telefone,
      `O atendimento automático da ${info.nome} está temporariamente indisponível. ` +
      `Por favor, entre em contato direto com a clínica${info.telefone ? ` pelo telefone ${info.telefone}` : ''}. 🙏`);
  }
  if ((suspensoNotificado.get(clinicaId) || 0) < now - 24 * 3600 * 1000) {
    suspensoNotificado.set(clinicaId, now);
    try {
      await supabase.from('notificacoes').insert({
        clinica_id: clinicaId, tipo: 'sistema',
        titulo: 'Atendimento pausado — plano inativo',
        corpo: 'Pacientes estão chamando no WhatsApp, mas o plano está inativo e a assistente não está respondendo. Regularize o pagamento no painel para reativar.',
      });
    } catch (e) { console.error('[gate-billing]', e.message); }
  }
}

// ── CAP ANTI-FLOOD (por telefone/hora) ───────────────────────────────────────
// Sem teto, um flood de mensagens (spam, bug, abuso) queima tokens sem limite.
const CAP_MSGS_HORA = 30;
const msgsHora = new Map(); // telefone → { n, resetAt }
function checarCap(telefone) {
  const now = Date.now();
  let c = msgsHora.get(telefone);
  if (!c || c.resetAt < now) { c = { n: 0, resetAt: now + 3600 * 1000 }; msgsHora.set(telefone, c); }
  c.n++;
  if (c.n <= CAP_MSGS_HORA) return 'ok';
  return c.n === CAP_MSGS_HORA + 1 ? 'avisar' : 'silencio';
}

// ── DEBOUNCE POR TELEFONE ────────────────────────────────────────────────────
// Agrega o "burst" de mensagens picadas ("oi" + "quero marcar" + "amanhã 10h") numa ÚNICA
// chamada ao modelo — sem isto, cada balão paga o prompt inteiro (~3,7k tokens de system).
// A janela de 3s também substitui o antigo delay "cosmético" aleatório de 2-5s.
const DEBOUNCE_MS = 3000;
const buffers = new Map(); // `${instanceName}|${telefone}` → { textos, timer, clinicaId }

// Serialização por telefone: dois flushes do MESMO paciente nunca rodam em paralelo
// (mensagem enviada durante um processamento espera a vez — elimina a corrida que
// criava conversas duplicadas e respostas fora de ordem). Fila de promises por chave.
const filaPorTelefone = new Map(); // key → Promise (cauda da fila)
function enfileirar(key, fn) {
  const cauda = (filaPorTelefone.get(key) || Promise.resolve())
    .then(fn)
    .catch(e => console.error('[fila]', e.message));
  filaPorTelefone.set(key, cauda);
  cauda.finally(() => { if (filaPorTelefone.get(key) === cauda) filaPorTelefone.delete(key); });
  return cauda;
}

function agendarProcessamento(instanceName, clinicaId, telefone, texto) {
  const key = `${instanceName}|${telefone}`;
  let buf = buffers.get(key);
  if (!buf) { buf = { textos: [], timer: null, clinicaId }; buffers.set(key, buf); }
  buf.textos.push(texto);
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    buffers.delete(key);
    enfileirar(key, () => processarBuffer(instanceName, buf.clinicaId, telefone, buf.textos.join('\n')));
  }, DEBOUNCE_MS);
}

// Confirmações/agradecimentos triviais FORA de conversa ativa → resposta fixa, sem tocar o
// modelo (o "obrigado" pós-encerramento e o "ok" de resposta a lembrete custariam 1 chamada
// Sonnet cheia cada). DENTRO de conversa ativa ("ok" confirmando um horário!) segue pro modelo.
const TRIVIAL = /^(ok(ay)?|blz|beleza|obrigad[oa]s?|muito obrigad[oa]|valeu|certo|perfeito|combinado|confirmado|ta bom|tá bom|de nada|show|top|joia|jóia|tudo bem|👍|🙏|❤️|😊|👌)[\s.!,]*$/i;

async function processarBuffer(instanceName, clinicaId, telefone, mensagem) {
  // Trava do atendimento humano (conversas.humano_ate): um humano assumiu a conversa
  // pelo painel → a mensagem do paciente é salva na conversa (o helper faz isso), mas
  // a Sofia não responde nem mostra "digitando" — silêncio total até a trava expirar.
  // ANTES do atalho TRIVIAL: nem o "obrigado" de resposta fixa pode atropelar o humano.
  if (await emAtendimentoHumano(clinicaId, telefone, mensagem)) return;

  // Confirmação textual do lembrete D-1 (determinística, sem LLM): "ok/sim/confirmado"
  // com consulta 'aguardando' à frente é o paciente confirmando presença. Sem isto, a
  // resposta natural cairia no atalho TRIVIAL ("Combinado!") sem gravar nada e o único
  // caminho de volta a 'confirmado' seria o link /c/<token>.
  const CONFIRMA = /^(sim|ok(ay)?|confirmo|confirmad[oa]|pode confirmar|confirmar|vou sim|estarei l[áa]|blz|beleza|certo|combinado|👍)[\s.!,]*$/i;
  if (CONFIRMA.test(mensagem.trim())) {
    try {
      const { data: pac } = await supabase.from('pacientes').select('id')
        .eq('clinica_id', clinicaId).eq('telefone', telefone).maybeSingle();
      if (pac?.id) {
        const { data: ag } = await supabase.from('agendamentos')
          .select('id, data_hora')
          .eq('clinica_id', clinicaId).eq('paciente_id', pac.id)
          .eq('status', 'aguardando')
          .gte('data_hora', new Date().toISOString())
          .order('data_hora', { ascending: true }).limit(1).maybeSingle();
        if (ag?.id) {
          const { error: cErr } = await supabase.from('agendamentos')
            .update({ status: 'confirmado', confirmado_em: new Date().toISOString(), confirmado_pelo_paciente: true })
            .eq('id', ag.id);
          if (!cErr) {
            const quando = new Date(ag.data_hora).toLocaleString('pt-BR', {
              timeZone: 'America/Sao_Paulo', weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
            });
            await sendMessage(instanceName, telefone, `Presença confirmada! ✅ Te esperamos ${quando}.`);
            return;
          }
        }
      }
    } catch (e) { console.error('[confirma-texto]', e.message); }
  }
  if (TRIVIAL.test(mensagem.trim())) {
    let temConversaAtiva = false;
    try {
      const { data: pac } = await supabase.from('pacientes').select('id')
        .eq('clinica_id', clinicaId).eq('telefone', telefone).maybeSingle();
      if (pac?.id) {
        const { data: conv } = await supabase.from('conversas').select('id')
          .eq('clinica_id', clinicaId).eq('paciente_id', pac.id).eq('status', 'ativa')
          .limit(1).maybeSingle();
        temConversaAtiva = !!conv;
      }
    } catch { /* na dúvida, segue pro modelo */ temConversaAtiva = true; }
    if (!temConversaAtiva) {
      const resposta = /obrigad|valeu|🙏/i.test(mensagem)
        ? 'De nada! 😊 Precisando, é só chamar.'
        : 'Combinado! 😊 Qualquer coisa, é só chamar.';
      await sendMessage(instanceName, telefone, resposta);
      return;
    }
  }
  await sendTyping(instanceName, telefone);
  try {
    const resposta = await processarMensagem(clinicaId, telefone, mensagem);
    await sendMessage(instanceName, telefone, resposta);
  } catch (e) {
    // Falha TOTAL (modelo + retries esgotados, ou envio impossível): nada some em silêncio.
    // O paciente recebe um aviso honesto e a clínica uma notificação para assumir a conversa.
    console.error('[buffer] falha total no processamento:', e.message);
    try {
      await sendMessage(instanceName, telefone,
        'Tive um probleminha técnico agora. Já avisei a equipe da clínica — eles vão te responder por aqui. 🙏');
    } catch { /* nem o fallback saiu — fica só a notificação */ }
    try {
      await supabase.from('notificacoes').insert({
        clinica_id: clinicaId, tipo: 'handoff',
        titulo: 'Resposta não entregue — assuma a conversa',
        corpo: `Falha técnica ao responder ${telefone}. Última mensagem do paciente: "${String(mensagem).slice(0, 160)}"`,
      });
    } catch (e2) { console.error('[buffer] notificação de falha também falhou:', e2.message); }
  }
}

router.post('/whatsapp', async (req, res) => {
  try {
    const body = req.body;

    const ev = (body.event || '').toUpperCase().replace('.', '_');

    // Queda de conexão em TEMPO REAL: antes esse evento era descartado e a única detecção era
    // o health-check 1x/dia — a Sofia ficava "morta" por horas. Agora marca desconectada na hora
    // (o painel reflete na hora e o health-check, mais frequente, dispara o alerta ao dono).
    if (ev === 'CONNECTION_UPDATE') {
      const st = String(body.data?.state || body.data?.connection || '').toLowerCase();
      const instName = body.instance || body.data?.instance;
      if (instName && st) {
        const novo = st === 'open' ? 'conectada' : 'desconectada';
        try {
          await supabase.from('whatsapp_instancias')
            .update({ status: novo, updated_at: new Date().toISOString() })
            .eq('instance_name', instName);
        } catch (e) { console.error('[conn-update]', e.message); }
      }
      return res.sendStatus(200);
    }

    if (ev !== 'MESSAGES_UPSERT') {
      return res.sendStatus(200);
    }

    // Evolution API v2 pode enviar data como array ou objeto
    const raw = body.data;
    const data = Array.isArray(raw) ? raw[0] : raw;

    if (data?.key?.fromMe) return res.sendStatus(200);
    if (data?.key?.remoteJid?.includes('@g.us')) return res.sendStatus(200);

    // Ignora mensagem já processada (Evolution pode disparar o mesmo evento duas vezes).
    // Set em memória = fast-path; a tabela eventos_processados (migration 20260713) torna o
    // dedup DURÁVEL entre restarts/deploys: INSERT antes de processar, conflito = já visto.
    const messageId = data?.key?.id;
    if (messageId) {
      if (processedMessageIds.has(messageId)) {
        console.log('[webhook] Mensagem duplicada ignorada:', messageId);
        return res.sendStatus(200);
      }
      processedMessageIds.add(messageId);
      setTimeout(() => processedMessageIds.delete(messageId), 5 * 60 * 1000);
      try {
        const { error: dupErr } = await supabase.from('eventos_processados').insert({ id: messageId });
        if (dupErr) {
          if (dupErr.code === '23505') {
            console.log('[webhook] Duplicado (persistente) ignorado:', messageId);
            return res.sendStatus(200);
          }
          // Tabela ausente (migration pendente) ou outro erro → segue com o Set em memória.
        } else if (Math.random() < 0.01) {
          // Higiene oportunista (~1% das mensagens): apaga registros com mais de 48h.
          supabase.from('eventos_processados').delete()
            .lt('created_at', new Date(Date.now() - 48 * 3600 * 1000).toISOString())
            .then(() => {}, () => {});
        }
      } catch { /* dedup persistente é best-effort */ }
    }

    const instanceName = body.instance;
    const telefone = data?.key?.remoteJid?.replace('@s.whatsapp.net', '');
    if (!telefone) return res.sendStatus(200);

    // Resolve a clínica UMA vez (todos os caminhos precisam) e aplica o gate de billing
    // ANTES de qualquer custo (Whisper no áudio, Sonnet no texto).
    const { data: instancia } = await supabase
      .from('whatsapp_instancias').select('clinica_id')
      .eq('instance_name', instanceName).maybeSingle();
    if (!instancia) {
      console.warn('[webhook] Instância não encontrada:', instanceName);
      return res.sendStatus(200);
    }
    const billing = await getBillingInfo(instancia.clinica_id);
    if (!['active', 'trial'].includes(billing.status)) {
      res.sendStatus(200);
      await responderSuspenso(instanceName, telefone, instancia.clinica_id, billing);
      return;
    }

    // Extrai texto de todos os tipos comuns de mensagem de texto
    const mensagem = data?.message?.conversation ||
                     data?.message?.extendedTextMessage?.text ||
                     data?.message?.imageMessage?.caption ||
                     data?.message?.videoMessage?.caption ||
                     data?.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
                     data?.message?.ephemeralMessage?.message?.conversation ||
                     data?.message?.ephemeralMessage?.message?.extendedTextMessage?.text ||
                     data?.message?.viewOnceMessage?.message?.conversation ||
                     data?.message?.viewOnceMessage?.message?.extendedTextMessage?.text ||
                     '';

    // Áudio (voz ou arquivo de áudio) — transcreve com Whisper e entra no MESMO buffer
    // do texto (áudio + balões de texto do mesmo burst viram uma única chamada ao modelo).
    const temAudio = data.message?.audioMessage || data.message?.pttMessage;
    if (!mensagem && temAudio) {
      res.sendStatus(200);
      const cap = checarCap(telefone);
      if (cap === 'silencio') return;
      if (cap === 'avisar') {
        // Trava do atendimento humano vale também para respostas fixas — a Sofia não
        // fala por cima do atendente nem para pedir calma.
        if (await conversaComTravaHumana(instancia.clinica_id, telefone)) return;
        await sendMessage(instanceName, telefone, 'Recebemos muitas mensagens seguidas. Aguarde um momento antes de continuar, por favor. 🙏');
        return;
      }
      try {
        const transcricao = await transcribeAudioMessage(instanceName, data.key, data.message);
        if (!transcricao) throw new Error('Transcrição vazia');
        agendarProcessamento(instanceName, instancia.clinica_id, telefone, transcricao);
      } catch (e) {
        console.error('Erro ao transcrever áudio:', e);
        if (await conversaComTravaHumana(instancia.clinica_id, telefone)) return;
        await new Promise(r => setTimeout(r, 1200));
        await sendMessage(instanceName, telefone,
          'Não consegui ouvir seu áudio. Pode digitar o que precisa? 🙏'
        );
      }
      return;
    }

    // Outros mídia (imagem, vídeo, documento, sticker) — pede para digitar
    if (!mensagem) {
      const temMidia = data.message && (
        data.message.imageMessage    ||
        data.message.videoMessage    ||
        data.message.documentMessage ||
        data.message.stickerMessage
      );
      res.sendStatus(200);
      if (temMidia) {
        if (await conversaComTravaHumana(instancia.clinica_id, telefone)) return;
        await new Promise(r => setTimeout(r, 1200));
        await sendMessage(instanceName, telefone,
          'Por enquanto só consigo ler mensagens de texto. Pode digitar o que precisa?'
        );
      }
      return;
    }

    res.sendStatus(200);

    // Opt-out do recall (LGPD/CFM): "SAIR"/"PARAR"/"STOP" ANTES do LLM → registra e confirma,
    // sem resposta livre. Match EXATO da mensagem normalizada — "vou sair 15h" NÃO silencia.
    // NÃO inclui "CANCELAR": é a palavra natural para cancelar a CONSULTA — deve fluir para o
    // processarMensagem (cancelamento), não descadastrar do recall nem virar no-show silencioso.
    const norm = (mensagem || '').trim().toUpperCase();
    if (['SAIR', 'PARAR', 'STOP'].includes(norm)) {
      try {
        await supabase.from('pacientes').update({ recall_opt_out: true })
          .eq('clinica_id', instancia.clinica_id).eq('telefone', telefone);
      } catch (e) { console.error('[optout]', e.message); }
      await sendMessage(instanceName, telefone, 'Pronto! Você não vai mais receber nossos lembretes de retorno. Se precisar agendar, é só chamar quando quiser. 💙');
      return;
    }

    // Cap anti-flood + debounce (a janela de 3s agrega o burst e já faz o papel do delay natural)
    const cap = checarCap(telefone);
    if (cap === 'silencio') return;
    if (cap === 'avisar') {
      if (await conversaComTravaHumana(instancia.clinica_id, telefone)) return;
      await sendMessage(instanceName, telefone, 'Recebemos muitas mensagens seguidas. Aguarde um momento antes de continuar, por favor. 🙏');
      return;
    }
    agendarProcessamento(instanceName, instancia.clinica_id, telefone, mensagem);

  } catch (error) {
    console.error('Erro no webhook:', error.message);
  }
});

module.exports = router;

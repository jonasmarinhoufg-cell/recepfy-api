import { useState } from "react";

// ─── TOKENS ──────────────────────────────────────────────────────────────────
const BASE = {
  bgGrad:  "linear-gradient(160deg, #F0F4FF 0%, #F5F6FB 40%, #F5F4FB 100%)",
  surface: "#FFFFFF", surface2: "#F8F9FC", surface3: "#F1F3F8",
  glass:   "rgba(255,255,255,0.80)",
  border:  "#E6E9F0", borderDk: "#D1D7E3",
  ink:     "#0F1629", text: "#374151", textSec: "#6B7280", muted: "#9CA3AF",
  white:   "#FFFFFF",
  green:   "#059669", greenLt: "#ECFDF5",
  amber:   "#B45309", amberLt: "#FFFBEB",
  red:     "#DC2626", redLt:   "#FEF2F2",
  purple:  "#7C3AED", purpleLt:"#F5F3FF",
  accent:  "#4F46E5", accentLt:"#EEF2FF", accentMd:"#C7D2FE", accentDk:"#4338CA",
};

const sh = {
  sm: "0 1px 4px rgba(15,22,41,0.06)",
  md: "0 4px 12px rgba(15,22,41,0.08)",
};

// ─── MOCK DATA ────────────────────────────────────────────────────────────────
const DOCTOR = {
  nome: "Dr. Ricardo Alves",
  especialidade: "Cardiologista",
  crm: "CRM/SP 123456",
  assistantName: "Sofia",
};

const AGENDA = [
  { time:"08:30", patient:"Carlos Eduardo Lima",   reason:"Dor no peito",          status:"confirmado", urgent:true,  via:"Sofia" },
  { time:"09:30", patient:"Ana Paula Ferreira",    reason:"Check-up anual",        status:"confirmado", urgent:false, via:"Sofia" },
  { time:"10:30", patient:"Roberto Alves Santos",  reason:"Palpitações",           status:"confirmado", urgent:true,  via:"Sofia" },
  { time:"11:30", patient:"Maria Graças Silva",    reason:"Retorno cardiologia",   status:"aguardando", urgent:false, via:"Manual" },
  { time:"14:00", patient:"Pedro Henrique Costa",  reason:"Pressão alta",          status:"confirmado", urgent:false, via:"Sofia" },
  { time:"15:00", patient:"Lúcia Moreira",         reason:"Resultado holter",      status:"confirmado", urgent:false, via:"Sofia" },
];

const ALERTS = [
  { type:"urgencia",  time:"08:14", patient:"Carlos Eduardo Lima", msg:"Relatou dor no peito intensa. Sofia orientou SAMU — paciente confirmou que virá mesmo assim.", read:false },
  { type:"booking",   time:"09:55", patient:"Pedro Henrique Costa", msg:"Novo agendamento para hoje às 14h — primeiro atendimento. Motivo: pressão alta detectada.", read:false },
  { type:"nps",       time:"Ontem", patient:"Ana Paula Ferreira",   msg:"Avaliou a consulta com ⭐⭐⭐⭐⭐ — 'Atendimento excelente, muito atencioso.'", read:true },
];

const METRICS = [
  { label:"Consultas hoje",        value:"6",   color:BASE.accent,  icon:"📅" },
  { label:"Agendadas pela Sofia",  value:"5",   color:BASE.green,   icon:"🤖" },
  { label:"Alertas novos",         value:"2",   color:BASE.red,     icon:"🔔" },
  { label:"Taxa de resolução IA",  value:"94%", color:BASE.purple,  icon:"◎"  },
];

// ─── ATOMS ───────────────────────────────────────────────────────────────────

const Badge = ({ children, color, bg, dot }) => {
  const c = color || BASE.textSec;
  return (
    <span style={{
      display:"inline-flex", alignItems:"center", gap:4,
      padding:"2px 7px", borderRadius:5,
      background:bg||c+"14", color:c,
      fontSize:10, fontWeight:600,
      border:`1px solid ${c}18`,
    }}>
      {dot&&<span style={{width:5,height:5,borderRadius:"50%",background:c,flexShrink:0}}/>}
      {children}
    </span>
  );
};

const Btn = ({ children, variant="primary", size="md", icon, onClick }) => {
  const [hov, setHov] = useState(false);
  const sizes = { xs:{p:"4px 9px",fs:11}, sm:{p:"5px 12px",fs:12}, md:{p:"7px 16px",fs:13} };
  const s = sizes[size]||sizes.md;
  const v = {
    primary:   { bg:hov?BASE.accentDk:BASE.accent, color:BASE.white, border:"none", bs:`0 2px 8px ${BASE.accent}40` },
    secondary: { bg:hov?BASE.surface3:BASE.white, color:BASE.text, border:`1px solid ${BASE.border}`, bs:sh.sm },
    ghost:     { bg:hov?BASE.surface3:"transparent", color:hov?BASE.ink:BASE.textSec, border:"none", bs:"none" },
    danger:    { bg:hov?BASE.redLt:BASE.white, color:BASE.red, border:`1px solid ${hov?BASE.red+"40":BASE.border}`, bs:sh.sm },
  }[variant]||{};
  return (
    <button onClick={onClick}
      onMouseEnter={()=>setHov(true)} onMouseLeave={()=>setHov(false)}
      style={{
        padding:s.p, fontSize:s.fs, fontWeight:500,
        background:v.bg, color:v.color, border:v.border,
        borderRadius:7, boxShadow:hov?v.bs:"none",
        fontFamily:"inherit", cursor:"pointer",
        display:"inline-flex", alignItems:"center", gap:6,
        transition:"all .12s", whiteSpace:"nowrap",
      }}
    >
      {icon&&<span>{icon}</span>}
      {children}
    </button>
  );
};

// ─── APPOINTMENT MODAL ────────────────────────────────────────────────────────

function ApptModal({ appt, onClose }) {
  if (!appt) return null;
  return (
    <div style={{
      position:"fixed", inset:0, background:"rgba(15,22,41,0.4)",
      zIndex:100, display:"flex", alignItems:"center", justifyContent:"center",
      padding:20, backdropFilter:"blur(4px)",
    }} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{
        background:BASE.white, borderRadius:14,
        width:"100%", maxWidth:480,
        boxShadow:"0 20px 60px rgba(15,22,41,0.15)",
        overflow:"hidden",
        animation:"fadeUp .2s ease",
      }}>
        {/* Header */}
        <div style={{
          background:appt.urgent?BASE.redLt:BASE.accentLt,
          borderBottom:`1px solid ${appt.urgent?BASE.red+"30":BASE.accentMd}`,
          padding:"16px 20px",
          display:"flex", alignItems:"center", justifyContent:"space-between",
        }}>
          <div>
            <div style={{fontWeight:700, fontSize:16, color:BASE.ink}}>{appt.patient}</div>
            <div style={{fontSize:12, color:BASE.textSec, marginTop:2}}>
              Hoje às {appt.time} · {DOCTOR.nome}
            </div>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            {appt.urgent&&<Badge color={BASE.red} bg={BASE.redLt} dot>Urgente</Badge>}
            <Badge color={appt.status==="confirmado"?BASE.green:BASE.amber} bg={appt.status==="confirmado"?BASE.greenLt:BASE.amberLt} dot>
              {appt.status}
            </Badge>
          </div>
        </div>

        <div style={{padding:20, display:"flex",flexDirection:"column",gap:14}}>
          {/* Detalhes */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[
              {label:"Motivo relatado",   value:appt.reason},
              {label:"Agendado via",      value:appt.via==="Sofia"?"Sofia (IA)":"Manual"},
            ].map((f,i)=>(
              <div key={i} style={{background:BASE.surface2,borderRadius:8,padding:"10px 12px"}}>
                <div style={{fontSize:10,color:BASE.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:"0.04em",marginBottom:4}}>{f.label}</div>
                <div style={{fontSize:13,fontWeight:600,color:BASE.ink}}>{f.value}</div>
              </div>
            ))}
          </div>

          {appt.urgent&&(
            <div style={{background:BASE.redLt,border:`1px solid ${BASE.red}30`,borderRadius:8,padding:"10px 14px",display:"flex",gap:8,alignItems:"flex-start"}}>
              <span style={{fontSize:16,flexShrink:0}}>⚠️</span>
              <div style={{fontSize:12,color:BASE.red,lineHeight:1.6}}>
                <strong>Atenção:</strong> Paciente relatou sintomas de urgência à Sofia. Priorize este atendimento.
              </div>
            </div>
          )}

          <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
            <Btn variant="ghost" size="sm" onClick={onClose}>Fechar</Btn>
            <Btn variant="danger" size="sm">Cancelar</Btn>
            <Btn variant="primary" size="sm">Marcar como realizado</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── NAV ITEMS ────────────────────────────────────────────────────────────────
// Profissional tem navegação unificada — sem separação clínica/médico
const NAV = [
  { id:"agenda",      icon:"📅", label:"Agenda de hoje",  section:"main" },
  { id:"pacientes",   icon:"👥", label:"Pacientes",        section:"main" },
  { id:"alertas",     icon:"🔔", label:"Alertas",          section:"main", badge:2 },
  { id:"train",       icon:"🤖", label:"Treinar Sofia",    section:"sofia" },
  { id:"whatsapp",    icon:"📱", label:"WhatsApp",         section:"sofia" },
  { id:"settings",    icon:"⚙",  label:"Configurações",    section:"system" },
];

const SECTION_LABELS = { sofia:"Sofia AI", system:"Sistema" };

// ─── APP ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [activePage, setActivePage] = useState("agenda");
  const [collapsed, setCollapsed] = useState(false);
  const [selectedAppt, setSelectedAppt] = useState(null);
  const [alerts, setAlerts] = useState(ALERTS);

  const unreadAlerts = alerts.filter(a=>!a.read).length;
  const navWithBadge = NAV.map(n => n.id==="alertas" ? {...n, badge:unreadAlerts} : n);

  return (
    <div style={{fontFamily:"Inter,-apple-system,sans-serif",background:BASE.bgGrad,height:"100vh",display:"flex",flexDirection:"column",color:BASE.text,overflow:"hidden"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:5px; }
        ::-webkit-scrollbar-thumb { background:${BASE.borderDk}; border-radius:8px; }
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
      `}</style>

      {/* Topbar */}
      <div style={{
        height:54, background:BASE.glass,
        backdropFilter:"blur(16px)", WebkitBackdropFilter:"blur(16px)",
        borderBottom:`1px solid ${BASE.border}`,
        display:"flex", alignItems:"center",
        padding:"0 20px", gap:12, flexShrink:0,
      }}>
        {/* Logo */}
        <div style={{display:"flex",alignItems:"center",gap:9}}>
          <div style={{
            width:28,height:28,borderRadius:7,
            background:`linear-gradient(135deg,${BASE.accent},#7C3AED)`,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:14,fontWeight:800,color:BASE.white,
            boxShadow:`0 3px 10px ${BASE.accent}40`,
          }}>R</div>
          {!collapsed&&<span style={{fontWeight:700,fontSize:14,color:BASE.ink,letterSpacing:"-0.02em"}}>Recepfy</span>}
        </div>

        <div style={{width:1,height:20,background:BASE.border}}/>

        {/* Doctor identity */}
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{
            width:30,height:30,borderRadius:"50%",
            background:`linear-gradient(135deg,${BASE.accent}30,${BASE.accent}60)`,
            border:`1.5px solid ${BASE.accent}20`,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontSize:12,fontWeight:700,color:BASE.accent,
          }}>RA</div>
          <div>
            <div style={{fontWeight:600,fontSize:13,color:BASE.ink,letterSpacing:"-0.01em"}}>{DOCTOR.nome}</div>
            <div style={{fontSize:10,color:BASE.muted}}>{DOCTOR.especialidade} · {DOCTOR.crm}</div>
          </div>
        </div>

        {/* Sofia status */}
        <div style={{
          display:"flex",alignItems:"center",gap:5,
          background:BASE.greenLt,border:`1px solid ${BASE.green}30`,
          borderRadius:999,padding:"3px 10px",
        }}>
          <div style={{width:6,height:6,borderRadius:"50%",background:BASE.green,animation:"pulse 2s infinite"}}/>
          <span style={{fontSize:10,color:BASE.green,fontWeight:600}}>{DOCTOR.assistantName} ativa</span>
        </div>

        <div style={{flex:1}}/>

        {/* Notif */}
        <button style={{
          width:34,height:34,borderRadius:7,
          background:"transparent",border:`1px solid transparent`,
          display:"flex",alignItems:"center",justifyContent:"center",
          cursor:"pointer",position:"relative",transition:"all .12s",
        }}
        onMouseEnter={e=>{e.currentTarget.style.background=BASE.surface3;e.currentTarget.style.borderColor=BASE.border;}}
        onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.borderColor="transparent";}}
        onClick={()=>setActivePage("alertas")}
        >
          <span style={{fontSize:16}}>🔔</span>
          {unreadAlerts>0&&<span style={{
            position:"absolute",top:5,right:5,
            width:8,height:8,borderRadius:"50%",
            background:BASE.red,border:`1.5px solid ${BASE.white}`,
            animation:"pulse 2s infinite",
          }}/>}
        </button>
      </div>

      {/* Body */}
      <div style={{flex:1,display:"flex",overflow:"hidden"}}>

        {/* Sidebar */}
        <div style={{
          width:collapsed?52:210,
          background:BASE.surface,
          borderRight:`1px solid ${BASE.border}`,
          display:"flex",flexDirection:"column",
          transition:"width .22s cubic-bezier(.4,0,.2,1)",
          overflow:"hidden",flexShrink:0,
        }}>
          <div style={{flex:1,padding:"8px 6px",overflowY:"auto"}}>
            {navWithBadge.map((item,idx)=>{
              const isActive = activePage===item.id;
              const showSection = item.section!=="main"&&(idx===0||navWithBadge[idx-1]?.section!==item.section);
              return (
                <div key={item.id}>
                  {showSection&&!collapsed&&(
                    <div style={{padding:"12px 12px 5px",fontSize:9,fontWeight:600,color:BASE.muted,letterSpacing:"0.1em",textTransform:"uppercase"}}>
                      {SECTION_LABELS[item.section]||item.section}
                    </div>
                  )}
                  {showSection&&collapsed&&<div style={{height:1,background:BASE.border,margin:"8px 4px"}}/>}
                  <button onClick={()=>setActivePage(item.id)}
                    title={collapsed?item.label:undefined}
                    style={{
                      width:"100%",display:"flex",alignItems:"center",
                      gap:collapsed?0:9,justifyContent:collapsed?"center":"flex-start",
                      padding:collapsed?"9px":"7px 10px",
                      borderRadius:7,border:"none",
                      background:isActive?BASE.accentLt:"transparent",
                      color:isActive?BASE.accent:BASE.textSec,
                      fontWeight:isActive?600:400,
                      fontSize:13,cursor:"pointer",fontFamily:"inherit",
                      marginBottom:1,transition:"all .1s",textAlign:"left",
                      position:"relative",
                    }}
                    onMouseEnter={e=>{if(!isActive){e.currentTarget.style.background=BASE.surface3;e.currentTarget.style.color=BASE.ink;}}}
                    onMouseLeave={e=>{if(!isActive){e.currentTarget.style.background="transparent";e.currentTarget.style.color=BASE.textSec;}}}
                  >
                    {isActive&&<div style={{position:"absolute",left:0,top:"20%",bottom:"20%",width:2.5,borderRadius:999,background:BASE.accent}}/>}
                    <span style={{fontSize:15,flexShrink:0}}>{item.icon}</span>
                    {!collapsed&&<>
                      <span style={{flex:1,whiteSpace:"nowrap"}}>{item.label}</span>
                      {item.badge>0&&<span style={{padding:"1px 6px",borderRadius:999,background:BASE.redLt,color:BASE.red,fontSize:9,fontWeight:700}}>{item.badge}</span>}
                    </>}
                  </button>
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div style={{padding:collapsed?"8px 6px":"8px",borderTop:`1px solid ${BASE.border}`,flexShrink:0}}>
            {collapsed?(
              <button onClick={()=>setCollapsed(false)} style={{width:"100%",display:"flex",alignItems:"center",justifyContent:"center",padding:"8px",borderRadius:7,border:"none",background:"transparent",color:BASE.muted,cursor:"pointer",fontSize:14,fontFamily:"inherit"}}>›</button>
            ):(
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",borderRadius:7,cursor:"pointer",transition:"background .12s"}}
              onMouseEnter={e=>e.currentTarget.style.background=BASE.surface3}
              onMouseLeave={e=>e.currentTarget.style.background="transparent"}
              >
                <div style={{width:28,height:28,borderRadius:"50%",background:`linear-gradient(135deg,${BASE.accent}30,${BASE.accent}60)`,border:`1.5px solid ${BASE.accent}20`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700,color:BASE.accent,flexShrink:0}}>RA</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:11,fontWeight:600,color:BASE.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{DOCTOR.nome}</div>
                  <div style={{fontSize:9,color:BASE.muted}}>Plano Solo</div>
                </div>
                <button onClick={e=>{e.stopPropagation();setCollapsed(true);}} style={{background:"none",border:"none",cursor:"pointer",color:BASE.muted,fontSize:12,padding:2,borderRadius:4,transition:"all .12s",flexShrink:0}}
                onMouseEnter={e=>{e.currentTarget.style.color=BASE.ink;e.currentTarget.style.background=BASE.surface3;}}
                onMouseLeave={e=>{e.currentTarget.style.color=BASE.muted;e.currentTarget.style.background="none";}}>‹</button>
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div style={{flex:1,overflowY:"auto",padding:"22px 24px"}}>

          {/* ── AGENDA ── */}
          {activePage==="agenda"&&(
            <div style={{display:"flex",flexDirection:"column",gap:20,animation:"fadeUp .3s ease"}}>
              {/* Header */}
              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
                <div>
                  <div style={{fontSize:20,fontWeight:700,color:BASE.ink,letterSpacing:"-0.03em"}}>
                    Bom dia, Dr. Ricardo ☀️
                  </div>
                  <div style={{fontSize:13,color:BASE.textSec,marginTop:2}}>
                    Quarta-feira, 17 de junho · {AGENDA.length} consultas hoje · {AGENDA.filter(a=>a.via==="Sofia").length} agendadas pela Sofia
                  </div>
                </div>
                <Btn variant="primary" size="sm" icon="＋">Novo agendamento</Btn>
              </div>

              {/* Metrics */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
                {METRICS.map((m,i)=>(
                  <div key={i} style={{
                    background:BASE.white,border:`1px solid ${BASE.border}`,
                    borderRadius:10,padding:"16px 18px",
                    boxShadow:sh.sm,position:"relative",overflow:"hidden",
                    transition:"all .18s",
                  }}
                  onMouseEnter={e=>{e.currentTarget.style.boxShadow=sh.md;e.currentTarget.style.transform="translateY(-1px)";}}
                  onMouseLeave={e=>{e.currentTarget.style.boxShadow=sh.sm;e.currentTarget.style.transform="none";}}
                  >
                    <div style={{position:"absolute",top:0,left:0,right:0,height:2,background:`linear-gradient(90deg,${m.color},${m.color}00)`,opacity:.5}}/>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                      <span style={{fontSize:11,color:BASE.muted,fontWeight:500}}>{m.label}</span>
                      <div style={{width:24,height:24,borderRadius:6,background:m.color+"12",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12}}>{m.icon}</div>
                    </div>
                    <div style={{fontSize:24,fontWeight:700,color:BASE.ink,letterSpacing:"-0.03em",lineHeight:1}}>{m.value}</div>
                  </div>
                ))}
              </div>

              {/* Appointments list */}
              <div style={{background:BASE.white,border:`1px solid ${BASE.border}`,borderRadius:10,overflow:"hidden",boxShadow:sh.sm}}>
                <div style={{padding:"13px 18px",borderBottom:`1px solid ${BASE.border}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <div style={{fontWeight:700,fontSize:14,color:BASE.ink}}>Agenda de hoje</div>
                  <div style={{display:"flex",gap:6}}>
                    <Badge color={BASE.green} bg={BASE.greenLt} dot>{AGENDA.filter(a=>a.status==="confirmado").length} confirmadas</Badge>
                    {AGENDA.filter(a=>a.urgent).length>0&&(
                      <Badge color={BASE.red} bg={BASE.redLt} dot>{AGENDA.filter(a=>a.urgent).length} urgentes</Badge>
                    )}
                  </div>
                </div>
                {AGENDA.map((a,i)=>(
                  <div key={i} onClick={()=>setSelectedAppt(a)} style={{
                    display:"flex",alignItems:"center",gap:12,
                    padding:"12px 18px",
                    borderBottom:i<AGENDA.length-1?`1px solid ${BASE.border}`:"none",
                    cursor:"pointer",transition:"background .08s",
                    borderLeft:a.urgent?`3px solid ${BASE.red}`:"3px solid transparent",
                  }}
                  onMouseEnter={e=>e.currentTarget.style.background=BASE.surface2}
                  onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                  >
                    {/* Time */}
                    <div style={{width:48,flexShrink:0}}>
                      <div style={{fontSize:12,fontWeight:700,color:a.urgent?BASE.red:BASE.ink,fontFamily:"'JetBrains Mono',monospace"}}>{a.time}</div>
                    </div>

                    {/* Status dot */}
                    <div style={{width:8,height:8,borderRadius:"50%",flexShrink:0,background:a.urgent?BASE.red:a.status==="confirmado"?BASE.green:BASE.amber}}/>

                    {/* Patient */}
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:600,fontSize:13,color:BASE.ink,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.patient}</div>
                      <div style={{fontSize:11,color:BASE.textSec,marginTop:1}}>{a.reason}</div>
                    </div>

                    {/* Badges */}
                    <div style={{display:"flex",gap:5,flexShrink:0}}>
                      <Badge color={a.status==="confirmado"?BASE.green:BASE.amber} bg={a.status==="confirmado"?BASE.greenLt:BASE.amberLt} dot>{a.status}</Badge>
                      {a.via==="Sofia"&&<Badge color={BASE.accent} bg={BASE.accentLt}>IA</Badge>}
                    </div>

                    <span style={{color:BASE.muted,fontSize:14,flexShrink:0}}>›</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── ALERTAS ── */}
          {activePage==="alertas"&&(
            <div style={{display:"flex",flexDirection:"column",gap:18,animation:"fadeUp .3s ease"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                <div>
                  <div style={{fontSize:20,fontWeight:700,color:BASE.ink,letterSpacing:"-0.03em"}}>Alertas</div>
                  <div style={{fontSize:13,color:BASE.textSec,marginTop:2}}>
                    {unreadAlerts>0?`${unreadAlerts} não lidos — requerem atenção`:"Tudo em dia"}
                  </div>
                </div>
                {unreadAlerts>0&&(
                  <Btn variant="ghost" size="sm" onClick={()=>setAlerts(a=>a.map(x=>({...x,read:true})))}>
                    Marcar todos como lidos
                  </Btn>
                )}
              </div>

              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {alerts.map((a,i)=>{
                  const cfg = {
                    urgencia: {color:BASE.red,   bg:BASE.redLt,   icon:"🚨", label:"Urgência"},
                    booking:  {color:BASE.green, bg:BASE.greenLt, icon:"📅", label:"Agendamento"},
                    nps:      {color:BASE.purple,bg:BASE.purpleLt,icon:"⭐", label:"Avaliação"},
                  }[a.type]||{color:BASE.textSec,bg:BASE.surface2,icon:"🔔",label:"Alerta"};
                  return (
                    <div key={i} style={{
                      background:BASE.white,
                      border:`1.5px solid ${a.read?BASE.border:cfg.color+"30"}`,
                      borderLeft:`3px solid ${a.read?BASE.border:cfg.color}`,
                      borderRadius:10,padding:"14px 16px",
                      display:"flex",gap:12,
                      boxShadow:a.read?"none":sh.sm,
                    }}>
                      <div style={{width:36,height:36,borderRadius:8,background:cfg.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>{cfg.icon}</div>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                          <Badge color={cfg.color} bg={cfg.bg}>{cfg.label}</Badge>
                          <span style={{fontSize:10,color:BASE.muted}}>{a.time}</span>
                          {!a.read&&<span style={{width:7,height:7,borderRadius:"50%",background:cfg.color,display:"inline-block"}}/>}
                        </div>
                        <div style={{fontWeight:600,fontSize:13,color:BASE.ink,marginBottom:4}}>{a.patient}</div>
                        <div style={{fontSize:12,color:BASE.textSec,lineHeight:1.6}}>{a.msg}</div>
                      </div>
                      {!a.read&&(
                        <button onClick={()=>setAlerts(prev=>prev.map((x,j)=>j===i?{...x,read:true}:x))} style={{
                          background:"none",border:`1px solid ${BASE.border}`,
                          borderRadius:6,padding:"4px 10px",
                          fontSize:11,color:BASE.muted,cursor:"pointer",
                          fontFamily:"inherit",alignSelf:"flex-start",whiteSpace:"nowrap",
                        }}>Lido</button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── OUTRAS PÁGINAS ── */}
          {activePage!=="agenda"&&activePage!=="alertas"&&(
            <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:60,textAlign:"center",animation:"fadeUp .25s ease"}}>
              <div style={{width:52,height:52,borderRadius:12,background:BASE.accentLt,border:`1px solid ${BASE.accentMd}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,marginBottom:16}}>
                {NAV.find(n=>n.id===activePage)?.icon||"▦"}
              </div>
              <div style={{fontSize:18,fontWeight:700,color:BASE.ink,letterSpacing:"-0.02em",marginBottom:6}}>
                {NAV.find(n=>n.id===activePage)?.label}
              </div>
              <div style={{fontSize:13,color:BASE.textSec,maxWidth:260,lineHeight:1.6}}>
                Esta tela está sendo construída na próxima etapa.
              </div>
              <div style={{marginTop:20,padding:"7px 14px",background:BASE.surface2,border:`1px solid ${BASE.border}`,borderRadius:7,fontSize:11,color:BASE.muted,fontFamily:"monospace"}}>em breve →</div>
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div style={{height:26,background:BASE.surface,borderTop:`1px solid ${BASE.border}`,display:"flex",alignItems:"center",padding:"0 18px",gap:14,flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <div style={{width:6,height:6,borderRadius:"50%",background:BASE.green,animation:"pulse 2s infinite"}}/>
          <span style={{fontSize:10,color:BASE.textSec,fontWeight:500}}>{DOCTOR.assistantName} respondendo</span>
        </div>
        <div style={{width:1,height:12,background:BASE.border}}/>
        <span style={{fontSize:10,color:BASE.muted}}>Modalidade: Profissional Solo</span>
        <div style={{marginLeft:"auto",fontSize:10,color:BASE.muted}}>recepfy.app.br · v1.0.0</div>
      </div>

      {/* Modal */}
      {selectedAppt&&<ApptModal appt={selectedAppt} onClose={()=>setSelectedAppt(null)}/>}
    </div>
  );
}

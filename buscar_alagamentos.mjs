// Pesquisa automática de alagamentos (Node 20+, sem dependências).
// Quando a previsão indica risco de enchente para hoje, amanhã ou ontem, procura notícias de alagamento
// em Presidente Prudente (G1 e Google Notícias) e registra o dia na tabela "enchentes".
// Se o dia já tem registro (qualquer origem), nada é gravado.
//
// Variáveis de ambiente: SUPABASE_URL (https://xxxx.supabase.co), SUPABASE_SERVICE_KEY (chave service_role, secreta)
// Opcionais: SIM_NOW (ISO, só para teste), FEEDS (lista de URLs RSS separadas por espaço), RISCO_MIN (padrão 65)

const SUPABASE_URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
const LAT = -22.1195, LON = -51.3935, TZ = 'America/Sao_Paulo';
const RISCO_MIN = Number(process.env.RISCO_MIN || 65);
const FEEDS = (process.env.FEEDS || [
  'https://g1.globo.com/rss/g1/sp/presidente-prudente-regiao/',
  'https://news.google.com/rss/search?q=' + encodeURIComponent('(alagamento OR alagou OR enchente OR inundação) "Presidente Prudente" site:g1.globo.com when:3d') + '&hl=pt-BR&gl=BR&ceid=BR:pt-419',
  'https://news.google.com/rss/search?q=' + encodeURIComponent('(alagamento OR alagou OR enchente) "Parque do Povo" when:3d') + '&hl=pt-BR&gl=BR&ceid=BR:pt-419'
].join(' ')).split(/\s+/).filter(Boolean);

const now = process.env.SIM_NOW ? new Date(process.env.SIM_NOW) : new Date();
const dayKey = (d) => new Date(d).toLocaleDateString('sv-SE', { timeZone: TZ });
const hourKey = (d) => new Date(d).toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const addDays = (key, n) => new Date(Date.parse(key + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);

/* ---- Índice do artigo (mesmo cálculo da página, só componentes disponíveis na previsão) ---- */
const W = [['I', 0.45, 40], ['A1', 0.20, 40], ['A24', 0.15, 100], ['A72', 0.10, 80]];
function indice(v) {
  let sw = 0, s = 0; for (const [k, w, ref] of W) { sw += w; s += w * Math.min(v[k] / ref, 1.2); }
  const base = Math.min(100, 100 * s / sw);
  const fl = [(v.I >= 40 || v.I >= 30) ? 65 : 0, v.A1 >= 40 ? 45 : 0, v.A24 >= 100 ? 85 : 0];
  return Math.max(base, ...fl);
}
async function diasEmRisco() {
  const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + LAT + '&longitude=' + LON +
    '&hourly=precipitation&models=ecmwf_ifs025,gfs_seamless,icon_seamless&past_days=3&forecast_days=3&timezone=' + encodeURIComponent(TZ);
  const r = await fetch(u); if (!r.ok) throw new Error('previsão ' + r.status);
  const h = (await r.json()).hourly; const out = {};
  for (const m of ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless']) {
    const a = h['precipitation_' + m]; if (!a) continue;
    const by = {}; h.time.forEach((t, i) => { (by[t.slice(0, 10)] ||= []).push(a[i] || 0); });
    const ks = Object.keys(by).sort(); const sums = ks.map(k => by[k].reduce((x, y) => x + y, 0));
    ks.forEach((k, i) => {
      if (by[k].length < 20) return;
      const i24 = sums[i], mx = Math.max(...by[k]);
      const v = { I: mx, A1: mx, A24: i24, A72: i24 + (sums[i - 1] || 0) + (sums[i - 2] || 0) };
      out[k] = Math.max(out[k] || 0, indice(v));
    });
  }
  const hoje = dayKey(now), cand = [addDays(hoje, -1), hoje, addDays(hoje, 1)];
  return cand.filter(k => (out[k] || 0) >= RISCO_MIN).map(k => ({ data: k, indice: Math.round(out[k]) }));
}

/* ---- Notícias ---- */
const tag = (x, n) => { const m = x.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>', 'i')); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;|&gt;/g, ' ').replace(/\s+/g, ' ').trim() : ''; };
function parseRss(xml) { return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map(m => ({ titulo: tag(m[0], 'title'), link: tag(m[0], 'link'), pub: tag(m[0], 'pubDate'), desc: tag(m[0], 'description') })); }
const ALAGA = /alagament|alagou|alagad|enchente|inunda|transbord/i, LOCAL = /prudente|parque do povo/i;
async function noticias() {
  const todas = [];
  for (const f of FEEDS) {
    try { const r = await fetch(f, { headers: { 'user-agent': 'alerta-enchentes-unoeste/1.0' } }); if (!r.ok) { console.log('feed falhou', r.status, f); continue; } todas.push(...parseRss(await r.text())); }
    catch (e) { console.log('feed erro', f, e.message); }
  }
  return todas.filter(n => n.link && n.titulo && !isNaN(Date.parse(n.pub)) && ALAGA.test(n.titulo + ' ' + n.desc) && LOCAL.test(n.titulo + ' ' + n.desc));
}
/* uma notícia vale para o dia D se foi publicada em D, ou em D+1 até o meio-dia */
const vale = (n, D) => { const k = dayKey(n.pub); return k === D || (k === addDays(D, 1) && Number(hourKey(n.pub).slice(0, 2)) < 12); };

/* ---- Base de dados ---- */
const hdr = { apikey: KEY, 'Content-Type': 'application/json' };
if (/^eyJ/.test(KEY)) hdr.Authorization = 'Bearer ' + KEY; // chaves novas (sb_secret_...) vão só em apikey
async function jaRegistrado(D) { const r = await fetch(SUPABASE_URL + '/rest/v1/enchentes?select=id&data=eq.' + D, { headers: hdr }); if (!r.ok) throw new Error('base ' + r.status); return (await r.json()).length > 0; }
async function registrar(D, n, indiceDia) {
  const texto = n.titulo + ' ' + n.desc;
  const reg = { data: D, hora: hourKey(n.pub), local: /parque do povo/i.test(texto) ? 'Parque do Povo' : 'Presidente Prudente (ver a notícia)', gravidade: 'A confirmar',
    fonte: 'pesquisa', link: n.link, obs: 'Notícia: ' + n.titulo + ' (hora = publicação da notícia; índice previsto para o dia: ' + indiceDia + ').', registrado_por: 'Pesquisa automática' };
  const r = await fetch(SUPABASE_URL + '/rest/v1/enchentes?on_conflict=data', { method: 'POST', headers: { ...hdr, Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(reg) });
  if (!r.ok) throw new Error('gravar ' + r.status + ' ' + await r.text());
}

async function main() {
  if (!SUPABASE_URL || !KEY) throw new Error('Defina SUPABASE_URL e SUPABASE_SERVICE_KEY');
  // consulta leve a cada execução: mantém o projeto do Supabase (plano grátis) ativo, sem pausar por inatividade
  const ping = await fetch(SUPABASE_URL + '/rest/v1/enchentes?select=id&limit=1', { headers: hdr });
  if (!ping.ok) throw new Error('base fora do ar ou chave inválida: ' + ping.status);
  const dias = await diasEmRisco();
  console.log('Dias com risco previsto:', dias.map(d => d.data + ' (índice ' + d.indice + ')').join(', ') || 'nenhum');
  if (!dias.length) return;
  const news = await noticias(); console.log('Notícias de alagamento encontradas nos feeds:', news.length);
  for (const d of dias) {
    if (await jaRegistrado(d.data)) { console.log(d.data, 'já tem registro, ignorado'); continue; }
    const n = news.find(x => vale(x, d.data));
    if (!n) { console.log(d.data, 'sem notícia ainda'); continue; }
    await registrar(d.data, n, d.indice); console.log(d.data, 'REGISTRADO:', n.titulo, n.link);
  }
}
main().catch(e => { console.error(e.message); process.exit(1); });

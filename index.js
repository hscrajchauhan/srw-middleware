// SRW Middleware V2 - RSS + HTML scrapers for news sites + OpenAI formatter
// IMPORTANT: Set env vars before running (OPENAI_API_KEY etc.)

const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const RSSParser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');
const cron = require('node-cron');
const OpenAI = require('openai');
const pLimit = require('p-limit').default;

dotenv.config();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const SOURCES_CONFIG = process.env.SOURCES_CONFIG || 'sources.json';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SECRET = process.env.MIDDLEWARE_SECRET || '';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || null;
const CONCURRENT = parseInt(process.env.CONCURRENT_REQUESTS || '3', 10);

if (!OPENAI_KEY) {
  console.error('OPENAI_API_KEY not set in environment - OpenAI calls will fail');
}
const openai = new OpenAI({ apiKey: OPENAI_KEY });
const rssParser = new RSSParser();
const limit = pLimit(CONCURRENT);
const processedSet = new Set();
let lastJobs = [];

/** Helpers **/
function loadSources() {
  const p = path.join(__dirname, SOURCES_CONFIG);
  if (!fs.existsSync(p)) return { sources: [] };
  try { return JSON.parse(fs.readFileSync(p,'utf8')); } 
  catch (e) { console.error('Failed to read sources.json', e.message); return { sources: [] }; }
}

async function fetchHtml(url) {
  try {
    const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'SRW-Middleware/2.0 (+contact)' } });
    return cheerio.load(res.data);
  } catch (e) {
    console.warn('fetchHtml fail', url, e.message);
    return null;
  }
}

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return res.data;
}

async function parsePdfBuffer(buffer) {
  try { const data = await pdf(buffer); return data.text || ''; } catch (e) { return ''; }
}

function sanitizeTitle(t) { if (!t) return ''; return t.replace(/\s+/g,' ').trim(); }

/** OpenAI formatting **/
async function formatWithOpenAI(raw) {
  if (!OPENAI_KEY) return null;
  const prompt = `You are a helpful assistant that converts raw job-notification data into a clean HTML post for a Hindi job site.
Input JSON:
${JSON.stringify(raw,null,2)}

Produce output as JSON exactly with keys:
- unique_id (string) - stable id or URL
- title (string) - short SEO-friendly title in Hindi or English as appropriate
- content_html (string) - HTML to be used as WordPress post content (include intro, Important Dates table if present, Vacancy Details table if present, How to Apply, Important Links)
- source (string) - source name
- source_link (string) - original URL

Return only valid JSON.`;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-5-mini',
      messages: [
        { role: 'system', content: 'You are a helpful formatter.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1000,
      temperature: 0.0
    });
    const txt = resp.choices?.[0]?.message?.content?.trim();
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (err) {
    console.error('OpenAI format error', err?.message || err);
    return null;
  }
}

/** Discover functions **/
async function discoverRSS(source) {
  const out = [];
  try {
    const feed = await rssParser.parseURL(source.url);
    if (!feed || !feed.items) return out;
    for (const it of feed.items) {
      const url = it.link || it.guid || (it.enclosure && it.enclosure.url);
      const title = it.title || (it.contentSnippet || '').slice(0,120);
      out.push({ title: sanitizeTitle(title), url, snippet: it.contentSnippet || it.content || '', source_name: source.name, from_source: source.id });
    }
  } catch (e) { console.warn('rss discover fail', source.id, e.message); }
  return out;
}

async function discoverNewsPage(source) {
  const results = [];
  const $ = await fetchHtml(source.url);
  if (!$) return results;
  const selectors = source.selectors || ['article a','a'];
  const seen = new Set();
  for (const sel of selectors) {
    $(sel).each((i, el) => {
      const el$ = $(el);
      let href = el$.attr('href') || '';
      let text = el$.text().trim();
      if (!href || !text) return;
      if (!href.startsWith('http')) {
        try { href = new URL(href, source.url).href; } catch (e) { return; }
      }
      // only consider likely job/notification links: heuristics
      const low = href.toLowerCase();
      if (low.includes('job') || low.includes('vacancy') || low.includes('recruit') || low.includes('notification') || text.toLowerCase().includes('result') || text.toLowerCase().includes('recruit')) {
        const key = href;
        if (!seen.has(key)) { seen.add(key); results.push({ title: sanitizeTitle(text), url: href, snippet: '', source_name: source.name, from_source: source.id }); }
      }
    });
    if (results.length > 50) break;
  }
  return results;
}

async function discoverFromSource(source) {
  if (source.type === 'rss') return await discoverRSS(source);
  if (source.type === 'news') return await discoverNewsPage(source);
  if (source.type === 'page') return await discoverNewsPage(source);
  if (source.type === 'pdf') {
    try {
      const buf = await fetchBuffer(source.url);
      const txt = await parsePdfBuffer(buf);
      return [{ title: source.name + ' Notification', url: source.url, snippet: txt.slice(0,400), pdf_text: txt, source_name: source.name, from_source: source.id }];
    } catch (e) { return []; }
  }
  return [];
}

async function processDiscoveredItem(item) {
  const raw = {
    title: item.title || '',
    snippet: item.snippet || '',
    url: item.url || '',
    pdf_text: item.pdf_text || '',
    source_name: item.source_name || item.source || '',
    discovered_from: item.from_source || ''
  };
  // call OpenAI to format
  const formatted = await formatWithOpenAI(raw);
  if (!formatted || !formatted.unique_id || !formatted.title || !formatted.content_html) {
    console.warn('Formatted missing fields', formatted && Object.keys(formatted));
    return null;
  }
  formatted.unique_id = formatted.unique_id.toString();
  return formatted;
}

async function fetchAllJobs() {
  const cfg = loadSources();
  const sources = cfg.sources || [];
  const discovered = [];
  await Promise.all(sources.map(s => limit(() => discoverFromSource(s).then(r => { if (r && r.length) discovered.push(...r); }))));
  if (discovered.length === 0) { lastJobs = []; return []; }
  // dedupe
  const uniqueMap = new Map();
  for (const d of discovered) {
    const key = (d.url || '').trim() || (d.title || '').slice(0,80);
    if (!key) continue;
    if (!uniqueMap.has(key)) uniqueMap.set(key, d);
  }
  const uniqList = Array.from(uniqueMap.values()).slice(0,200);
  const formattedJobs = [];
  await Promise.all(uniqList.map(item => limit(async () => {
    try {
      const key = (item.url || '').trim();
      if (processedSet.has(key)) return;
      const f = await processDiscoveredItem(item);
      if (f) {
        processedSet.add(f.unique_id || (f.source_link || item.url));
        formattedJobs.push(f);
      }
    } catch (err) { console.warn('process item error', err.message); }
  })));
  lastJobs = formattedJobs;
  console.log('Fetch completed, jobs:', formattedJobs.length);
  return formattedJobs;
}

/** Routes **/
app.get('/check-jobs', async (req, res) => {
  const token = req.query.secret || req.headers['x-middleware-secret'] || '';
  if (SECRET && token !== SECRET) return res.status(401).json({ status:'error', message:'Unauthorized' });
  try {
    const jobs = await fetchAllJobs();
    return res.json({ status:'success', data:{ jobs } });
  } catch (e) {
    console.error('check-jobs error', e.message || e);
    return res.status(500).json({ status:'error', message: e.message || String(e) });
  }
});

app.get('/_health', (req, res) => res.json({ ok:true }));

if (CRON_SCHEDULE) {
  try {
    cron.schedule(CRON_SCHEDULE, async () => {
      console.log('Cron running fetchAllJobs...');
      await fetchAllJobs();
    }, { timezone: 'Asia/Kolkata' });
    console.log('Cron scheduled at', CRON_SCHEDULE);
  } catch (e) { console.warn('Cron schedule failed', e.message); }
}

app.listen(PORT, () => {
  console.log(`Middleware running on port ${PORT}`);
});

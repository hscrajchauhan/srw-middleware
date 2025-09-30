// Full middleware - multi-source scraper + OpenAI formatter (deploy-ready)
// IMPORTANT: set OPENAI_API_KEY and other env vars before deploy.
// Uses OpenAI JS SDK v4 pattern (openai.chat.completions.create).

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
const pLimit = require('p-limit');

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
const processedSet = new Set();
let lastJobs = [];

function loadSources() {
  const p = path.join(__dirname, SOURCES_CONFIG);
  if (!fs.existsSync(p)) return { sources: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('Failed to parse sources.json', e.message);
    return { sources: [] };
  }
}

async function fetchBuffer(url) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return res.data;
}

async function parsePdfBuffer(buffer) {
  try {
    const data = await pdf(buffer);
    return data.text || '';
  } catch (e) {
    console.warn('PDF parse failed', e.message);
    return '';
  }
}

async function fetchHtml(url) {
  const res = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'SRW-Middleware/1.0 (+contact)' } });
  return cheerio.load(res.data);
}

function sanitizeTitle(t) {
  if (!t) return '';
  return t.replace(/\s+/g, ' ').trim();
}

// Use OpenAI to format raw item into required JSON structure
async function formatWithOpenAI(raw) {
  if (!OPENAI_KEY) {
    console.warn('Skipping OpenAI formatting because OPENAI_API_KEY not set');
    return null;
  }
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
      max_tokens: 1200,
      temperature: 0.0
    });
    const txt = resp.choices?.[0]?.message?.content?.trim();
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (err) {
    console.error('OpenAI format error', err?.response?.data || err?.message || err);
    return null;
  }
}

async function discoverFromSource(source) {
  const results = [];
  try {
    if (source.type === 'rss') {
      const feed = await rssParser.parseURL(source.url);
      if (!feed || !feed.items) return results;
      for (const it of feed.items) {
        const url = it.link || it.guid || (it.enclosure && it.enclosure.url);
        const title = it.title || (it.contentSnippet || '').slice(0,120);
        const snippet = it.contentSnippet || it.content || '';
        results.push({ title: sanitizeTitle(title), url, snippet, source_name: source.name, from_source: source.id });
      }
    } else if (source.type === 'page') {
      const $ = await fetchHtml(source.url);
      const sel = source.selector || 'a';
      $(sel).each((i, el) => {
        const el$ = $(el);
        const href = el$.attr('href');
        const text = el$.text().trim();
        if (href && text) {
          const url = href.startsWith('http') ? href : new URL(href, source.url).href;
          results.push({ title: sanitizeTitle(text), url, snippet: '', source_name: source.name, from_source: source.id });
        }
      });
    } else if (source.type === 'pdf') {
      const buf = await fetchBuffer(source.url);
      const txt = await parsePdfBuffer(buf);
      results.push({ title: source.name + ' Notification', url: source.url, snippet: txt.slice(0,400), pdf_text: txt, source_name: source.name, from_source: source.id });
    } else if (source.type === 'api') {
      const res = await axios.get(source.url, { timeout: 20000 });
      const data = res.data;
      if (Array.isArray(data)) {
        for (const n of data) {
          results.push({ title: n.title || n.name || '', url: n.url || n.link || '', snippet: n.summary || '', source_name: source.name, from_source: source.id });
        }
      } else if (Array.isArray(data.items)) {
        for (const n of data.items) {
          results.push({ title: n.title || '', url: n.url || n.link || '', snippet: n.summary || '', source_name: source.name, from_source: source.id });
        }
      }
    }
  } catch (e) {
    console.warn('discover error for ' + source.id + ' -> ' + e.message);
  }
  return results;
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

  const formatted = await formatWithOpenAI(raw);
  if (!formatted || !formatted.unique_id || !formatted.title || !formatted.content_html) {
    console.warn('Formatted result missing required fields', formatted);
    return null;
  }
  formatted.unique_id = formatted.unique_id.toString();
  return formatted;
}

async function fetchAllJobs() {
  const cfg = loadSources();
  const sources = cfg.sources || [];
  const discovered = [];
  const limit = pLimit(CONCURRENT);

  await Promise.all(sources.map(s => limit(() => discoverFromSource(s).then(r => { if (r && r.length) discovered.push(...r); }))));

  if (discovered.length === 0) {
    console.log('No discovered items');
    lastJobs = [];
    return [];
  }

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
    } catch (err) {
      console.warn('process item error', err.message);
    }
  })));

  lastJobs = formattedJobs;
  console.log('Fetch completed, jobs:', formattedJobs.length);
  return formattedJobs;
}

app.get('/check-jobs', async (req, res) => {
  const token = req.query.secret || req.headers['x-middleware-secret'] || '';
  if (SECRET && token !== SECRET) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  try {
    const jobs = await fetchAllJobs();
    return res.json({ status: 'success', data: { jobs } });
  } catch (e) {
    console.error('check-jobs error', e.message);
    return res.status(500).json({ status: 'error', message: e.message });
  }
});

app.get('/_health', (req, res) => res.json({ ok: true }));

if (CRON_SCHEDULE) {
  try {
    cron.schedule(CRON_SCHEDULE, async () => {
      console.log('Cron running fetchAllJobs...');
      await fetchAllJobs();
    }, { timezone: 'Asia/Kolkata' });
    console.log('Cron scheduled at', CRON_SCHEDULE);
  } catch (e) {
    console.warn('Cron schedule failed', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`Middleware running on port ${PORT}`);
});

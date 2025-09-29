// index.js - SRW Middleware
// Multi-source scraping, PDF parsing, GPT formatting

const express = require('express');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const RSSParser = require('rss-parser');
const axios = require('axios');
const cheerio = require('cheerio');
const pdf = require('pdf-parse');
const cron = require('node-cron');
const { OpenAIApi, Configuration } = require('openai');
const pLimit = require('p-limit');

dotenv.config();
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4000;
const SOURCES_CONFIG = process.env.SOURCES_CONFIG || 'sources.json';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const SECRET = process.env.MIDDLEWARE_SECRET || '';
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || null;
const CONCURRENT = parseInt(process.env.CONCURRENT_REQUESTS || '4', 10);

if (!OPENAI_KEY) {
  console.error('OPENAI_API_KEY not set in .env');
}

const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_KEY }));
const rssParser = new RSSParser();
const processedSet = new Set();
let lastJobs = [];

function loadSources() {
  const p = path.join(__dirname, SOURCES_CONFIG);
  if (!fs.existsSync(p)) return { sources: [] };
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

app.get('/check-jobs', async (req, res) => {
  return res.json({ status: 'success', data: { jobs: [] } });
});

app.get('/_health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Middleware running on port ${PORT}`);
});

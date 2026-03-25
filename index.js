const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chromium = require('@sparticuz/chromium');

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const MAX_ARTICLES = 25;
const CONCURRENCY = 5;
const TIMEOUT = 20000; // 20 seconds per page

// Helper: launch browser with Railway‑compatible settings
async function launchBrowser() {
  const executablePath = await chromium.executablePath();
  const args = [
    ...chromium.args,
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--disable-accelerated-2d-canvas',
    '--disable-accelerated-jpeg-decoding',
    '--disable-web-security',
    '--window-size=1280,800',
  ];

  const browser = await puppeteer.launch({
    executablePath,
    args,
    headless: true,
    defaultViewport: {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
    },
  });
  return browser;
}

// Scrape homepage to get article URLs and titles
async function getArticleUrls(page) {
  await page.goto('https://jamuna.tv', {
    waitUntil: 'networkidle2',
    timeout: TIMEOUT,
  });

  // Wait for news links to appear
  await page.waitForSelector('a[href*="/national/"], a[href*="/all-bangladesh/"], a[href*="/international/"]', {
    timeout: TIMEOUT,
  });

  const articles = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/national/"], a[href*="/all-bangladesh/"], a[href*="/international/"]');
    const seen = new Set();
    const result = [];

    for (const a of links) {
      let href = a.getAttribute('href');
      if (!href) continue;

      // Make absolute URL
      if (href.startsWith('/')) {
        href = 'https://jamuna.tv' + href;
      } else if (!href.startsWith('http')) {
        href = 'https://jamuna.tv/' + href;
      }

      if (seen.has(href)) continue;
      seen.add(href);

      // Try to get title from heading near the link
      let title = a.innerText.trim();
      if (!title) {
        const parent = a.closest('div, article, li');
        if (parent) {
          const heading = parent.querySelector('h2, h3, h4, .title, .heading');
          if (heading) title = heading.innerText.trim();
        }
      }
      if (!title) title = 'No title';

      result.push({ url: href, title });
      if (result.length >= 25) break;
    }
    return result;
  });

  return articles;
}

// Scrape a single article page for detailed info
async function scrapeArticle(browser, url, fallbackTitle) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT,
    });

    const data = await page.evaluate(() => {
      const getMeta = (attr, value) => {
        const el = document.querySelector(`meta[${attr}="${value}"]`);
        return el ? el.getAttribute('content') : '';
      };

      const title =
        document.querySelector('h1')?.innerText ||
        document.querySelector('h2')?.innerText ||
        getMeta('property', 'og:title') ||
        document.title;

      const image = getMeta('property', 'og:image') || document.querySelector('img')?.src || '';

      const description =
        getMeta('name', 'description') ||
        getMeta('property', 'og:description') ||
        '';

      let date = '';
      const timeEl = document.querySelector('time');
      if (timeEl) date = timeEl.getAttribute('datetime') || timeEl.innerText;
      if (!date) {
        const dateSpan = document.querySelector('.date, .time, .published, .post-date');
        if (dateSpan) date = dateSpan.innerText;
      }

      return {
        title: title.trim(),
        image: image.trim(),
        description: description.trim(),
        date: date.trim(),
      };
    });

    if (!data.title) data.title = fallbackTitle;

    return {
      title: data.title,
      image: data.image,
      description: data.description,
      date: data.date,
      link: url,
    };
  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error.message);
    return {
      title: fallbackTitle,
      image: '',
      description: '',
      date: '',
      link: url,
    };
  } finally {
    if (page) await page.close();
  }
}

// Main endpoint
app.get('/api/news', async (req, res) => {
  let browser = null;
  try {
    console.log('Launching browser...');
    browser = await launchBrowser();
    const page = await browser.newPage();

    console.log('Fetching homepage...');
    const articles = await getArticleUrls(page);
    await page.close();

    if (articles.length === 0) {
      throw new Error('No articles found on homepage');
    }
    console.log(`Found ${articles.length} articles, scraping details...`);

    // Scrape in parallel with concurrency limit
    const results = [];
    for (let i = 0; i < articles.length; i += CONCURRENCY) {
      const chunk = articles.slice(i, i + CONCURRENCY);
      const promises = chunk.map(item => scrapeArticle(browser, item.url, item.title));
      const chunkResults = await Promise.allSettled(promises);
      for (const r of chunkResults) {
        if (r.status === 'fulfilled') results.push(r.value);
        else console.error('Scrape failed:', r.reason);
      }
    }

    const validNews = results.filter(n => n.title && n.title !== 'No title');
    console.log(`Successfully scraped ${validNews.length} articles`);

    res.json({
      success: true,
      total: validNews.length,
      news: validNews,
    });
  } catch (error) {
    console.error('Scraping error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  } finally {
    if (browser) await browser.close();
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'jamuna-scraper' });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

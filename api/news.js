import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import chromium from '@sparticuz/chromium';

// Add stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

// Timeout for each page load (ms)
const TIMEOUT = 15000;
const MAX_CONCURRENT = 5; // limit parallel scraping
const MAX_ARTICLES = 25;

/**
 * Launch browser with serverless-optimized settings
 */
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

/**
 * Scrape homepage and collect article URLs with titles
 */
async function getArticleUrls(page) {
  await page.goto('https://jamuna.tv', {
    waitUntil: 'networkidle2',
    timeout: TIMEOUT,
  });

  // Wait for news links – adjust selector as needed
  await page.waitForSelector('a[href*="/national/"], a[href*="/all-bangladesh/"], a[href*="/international/"]', {
    timeout: TIMEOUT,
  });

  // Extract links and titles from homepage
  const links = await page.evaluate(() => {
    const items = document.querySelectorAll('a[href*="/national/"], a[href*="/all-bangladesh/"], a[href*="/international/"]');
    const seen = new Set();
    const result = [];

    for (const a of items) {
      let href = a.getAttribute('href');
      if (!href) continue;

      // Make absolute URL
      if (href.startsWith('/')) {
        href = 'https://jamuna.tv' + href;
      } else if (!href.startsWith('http')) {
        href = 'https://jamuna.tv/' + href;
      }

      // Avoid duplicates
      if (seen.has(href)) continue;
      seen.add(href);

      // Try to get title from nearby heading
      let title = a.innerText.trim();
      if (!title) {
        const parent = a.closest('div, article');
        if (parent) {
          const heading = parent.querySelector('h2, h3, h4, .title, .heading');
          if (heading) title = heading.innerText.trim();
        }
      }
      if (!title) title = 'No title';

      result.push({ url: href, title });
    }
    return result;
  });

  // Limit and deduplicate (just in case)
  const unique = [];
  const urlSet = new Set();
  for (const item of links) {
    if (urlSet.has(item.url)) continue;
    urlSet.add(item.url);
    unique.push(item);
    if (unique.length >= MAX_ARTICLES) break;
  }

  return unique;
}

/**
 * Scrape a single article page for detailed data
 */
async function scrapeArticle(browser, url, fallbackTitle) {
  let page = null;
  try {
    page = await browser.newPage();

    // Set realistic viewport and user-agent (already handled by stealth plugin)
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT,
    });

    // Extract data from meta tags and visible elements
    const data = await page.evaluate(() => {
      // Helper to get meta content by name or property
      const getMeta = (selector) => {
        const el = document.querySelector(`meta[${selector}]`);
        return el ? el.getAttribute('content') : '';
      };

      const title =
        document.querySelector('h1')?.innerText ||
        document.querySelector('h2')?.innerText ||
        getMeta('property="og:title"') ||
        document.title ||
        '';

      const image =
        getMeta('property="og:image"') ||
        document.querySelector('img')?.src ||
        '';

      const description =
        getMeta('name="description"') ||
        getMeta('property="og:description"') ||
        '';

      // Try to find a date (time tag or specific class)
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

    // If no title from article, use fallback from homepage
    if (!data.title) data.title = fallbackTitle;

    return {
      title: data.title || 'No title',
      image: data.image,
      description: data.description,
      date: data.date,
      link: url,
    };
  } catch (error) {
    console.error(`Failed to scrape ${url}:`, error.message);
    // Return minimal data with fallback title
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

/**
 * Main API handler (Vercel serverless function)
 */
export default async function handler(req, res) {
  // Only allow GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let browser = null;
  try {
    // Launch browser with stealth plugin
    browser = await launchBrowser();

    const page = await browser.newPage();

    // Get list of article URLs from homepage
    const articles = await getArticleUrls(page);
    await page.close();

    if (articles.length === 0) {
      throw new Error('No articles found on homepage');
    }

    // Scrape articles in parallel with concurrency limit
    const results = [];
    const chunks = [];
    for (let i = 0; i < articles.length; i += MAX_CONCURRENT) {
      chunks.push(articles.slice(i, i + MAX_CONCURRENT));
    }

    for (const chunk of chunks) {
      const promises = chunk.map((item) =>
        scrapeArticle(browser, item.url, item.title)
      );
      const chunkResults = await Promise.allSettled(promises);
      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          console.error('Scrape promise rejected:', result.reason);
        }
      }
    }

    // Remove any empty entries (just in case)
    const validNews = results.filter((item) => item.title && item.title !== 'No title');

    res.status(200).json({
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
}

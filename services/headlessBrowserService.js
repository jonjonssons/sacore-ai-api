const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/**
 * Service for headless browser operations to analyze Google CSE structure
 */
class HeadlessBrowserService {
  constructor() {
    this.browser = null;
  }

  /**
   * Initialize the browser instance
   */
  async initialize() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    }
  }

  /**
   * Close the browser instance
   */
  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Capture Google CSE search results with full page structure
   * @param {string} query - The search query
   * @param {number} start - The start index for pagination
   * @returns {Object} - The captured data including HTML, screenshots, and network requests
   */
  async captureGoogleCseStructure(query, start = 1) {
    await this.initialize();

    const page = await this.browser.newPage();

    // Enable request interception to capture network activity
    await page.setRequestInterception(true);

    const requests = [];
    const responses = [];

    // Capture all network requests
    page.on('request', request => {
      requests.push({
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        resourceType: request.resourceType()
      });
      request.continue();
    });

    // Capture all network responses
    page.on('response', async response => {
      const responseData = {
        url: response.url(),
        status: response.status(),
        headers: response.headers()
      };

      // Try to capture response body for API calls
      if (response.url().includes('customsearch/v1')) {
        try {
          responseData.body = await response.json();
        } catch (e) {
          // Ignore if we can't parse the body
        }
      }

      responses.push(responseData);
    });

    // Construct the Google CSE URL
    const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
    const GOOGLE_CSE_ID = process.env.GOOGLE_SEARCH_ENGINE_ID;

    if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) {
      throw new Error('Google CSE configuration missing');
    }

    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&start=${start}`;

    // Navigate to the URL
    await page.goto(url, { waitUntil: 'networkidle2' });

    // Capture the full page HTML
    const html = await page.content();

    // Take a screenshot
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const screenshotBase64 = screenshotBuffer.toString('base64');

    // Save the screenshot to a file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(__dirname, '..', 'data', 'screenshots', `google-cse-${timestamp}.png`);

    // Ensure the directory exists
    const dir = path.dirname(screenshotPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(screenshotPath, screenshotBuffer);

    // Extract all DOM elements with their attributes
    const domStructure = await page.evaluate(() => {
      function extractElement(element) {
        const children = Array.from(element.children).map(child => extractElement(child));

        const attributes = {};
        for (const attr of element.attributes) {
          attributes[attr.name] = attr.value;
        }

        return {
          tagName: element.tagName.toLowerCase(),
          id: element.id || null,
          className: element.className || null,
          attributes,
          textContent: element.textContent.trim() || null,
          children
        };
      }

      return extractElement(document.documentElement);
    });

    // Close the page
    await page.close();

    return {
      query,
      start,
      html,
      domStructure,
      screenshotPath,
      screenshotBase64,
      requests: requests.filter(req => req.resourceType === 'xhr' || req.resourceType === 'fetch'),
      responses: responses.filter(res => res.url.includes('customsearch/v1')),
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = new HeadlessBrowserService();
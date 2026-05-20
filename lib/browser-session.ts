/**
 * Persistent Playwright browser session for Mission Control.
 *
 * Manages a single long-lived Chromium instance that the chat agent
 * can control: navigate, click, type, extract data, run JS.
 * Returns structured DOM data — NOT screenshots.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let pages: Map<string, Page> = new Map();
let activePageId: string = 'tab-0';

async function ensureBrowser(): Promise<BrowserContext> {
  if (context && browser?.isConnected()) return context;

  // Try to connect to the user's Chrome (launched with --remote-debugging-port=9222)
  // This uses their real profile with all saved passwords, cookies, and sessions
  const cdpPort = process.env.CHROME_CDP_PORT || '9222';
  try {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const contexts = browser.contexts();
    if (contexts.length > 0) {
      context = contexts[0];
      // Import existing tabs
      const existingPages = context.pages();
      pages.clear();
      existingPages.forEach((p, i) => pages.set(`tab-${i}`, p));
      activePageId = pages.size > 0 ? `tab-${pages.size - 1}` : 'tab-0';
      console.log(`[Browser] Connected to existing Chrome on port ${cdpPort} with ${pages.size} tabs`);
      return context;
    }
  } catch {
    // No existing Chrome with CDP — launch our own
  }

  // Launch with visible UI if DISPLAY is set, otherwise headless
  const headless = !process.env.DISPLAY;

  browser = await chromium.launch({
    headless,
    executablePath: '/usr/bin/google-chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  // Create first tab
  const page = await context.newPage();
  pages.set('tab-0', page);
  activePageId = 'tab-0';

  console.log('[Browser] Launched new Chromium instance');
  return context;
}

function getActivePage(): Page | null {
  return pages.get(activePageId) || null;
}

export type BrowserAction =
  | { action: 'status' }
  | { action: 'connect'; port?: number }
  | { action: 'navigate'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'type'; selector: string; text: string }
  | { action: 'press'; key: string }
  | { action: 'select'; selector: string; value: string }
  | { action: 'getText'; selector?: string }
  | { action: 'getLinks'; selector?: string }
  | { action: 'getAttribute'; selector: string; attribute: string }
  | { action: 'getInputValues'; selector?: string }
  | { action: 'evaluate'; script: string }
  | { action: 'waitFor'; selector: string; timeout?: number }
  | { action: 'fill'; selector: string; text: string }
  | { action: 'newTab'; url?: string }
  | { action: 'switchTab'; tabId: string }
  | { action: 'closeTab'; tabId: string }
  | { action: 'listTabs' }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }
  | { action: 'getPageInfo' }
  | { action: 'querySelector'; selector: string }
  | { action: 'querySelectorAll'; selector: string }
  | { action: 'scroll'; direction: 'up' | 'down' | 'top' | 'bottom'; amount?: number }
  | { action: 'close' };

export async function executeBrowserAction(cmd: BrowserAction): Promise<any> {
  try {
    if (cmd.action === 'close') {
      if (browser) {
        await browser.close();
        browser = null;
        context = null;
        pages.clear();
      }
      return { success: true, message: 'Browser closed' };
    }

    if (cmd.action === 'status') {
      const tabs = [];
      for (const [id, p] of pages) {
        try { tabs.push({ id, url: p.url(), title: await p.title().catch(() => ''), active: id === activePageId }); } catch {}
      }
      return {
        running: !!browser?.isConnected(),
        tabs,
        activeTab: activePageId,
      };
    }

    if (cmd.action === 'connect') {
      // Explicitly connect to an existing Chrome with remote debugging
      const port = cmd.port || 9222;
      if (browser) { try { await browser.close(); } catch {} }
      browser = null; context = null; pages.clear();
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const contexts = browser.contexts();
        if (contexts.length > 0) {
          context = contexts[0];
          const existingPages = context.pages();
          existingPages.forEach((p, i) => pages.set(`tab-${i}`, p));
          activePageId = pages.size > 0 ? `tab-${pages.size - 1}` : 'tab-0';
          const tabs = [];
          for (const [id, p] of pages) {
            tabs.push({ id, url: p.url(), title: await p.title().catch(() => '') });
          }
          return { success: true, message: `Connected to Chrome on port ${port}`, tabs };
        }
        return { success: true, message: `Connected but no browser contexts found` };
      } catch (e: any) {
        return { error: `Failed to connect to Chrome on port ${port}: ${e.message}. Launch Chrome with: google-chrome --remote-debugging-port=${port}` };
      }
    }

    await ensureBrowser();
    const page = getActivePage();
    if (!page) throw new Error('No active page');

    switch (cmd.action) {
      case 'navigate': {
        const url = cmd.url.startsWith('http') ? cmd.url : `https://${cmd.url}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return {
          success: true,
          url: page.url(),
          title: await page.title(),
        };
      }

      case 'click': {
        await page.click(cmd.selector, { timeout: 10000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        return {
          success: true,
          url: page.url(),
          title: await page.title(),
        };
      }

      case 'type': {
        await page.type(cmd.selector, cmd.text, { timeout: 10000 });
        return { success: true };
      }

      case 'fill': {
        await page.fill(cmd.selector, cmd.text, { timeout: 10000 });
        return { success: true };
      }

      case 'press': {
        await page.keyboard.press(cmd.key);
        return { success: true };
      }

      case 'select': {
        await page.selectOption(cmd.selector, cmd.value, { timeout: 10000 });
        return { success: true };
      }

      case 'getText': {
        const selector = cmd.selector || 'body';
        const text = await page.textContent(selector, { timeout: 10000 });
        // Trim and limit output
        const cleaned = (text || '').replace(/\s+/g, ' ').trim();
        return {
          text: cleaned.slice(0, 10000),
          length: cleaned.length,
          truncated: cleaned.length > 10000,
        };
      }

      case 'getLinks': {
        const links = await page.evaluate((sel) => {
          const container = sel ? document.querySelector(sel) : document;
          if (!container) return [];
          return Array.from(container.querySelectorAll('a[href]')).map(a => ({
            text: (a as HTMLAnchorElement).textContent?.trim().slice(0, 100) || '',
            href: (a as HTMLAnchorElement).href,
          })).filter(l => l.href && !l.href.startsWith('javascript:'));
        }, cmd.selector || null);
        return { links: links.slice(0, 100), total: links.length };
      }

      case 'getAttribute': {
        const value = await page.getAttribute(cmd.selector, cmd.attribute, { timeout: 5000 });
        return { value };
      }

      case 'getInputValues': {
        const inputs = await page.evaluate((sel) => {
          const container = sel ? document.querySelector(sel) : document;
          if (!container) return [];
          return Array.from(container.querySelectorAll('input, textarea, select')).map(el => {
            const input = el as HTMLInputElement;
            return {
              tag: el.tagName.toLowerCase(),
              type: input.type || '',
              name: input.name || '',
              id: input.id || '',
              value: input.value || '',
              placeholder: input.placeholder || '',
            };
          });
        }, cmd.selector || null);
        return { inputs };
      }

      case 'evaluate': {
        const result = await page.evaluate(cmd.script);
        return { result };
      }

      case 'waitFor': {
        await page.waitForSelector(cmd.selector, { timeout: cmd.timeout || 10000 });
        return { success: true, found: true };
      }

      case 'newTab': {
        const ctx = await ensureBrowser();
        const newPage = await ctx.newPage();
        const tabId = `tab-${pages.size}`;
        pages.set(tabId, newPage);
        activePageId = tabId;
        if (cmd.url) {
          const url = cmd.url.startsWith('http') ? cmd.url : `https://${cmd.url}`;
          await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        return { tabId, url: newPage.url(), title: await newPage.title() };
      }

      case 'switchTab': {
        if (!pages.has(cmd.tabId)) throw new Error(`Tab ${cmd.tabId} not found`);
        activePageId = cmd.tabId;
        const p = pages.get(cmd.tabId)!;
        return { tabId: cmd.tabId, url: p.url(), title: await p.title() };
      }

      case 'closeTab': {
        const p = pages.get(cmd.tabId);
        if (p) {
          await p.close();
          pages.delete(cmd.tabId);
          if (activePageId === cmd.tabId) {
            activePageId = pages.keys().next().value || '';
          }
        }
        return { success: true, remaining: pages.size };
      }

      case 'listTabs': {
        const tabs = [];
        for (const [id, p] of pages) {
          tabs.push({
            id,
            url: p.url(),
            title: await p.title(),
            active: id === activePageId,
          });
        }
        return { tabs };
      }

      case 'back': {
        await page.goBack({ waitUntil: 'domcontentloaded' });
        return { url: page.url(), title: await page.title() };
      }

      case 'forward': {
        await page.goForward({ waitUntil: 'domcontentloaded' });
        return { url: page.url(), title: await page.title() };
      }

      case 'reload': {
        await page.reload({ waitUntil: 'domcontentloaded' });
        return { url: page.url(), title: await page.title() };
      }

      case 'scroll': {
        if (cmd.direction === 'top') {
          await page.evaluate(() => window.scrollTo(0, 0));
        } else if (cmd.direction === 'bottom') {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        } else {
          const amount = cmd.amount || 500;
          const delta = cmd.direction === 'down' ? amount : -amount;
          await page.evaluate((d) => window.scrollBy(0, d), delta);
        }
        return { success: true };
      }

      case 'getPageInfo': {
        const info = await page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
          h1: document.querySelector('h1')?.textContent?.trim() || null,
          metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content') || null,
          forms: document.querySelectorAll('form').length,
          inputs: document.querySelectorAll('input, textarea, select').length,
          buttons: document.querySelectorAll('button, [role="button"], input[type="submit"]').length,
          links: document.querySelectorAll('a[href]').length,
          images: document.querySelectorAll('img').length,
          bodyText: document.body?.innerText?.slice(0, 3000) || '',
        }));
        return info;
      }

      case 'querySelector': {
        const el = await page.evaluate((sel) => {
          const e = document.querySelector(sel);
          if (!e) return null;
          return {
            tag: e.tagName.toLowerCase(),
            id: e.id || null,
            className: e.className || null,
            text: e.textContent?.trim().slice(0, 500) || '',
            attributes: Object.fromEntries(Array.from(e.attributes).map(a => [a.name, a.value])),
            childCount: e.children.length,
          };
        }, cmd.selector);
        return el ? { found: true, element: el } : { found: false };
      }

      case 'querySelectorAll': {
        const els = await page.evaluate((sel) => {
          return Array.from(document.querySelectorAll(sel)).slice(0, 50).map(e => ({
            tag: e.tagName.toLowerCase(),
            id: e.id || null,
            text: e.textContent?.trim().slice(0, 200) || '',
            href: (e as HTMLAnchorElement).href || null,
          }));
        }, cmd.selector);
        return { count: els.length, elements: els };
      }

      default:
        throw new Error(`Unknown action: ${(cmd as any).action}`);
    }
  } catch (error: any) {
    return { error: error.message };
  }
}

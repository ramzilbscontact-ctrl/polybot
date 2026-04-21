/**
 * ibkr-diagnose.js — Diagnostic du login IBKR sans timeout
 * Prend des screenshots à chaque étape pour voir ce qui bloque.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { chromium } = require('playwright');
const fs = require('fs');

const GATEWAY  = process.env.IBKR_GATEWAY_URL || 'https://127.0.0.1:5000';
const USERNAME = process.env.IBKR_USERNAME    || '';
const PASSWORD = process.env.IBKR_PASSWORD    || '';

(async () => {
  console.log('=== IBKR Diagnostic ===');
  console.log(`Gateway: ${GATEWAY}`);
  console.log(`Username: ${USERNAME}`);

  // Check gateway is up (use https module to skip cert check)
  const https = require('https');
  await new Promise(resolve => {
    const req = https.get(`${GATEWAY}/v1/api/one/user`, { rejectUnauthorized: false }, res => {
      console.log(`Gateway health: ${res.statusCode}`);
      resolve();
    });
    req.on('error', e => { console.log(`Gateway check: ${e.message} (may still be starting)`); resolve(); });
    req.setTimeout(5000, () => { req.destroy(); console.log('Gateway: timeout'); resolve(); });
  });

  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx  = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  // Capture all console errors from the page
  page.on('console', m => { if (m.type() === 'error') console.log(`  JS Error: ${m.text()}`); });
  page.on('response', r => { if (r.status() >= 400) console.log(`  HTTP ${r.status()}: ${r.url().substring(0, 80)}`); });

  try {
    console.log('\n1. Chargement page login...');
    await page.goto(`${GATEWAY}/sso/Login?forwardTo=22&RL=1&ip2loc=EU`, {
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await page.screenshot({ path: '/tmp/ibkr-diag-01-loaded.png' });
    const title = await page.title();
    console.log(`   Title: "${title}"`);
    console.log('   Screenshot: /tmp/ibkr-diag-01-loaded.png');

    // Check what's on the page
    const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
    console.log(`   Body preview: ${bodyText.replace(/\n/g, '|').substring(0, 300)}`);

    // List all input fields
    const inputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(el => ({
        id: el.id, name: el.name, type: el.type, placeholder: el.placeholder
      }));
    });
    console.log('   Inputs found:', JSON.stringify(inputs));

    // Wait a bit for JS to render
    console.log('\n2. Attente rendu JS (5s)...');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '/tmp/ibkr-diag-02-after5s.png' });
    console.log('   Screenshot: /tmp/ibkr-diag-02-after5s.png');

    const inputs2 = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(el => ({
        id: el.id, name: el.name, type: el.type
      }));
    });
    console.log('   Inputs after 5s:', JSON.stringify(inputs2));

    // Try to find username field with multiple selectors
    const selectors = [
      '#xyz-field-username',
      'input[name="username"]',
      'input[type="text"]',
      'input[placeholder*="user" i]',
      'input[placeholder*="login" i]',
      'input[id*="user" i]',
      'input[autocomplete="username"]',
    ];

    for (const sel of selectors) {
      const visible = await page.isVisible(sel, { timeout: 1000 }).catch(() => false);
      if (visible) console.log(`   ✅ Found: ${sel}`);
      else {
        const exists = await page.$(sel);
        if (exists) console.log(`   ⚠️  Exists but hidden: ${sel}`);
      }
    }

    // Check if it's an IP block / captcha page
    const html = await page.content();
    if (html.includes('blocked') || html.includes('captcha') || html.includes('CAPTCHA')) {
      console.log('\n   ❌ IP BLOCKED or CAPTCHA detected!');
    }
    if (html.includes('too many') || html.includes('Too many')) {
      console.log('\n   ❌ Too many attempts detected!');
    }

    console.log('\n3. Tentative login si champs trouvés...');
    const usernameField = inputs2.find(i => i.id === 'xyz-field-username' || i.type === 'text');
    if (!usernameField) {
      console.log('   ❌ Pas de champ username — page différente');
      console.log('   Vérifier /tmp/ibkr-diag-02-after5s.png pour voir ce qui est affiché');
      await browser.close();
      return;
    }

    // Try filling
    await page.locator(`#${usernameField.id || 'input[type="text"]'}`).fill(USERNAME);
    await page.screenshot({ path: '/tmp/ibkr-diag-03-filled.png' });
    console.log('   Champ rempli, screenshot: /tmp/ibkr-diag-03-filled.png');

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    await page.screenshot({ path: '/tmp/ibkr-diag-error.png' }).catch(() => {});
    console.log('   Screenshot error: /tmp/ibkr-diag-error.png');
  } finally {
    await browser.close();
  }
})();

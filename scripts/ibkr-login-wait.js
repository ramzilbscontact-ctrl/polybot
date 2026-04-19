/**
 * ibkr-login-wait.js — Login IBKR Client Portal Gateway
 * Strategy: click Paper toggle FIRST (before filling), so form reset is harmless.
 * Paper account DUP564236 — same credentials as live.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { chromium } = require('playwright');
const https  = require('https');
const fs     = require('fs');

const GATEWAY    = process.env.IBKR_GATEWAY_URL || 'https://localhost:5000';
const USERNAME   = process.env.IBKR_USERNAME    || '';
const PASSWORD   = process.env.IBKR_PASSWORD    || '';
const CODE_FILE  = '/tmp/ibkr-2fa-code';
const STATE_FILE = '/tmp/ibkr-login-state';

function waitForFile(f, ms = 120000) {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const check = () => {
      if (fs.existsSync(f)) {
        const c = fs.readFileSync(f, 'utf8').trim();
        fs.unlinkSync(f);
        resolve(c);
      } else if (Date.now() - t > ms) {
        reject(new Error('Timeout 2FA'));
      } else {
        setTimeout(check, 300);
      }
    };
    check();
  });
}

(async () => {
  [CODE_FILE, STATE_FILE].forEach(f => { try { fs.unlinkSync(f); } catch {} });

  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    fs.writeFileSync(STATE_FILE, 'loading');
    console.log('▶ Chargement page login...');
    await page.goto(`${GATEWAY}/sso/Login?forwardTo=22&RL=1&ip2loc=EU`, {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await page.waitForSelector('#xyz-field-username', { timeout: 15000 });
    console.log('   Page chargée');

    // Fill credentials FIRST with fill() (triggers React onChange)
    console.log('▶ Saisie identifiants...');
    await page.locator('#xyz-field-username').fill(USERNAME);
    await page.locator('#xyz-field-password').fill(PASSWORD);

    const u = await page.locator('#xyz-field-username').inputValue();
    const p = await page.locator('#xyz-field-password').inputValue();
    console.log(`   Username: "${u}" (${u.length} chars), Password: ${p.length} chars`);
    if (!u) throw new Error('Username still empty');

    // THEN switch to Paper mode (fill() already committed React state, toggle won't reset it)
    const toggleVisible = await page.isVisible('.toggle-wrapper', { timeout: 3000 }).catch(() => false);
    if (toggleVisible) {
      console.log('▶ Passage en mode Paper...');
      await page.locator('.toggle-wrapper').click({ force: true });
      await page.waitForTimeout(1000);
      const u2 = await page.locator('#xyz-field-username').inputValue();
      console.log(`   Username après toggle: "${u2}" (${u2.length} chars)`);
      if (!u2) {
        // Toggle cleared the form — refill
        console.log('   Refill après toggle...');
        await page.locator('#xyz-field-username').fill(USERNAME);
        await page.locator('#xyz-field-password').fill(PASSWORD);
      }
    }

    await page.click('.xyz-button-login');
    console.log('▶ Credentials soumis...');
    await page.waitForTimeout(5000);

    // OTP selector
    const otpSel = await page.isVisible('.xyz-otp-select-text', { timeout: 2000 }).catch(() => false);
    if (otpSel) {
      console.log('   Sélection SMS...');
      await page.click('.xyz-otp-select-text');
      await page.waitForTimeout(3000);
    }

    // Silver 2FA
    const silverVisible = await page.isVisible('.xyz-silver-response', { timeout: 5000 }).catch(() => false);
    if (silverVisible) {
      fs.writeFileSync(STATE_FILE, 'waiting-2fa');
      console.log('\n📱 CODE 2FA REQUIS\n   Envoyez le code maintenant\n');

      const code = await waitForFile(CODE_FILE, 120000);
      console.log(`   Code reçu : ${code}`);
      await page.fill('.xyz-silver-response', code);
      await page.locator('.xyzform-silver button[type="submit"]').click();
      await page.waitForTimeout(8000);
    }

    // Wait for Dispatcher to complete its redirect to the main app
    console.log('▶ Attente navigation post-login...');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    const url = page.url();
    console.log(`   URL finale : ${url}`);

    // Give the gateway a moment to establish the IServer session
    await page.waitForTimeout(3000);

    // Call reauthenticate to ensure IServer session is initialized
    const reauth = await page.evaluate(async () => {
      try {
        const r = await fetch('/v1/api/iserver/reauthenticate', { method: 'POST' });
        return r.status;
      } catch(e) { return 0; }
    });
    console.log(`   Reauthenticate: ${reauth}`);
    await page.waitForTimeout(3000);

    // Vérifier auth depuis la même page (même session cookie)
    const sessionCheck = await page.evaluate(async () => {
      await fetch('/v1/api/tickle', { method: 'POST' }).catch(() => {});
      try {
        const r = await fetch('/v1/api/iserver/auth/status');
        const j = await r.json();
        return { authenticated: j.authenticated, status: r.status, data: j };
      } catch(e) {
        return { authenticated: false, error: e.message };
      }
    });
    console.log('   Session check:', JSON.stringify(sessionCheck));

    const pageText = await page.textContent('body').catch(() => '');
    const loginOk = sessionCheck.authenticated === true ||
                    pageText.includes('login succeeds') ||
                    url.includes('Dispatcher') ||
                    url.includes('portal');

    // Sauvegarder cookies
    const cookies = await context.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    fs.writeFileSync('/tmp/ibkr-cookies.txt', cookieStr);
    const storageState = await context.storageState();
    fs.writeFileSync('/tmp/ibkr-session.json', JSON.stringify(storageState));

    if (loginOk) {
      fs.writeFileSync(STATE_FILE, 'authenticated');
      console.log('\n✅ Authentifié !\n   Session: /tmp/ibkr-session.json\n   Lancer : npm run nordic:dry\n');

      // Garder le browser vivant + tickle toutes les 60s
      console.log('   Keepalive actif (tickle/60s) — Ctrl+C pour arrêter');
      while (true) {
        await page.waitForTimeout(55000);
        const t = await page.evaluate(async () => {
          try {
            const r = await fetch('/v1/api/tickle', { method: 'POST' });
            return r.status;
          } catch(e) { return 0; }
        }).catch(() => 0);
        console.log(`   Tickle: ${t}`);
        if (t === 0) { console.log('   Session perdue — relancer le login'); break; }
        if (t === 401) {
          // Try reauthenticate before giving up
          const ra = await page.evaluate(async () => {
            try { const r = await fetch('/v1/api/iserver/reauthenticate', { method: 'POST' }); return r.status; }
            catch(e) { return 0; }
          }).catch(() => 0);
          console.log(`   Reauthenticate: ${ra}`);
        }
      }
    } else {
      fs.writeFileSync(STATE_FILE, 'failed');
      await page.screenshot({ path: '/tmp/ibkr-post-login.png' });
      console.log('\n❌ Échec. Screenshot: /tmp/ibkr-post-login.png');
    }

  } catch (err) {
    fs.writeFileSync(STATE_FILE, `error:${err.message}`);
    console.error('❌', err.message);
    await page.screenshot({ path: '/tmp/ibkr-debug-err.png' }).catch(() => {});
  } finally {
    await browser.close();
  }
})();

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
      // Wait for Dispatcher redirect — don't navigate away, it kills the session
      await page.waitForURL('**/sso/Dispatcher**', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    const url = page.url();
    console.log(`   URL post-login : ${url}`);

    // Sauvegarder cookies depuis le contexte du browser (session SSO valide)
    const cookies = await context.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    fs.writeFileSync('/tmp/ibkr-cookies.txt', cookieStr);
    const storageState = await context.storageState();
    fs.writeFileSync('/tmp/ibkr-session.json', JSON.stringify(storageState));

    // Use context.request (shares browser cookies)
    const apiCall = async (method, path) => {
      try {
        const r = method === 'POST'
          ? await context.request.post(`${GATEWAY}${path}`)
          : await context.request.get(`${GATEWAY}${path}`);
        return r;
      } catch(e) { return null; }
    };

    // Log raw auth/status for debugging
    const statusR = await apiCall('GET', '/v1/api/iserver/auth/status');
    const statusBody = statusR ? await statusR.text() : 'no response';
    console.log(`   Auth status: ${statusR ? statusR.status() : 0} ${statusBody.substring(0, 150)}`);

    const loginOk = url.includes('Dispatcher') || url.includes('portal') || statusBody.includes('"authenticated":true');

    if (loginOk) {
      fs.writeFileSync(STATE_FILE, 'authenticated');
      console.log(`\n✅ Session active (${url.includes('Dispatcher') ? 'Dispatcher' : 'API'})\n   Cookies: /tmp/ibkr-cookies.txt\n   Lancer : npm run nordic:dry\n`);

      // Keepalive: tickle via context.request every 55s
      console.log('   Keepalive actif (tickle/55s) — Ctrl+C pour arrêter');
      let failCount = 0;
      while (true) {
        await page.waitForTimeout(55000);
        const tr = await apiCall('POST', '/v1/api/tickle');
        const t = tr ? tr.status() : 0;
        const tb = tr ? (await tr.text().catch(() => '')).substring(0, 80) : '';
        console.log(`   Tickle: ${t} ${tb}`);
        if (t === 0) { console.log('   Connexion perdue — relancer le login'); break; }
        if (t === 401) {
          failCount++;
          if (failCount >= 3) { console.log('   Session expirée après 3 tentatives — relancer le login'); break; }
          const ra = await apiCall('POST', '/v1/api/iserver/reauthenticate');
          console.log(`   Reauthenticate: ${ra ? ra.status() : 0}`);
        } else {
          failCount = 0;
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

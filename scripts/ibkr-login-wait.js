/**
 * ibkr-login-wait.js — Login IBKR Client Portal Gateway
 * Supports both SMS code (via /tmp/ibkr-2fa-code file) and push notification.
 * After login, navigates to /demo to initialize the IServer API session.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { chromium } = require('playwright');
const fs = require('fs');

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

async function apiCall(context, method, path) {
  try {
    const r = method === 'POST'
      ? await context.request.post(`${GATEWAY}${path}`)
      : await context.request.get(`${GATEWAY}${path}`);
    return r;
  } catch { return null; }
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

    // Fill credentials first (triggers React onChange)
    console.log('▶ Saisie identifiants...');
    await page.locator('#xyz-field-username').fill(USERNAME);
    await page.locator('#xyz-field-password').fill(PASSWORD);

    const u = await page.locator('#xyz-field-username').inputValue();
    if (!u) throw new Error('Username still empty');
    console.log(`   Username: "${u}", Password: ${PASSWORD.length} chars`);

    // Switch to Paper mode after filling (fill() committed React state)
    const toggleVisible = await page.isVisible('.toggle-wrapper', { timeout: 3000 }).catch(() => false);
    if (toggleVisible) {
      console.log('▶ Mode Paper...');
      await page.locator('.toggle-wrapper').click({ force: true });
      await page.waitForTimeout(1000);
      const u2 = await page.locator('#xyz-field-username').inputValue();
      if (!u2) {
        await page.locator('#xyz-field-username').fill(USERNAME);
        await page.locator('#xyz-field-password').fill(PASSWORD);
        console.log('   Refill après toggle');
      }
    }

    await page.click('.xyz-button-login');
    console.log('▶ Credentials soumis — attente 2FA...');
    await page.waitForTimeout(5000);

    // OTP method selector
    const otpSel = await page.isVisible('.xyz-otp-select-text', { timeout: 2000 }).catch(() => false);
    if (otpSel) {
      await page.click('.xyz-otp-select-text');
      await page.waitForTimeout(3000);
    }

    // Push notification (tap sur mobile IBKR — plus de code SMS nécessaire)
    const pushVisible = await page.isVisible('.xyzblock-notification', { timeout: 3000 }).catch(() => false);
    if (pushVisible) {
      fs.writeFileSync(STATE_FILE, 'waiting-push');
      console.log('\n📲 APPROBATION PUSH REQUISE\n   Ouvrez l\'app IBKR sur votre téléphone et approuvez la connexion\n');
      await page.waitForSelector('.xyzblock-success, .xyzform-silver', { timeout: 90000 });
      console.log('   Push approuvé');
    }

    // SMS/email code (Silver OTP)
    const silverVisible = await page.isVisible('.xyz-silver-response', { timeout: 5000 }).catch(() => false);
    if (silverVisible) {
      fs.writeFileSync(STATE_FILE, 'waiting-2fa');
      console.log('\n📱 CODE 2FA — envoyez : echo "VOTRE_CODE" > /tmp/ibkr-2fa-code\n');
      const code = await waitForFile(CODE_FILE, 120000);
      console.log(`   Code reçu : ${code}`);
      await page.fill('.xyz-silver-response', code);
      await page.locator('.xyzform-silver button[type="submit"]').click();
    }

    // Wait for Dispatcher (confirms SSO success)
    await page.waitForURL('**/sso/Dispatcher**', { timeout: 20000 }).catch(() => {});
    const urlDispatcher = page.url();
    console.log(`   URL post-login : ${urlDispatcher}`);

    if (!urlDispatcher.includes('Dispatcher')) {
      await page.screenshot({ path: '/tmp/ibkr-post-login.png' });
      throw new Error(`Login failed — URL: ${urlDispatcher}`);
    }

    // Navigate to demo app to trigger IServer session initialization
    console.log('▶ Initialisation session IServer via /demo...');
    await page.goto(`${GATEWAY}/demo`, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(5000);
    console.log(`   URL demo : ${page.url()}`);

    // Poll auth/status (IServer session may take up to 30s to init)
    console.log('▶ Vérification session API...');
    let authenticated = false;
    for (let i = 0; i < 10; i++) {
      const r = await apiCall(context, 'GET', '/v1/api/iserver/auth/status');
      const body = r ? await r.text() : '';
      const status = r ? r.status() : 0;
      console.log(`   Auth [${i+1}]: ${status} ${body.substring(0, 120)}`);
      try {
        if (JSON.parse(body).authenticated === true) { authenticated = true; break; }
      } catch {}
      if (i < 9) await page.waitForTimeout(3000);
    }

    // Save session cookies
    const cookies = await context.cookies();
    fs.writeFileSync('/tmp/ibkr-cookies.txt', cookies.map(c => `${c.name}=${c.value}`).join('; '));
    fs.writeFileSync('/tmp/ibkr-session.json', JSON.stringify(await context.storageState()));

    fs.writeFileSync(STATE_FILE, 'authenticated');
    console.log(`\n✅ Session ${authenticated ? 'API confirmée' : 'SSO active (IServer en cours)'}`);
    console.log('   Lancer : npm run nordic:dry\n');
    console.log('   Keepalive actif (tickle/55s) — Ctrl+C pour arrêter');

    let failCount = 0;
    while (true) {
      await page.waitForTimeout(55000);
      const tr = await apiCall(context, 'POST', '/v1/api/tickle');
      const t = tr ? tr.status() : 0;
      const tb = tr ? (await tr.text().catch(() => '')).substring(0, 100) : '';
      console.log(`   Tickle: ${t} ${tb}`);
      if (t === 0) { console.log('   Connexion perdue'); fs.writeFileSync(STATE_FILE, 'expired'); break; }
      if (t === 401) {
        failCount++;
        if (failCount >= 3) { console.log('   Session expirée (3×401)'); fs.writeFileSync(STATE_FILE, 'expired'); break; }
        const ra = await apiCall(context, 'POST', '/v1/api/iserver/reauthenticate');
        console.log(`   Reauthenticate: ${ra ? ra.status() : 0}`);
      } else {
        failCount = 0;
      }
    }

  } catch (err) {
    fs.writeFileSync(STATE_FILE, `error:${err.message}`);
    console.error('❌', err.message);
    await page.screenshot({ path: '/tmp/ibkr-debug-err.png' }).catch(() => {});
  } finally {
    await browser.close();
  }
})();

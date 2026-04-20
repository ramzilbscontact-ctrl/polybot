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

function waitForFile(f, ms = 300000) {
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
      waitUntil: 'domcontentloaded', timeout: 45000,
    });
    await page.waitForSelector('#xyz-field-username', { timeout: 30000 });
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
    await page.waitForTimeout(8000);
    await page.screenshot({ path: '/tmp/ibkr-2fa-page.png' });
    console.log('   Screenshot 2FA sauvé: /tmp/ibkr-2fa-page.png');

    // Log visible 2FA elements for debugging
    const allText = await page.evaluate(() => document.body.innerText.substring(0, 300)).catch(() => '');
    console.log(`   Page text: ${allText.replace(/\n/g, '|')}`);

    // OTP method selector — try to pick push if available
    const otpSel = await page.isVisible('.xyz-otp-select-text', { timeout: 2000 }).catch(() => false);
    if (otpSel) {
      console.log('   OTP selector visible, clicking...');
      await page.click('.xyz-otp-select-text');
      await page.waitForTimeout(3000);
      await page.screenshot({ path: '/tmp/ibkr-otp-select.png' });
    }

    // Push notification (tap sur mobile IBKR — plus de code SMS nécessaire)
    const pushVisible = await page.isVisible('.xyzblock-notification', { timeout: 5000 }).catch(() => false);
    console.log(`   Push visible: ${pushVisible}`);
    if (pushVisible) {
      fs.writeFileSync(STATE_FILE, 'waiting-push');
      console.log('\n📲 APPROBATION PUSH REQUISE — Ouvrez l\'app IBKR et approuvez\n');
      await page.waitForSelector('.xyzblock-success, .xyzform-silver', { timeout: 90000 });
      console.log('   Push approuvé');
    }

    // SMS/email code (Silver OTP)
    const silverVisible = await page.isVisible('.xyz-silver-response', { timeout: 5000 }).catch(() => false);
    console.log(`   SMS visible: ${silverVisible}`);
    if (silverVisible) {
      // Screenshot showing SMS form with timestamp for debugging
      await page.screenshot({ path: '/tmp/ibkr-sms-form.png' });
      fs.writeFileSync(STATE_FILE, 'waiting-2fa');
      const ts = new Date().toISOString();
      console.log(`\n📱 CODE 2FA [${ts}] — envoyez : echo "VOTRE_CODE" > /tmp/ibkr-2fa-code\n`);
      const code = await waitForFile(CODE_FILE, 300000);
      const age = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
      console.log(`   Code reçu : ${code} (après ${age}s)`);
      await page.fill('.xyz-silver-response', code);
      // Try both possible submit selectors
      const submitted = await page.locator('.xyzform-silver button[type="submit"]').click({ timeout: 3000 }).then(() => true).catch(() => false);
      if (!submitted) {
        console.log('   Fallback: click Login button');
        await page.locator('button:has-text("Login"), button[type="submit"]').first().click({ timeout: 3000 }).catch(() => {});
      }
    }

    // Wait for Dispatcher (confirms SSO success)
    await page.waitForURL('**/sso/Dispatcher**', { timeout: 20000 }).catch(() => {});
    const urlDispatcher = page.url();
    console.log(`   URL post-login : ${urlDispatcher}`);

    if (!urlDispatcher.includes('Dispatcher')) {
      await page.screenshot({ path: '/tmp/ibkr-post-login.png' });
      throw new Error(`Login failed — URL: ${urlDispatcher}`);
    }

    // CRITICAL: Wait for network idle so Dispatcher completes its init
    console.log('▶ Attente stabilisation Dispatcher...');
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // Helper for JSON API calls via context.request (shares cookies)
    const apiCall = async (method, path, body) => {
      try {
        const opts = { headers: { 'Content-Type': 'application/json' } };
        if (body) opts.data = body;
        const r = method === 'POST'
          ? await context.request.post(`${GATEWAY}${path}`, opts)
          : await context.request.get(`${GATEWAY}${path}`, opts);
        return r;
      } catch { return null; }
    };

    // STEP 1: Initialize brokerage session (ssodh/init) — this is the MISSING call
    console.log('▶ Init brokerage session (ssodh/init)...');
    const init = await apiCall('POST', '/v1/api/iserver/auth/ssodh/init', { publish: true, compete: true });
    const initBody = init ? await init.text() : '';
    console.log(`   ssodh/init: ${init ? init.status() : 0} ${initBody.substring(0, 150)}`);
    await page.waitForTimeout(3000);

    // STEP 2: SSO validate
    const ssoV = await apiCall('GET', '/v1/api/sso/validate');
    console.log(`   sso/validate: ${ssoV ? ssoV.status() : 0}`);

    // STEP 3: POST auth/status (MUST BE POST, not GET)
    const statusR = await apiCall('POST', '/v1/api/iserver/auth/status');
    const statusBody = statusR ? await statusR.text() : '';
    console.log(`   auth/status: ${statusR ? statusR.status() : 0} ${statusBody.substring(0, 200)}`);

    // STEP 4: Warm brokerage session via /iserver/accounts
    const accts = await apiCall('GET', '/v1/api/iserver/accounts');
    const acctsBody = accts ? await accts.text() : '';
    console.log(`   iserver/accounts: ${accts ? accts.status() : 0} ${acctsBody.substring(0, 200)}`);

    // STEP 5: Required once per session
    const port = await apiCall('GET', '/v1/api/portfolio/accounts');
    console.log(`   portfolio/accounts: ${port ? port.status() : 0}`);

    // Re-check auth/status after warm-up
    const statusR2 = await apiCall('POST', '/v1/api/iserver/auth/status');
    const statusBody2 = statusR2 ? await statusR2.text() : '';
    console.log(`   auth/status (retry): ${statusR2 ? statusR2.status() : 0} ${statusBody2.substring(0, 200)}`);

    const authenticated = statusBody2.includes('"authenticated":true') || statusBody.includes('"authenticated":true');

    // Save session cookies
    const cookies = await context.cookies();
    fs.writeFileSync('/tmp/ibkr-cookies.txt', cookies.map(c => `${c.name}=${c.value}`).join('; '));
    fs.writeFileSync('/tmp/ibkr-session.json', JSON.stringify(await context.storageState()));

    fs.writeFileSync(STATE_FILE, authenticated ? 'authenticated' : 'sso-only');
    console.log(`\n${authenticated ? '✅ Session API confirmée (authenticated:true)' : '⚠️  SSO OK mais API non auth — bot ne pourra pas trader'}`);
    console.log('   Lancer : npm run nordic:dry\n');
    console.log('   Keepalive actif (tickle/55s) — Ctrl+C pour arrêter');

    let failCount = 0;
    while (true) {
      await page.waitForTimeout(55000);
      const tr = await apiCall('POST', '/v1/api/tickle');
      const t = tr ? tr.status() : 0;
      const tb = tr ? (await tr.text().catch(() => '')).substring(0, 100) : '';
      console.log(`   Tickle: ${t} ${tb}`);
      if (t === 0) { console.log('   Connexion perdue'); fs.writeFileSync(STATE_FILE, 'expired'); break; }
      if (t === 401) {
        failCount++;
        if (failCount >= 3) { console.log('   Session expirée (3×401)'); fs.writeFileSync(STATE_FILE, 'expired'); break; }
        // Try ssodh/init again on 401
        const ra = await apiCall('POST', '/v1/api/iserver/auth/ssodh/init', { publish: true, compete: true });
        console.log(`   ssodh/init retry: ${ra ? ra.status() : 0}`);
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

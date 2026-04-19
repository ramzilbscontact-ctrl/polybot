/**
 * ibkr-login-wait.js — Login IBKR avec attente code 2FA via fichier
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { chromium } = require('playwright');
const https = require('https');
const fs    = require('fs');

const GATEWAY   = process.env.IBKR_GATEWAY_URL || 'https://localhost:5000';
const USERNAME  = process.env.IBKR_USERNAME    || '';
const PASSWORD  = process.env.IBKR_PASSWORD    || '';
const CODE_FILE  = '/tmp/ibkr-2fa-code';
const STATE_FILE = '/tmp/ibkr-login-state';

function checkAuth() {
  return new Promise(resolve => {
    const req = https.request(`${GATEWAY}/v1/api/iserver/auth/status`,
      { rejectUnauthorized: false },
      res => { let d=''; res.on('data',x=>d+=x); res.on('end',()=>{ try{resolve(JSON.parse(d).authenticated===true);}catch{resolve(false);} }); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function waitForFile(f, ms=120000) {
  return new Promise((resolve,reject) => {
    const t = Date.now();
    const check = () => {
      if (fs.existsSync(f)) { const c=fs.readFileSync(f,'utf8').trim(); fs.unlinkSync(f); resolve(c); }
      else if (Date.now()-t > ms) reject(new Error('Timeout 2FA'));
      else setTimeout(check, 500);
    };
    check();
  });
}

(async () => {
  [CODE_FILE, STATE_FILE].forEach(f => { try { fs.unlinkSync(f); } catch {} });

  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors','--no-sandbox','--disable-dev-shm-usage'],
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

    // Activer Paper mode en cliquant le wrapper du toggle
    await page.locator('.toggle-wrapper').click({ force: true });
    await page.waitForTimeout(1000);
    const isPaper = await page.evaluate(() => !!document.querySelector('.xyz-paper-switch')?.checked);
    console.log(`   Mode Paper : ${isPaper ? '✓' : '✗ (mode Live)'}`);
    await page.waitForTimeout(800);

    // Après toggle, re-attendre le formulaire (React peut re-monter le DOM)
    await page.waitForSelector('#xyz-field-username', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(500);

    // Utiliser page.locator() (auto-retry, toujours frais)
    console.log('▶ Saisie identifiants...');
    const userField = page.locator('#xyz-field-username');
    const passField = page.locator('#xyz-field-password');

    await userField.click();
    await userField.fill(USERNAME);
    await passField.click();
    await passField.fill(PASSWORD);

    const uVal = await userField.inputValue();
    const pLen = (await passField.inputValue()).length;
    console.log(`   Username: "${uVal}", Password: ${pLen} chars`);

    await page.click('.xyz-button-login');
    console.log('▶ Credentials soumis, attente...');
    await page.waitForTimeout(5000);

    // OTP selector (SMS/email)
    const otpSel = await page.isVisible('.xyz-otp-select-text', { timeout: 2000 }).catch(() => false);
    if (otpSel) {
      console.log('   Sélection SMS OTP...');
      await page.click('.xyz-otp-select-text');
      await page.waitForTimeout(3000);
    }

    // Silver 2FA field
    const silverVisible = await page.isVisible('.xyz-silver-response', { timeout: 5000 }).catch(() => false);
    if (silverVisible) {
      fs.writeFileSync(STATE_FILE, 'waiting-2fa');
      console.log('\n📱 CODE 2FA REQUIS — SMS envoyé sur votre téléphone');
      console.log('   → Envoyez le code ici dans le chat\n');

      const code = await waitForFile(CODE_FILE, 120000);
      console.log(`   Code : ${code}`);
      await page.fill('.xyz-silver-response', code);
      await page.locator('.xyzform-silver button[type="submit"]').click();
      await page.waitForTimeout(8000);
    } else {
      const errMsg = await page.textContent('.xyz-errormessage').catch(() => '');
      if (errMsg?.trim()) console.log('   Page error:', errMsg.trim());
    }

    // Vérifier l'auth VIA le contexte browser (a les bons cookies)
    const authViaPage = await page.evaluate(async () => {
      try {
        const r = await fetch('/v1/api/iserver/auth/status');
        const j = await r.json();
        return j;
      } catch(e) { return { error: e.message }; }
    });
    console.log('   Auth via browser:', JSON.stringify(authViaPage));

    const authed = authViaPage.authenticated === true;

    if (authed) {
      // Sauvegarder les cookies de session pour curl/API
      const cookies = await context.cookies();
      const sessCookie = cookies.find(c => c.name === 'x-sess-uuid' || c.name.includes('sess'));
      if (sessCookie) {
        fs.writeFileSync('/tmp/ibkr-session-cookie', `${sessCookie.name}=${sessCookie.value}`);
        console.log(`   Cookie sauvé: ${sessCookie.name}`);
      }
      // Sauvegarder tous les cookies pour curl
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      fs.writeFileSync('/tmp/ibkr-cookies.txt', cookieStr);

      fs.writeFileSync(STATE_FILE, 'authenticated');
      console.log('\n✅ Authentifié ! Session active.\n   Lancer : npm run nordic:dry\n');
    } else {
      fs.writeFileSync(STATE_FILE, 'failed');
      await page.screenshot({ path: '/tmp/ibkr-debug-final.png' });
      console.log('\n❌ Échec. Screenshot: /tmp/ibkr-debug-final.png');
    }

  } catch (err) {
    fs.writeFileSync(STATE_FILE, `error:${err.message}`);
    console.error('❌', err.message);
    await page.screenshot({ path: '/tmp/ibkr-debug-err.png' }).catch(() => {});
  } finally {
    await browser.close();
  }
})();

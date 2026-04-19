/**
 * ibkr-login-wait.js — Login IBKR Client Portal Gateway
 * Login en mode LIVE (pas de toggle Paper qui vide le formulaire)
 * Le compte paper DUP564236 est accessible via account switcher après login
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
    console.log('   Page chargée (mode Live — pas de toggle)');

    // Remplir credentials avec pressSequentially (déclenche React onChange)
    console.log('▶ Saisie identifiants...');
    await page.locator('#xyz-field-username').click();
    await page.locator('#xyz-field-username').pressSequentially(USERNAME, { delay: 50 });
    await page.locator('#xyz-field-password').click();
    await page.locator('#xyz-field-password').pressSequentially(PASSWORD, { delay: 50 });

    const u = await page.locator('#xyz-field-username').inputValue();
    const p = await page.locator('#xyz-field-password').inputValue();
    console.log(`   Username: "${u}" (${u.length} chars), Password: ${p.length} chars`);

    if (!u) throw new Error('Username still empty after pressSequentially');

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

    // Dump current URL and page state
    const url = page.url();
    console.log(`   URL après login : ${url}`);
    await page.screenshot({ path: '/tmp/ibkr-post-login.png' });

    // Auth check via cookies + direct HTTPS request
    const cookies = await context.cookies();
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    fs.writeFileSync('/tmp/ibkr-cookies.txt', cookieStr);

    // Check auth via API with cookies
    const authed = await new Promise(resolve => {
      const req = https.request(
        `${GATEWAY}/v1/api/iserver/auth/status`,
        {
          rejectUnauthorized: false,
          headers: { Cookie: cookieStr },
        },
        res => {
          let d = '';
          res.on('data', x => d += x);
          res.on('end', () => {
            try {
              const j = JSON.parse(d);
              console.log('   Auth status:', JSON.stringify(j));
              resolve(j.authenticated === true);
            } catch { resolve(false); }
          });
        }
      );
      req.on('error', () => resolve(false));
      req.end();
    });

    if (authed) {
      fs.writeFileSync(STATE_FILE, 'authenticated');
      console.log('\n✅ Authentifié avec succès !\n   Cookies: /tmp/ibkr-cookies.txt\n   Lancer : npm run nordic:dry\n');
    } else {
      // Check page text for success message
      const pageText = await page.textContent('body').catch(() => '');
      if (pageText.includes('login succeeds') || pageText.includes('success')) {
        fs.writeFileSync(STATE_FILE, 'authenticated');
        console.log('\n✅ Login réussi (détecté via page text)\n   Lancer : npm run nordic:dry\n');
      } else {
        fs.writeFileSync(STATE_FILE, 'failed');
        console.log('\n❌ Échec. Screenshot: /tmp/ibkr-post-login.png');
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

#!/bin/bash
# Usage: bash scripts/ibkr-login-quick.sh 123456
# Logs in to IBKR with 2FA code passed as argument

CODE="${1:-}"
if [ -z "$CODE" ]; then
  echo "Usage: bash scripts/ibkr-login-quick.sh <2FA_CODE>"
  exit 1
fi

node - "$CODE" <<'EOF'
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const { chromium } = require('playwright');
const https = require('https');
const fs    = require('fs');

const GATEWAY  = process.env.IBKR_GATEWAY_URL || 'https://localhost:5000';
const USERNAME = process.env.IBKR_USERNAME    || '';
const PASSWORD = process.env.IBKR_PASSWORD    || '';
const CODE     = process.argv[2] || '';

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors','--no-sandbox','--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    console.log('▶ Loading login page...');
    await page.goto(`${GATEWAY}/sso/Login?forwardTo=22&RL=1&ip2loc=EU`, {
      waitUntil: 'networkidle', timeout: 30000,
    });
    await page.waitForSelector('#xyz-field-username', { timeout: 15000 });

    console.log('▶ Filling credentials...');
    const userField = page.locator('#xyz-field-username');
    const passField = page.locator('#xyz-field-password');
    await userField.fill(USERNAME);
    await passField.fill(PASSWORD);

    // THEN toggle to paper (AFTER filling to avoid form reset)
    console.log('▶ Switching to Paper mode...');
    await page.locator('.toggle-wrapper').click({ force: true });
    await page.waitForTimeout(1000);

    await page.click('.xyz-button-login');
    console.log('▶ Waiting for 2FA...');
    await page.waitForTimeout(5000);

    // OTP selector
    const otpSel = await page.isVisible('.xyz-otp-select-text', { timeout: 2000 }).catch(() => false);
    if (otpSel) {
      await page.click('.xyz-otp-select-text');
      await page.waitForTimeout(3000);
    }

    // Silver 2FA
    const silverVisible = await page.isVisible('.xyz-silver-response', { timeout: 5000 }).catch(() => false);
    if (silverVisible) {
      console.log(`▶ Submitting 2FA code: ${CODE}`);
      await page.fill('.xyz-silver-response', CODE);
      await page.locator('.xyzform-silver button[type="submit"]').click();
      await page.waitForTimeout(8000);
    }

    // Check auth via browser context
    const authResult = await page.evaluate(async () => {
      try {
        const r = await fetch('/v1/api/iserver/auth/status');
        const j = await r.json();
        return j;
      } catch(e) { return { error: e.message }; }
    });

    const authed = authResult.authenticated === true;

    if (authed) {
      const cookies = await context.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      fs.writeFileSync('/tmp/ibkr-cookies.txt', cookieStr);
      console.log('✅ AUTHENTICATED');
      console.log('   Cookies saved to /tmp/ibkr-cookies.txt');
      process.exit(0);
    } else {
      console.log('❌ Auth failed:', authResult);
      await page.screenshot({ path: '/tmp/ibkr-login-debug.png' });
      process.exit(1);
    }

  } catch (err) {
    console.error('❌ Error:', err.message);
    await page.screenshot({ path: '/tmp/ibkr-login-err.png' }).catch(() => {});
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
EOF

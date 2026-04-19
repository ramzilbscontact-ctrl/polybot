/**
 * ibkr-login.ts — Authentification automatique IBKR Client Portal Gateway
 */
import { chromium } from 'playwright';
import * as dotenv  from 'dotenv';
import * as https   from 'https';
import * as readline from 'readline';

dotenv.config();

const GATEWAY  = process.env.IBKR_GATEWAY_URL ?? 'https://localhost:5000';
const USERNAME  = process.env.IBKR_USERNAME ?? '';
const PASSWORD  = process.env.IBKR_PASSWORD ?? '';
const CODE_ARG  = process.argv[2] ?? '';   // optionnel : ts-node ibkr-login.ts 123456

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function checkAuth(): Promise<boolean> {
  return new Promise(resolve => {
    const req = https.request(
      `${GATEWAY}/v1/api/iserver/auth/status`,
      { rejectUnauthorized: false },
      (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try { resolve((JSON.parse(data) as any).authenticated === true); }
          catch { resolve(false); }
        });
      }
    );
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.error('❌ IBKR_USERNAME et IBKR_PASSWORD requis dans .env');
    process.exit(1);
  }

  console.log(`\n🔐 Connexion IBKR — ${GATEWAY}`);
  console.log(`   Utilisateur : ${USERNAME}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    console.log('▶ Chargement page login...');
    await page.goto(`${GATEWAY}/sso/Login?forwardTo=22&RL=1&ip2loc=EU`, {
      waitUntil: 'networkidle', timeout: 30_000,
    });
    await page.waitForSelector('.xyz-username', { timeout: 15_000 });

    // Activer le mode Paper Trading (le toggle est un checkbox caché, on clique le label visible)
    const toggleLabel = page.locator('.toggle-wrapper .toggle-label, .toggle-wrapper label').first();
    const labelText   = await toggleLabel.textContent().catch(() => '');
    if (labelText?.toLowerCase().includes('live')) {
      await toggleLabel.click({ force: true });
      await page.waitForTimeout(500);
      console.log('   Mode Paper Trading activé');
    }

    console.log('▶ Saisie identifiants...');
    await page.fill('.xyz-username', USERNAME);
    await page.fill('.xyz-password', PASSWORD);
    await page.click('.xyz-button-login');

    console.log('▶ Authentification en cours...');
    await page.waitForTimeout(5_000);

    // ── Détection 2FA ──────────────────────────────────────────────
    // OTP selector (SMS / email / voice)
    const otpSelector = await page.isVisible('.xyzblock-otpselector .xyz-otp-select-text', { timeout: 2_000 }).catch(() => false);
    if (otpSelector) {
      console.log('\n📱 Sélection méthode 2FA → SMS...');
      await page.click('.xyz-otp-select-text');
      await page.waitForTimeout(3_000);
    }

    // Silver OTP (code numérique par SMS/email)
    const silverVisible = await page.isVisible('.xyz-silver-response', { timeout: 3_000 }).catch(() => false);
    if (silverVisible) {
      const code = CODE_ARG || await ask('\n📱 Code 2FA reçu par SMS/email :\n   Entrez le code → ');
      console.log(`   Code saisi : ${code}`);
      await page.fill('.xyz-silver-response', code);
      const submitBtn = page.locator('.xyzform-silver button[type="submit"]');
      await submitBtn.click();
      await page.waitForTimeout(4_000);
    }

    // Bronze (security card)
    const bronzeVisible = await page.isVisible('.xyz-bronze-response', { timeout: 2_000 }).catch(() => false);
    if (bronzeVisible) {
      const challenge = await page.textContent('.xyz-bronze-challenge, [class*="challenge"]') ?? '';
      console.log(`\n🔑 Carte sécurité Bronze — Code défi : ${challenge}`);
      const code = await ask('   Entrez la réponse → ');
      await page.fill('.xyz-bronze-response', code);
      await page.locator('.xyzform-bronze button[type="submit"]').click();
      await page.waitForTimeout(4_000);
    }

    // Notification push (attente approbation téléphone)
    const notifVisible = await page.isVisible('.xyzblock-notification .xyz-notificationimg', { timeout: 2_000 }).catch(() => false);
    if (notifVisible) {
      console.log('\n📲 Approuvez la connexion sur votre téléphone IBKR...');
      await page.waitForSelector('.xyzblock-success', { timeout: 60_000 });
    }

    // ── Vérification finale ────────────────────────────────────────
    await page.waitForTimeout(2_000);
    const errMsg = await page.textContent('.xyz-errormessage').catch(() => '');
    if (errMsg) console.log(`   ⚠️  Message page : ${errMsg.trim()}`);

    const authed = await checkAuth();
    if (authed) {
      console.log('\n✅ Session active ! Vous pouvez lancer le bot :\n   npm run nordic:dry\n');
    } else {
      console.log('\n⚠️  Session non confirmée. Vérifiez les identifiants ou le 2FA.\n');
    }

  } catch (err: any) {
    console.error(`\n❌ Erreur : ${err.message}`);
    // Dump screenshot for debug
    await page.screenshot({ path: '/tmp/ibkr-login-debug.png' }).catch(() => {});
    console.log('   Screenshot sauvegardé : /tmp/ibkr-login-debug.png');
  } finally {
    await browser.close();
  }
}

main().catch(console.error);

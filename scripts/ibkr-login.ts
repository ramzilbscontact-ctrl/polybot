/**
 * ibkr-login.ts — Authentification automatique IBKR Client Portal Gateway
 *
 * Usage :
 *   IBKR_USERNAME=xxx IBKR_PASSWORD=yyy ts-node scripts/ibkr-login.ts
 *   ou avec .env : ts-node scripts/ibkr-login.ts
 *
 * Le script :
 *   1. Ouvre un navigateur headless
 *   2. Navigue vers https://localhost:5000
 *   3. Remplit username + password
 *   4. Gère le 2FA si demandé (code envoyé par SMS/email)
 *   5. Vérifie que la session est active via l'API
 */
import { chromium } from 'playwright';
import * as dotenv  from 'dotenv';
import * as readline from 'readline';

dotenv.config();

const GATEWAY = process.env.IBKR_GATEWAY_URL ?? 'https://localhost:5000';
const USERNAME = process.env.IBKR_USERNAME ?? '';
const PASSWORD = process.env.IBKR_PASSWORD ?? '';

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

async function checkAuth(): Promise<boolean> {
  try {
    // @ts-ignore
    const https = await import('https');
    return new Promise(resolve => {
      const req = https.request(
        `${GATEWAY}/v1/api/iserver/auth/status`,
        { rejectUnauthorized: false },
        (res: any) => {
          let data = '';
          res.on('data', (d: any) => data += d);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.authenticated === true);
            } catch { resolve(false); }
          });
        }
      );
      req.on('error', () => resolve(false));
      req.end();
    });
  } catch { return false; }
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.error('❌ IBKR_USERNAME et IBKR_PASSWORD requis dans .env');
    process.exit(1);
  }

  console.log(`\n🔐 Connexion IBKR — ${GATEWAY}`);
  console.log(`   Compte : ${USERNAME}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--ignore-certificate-errors', '--no-sandbox'],
  });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    console.log('▶ Navigation vers le portail...');
    await page.goto(`${GATEWAY}/sso/Login?forwardTo=22&RL=1&ip2loc=EU`, {
      waitUntil: 'networkidle',
      timeout:   30_000,
    });

    // Attendre le champ username
    console.log('▶ Attente formulaire login...');
    await page.waitForSelector('.xyz-username', { timeout: 15_000 });

    console.log('▶ Saisie identifiants...');
    await page.fill('.xyz-username', USERNAME);
    await page.click('.xyz-button-username');

    // Attendre le champ password
    await page.waitForSelector('.xyz-password', { timeout: 10_000 });
    await page.fill('.xyz-password', PASSWORD);
    await page.click('.xyz-button-login');

    // Attendre redirect ou 2FA
    console.log('▶ Authentification en cours...');
    await page.waitForTimeout(4_000);

    // Vérifier si 2FA demandé
    const twoFaVisible = await page.isVisible('.xyz-sf-input, [class*="twofa"], [class*="2fa"], #sf_input', { timeout: 2_000 }).catch(() => false);

    if (twoFaVisible) {
      console.log('\n📱 Code 2FA requis (vérifiez votre téléphone / email IBKR) :');
      const code = await ask('   Entrez le code : ');
      await page.fill('.xyz-sf-input, [class*="twofa"] input, #sf_input', code);
      const btn = await page.$('[class*="submit"], .xyz-button-sf, button[type="submit"]');
      if (btn) await btn.click();
      await page.waitForTimeout(4_000);
    }

    // Vérifier l'auth via API
    await page.waitForTimeout(3_000);
    const authed = await checkAuth();

    if (authed) {
      console.log('\n✅ Authentification réussie ! Session active.');
      console.log('   Le bot Nordic peut maintenant démarrer : npm run nordic:dry\n');
    } else {
      // Dump la page pour debug
      const content = await page.content();
      const errMsg  = content.match(/error|invalid|failed|incorrect/gi) || [];
      console.log(`\n⚠️  Auth non confirmée. Mots-clés page : ${[...new Set(errMsg)].slice(0,5).join(', ')}`);
      console.log('   Vérifiez les identifiants et réessayez.\n');
    }

  } catch (err: any) {
    console.error(`\n❌ Erreur : ${err.message}`);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);

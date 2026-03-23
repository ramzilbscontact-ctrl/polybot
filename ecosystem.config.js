module.exports = {
  apps: [{
    name:        'polybot',
    script:      'npx',
    args:        'ts-node --transpile-only src/main.ts',
    cwd:         '/root/polybot',
    interpreter: 'none',

    // Redémarrage automatique
    watch:       false,
    autorestart: true,
    max_restarts: 10,
    min_uptime:  '10s',
    restart_delay: 5000,

    // Variables d'environnement (les vraies sont dans .env)
    env: {
      NODE_ENV:        'production',
      LOG_LEVEL:       'info',
      SCAN_INTERVAL_S: '60',
      DRY_RUN:         'false',
      YES_MIN:         '0.88',
      YES_MAX:         '0.94',
      STAKE_USDC:      '0.80',
      EXPIRY_MAX_H:    '48',
      CRYPTO_BUFFER:   '60',
      MAX_TRADES:      '3',
      MAX_LOSS:        '2.00',
    },

    // Logs PM2
    out_file:    '/root/polybot/logs/pm2-out.log',
    error_file:  '/root/polybot/logs/pm2-err.log',
    merge_logs:  true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }]
};

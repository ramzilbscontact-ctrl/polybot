import * as winston from 'winston';
import * as path    from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const DailyRotate = require('winston-daily-rotate-file');

const LOG_DIR = path.resolve(__dirname, '../../logs');
const { combine, timestamp, printf, colorize, errors } = winston.format;

const consoleFormat = printf(({ level, message, timestamp: ts, context, ...meta }: any) => {
  const ctx   = context ? `[${context}] ` : '';
  const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${ts} ${level.padEnd(7)} ${ctx}${message}${extra}`;
});

const fileFormat = printf(({ level, message, timestamp: ts, context, ...meta }: any) => {
  return JSON.stringify({ ts, level, context: context ?? 'app', message, ...meta });
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  format: combine(timestamp({ format: 'HH:mm:ss' }), errors({ stack: true })),
  transports: [
    new winston.transports.Console({
      format: combine(colorize({ all: true }), consoleFormat),
    }),
    new DailyRotate({
      dirname:      LOG_DIR,
      filename:     'polybot-%DATE%.log',
      datePattern:  'YYYY-MM-DD',
      maxFiles:     '7d',
      zippedArchive: true,
      format:       combine(timestamp(), fileFormat),
    }),
    new DailyRotate({
      dirname:      LOG_DIR,
      filename:     'errors-%DATE%.log',
      datePattern:  'YYYY-MM-DD',
      level:        'error',
      maxFiles:     '14d',
      format:       combine(timestamp(), fileFormat),
    }),
  ],
});

export function getLogger(context: string) {
  return {
    debug: (msg: string, meta?: object) => logger.debug(msg, { context, ...meta }),
    info:  (msg: string, meta?: object) => logger.info(msg,  { context, ...meta }),
    warn:  (msg: string, meta?: object) => logger.warn(msg,  { context, ...meta }),
    error: (msg: string, meta?: object) => logger.error(msg, { context, ...meta }),
  };
}

export default logger;

'use strict';

const { createLogger, format, transports } = require('winston');
const fs = require('fs');

if (!fs.existsSync('logs')) fs.mkdirSync('logs');

const logger = createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [
    new transports.File({ filename: 'logs/error.log', level: 'error' }),
    new transports.File({ filename: 'logs/combined.log' }),
  ],
});

if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new transports.Console({
      format: format.combine(
        format.colorize(),
        format.printf(({ level, message, timestamp, stack }) => {
          return stack
            ? `${timestamp} ${level}: ${message}\n${stack}`
            : `${timestamp} ${level}: ${message}`;
        })
      ),
    })
  );
} else {
  // In a container, stdout is what `docker logs` collects and rotates — without
  // this, production output only ever reaches the files above.
  logger.add(new transports.Console());
}

module.exports = logger;

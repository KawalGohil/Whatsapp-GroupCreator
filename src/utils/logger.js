const pino = require('pino');
const pretty = require('pino-pretty');

const stream = pretty({
    colorize: true,
    translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
    ignore: 'pid,hostname',
});

const logger = pino(stream);

module.exports = logger;
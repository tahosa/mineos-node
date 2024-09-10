import winston, { format } from 'winston';

const baseFormat = format.combine(format.timestamp({ format: 'YYYY-MM-DD H:mm:ss' }));

export const Logger = winston.createLogger({
  level: 'info',
  format: baseFormat,
  transports: [
    new winston.transports.Console({
      format: format.combine(
        //format.colorize({ all: true }),
        format.metadata({ fillExcept: ['message', 'level', 'timestamp', 'label', 'request']}),
        //format.printf((info) => ` ${info.timestamp} [${info.level}] {${info.metadata.service}}: ${info.message}`),
        format.json(),
        format.prettyPrint(),
      ),
    }),
  ],
});

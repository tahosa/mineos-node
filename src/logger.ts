import winston from 'winston';

export const Logger = (service: string, level: string = 'info') => {
  const logger = winston.createLogger({
    level,
    format: winston.format.json(),
    transports: [new winston.transports.Console()],
    defaultMeta: {
      service,
    },
  });
  return logger;
};

import { createLogger, format, transports } from 'winston';
import util from 'util';

const baseLogger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.printf(info => {
            const location = info.location ? ` ${info.location}` : '';
            return `${info.timestamp} [${info.level.toUpperCase()}]${location} - ${info.message}`;
        })
    ),
    transports: [new transports.Console()],
});

function getCallerLocation(): string {
    const stack = new Error().stack;
    if (stack) {
        const lines = stack.split('\n');
        for (let i = 3; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(/\((.*):(\d+):(\d+)\)/);
            if (match) {
                const fullPath = match[1];
                const lineno = match[2];
                return `${fullPath}:${lineno}`;
            }
        }
    }
    return '';
}

const logger = {
    info: (...args: any[]) => { baseLogger.info(util.format(...args), { location: getCallerLocation() }) },
    warn: (...args: any[]) => { baseLogger.warn(util.format(...args), { location: getCallerLocation() }) },
    error: (...args: any[]) => { baseLogger.error(util.format(...args), { location: getCallerLocation() }) },
    debug: (...args: any[]) => { baseLogger.debug(util.format(...args), { location: getCallerLocation() }) },
};

export default logger;
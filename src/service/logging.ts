import * as winston from 'winston';
import * as _ from "lodash";

const { combine, timestamp, label, prettyPrint } = winston.format;

const logger = (name: string, level?: string) => winston.createLogger({
    format: combine(
        label({ label: name }),
        timestamp(),
        prettyPrint()
    ),
    transports: [
        new winston.transports.Console({ level: level || 'info'})
    ]
});


export default function log(name: string): winston.Logger {
    // don't log while testing
    const isRunFromMocha = process.argv.length >= 2 && _.includes(process.argv[1], "mocha");
    if (isRunFromMocha) {
        return logger(name, 'crit');
    }

    return logger(name, _.includes(process.argv, "debug") ? 'debug' : null)
}
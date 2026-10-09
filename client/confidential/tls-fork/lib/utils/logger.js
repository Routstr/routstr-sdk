export const logger = {
    info(...args) {
        return console.info(...args);
    },
    debug(...args) {
        return console.debug(...args);
    },
    trace: () => { },
    warn(...args) {
        return console.warn(...args);
    },
    error(...args) {
        return console.error(...args);
    }
};

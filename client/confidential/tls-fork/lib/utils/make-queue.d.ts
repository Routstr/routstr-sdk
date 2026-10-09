export declare const makeQueue: () => {
    enqueue<A extends any[], R, T extends (...args: A) => R>(code: T, ...args: A): Promise<R>;
};

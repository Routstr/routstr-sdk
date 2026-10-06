/**
 * IoChannel adapters for the tlsn wasm verifier.
 *
 * The wasm crate consumes JS objects implementing:
 *   read(): Promise<Uint8Array | null>   (null = EOF)
 *   write(data: Uint8Array): Promise<void>
 *   close(): Promise<void>
 *   unread(data: Uint8Array): void       (synchronous push-back)
 *
 * Channel B (mux) is a WebSocket; channel C (relay) is raw TCP, which only
 * exists outside browsers (Bun.connect here; Node via a future net adapter).
 */

export interface IoChannel {
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  unread(data: Uint8Array): void;
}

export type TcpDialer = (hostname: string, port: number) => Promise<IoChannel>;
export type WsOpener = (url: string) => Promise<IoChannel>;

/** Shared queue-backed channel core: producers push, read() awaits. */
class QueueChannel implements IoChannel {
  private queue: Uint8Array[] = [];
  private waiters: ((v: Uint8Array | null) => void)[] = [];
  private ended = false;
  private failed: Error | null = null;

  push(data: Uint8Array): void {
    if (this.ended) return;
    // Never deliver empty reads: the wasm adapter treats them as EOF.
    if (data.length === 0) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(data);
    else this.queue.push(data);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w(null);
  }

  fail(error: Error): void {
    if (this.failed) return;
    this.failed = error;
    this.end();
  }

  read(): Promise<Uint8Array | null> {
    if (this.failed) return Promise.reject(this.failed);
    const data = this.queue.shift();
    if (data !== undefined) return Promise.resolve(data);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async write(_data: Uint8Array): Promise<void> {
    throw new Error("write not implemented on this channel");
  }

  async close(): Promise<void> {
    this.end();
  }

  unread(data: Uint8Array): void {
    this.queue.unshift(data);
  }
}

/** Channel B: WebSocket → IoChannel (binary messages = byte stream). */
export function webSocketIo(url: string): Promise<IoChannel> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    class WsChannel extends QueueChannel {
      override async write(data: Uint8Array): Promise<void> {
        // Never send empty frames (peer treats them as EOF); copy out of
        // wasm linear memory before a grow can invalidate the view.
        if (data.length === 0) return;
        ws.send(data.slice());
      }
      override async close(): Promise<void> {
        try {
          ws.close();
        } finally {
          super.close();
        }
      }
    }
    const channel = new WsChannel();

    ws.onopen = () => resolve(channel);
    ws.onerror = () => {
      const error = new Error(`websocket failed: ${url}`);
      if (!channel.read) reject(error);
      channel.fail(error);
      reject(error);
    };
    ws.onclose = () => channel.end();
    ws.onmessage = (event) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) channel.push(new Uint8Array(data));
      else if (data instanceof Uint8Array) channel.push(data);
      else if (typeof data === "string") channel.push(new TextEncoder().encode(data));
      else if (data && typeof data.arrayBuffer === "function") {
        // Blob (browser default if binaryType wasn't honored)
        void data.arrayBuffer().then((buf: ArrayBuffer) => channel.push(new Uint8Array(buf)));
      }
    };
  });
}

/** Channel C: raw TCP via Bun.connect → IoChannel. */
export function bunTcpDialer(hostname: string, port: number): Promise<IoChannel> {
  const Bun = (globalThis as any).Bun;
  if (!Bun?.connect) {
    return Promise.reject(
      new Error("raw TCP unavailable: Bun.connect not found (browser builds cannot verify)")
    );
  }
  return new Promise((resolve, reject) => {
    class TcpChannel extends QueueChannel {
      override async write(data: Uint8Array): Promise<void> {
        socket.write(data);
      }
      override async close(): Promise<void> {
        try {
          socket.end();
        } finally {
          super.close();
        }
      }
    }
    const channel = new TcpChannel();
    let socket: any;

    Bun.connect({
      hostname,
      port,
      socket: {
        open(s: any) {
          socket = s;
          resolve(channel);
        },
        data(_s: any, data: Uint8Array) {
          channel.push(new Uint8Array(data));
        },
        close() {
          channel.end();
        },
        end() {
          channel.end();
        },
        error(_s: any, error: Error) {
          channel.fail(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        },
        connectError(_s: any, error: Error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}

/** Default channel-C dialer: Bun TCP, or a clear error. */
export const defaultTcpDialer: TcpDialer = (hostname, port) => bunTcpDialer(hostname, port);

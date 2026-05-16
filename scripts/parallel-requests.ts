import http from "http";

const DAEMON_URL = "http://localhost:8009";
const NUM_REQUESTS = 1;

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

async function sendRequest(body: object, index: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL("/v1/chat/completions", DAEMON_URL);
    const bodyStr = JSON.stringify(body);

    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      },
      async (res) => {
        const responseBody = await readBody(res);
        console.log(`[${index}] Status: ${res.statusCode}`);
        console.log(`[${index}] Body: ${responseBody}`);
        resolve();
      }
    );

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

async function main(): Promise<void> {
  const body = {
    model: "minimax-m2.5",
    messages: [{ role: "user", content: "hi" }],
    // stream: true
  };

  console.log(`Sending ${NUM_REQUESTS} parallel requests...`);

  const promises = Array.from({ length: NUM_REQUESTS }, (_, i) =>
    sendRequest(body, i)
  );

  await Promise.all(promises);

  console.log("\nDone processing all requests.");
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

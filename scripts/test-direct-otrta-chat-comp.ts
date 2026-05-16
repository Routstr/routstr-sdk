const API_URL = "https://routstr.otrta.me/v1/chat/completions";
const API_KEY =
  process.env.OPENROUTER_API_KEY ||
  process.env.ROUTSTR_UPSTREAM_API_KEY ||
  "sk-511f8bdba2b44c2f45683fcd1b5276f49509f6181596b08c7a252ec99b3fba85";

async function main() {
  const payload = {
    model: "gemma-3n-e4b-it",
    messages: [
      {
        role: "user",
        content: "count from 1 to 10, one token-ish chunk at a time",
      },
    ],
    stream: true,
  };

  const start = Date.now();
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  console.log("status", response.status, response.statusText);
  console.log("content-type", response.headers.get("content-type"));

  if (!response.body) {
    throw new Error("Response body missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let last = start;
  let reads = 0;
  let fullContent = "";
  let buffer = "";
  let lastJson: any = null;

  while (true) {
    const before = Date.now();
    const { done, value } = await reader.read();
    const now = Date.now();

    if (done) {
      console.log("\n--- Final Accumulated Content ---");
      console.log(fullContent);
      console.log("\n--- Last JSON Object (Metadata) ---");
      console.log(JSON.stringify(lastJson, null, 2));
      console.log("--------------------\n");
      console.log(`done total=${now - start}ms reads=${reads}`);
      break;
    }

    reads += 1;
    buffer += decoder.decode(value, { stream: true });
    
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      
      if (trimmed.startsWith("data: ")) {
        try {
          const json = JSON.parse(trimmed.slice(6));
          lastJson = json; 
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            process.stdout.write(delta);
          }
        } catch (e) {}
      }
    }
    last = now;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export {};

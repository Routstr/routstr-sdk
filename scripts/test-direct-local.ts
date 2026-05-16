const API_URL = "http://localhost:8010/v1/messages";
const XCASHU_TOKEN =
  process.env.ROUTSTR_XCASHU_TOKEN ||
  "cashuBo2FteCJodHRwczovL21pbnQubWluaWJpdHMuY2FzaC9CaXRjb2luYXVjc2F0YXSBomFpSAAQeTfbDMhlYXCDpGFhEGFzeEBlMmM2N2M1NmM2OWFhNjNhNjRmNGNkYjhmMGFhMmUzMDkwMzA4NWQ0NDAyMzY3MzM5YmZhZjMyY2M5MDQ5ZjgzYWNYIQLWssNGWqHPktoUyHNZWOZWd7qBNlhql9zE89zLC11AFWFko2FlWCAJxHwhHyA4BmlI_GGffYHYTAgugQZnYeBxGP0t_6coJ2FzWCAifdLH-nkOVKxYQXFvmKhX5374wDBJjBKfYmWl4ZZMtWFyWCCPLXmCKtSqFJ4ouBGLSg_izi0NUkQVNs6AawUy8LpYnqRhYQRhc3hAZTFmNjM5ODg5OTEwZTY5MGM4MzExZmQ1MWZjYzhkZDQwYWI1NGYzOTU2OTI5NTQzZjFjNzI0MGI5Yzg4MGFlY2FjWCEDSVzZ-UI7N79oTK36h3f3YqXL2eAkOM5oR6p9QRZTnq5hZKNhZVgg2HCOkx_iQn3N4CnaxbcflIAk8vDXlCX_jz7C9fe4Aj9hc1ggootofy3_pc8nw_PP87YV01jX6F6MefbPdBTj2hB_aIBhclggT0p8GLZqnnVK0CM0R7xuJ5aMtKdWHNiql0VmfW_Vtz2kYWEBYXN4QDRkYTAxZGRhZGZmZTIxMDdkZGZhZTFjZGQ2MThhODcyMzM0M2M0YzFkZmNlMTQ3ZmJhMzRmZWZmMTE3ZDhlNWVhY1ghAwf-Nggav9eR6vZ7t72JKtKgALD3l2mwgJ9-9YQ4GCzSYWSjYWVYIEfyq6WAf55wuIV29SiCwtjA_LvFCcrhJqdvU2pUQYi4YXNYIDKlyKmw8Hge2uK9QDXXIyXoWaf0-RFxuWaTmSFDutgxYXJYIO7JOea1rwCAfwBY-KptgBoel34sOlV9mnB0AmCOIgY9"

async function main() {
  const payload = {
    model: process.env.ROUTSTR_TEST_MODEL || "gemma-3n-e4b-it",
    messages: [
      {
        role: "user",
        content:
          process.env.ROUTSTR_TEST_PROMPT ||
          "count from 1 to 10, one token-ish chunk at a time",
      },
    ],
    stream: true,
  };

  const start = Date.now();
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${XCASHU_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  console.log("status", response.status, response.statusText);
  console.log("content-type", response.headers.get("content-type"));

  if (!response.body) {
    throw new Error("Response body missing");
  }

  const reader = response.body.getReader();
  let last = start;
  let reads = 0;

  while (true) {
    const before = Date.now();
    const { done, value } = await reader.read();
    const now = Date.now();

    if (done) {
      console.log(`done total=${now - start}ms reads=${reads}`);
      break;
    }

    reads += 1;
    const text = new TextDecoder().decode(value, { stream: true });
    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        console.log("data chunk:", data);
      }
    }
    console.log(
      `read#${reads} total=${now - start}ms wait=${now - before}ms dt=${now - last}ms bytes=${value.byteLength}`
    );
    last = now;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

export {};

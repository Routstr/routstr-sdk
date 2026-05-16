import { getEncodedTokenV4 } from "@cashu/cashu-ts";

interface TokenInput {
  mint: string;
  proofs: Array<{
    id: string;
    amount: number;
    secret: string;
    C: string;
  }>;
  unit: string;
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: ts-node encode-cashu-token.ts '<json-token>'");
    process.exit(1);
  }

  try {
    const token: TokenInput = JSON.parse(args[0]);
    const encoded = getEncodedTokenV4(token as Parameters<typeof getEncodedTokenV4>[0]);
    console.log(encoded);
  } catch (error) {
    console.error("Failed to encode token:", error);
    process.exit(1);
  }
}

main();
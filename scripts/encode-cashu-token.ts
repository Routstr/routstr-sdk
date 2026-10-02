import { getEncodedToken, Amount } from "@cashu/cashu-ts";

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
    const parsed: TokenInput = JSON.parse(args[0]);
    const token = {
      mint: parsed.mint,
      unit: parsed.unit,
      proofs: parsed.proofs.map((proof) => ({
        id: proof.id,
        amount: Amount.from(proof.amount),
        secret: proof.secret,
        C: proof.C,
      })),
    };
    const encoded = getEncodedToken(token);
    console.log(encoded);
  } catch (error) {
    console.error("Failed to encode token:", error);
    process.exit(1);
  }
}

main();
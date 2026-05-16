import { RoutstrChatClient } from "@/src/ctxcn/RoutstrChatClient";

const PUBKEYS = [
  "b7c6f6915cfa9a62fff6a1f02604de88c23c6c6c6d1b8f62c7cc10749f307e81",
  "b1aafeab21e6b52be4ff9f3fd5c9365b59d7c5298c9d77a7cc1622f7582a8916",
  "48dbb5e717a6221d64fd13ba12794bc28e5067ac1d7632ee9437d533772750df",
  "fb9066ad45f755b694c8b32458009fe5325ac94cc6cdee6112124b9825d92afd",
  "bcdf25d9239f854a4c3d3619cbf8f13d335023686b80a552d8749d7df2565468",
  "4ad6fa2d16e2a9b576c863b4cf7404a70d4dc320c0c447d10ad6ff58993eacc8",
] as const;

async function main(): Promise<void> {
  const client = new RoutstrChatClient();

  try {
    const result = await client.CalculateTrustScores([...PUBKEYS]);

    console.log(
      `Computed ${result.trustScores.length} trust scores in ${result.computationTimeMs}ms`
    );
    for (const score of result.trustScores) {
      console.log(`${score.targetPubkey}: ${score.score}`);
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((error) => {
  console.error("Failed to fetch trust scores:", error);
  process.exit(1);
});

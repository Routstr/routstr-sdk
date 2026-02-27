import type { MintSelection } from "../core/types";

export function isNetworkErrorMessage(message: string): boolean {
  return (
    message.includes("NetworkError when attempting to fetch resource") ||
    message.includes("Failed to fetch") ||
    message.includes("Load failed")
  );
}

export function getBalanceInSats(
  balance: number,
  unit: "sat" | "msat" | string | undefined
): number {
  return unit === "msat" ? balance / 1000 : balance;
}

export function getTotalMintBalanceInSats(
  balances: Record<string, number>,
  units: Record<string, "sat" | "msat">
): number {
  let total = 0;
  for (const mintUrl in balances) {
    total += getBalanceInSats(balances[mintUrl], units[mintUrl]);
  }
  return total;
}

export function selectMintWithBalance(
  balances: Record<string, number>,
  units: Record<string, string>,
  amount: number,
  excludeMints: string[] = []
): MintSelection {
  for (const mintUrl in balances) {
    if (excludeMints.includes(mintUrl)) {
      continue;
    }

    const balanceInSats = getBalanceInSats(balances[mintUrl], units[mintUrl]);
    if (balanceInSats >= amount) {
      return { selectedMintUrl: mintUrl, selectedMintBalance: balanceInSats };
    }
  }

  return { selectedMintUrl: null, selectedMintBalance: 0 };
}

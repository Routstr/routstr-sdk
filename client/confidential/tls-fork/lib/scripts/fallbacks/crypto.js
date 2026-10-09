import { randomBytes } from "../../crypto/insecure-rand.js";
export const crypto = { getRandomValues: randomBytes };

import bcrypt from "bcryptjs";

const DUMMY_HASH = bcrypt.hashSync("continuixai-invalid-credential", 10);

export async function comparePasswordOrDummy(value: string, hash?: string | null): Promise<boolean> {
  const valid = await bcrypt.compare(value, hash || DUMMY_HASH);
  return Boolean(hash) && valid;
}

export const compareRecoveryPinOrDummy = comparePasswordOrDummy;

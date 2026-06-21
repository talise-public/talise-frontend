import { describe, it, expect } from "vitest";
import { Transaction } from "@mysten/sui/transactions";

// The two offline base64 TransactionKind blobs emitted by shield-ptb-harness.
const DEPOSIT_B64 =
  "ABEAIGvNKHY0VttUPQwprLNJcLgeTX8ATSWB/ORrgT7OgVLBAIIBgAFQIP2BaEn5jU9CiYKcyt1Takg5nwmod5c6GILG4UYjHGmaKFT0TT2dJfS13ha8Yv8wPjefkhH58WetrVtA3XAcZhGIastin119jT1ztYMx1Z8/BswC6cNNL/1gvcZUm4DLhKlKVY7NCHxAgQ7ytJmzmz1LiKNXdJcuRkBu26UPgAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIOgDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACDKc7ihxM5AdD5iPbmyRVQCaEKEdiKDkbV0LFDafMieEwAgpaoVjez4oEEMoaNLikb89ozcnc3d5BQUDG2JYXDFkyAAIDU0G7cjI1x/uL7Uil3BHyAfyMpVJdRtfXlPxGq+CxkYACDyTbIOHJl5LBMXH2CsKT7K8vZi7hc+yt7VRsAZE46PGgAI6AMAAAAAAAAAAQEAIDeUnlcrvJzVe3gXzz0wnA+htTYeC8dgX2/v/Gtv23KvAAgAAAAAAAAAAADfAd0BBJG8U3RMOILTfQVh8vVhXh2jw9rQ+NFdm6cJwMO1N4ykeZ0TVucEQ3HrTk5EgPBYivxbxviqPYMQsY6jN+YDezH+ErdLbdCx9D845dWvymENUv/0mwX1BShQuXB2Of/3/8mFpfPQBFSIVsSw7y5wNVecbPzsFuobVYnDgkpVnsJxdH3U9Yt+yDQYZJ2R/9Ce4kWKDHHQLTfuvUKg8/rTQKnCEx15m/QQ8EWhqGYiAD7KVmsQ8oVUbuKaq8Ge8/mvzZ/i6huGBSwMKXZqdjt5Ii2WpPk07+z80bOsz9kA3wHdAQQNJC8ALh7pokwWu9Pwle7jNmipnZRYSuHLp7/vHPkengAqDRDuLNOeYPn4EuSDeiblTmrDuO5FQ4QQWAv37753h7QBtQsRieqbyLAFGcsw8IorL+D3XzXnwqe6yQOU1QvjmUj3VxXh7oFIOZEsySfeKrW/19u5o8uZQK5Zj8WFNPDW0nfC5m5DWgu8aHJJcrwXol5eyT38OoDzMgQSkWerAlo9dKmAjZB9wlWxyyQAEkT+nyXvCyraIYU1/7/04GvTirxp07D2Pqc9GzMRi+4RwSO5szWCVEWAydBcAQAREREREREREREREREREREREREREREREREREREREREREQEAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQFrzSh2NFbbVD0MKayzSXC4Hk1/AE0lgfzka4E+zoFSweiTyDYAAAAAAQAgN5SeVyu8nNV7eBfPPTCcD6G1Nh4Lx2Bfb+/8a2/bcq8EAIcieQdzlYciIlz5H1pnYmidwT+XB2U0wF69NQXVhvm/BXByb29mA25ldwEHRPg4IZz2ewWPOzeQe2VfImFTwY4z380NpVmoRP6pscEGdXNkc3VpBlVTRFNVSQAIAQAAAQEAAQIAAQMAAQQAAQUAAQYAAQcAAIcieQdzlYciIlz5H1pnYmidwT+XB2U0wF69NQXVhvm/CGV4dF9kYXRhA25ldwAGAQgAAQkAAQoAAQsAAQwAAQ0AAIcieQdzlYciIlz5H1pnYmidwT+XB2U0wF69NQXVhvm/DXNoaWVsZGVkX3Bvb2wIdHJhbnNhY3QBB0T4OCGc9nsFjzs3kHtlXyJhU8GOM9/NDaVZqET+qbHBBnVzZHN1aQZVU0RTVUkABAEPAAEOAAIAAAIBAAEBAgIAARAA";

const WITHDRAW_B64 =
  "ABIAIGvNKHY0VttUPQwprLNJcLgeTX8ATSWB/ORrgT7OgVLBAIIBgAGaJEjjjdyPC2+Xrue/aOOq9QDfLzcNZ2fSqPwqf5MWjCCN7FxRMmJ570RFf63ry2+xUE/iOgJslT+l9BpfYCMVn9gagIwi6/u9WtCZr7qLYfp5JfBM3l5Ys3z6Dhh5uw6WTOJUIwpkzDAIDaC4yXdcPInpoxw+00+NM+WlTLFLMAAgTL9NDpK1gw7yUsJwFZ133cSR972OLVdxS3vK1hk5Fy8AIBn8/++T9eFDkXC5eUjoMyhdWIGBtkVQuCmgMeFyTmQwACAec/Vu2PRgFPfbIaSHzGh2VecFEbRxlcB7TsSw2M1kJgAgomtE2Xo68xz8+h/09hfGUyyUh6Eg4X/j1UFBlxm5fysAILdugburxI1c0BorovK6uhRE6mIS1EyAjxW1uYtZtDgCACCIx+740w6nIgO6GI01EGUvw54ruIKb/yOMBBhi5dQEDwAI6AMAAAAAAAAAAQAAIDeUnlcrvJzVe3gXzz0wnA+htTYeC8dgX2/v/Gtv23KvAAgAAAAAAAAAAADfAd0BBOzj7+As/+J1p5IGWkqF2kGRztAZBgR/XVVOhx85sgvjoNpz/FAesqRX2U0dbKOUNUqIw8j8bLsorCNCnhsf3g7RLRNJucUEFGisQvVemLBzHd/z+KnAcEiDV2nhaH1kG35lsU+8DbwBFbmPNaKikjhWVqz0kE3W46pCmL58GBNuG6NcXFeg7hnEiSIGVtJ5/w8SKIS8exEX4mwfrvcm5sb9dG6UNLxnxwefa66V8UHJypoiCoHGHGlqlvOBw0keuplAUcTzoQFjB0RP0z6bPpWNlSuXVATwCpRN9FIA3wHdAQTDjDo54/1TFJ/6o09CvbyMrNQmBRBJ93NacuFDLcedTR0GLdoGNMNFMs/d58sM3j0Z0vpSj52s7tcP6X2ucK5miTR+CAd2PSOTwrz+9QL4JiPpRNH3njgAN/gY0YlLTV6N8c2fCskJ4yHgUiQo5qOSr7WJSzrFd0yeV3dEomtz5iqMI6vYOQ5hEe3LpwYLAat5eOzsGk3/Rw3paqdZcJTIkSI0JB89MGxTs53WBds/WYkS0vGaCqlWuSSJrconc+jX6GTtGkW1z9LWovwOpUPYQLokaCyUrtGN4EFOAQAiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIgEAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAAAAAAAEBa80odjRW21Q9DCmss0lwuB5NfwBNJYH85GuBPs6BUsHok8g2AAAAAAEAIDMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzBQCHInkHc5WHIiJc+R9aZ2JoncE/lwdlNMBevTUF1Yb5vwVwcm9vZgNuZXcBB0T4OCGc9nsFjzs3kHtlXyJhU8GOM9/NDaVZqET+qbHBBnVzZHN1aQZVU0RTVUkACAEAAAEBAAECAAEDAAEEAAEFAAEGAAEHAACHInkHc5WHIiJc+R9aZ2JoncE/lwdlNMBevTUF1Yb5vwhleHRfZGF0YQNuZXcABgEIAAEJAAEKAAELAAEMAAENAAIBDgABAQ8AAIcieQdzlYciIlz5H1pnYmidwT+XB2U0wF69NQXVhvm/DXNoaWVsZGVkX3Bvb2wIdHJhbnNhY3QBB0T4OCGc9nsFjzs3kHtlXyJhU8GOM9/NDaVZqET+qbHBBnVzZHN1aQZVU0RTVUkABAEQAAMCAAAAAgAAAgEAAQECAwABEQA=";

function kinds(b64: string): string[] {
  const tx = Transaction.fromKind(Buffer.from(b64, "base64"));
  const data = tx.getData();
  return data.commands.map((c) => Object.keys(c)[0]);
}

describe("shield PTB verify (parse the base64 back)", () => {
  it("DEPOSIT parses to proof::new -> ext_data::new -> transact -> TransferObjects", () => {
    const tx = Transaction.fromKind(Buffer.from(DEPOSIT_B64, "base64"));
    const cmds = tx.getData().commands;
    const moveTargets = cmds
      .filter((c) => "MoveCall" in c)
      .map((c) => (c as { MoveCall: { module: string; function: string } }).MoveCall)
      .map((m) => `${m.module}::${m.function}`);
    // eslint-disable-next-line no-console
    console.log("DEPOSIT cmds", JSON.stringify(kinds(DEPOSIT_B64)));
    // eslint-disable-next-line no-console
    console.log("DEPOSIT moves", JSON.stringify(moveTargets));
    expect(moveTargets).toEqual([
      "proof::new",
      "ext_data::new",
      "shielded_pool::transact",
    ]);
    expect(kinds(DEPOSIT_B64).at(-1)).toBe("TransferObjects");
  });

  it("WITHDRAW parses to proof::new -> ext_data::new -> SplitCoins -> transact -> TransferObjects", () => {
    const tx = Transaction.fromKind(Buffer.from(WITHDRAW_B64, "base64"));
    const cmds = tx.getData().commands;
    const moveTargets = cmds
      .filter((c) => "MoveCall" in c)
      .map((c) => (c as { MoveCall: { module: string; function: string } }).MoveCall)
      .map((m) => `${m.module}::${m.function}`);
    // eslint-disable-next-line no-console
    console.log("WITHDRAW cmds", JSON.stringify(kinds(WITHDRAW_B64)));
    // eslint-disable-next-line no-console
    console.log("WITHDRAW moves", JSON.stringify(moveTargets));
    expect(moveTargets).toEqual([
      "proof::new",
      "ext_data::new",
      "shielded_pool::transact",
    ]);
    const ks = kinds(WITHDRAW_B64);
    expect(ks).toContain("SplitCoins");
    expect(ks.at(-1)).toBe("TransferObjects");
  });
});

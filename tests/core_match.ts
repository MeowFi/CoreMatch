import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CoreMatch } from "../target/types/core_match";

describe("core_match", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.CoreMatch as Program<CoreMatch>;

  it("Is initialized!", async () => {
    const tx = await program.methods.initialize().rpc();
    console.log("Your transaction signature", tx);
  });
});

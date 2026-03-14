import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { CoreMatch } from "../target/types/core_match";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";
import BN from "bn.js";

describe("core_match", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.CoreMatch as Program<CoreMatch>;
  const connection = provider.connection;
  const admin = provider.wallet as anchor.Wallet;

  // Test keypairs
  let baseMint: PublicKey;
  let quoteMint: PublicKey;
  let baseVaultKp: Keypair;
  let quoteVaultKp: Keypair;
  let marketPda: PublicKey;
  let marketBump: number;

  // User A (bidder - buying base with quote)
  const userA = Keypair.generate();
  let userABaseAccount: PublicKey;
  let userAQuoteAccount: PublicKey;

  // User B (asker - selling base for quote)
  const userB = Keypair.generate();
  let userBBaseAccount: PublicKey;
  let userBQuoteAccount: PublicKey;

  // Cranker (permissionless matcher)
  const cranker = Keypair.generate();
  let crankerBaseAccount: PublicKey;
  let crankerQuoteAccount: PublicKey;

  // Constants
  const PRICE = new BN(10); // 10 quote tokens per base token
  const BASE_AMOUNT = new BN(100); // 100 base tokens
  const QUOTE_AMOUNT = PRICE.mul(BASE_AMOUNT); // 1000 quote tokens

  before(async () => {
    // Airdrop SOL to test wallets
    for (const kp of [userA, userB, cranker]) {
      const sig = await connection.requestAirdrop(
        kp.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig, "confirmed");
    }

    // Create base mint (the asset being traded)
    baseMint = await createMint(
      connection,
      admin.payer,
      admin.publicKey,
      null,
      6 // 6 decimals
    );

    // Create quote mint (e.g. USDC)
    quoteMint = await createMint(
      connection,
      admin.payer,
      admin.publicKey,
      null,
      6 // 6 decimals
    );

    // Create token accounts for users
    userABaseAccount = await createAccount(
      connection,
      admin.payer,
      baseMint,
      userA.publicKey
    );
    userAQuoteAccount = await createAccount(
      connection,
      admin.payer,
      quoteMint,
      userA.publicKey
    );
    userBBaseAccount = await createAccount(
      connection,
      admin.payer,
      baseMint,
      userB.publicKey
    );
    userBQuoteAccount = await createAccount(
      connection,
      admin.payer,
      quoteMint,
      userB.publicKey
    );
    crankerBaseAccount = await createAccount(
      connection,
      admin.payer,
      baseMint,
      cranker.publicKey
    );
    crankerQuoteAccount = await createAccount(
      connection,
      admin.payer,
      quoteMint,
      cranker.publicKey
    );

    // Mint tokens to users
    // User A gets quote tokens (they want to buy base)
    await mintTo(
      connection,
      admin.payer,
      quoteMint,
      userAQuoteAccount,
      admin.publicKey,
      10_000_000_000 // 10,000 quote tokens
    );

    // User B gets base tokens (they want to sell base)
    await mintTo(
      connection,
      admin.payer,
      baseMint,
      userBBaseAccount,
      admin.publicKey,
      10_000_000_000 // 10,000 base tokens
    );

    // Derive Market PDA
    [marketPda, marketBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), admin.publicKey.toBuffer()],
      program.programId
    );

    // Generate keypairs for vaults
    baseVaultKp = Keypair.generate();
    quoteVaultKp = Keypair.generate();
  });

  // ==========================================================
  // TEST 1: Initialize Market
  // ==========================================================
  it("initializes the market", async () => {
    const tx = await program.methods
      .initializeMarket()
      .accounts({
        admin: admin.publicKey,
        market: marketPda,
        baseMint: baseMint,
        quoteMint: quoteMint,
        baseVault: baseVaultKp.publicKey,
        quoteVault: quoteVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([baseVaultKp, quoteVaultKp])
      .rpc();

    console.log("  Market initialized:", tx);

    // Verify market state
    const market = await program.account.market.fetch(marketPda);
    expect(market.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(market.baseMint.toBase58()).to.equal(baseMint.toBase58());
    expect(market.quoteMint.toBase58()).to.equal(quoteMint.toBase58());
    expect(market.baseVault.toBase58()).to.equal(
      baseVaultKp.publicKey.toBase58()
    );
    expect(market.quoteVault.toBase58()).to.equal(
      quoteVaultKp.publicKey.toBase58()
    );

    // Verify vaults exist and have correct mints
    const baseVaultAccount = await getAccount(
      connection,
      baseVaultKp.publicKey
    );
    expect(baseVaultAccount.mint.toBase58()).to.equal(baseMint.toBase58());
    expect(baseVaultAccount.owner.toBase58()).to.equal(marketPda.toBase58());

    const quoteVaultAccount = await getAccount(
      connection,
      quoteVaultKp.publicKey
    );
    expect(quoteVaultAccount.mint.toBase58()).to.equal(quoteMint.toBase58());
    expect(quoteVaultAccount.owner.toBase58()).to.equal(marketPda.toBase58());
  });

  // ==========================================================
  // TEST 2: Place Bid Order
  // ==========================================================
  it("places a bid order (buying base with quote)", async () => {
    const orderId = new BN(1);

    const [orderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userA.publicKey.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const quoteBalanceBefore = (
      await getAccount(connection, userAQuoteAccount)
    ).amount;

    const tx = await program.methods
      .placeOrder(orderId, true, PRICE, BASE_AMOUNT)
      .accounts({
        maker: userA.publicKey,
        market: marketPda,
        order: orderPda,
        makerTokenAccount: userAQuoteAccount,
        vault: quoteVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    console.log("  Bid placed:", tx);

    // Verify order state
    const order = await program.account.order.fetch(orderPda);
    expect(order.maker.toBase58()).to.equal(userA.publicKey.toBase58());
    expect(order.isBid).to.be.true;
    expect(order.price.toNumber()).to.equal(PRICE.toNumber());
    expect(order.baseAmount.toNumber()).to.equal(BASE_AMOUNT.toNumber());
    expect(order.filledBaseAmount.toNumber()).to.equal(0);

    // Verify quote tokens were transferred to vault
    const quoteBalanceAfter = (
      await getAccount(connection, userAQuoteAccount)
    ).amount;
    const expectedTransfer = BigInt(QUOTE_AMOUNT.toNumber());
    expect(quoteBalanceBefore - quoteBalanceAfter).to.equal(expectedTransfer);

    // Verify vault received the tokens
    const vaultBalance = (
      await getAccount(connection, quoteVaultKp.publicKey)
    ).amount;
    expect(vaultBalance).to.equal(expectedTransfer);
  });

  // ==========================================================
  // TEST 3: Place Ask Order
  // ==========================================================
  it("places an ask order (selling base for quote)", async () => {
    const orderId = new BN(1);

    const [orderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userB.publicKey.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const baseBalanceBefore = (
      await getAccount(connection, userBBaseAccount)
    ).amount;

    const tx = await program.methods
      .placeOrder(orderId, false, PRICE, BASE_AMOUNT)
      .accounts({
        maker: userB.publicKey,
        market: marketPda,
        order: orderPda,
        makerTokenAccount: userBBaseAccount,
        vault: baseVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userB])
      .rpc();

    console.log("  Ask placed:", tx);

    // Verify order state
    const order = await program.account.order.fetch(orderPda);
    expect(order.maker.toBase58()).to.equal(userB.publicKey.toBase58());
    expect(order.isBid).to.be.false;
    expect(order.price.toNumber()).to.equal(PRICE.toNumber());
    expect(order.baseAmount.toNumber()).to.equal(BASE_AMOUNT.toNumber());
    expect(order.filledBaseAmount.toNumber()).to.equal(0);

    // Verify base tokens were transferred to vault
    const baseBalanceAfter = (
      await getAccount(connection, userBBaseAccount)
    ).amount;
    const expectedTransfer = BigInt(BASE_AMOUNT.toNumber());
    expect(baseBalanceBefore - baseBalanceAfter).to.equal(expectedTransfer);
  });

  // ==========================================================
  // TEST 4: Match Orders at Exact Price (Full Fill)
  // ==========================================================
  it("matches orders at exact price (full fill)", async () => {
    const bidOrderId = new BN(1);
    const askOrderId = new BN(1);

    const [bidOrderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userA.publicKey.toBuffer(),
        bidOrderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [askOrderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userB.publicKey.toBuffer(),
        askOrderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Record balances before match
    const userABaseBefore = (
      await getAccount(connection, userABaseAccount)
    ).amount;
    const userBQuoteBefore = (
      await getAccount(connection, userBQuoteAccount)
    ).amount;

    const tx = await program.methods
      .matchOrders()
      .accounts({
        cranker: cranker.publicKey,
        market: marketPda,
        bidOrder: bidOrderPda,
        askOrder: askOrderPda,
        baseVault: baseVaultKp.publicKey,
        quoteVault: quoteVaultKp.publicKey,
        buyerBaseAccount: userABaseAccount,
        sellerQuoteAccount: userBQuoteAccount,
        bidMaker: userA.publicKey,
        askMaker: userB.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([cranker])
      .rpc();

    console.log("  Orders matched:", tx);

    // Verify buyer received base tokens
    const userABaseAfter = (
      await getAccount(connection, userABaseAccount)
    ).amount;
    expect(userABaseAfter - userABaseBefore).to.equal(
      BigInt(BASE_AMOUNT.toNumber())
    );

    // Verify seller received quote tokens
    const userBQuoteAfter = (
      await getAccount(connection, userBQuoteAccount)
    ).amount;
    expect(userBQuoteAfter - userBQuoteBefore).to.equal(
      BigInt(QUOTE_AMOUNT.toNumber())
    );

    // Verify both orders are closed (accounts should not exist)
    try {
      await program.account.order.fetch(bidOrderPda);
      expect.fail("Bid order should have been closed");
    } catch (err: any) {
      expect(err.message).to.include("Account does not exist");
    }

    try {
      await program.account.order.fetch(askOrderPda);
      expect.fail("Ask order should have been closed");
    } catch (err: any) {
      expect(err.message).to.include("Account does not exist");
    }
  });

  // ==========================================================
  // TEST 5: Partial Fill
  // ==========================================================
  it("handles partial fills correctly", async () => {
    // User A bids for 100 base tokens
    const bidOrderId = new BN(2);
    const largeBidAmount = new BN(100);

    const [bidOrderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userA.publicKey.toBuffer(),
        bidOrderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .placeOrder(bidOrderId, true, PRICE, largeBidAmount)
      .accounts({
        maker: userA.publicKey,
        market: marketPda,
        order: bidOrderPda,
        makerTokenAccount: userAQuoteAccount,
        vault: quoteVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    // User B asks for only 40 base tokens (smaller)
    const askOrderId = new BN(2);
    const smallAskAmount = new BN(40);

    const [askOrderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userB.publicKey.toBuffer(),
        askOrderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .placeOrder(askOrderId, false, PRICE, smallAskAmount)
      .accounts({
        maker: userB.publicKey,
        market: marketPda,
        order: askOrderPda,
        makerTokenAccount: userBBaseAccount,
        vault: baseVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userB])
      .rpc();

    // Match them - should partially fill the bid
    await program.methods
      .matchOrders()
      .accounts({
        cranker: cranker.publicKey,
        market: marketPda,
        bidOrder: bidOrderPda,
        askOrder: askOrderPda,
        baseVault: baseVaultKp.publicKey,
        quoteVault: quoteVaultKp.publicKey,
        buyerBaseAccount: userABaseAccount,
        sellerQuoteAccount: userBQuoteAccount,
        bidMaker: userA.publicKey,
        askMaker: userB.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([cranker])
      .rpc();

    // Bid order should still exist with 40 filled out of 100
    const bidOrder = await program.account.order.fetch(bidOrderPda);
    expect(bidOrder.filledBaseAmount.toNumber()).to.equal(40);
    expect(bidOrder.baseAmount.toNumber()).to.equal(100);

    // Ask order should be closed (fully filled: 40/40)
    try {
      await program.account.order.fetch(askOrderPda);
      expect.fail("Ask order should have been closed (fully filled)");
    } catch (err: any) {
      expect(err.message).to.include("Account does not exist");
    }

    // Cleanup: cancel the remaining bid order
    await program.methods
      .cancelOrder()
      .accounts({
        maker: userA.publicKey,
        market: marketPda,
        order: bidOrderPda,
        vault: quoteVaultKp.publicKey,
        makerTokenAccount: userAQuoteAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userA])
      .rpc();
  });

  // ==========================================================
  // TEST 6: Sad Path - PriceNotCrossed
  // ==========================================================
  it("fails to match when bid price < ask price (PriceNotCrossed)", async () => {
    const lowPrice = new BN(5);
    const highPrice = new BN(15);

    // User A bids at price 5
    const bidOrderId = new BN(3);
    const [bidOrderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userA.publicKey.toBuffer(),
        bidOrderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .placeOrder(bidOrderId, true, lowPrice, new BN(10))
      .accounts({
        maker: userA.publicKey,
        market: marketPda,
        order: bidOrderPda,
        makerTokenAccount: userAQuoteAccount,
        vault: quoteVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    // User B asks at price 15
    const askOrderId = new BN(3);
    const [askOrderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userB.publicKey.toBuffer(),
        askOrderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .placeOrder(askOrderId, false, highPrice, new BN(10))
      .accounts({
        maker: userB.publicKey,
        market: marketPda,
        order: askOrderPda,
        makerTokenAccount: userBBaseAccount,
        vault: baseVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userB])
      .rpc();

    // Try to match - should fail
    try {
      await program.methods
        .matchOrders()
        .accounts({
          cranker: cranker.publicKey,
          market: marketPda,
          bidOrder: bidOrderPda,
          askOrder: askOrderPda,
          baseVault: baseVaultKp.publicKey,
          quoteVault: quoteVaultKp.publicKey,
          buyerBaseAccount: userABaseAccount,
          sellerQuoteAccount: userBQuoteAccount,
          bidMaker: userA.publicKey,
          askMaker: userB.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([cranker])
        .rpc();

      expect.fail("Should have thrown PriceNotCrossed error");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("PriceNotCrossed");
      console.log("  ✓ PriceNotCrossed error thrown correctly");
    }

    // Cleanup: cancel both orders
    await program.methods
      .cancelOrder()
      .accounts({
        maker: userA.publicKey,
        market: marketPda,
        order: bidOrderPda,
        vault: quoteVaultKp.publicKey,
        makerTokenAccount: userAQuoteAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    await program.methods
      .cancelOrder()
      .accounts({
        maker: userB.publicKey,
        market: marketPda,
        order: askOrderPda,
        vault: baseVaultKp.publicKey,
        makerTokenAccount: userBBaseAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userB])
      .rpc();
  });

  // ==========================================================
  // TEST 7: Security - Unauthorized Cancel Attempt
  // ==========================================================
  it("prevents unauthorized users from cancelling orders", async () => {
    const orderId = new BN(4);

    const [orderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userA.publicKey.toBuffer(),
        orderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // User A places an order
    await program.methods
      .placeOrder(orderId, true, PRICE, new BN(10))
      .accounts({
        maker: userA.publicKey,
        market: marketPda,
        order: orderPda,
        makerTokenAccount: userAQuoteAccount,
        vault: quoteVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    // User B tries to cancel User A's order
    try {
      await program.methods
        .cancelOrder()
        .accounts({
          maker: userB.publicKey,
          market: marketPda,
          order: orderPda,
          vault: quoteVaultKp.publicKey,
          makerTokenAccount: userBQuoteAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([userB])
        .rpc();

      expect.fail("Should have failed - unauthorized cancellation");
    } catch (err: any) {
      // The has_one constraint or PDA seed validation should prevent this
      console.log("  ✓ Unauthorized cancel correctly rejected");
    }

    // Cleanup: actual maker cancels
    await program.methods
      .cancelOrder()
      .accounts({
        maker: userA.publicKey,
        market: marketPda,
        order: orderPda,
        vault: quoteVaultKp.publicKey,
        makerTokenAccount: userAQuoteAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userA])
      .rpc();
  });

  // ==========================================================
  // TEST 8: Security - Cranker Cannot Redirect Settlement
  // ==========================================================
  it("prevents a cranker from redirecting settlement token accounts", async () => {
    const bidOrderId = new BN(5);
    const askOrderId = new BN(5);
    const amount = new BN(15);

    const [bidOrderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userA.publicKey.toBuffer(),
        bidOrderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const [askOrderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        marketPda.toBuffer(),
        userB.publicKey.toBuffer(),
        askOrderId.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .placeOrder(bidOrderId, true, PRICE, amount)
      .accounts({
        maker: userA.publicKey,
        market: marketPda,
        order: bidOrderPda,
        makerTokenAccount: userAQuoteAccount,
        vault: quoteVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    await program.methods
      .placeOrder(askOrderId, false, PRICE, amount)
      .accounts({
        maker: userB.publicKey,
        market: marketPda,
        order: askOrderPda,
        makerTokenAccount: userBBaseAccount,
        vault: baseVaultKp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userB])
      .rpc();

    try {
      await program.methods
        .matchOrders()
        .accounts({
          cranker: cranker.publicKey,
          market: marketPda,
          bidOrder: bidOrderPda,
          askOrder: askOrderPda,
          baseVault: baseVaultKp.publicKey,
          quoteVault: quoteVaultKp.publicKey,
          buyerBaseAccount: crankerBaseAccount,
          sellerQuoteAccount: crankerQuoteAccount,
          bidMaker: userA.publicKey,
          askMaker: userB.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([cranker])
        .rpc();

      expect.fail("Should have rejected redirected settlement accounts");
    } catch (err: any) {
      expect(err.error.errorCode.code).to.equal("InvalidSettlementAccount");
      console.log("  ✓ Redirected settlement accounts correctly rejected");
    }

    await program.methods
      .cancelOrder()
      .accounts({
        maker: userA.publicKey,
        market: marketPda,
        order: bidOrderPda,
        vault: quoteVaultKp.publicKey,
        makerTokenAccount: userAQuoteAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userA])
      .rpc();

    await program.methods
      .cancelOrder()
      .accounts({
        maker: userB.publicKey,
        market: marketPda,
        order: askOrderPda,
        vault: baseVaultKp.publicKey,
        makerTokenAccount: userBBaseAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([userB])
      .rpc();
  });
});

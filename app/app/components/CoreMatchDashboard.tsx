"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import {
  AnchorProvider,
  BN,
  Program,
  type Idl,
  type Wallet,
} from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  ArrowRightLeft,
  Boxes,
  CandlestickChart,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { Buffer } from "buffer";

import idlJson from "../idl.json";

type CoreMatchIdl = Idl & { address: string };

type MarketAccountData = {
  admin: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  bump: number;
};

type OrderAccountData = {
  maker: PublicKey;
  market: PublicKey;
  orderId: BN;
  isBid: boolean;
  price: BN;
  baseAmount: BN;
  filledBaseAmount: BN;
  bump: number;
};

type AccountRecord<T> = {
  publicKey: PublicKey;
  account: T;
};

type PlaceOrderAccounts = {
  maker: PublicKey;
  market: PublicKey;
  order: PublicKey;
  makerTokenAccount: PublicKey;
  vault: PublicKey;
  tokenProgram: PublicKey;
  systemProgram: PublicKey;
};

type MatchOrdersAccounts = {
  cranker: PublicKey;
  market: PublicKey;
  bidOrder: PublicKey;
  askOrder: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  buyerBaseAccount: PublicKey;
  sellerQuoteAccount: PublicKey;
  bidMaker: PublicKey;
  askMaker: PublicKey;
  tokenProgram: PublicKey;
  systemProgram: PublicKey;
};

type TypedProgram = Program<Idl> & {
  account: {
    market: {
      all(): Promise<Array<AccountRecord<MarketAccountData>>>;
    };
    order: {
      all(): Promise<Array<AccountRecord<OrderAccountData>>>;
    };
  };
  methods: {
    placeOrder(
      orderId: BN,
      isBid: boolean,
      price: BN,
      baseAmount: BN
    ): {
      accounts(accounts: PlaceOrderAccounts): {
        rpc(): Promise<string>;
      };
    };
    matchOrders(): {
      accounts(accounts: MatchOrdersAccounts): {
        rpc(): Promise<string>;
      };
    };
  };
};

const CORE_MATCH_IDL = idlJson as CoreMatchIdl;
const PROGRAM_ID = new PublicKey(CORE_MATCH_IDL.address);
const READONLY_PAYER = Keypair.generate();
const READONLY_WALLET: Wallet = {
  payer: READONLY_PAYER,
  publicKey: READONLY_PAYER.publicKey,
  signTransaction<T extends Transaction | VersionedTransaction>(
    transaction: T
  ): Promise<T> {
    return Promise.resolve(transaction);
  },
  signAllTransactions<T extends Transaction | VersionedTransaction>(
    transactions: T[]
  ): Promise<T[]> {
    return Promise.resolve(transactions);
  },
};

function shortAddress(address: PublicKey, chars = 4) {
  const value = address.toBase58();
  return `${value.slice(0, chars)}...${value.slice(-chars)}`;
}

function parsePositiveInteger(value: string) {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error";
}

function sortBids(
  left: AccountRecord<OrderAccountData>,
  right: AccountRecord<OrderAccountData>
) {
  return right.account.price.cmp(left.account.price);
}

function sortAsks(
  left: AccountRecord<OrderAccountData>,
  right: AccountRecord<OrderAccountData>
) {
  return left.account.price.cmp(right.account.price);
}

export default function CoreMatchDashboard() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();

  const [market, setMarket] = useState<AccountRecord<MarketAccountData> | null>(null);
  const [orders, setOrders] = useState<Array<AccountRecord<OrderAccountData>>>([]);
  const [priceInput, setPriceInput] = useState("10");
  const [amountInput, setAmountInput] = useState("100");
  const [isBid, setIsBid] = useState(true);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(
    "Scanning devnet for the first configured market..."
  );
  const [txSignature, setTxSignature] = useState<string | null>(null);

  const program = useMemo(() => {
    const provider = new AnchorProvider(connection, wallet ?? READONLY_WALLET, {
      commitment: "confirmed",
    });

    return new Program(CORE_MATCH_IDL, provider) as unknown as TypedProgram;
  }, [connection, wallet]);

  useEffect(() => {
    let cancelled = false;

    async function syncBook() {
      try {
        const [markets, openOrders] = await Promise.all([
          program.account.market.all(),
          program.account.order.all(),
        ]);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setMarket(markets[0] ?? null);
          setOrders(openOrders);
        });

        if (markets.length === 0) {
          setStatus(
            "No market PDA found on devnet yet. Initialize one before placing orders."
          );
        } else if (!wallet) {
          setStatus(
            "Market discovered. Connect a wallet to place orders or crank a match."
          );
        } else if (!txSignature) {
          setStatus("Market live. Orders refresh automatically every 10 seconds.");
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(`Failed to load market data: ${getErrorMessage(error)}`);
        }
      }
    }

    void syncBook();
    const interval = window.setInterval(() => {
      void syncBook();
    }, 10_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [program, txSignature, wallet]);

  const marketOrders = market
    ? orders.filter((order) => order.account.market.equals(market.publicKey))
    : [];
  const bidOrders = [...marketOrders].filter((order) => order.account.isBid).sort(sortBids);
  const askOrders = [...marketOrders]
    .filter((order) => !order.account.isBid)
    .sort(sortAsks);
  const spread =
    bidOrders.length > 0 && askOrders.length > 0
      ? askOrders[0].account.price.sub(bidOrders[0].account.price).toString()
      : "N/A";

  async function refreshOrderBook() {
    try {
      const [markets, openOrders] = await Promise.all([
        program.account.market.all(),
        program.account.order.all(),
      ]);

      startTransition(() => {
        setMarket(markets[0] ?? null);
        setOrders(openOrders);
      });
    } catch (error) {
      setStatus(`Refresh failed: ${getErrorMessage(error)}`);
    }
  }

  async function placeOrder() {
    if (!wallet) {
      setStatus("Connect a wallet before placing an order.");
      return;
    }

    if (!market) {
      setStatus("No market is initialized yet.");
      return;
    }

    const parsedPrice = parsePositiveInteger(priceInput);
    const parsedAmount = parsePositiveInteger(amountInput);

    if (!parsedPrice || !parsedAmount) {
      setStatus("Price and amount must both be positive integers.");
      return;
    }

    const orderId = new BN(Date.now().toString());
    const makerMint = isBid ? market.account.quoteMint : market.account.baseMint;
    const makerTokenAccount = getAssociatedTokenAddressSync(makerMint, wallet.publicKey);
    const vault = isBid ? market.account.quoteVault : market.account.baseVault;
    const orderSeedBytes = orderId.toArrayLike(Buffer, "le", 8);
    const [orderPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("order"),
        market.publicKey.toBuffer(),
        wallet.publicKey.toBuffer(),
        orderSeedBytes,
      ],
      PROGRAM_ID
    );

    const makerAccountInfo = await connection.getAccountInfo(makerTokenAccount);
    if (!makerAccountInfo) {
      setStatus(
        `Missing associated token account for ${
          isBid ? "quote" : "base"
        } tokens: ${makerTokenAccount.toBase58()}`
      );
      return;
    }

    setLoading(true);
    setTxSignature(null);
    setStatus(`Submitting ${isBid ? "bid" : "ask"} order to devnet...`);

    try {
      const signature = await program.methods
        .placeOrder(orderId, isBid, new BN(parsedPrice), new BN(parsedAmount))
        .accounts({
          maker: wallet.publicKey,
          market: market.publicKey,
          order: orderPda,
          makerTokenAccount,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setTxSignature(signature);
      setStatus(
        `${
          isBid ? "Bid" : "Ask"
        } accepted. Escrow moved on-chain and the order PDA is now live.`
      );
      await refreshOrderBook();
    } catch (error) {
      setStatus(`Place order failed: ${getErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }

  async function crankBestMatch() {
    if (!wallet) {
      setStatus("Connect a wallet before running the crank.");
      return;
    }

    if (!market) {
      setStatus("No market is initialized yet.");
      return;
    }

    if (bidOrders.length === 0 || askOrders.length === 0) {
      setStatus("At least one bid and one ask are required before a crank can run.");
      return;
    }

    const bestBid = bidOrders[0];
    const bestAsk = askOrders[0];

    if (bestBid.account.price.lt(bestAsk.account.price)) {
      setStatus(
        `No crossing orders yet. Best bid ${bestBid.account.price.toString()} is below best ask ${bestAsk.account.price.toString()}.`
      );
      return;
    }

    const buyerBaseAccount = getAssociatedTokenAddressSync(
      market.account.baseMint,
      bestBid.account.maker
    );
    const sellerQuoteAccount = getAssociatedTokenAddressSync(
      market.account.quoteMint,
      bestAsk.account.maker
    );

    const [buyerInfo, sellerInfo] = await Promise.all([
      connection.getAccountInfo(buyerBaseAccount),
      connection.getAccountInfo(sellerQuoteAccount),
    ]);

    if (!buyerInfo || !sellerInfo) {
      setStatus(
        "Match blocked: one of the makers is missing the required associated token account for settlement."
      );
      return;
    }

    setLoading(true);
    setTxSignature(null);
    setStatus(
      `Cross found. Cranking bid ${bestBid.account.price.toString()} against ask ${bestAsk.account.price.toString()}...`
    );

    try {
      const signature = await program.methods
        .matchOrders()
        .accounts({
          cranker: wallet.publicKey,
          market: market.publicKey,
          bidOrder: bestBid.publicKey,
          askOrder: bestAsk.publicKey,
          baseVault: market.account.baseVault,
          quoteVault: market.account.quoteVault,
          buyerBaseAccount,
          sellerQuoteAccount,
          bidMaker: bestBid.account.maker,
          askMaker: bestAsk.account.maker,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      setTxSignature(signature);
      setStatus(
        "Match executed. Filled amounts and order closures have been applied on-chain."
      );
      await refreshOrderBook();
    } catch (error) {
      setStatus(`Crank failed: ${getErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="corematch-shell">
      <header className="hero-bar">
        <div>
          <p className="eyebrow">On-Chain Order Matching Engine</p>
          <h1>CoreMatch</h1>
          <p className="hero-copy">
            Flat PDAs replace the monolithic Redis order book, and any wallet can
            crank a crossing match.
          </p>
        </div>
        <div className="header-actions">
          <a
            className="ghost-link"
            href={`https://explorer.solana.com/address/${PROGRAM_ID.toBase58()}?cluster=devnet`}
            rel="noreferrer"
            target="_blank"
          >
            Program <ExternalLink size={14} />
          </a>
          <WalletMultiButton />
        </div>
      </header>

      <section className="market-grid">
        <article className="panel market-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Market</p>
              <h2>Discovered Market PDA</h2>
            </div>
            <button
              className="icon-button"
              onClick={() => void refreshOrderBook()}
              type="button"
            >
              <RefreshCw size={16} />
              Refresh
            </button>
          </div>

          {market ? (
            <div className="market-meta">
              <div>
                <span>Market</span>
                <strong>{shortAddress(market.publicKey, 6)}</strong>
              </div>
              <div>
                <span>Base Mint</span>
                <strong>{shortAddress(market.account.baseMint, 6)}</strong>
              </div>
              <div>
                <span>Quote Mint</span>
                <strong>{shortAddress(market.account.quoteMint, 6)}</strong>
              </div>
              <div>
                <span>Spread</span>
                <strong>{spread}</strong>
              </div>
            </div>
          ) : (
            <p className="empty-state">No market PDA found yet.</p>
          )}
        </article>

        <article className="panel stat-strip">
          <div className="stat-card">
            <CandlestickChart size={18} />
            <span>Bids</span>
            <strong>{bidOrders.length}</strong>
          </div>
          <div className="stat-card">
            <Boxes size={18} />
            <span>Asks</span>
            <strong>{askOrders.length}</strong>
          </div>
          <div className="stat-card">
            <ArrowRightLeft size={18} />
            <span>Mode</span>
            <strong>Devnet</strong>
          </div>
          <div className="stat-card">
            <ShieldCheck size={18} />
            <span>Settlement</span>
            <strong>Constrained</strong>
          </div>
        </article>
      </section>

      <section className="main-grid">
        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Order Entry</p>
              <h2>Place Order</h2>
            </div>
            <span className={`side-pill ${isBid ? "bid-pill" : "ask-pill"}`}>
              {isBid ? "Bid" : "Ask"}
            </span>
          </div>

          <div className="toggle-row">
            <button
              className={isBid ? "toggle active-bid" : "toggle"}
              onClick={() => setIsBid(true)}
              type="button"
            >
              Buy Base
            </button>
            <button
              className={!isBid ? "toggle active-ask" : "toggle"}
              onClick={() => setIsBid(false)}
              type="button"
            >
              Sell Base
            </button>
          </div>

          <label className="field">
            <span>Price (quote per base)</span>
            <input
              inputMode="numeric"
              onChange={(event) => setPriceInput(event.target.value)}
              placeholder="10"
              value={priceInput}
            />
          </label>

          <label className="field">
            <span>Amount (base)</span>
            <input
              inputMode="numeric"
              onChange={(event) => setAmountInput(event.target.value)}
              placeholder="100"
              value={amountInput}
            />
          </label>

          <div className="summary-card">
            <span>Escrow total</span>
            <strong>
              {(() => {
                const parsedPrice = parsePositiveInteger(priceInput) ?? 0;
                const parsedAmount = parsePositiveInteger(amountInput) ?? 0;
                return (parsedPrice * parsedAmount).toLocaleString();
              })()}
            </strong>
            <small>
              {isBid
                ? "Quote tokens escrowed in quote_vault"
                : "Base tokens escrowed in base_vault"}
            </small>
          </div>

          <button
            className="primary-button"
            disabled={loading || !market}
            onClick={() => void placeOrder()}
            type="button"
          >
            {loading ? "Submitting..." : `Place ${isBid ? "Bid" : "Ask"}`}
          </button>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Order Book</p>
              <h2>Open Order PDAs</h2>
            </div>
            <span className="badge">{marketOrders.length} open</span>
          </div>

          <div className="book-grid">
            <div>
              <div className="book-header bid-header">Bids</div>
              {bidOrders.length === 0 ? (
                <p className="empty-state">No bids are live.</p>
              ) : (
                bidOrders.map((order) => (
                  <div className="book-row" key={order.publicKey.toBase58()}>
                    <div>
                      <strong>{order.account.price.toString()}</strong>
                      <span>
                        {order.account.baseAmount
                          .sub(order.account.filledBaseAmount)
                          .toString()}{" "}
                        base
                      </span>
                    </div>
                    <small>{shortAddress(order.account.maker)}</small>
                  </div>
                ))
              )}
            </div>

            <div>
              <div className="book-header ask-header">Asks</div>
              {askOrders.length === 0 ? (
                <p className="empty-state">No asks are live.</p>
              ) : (
                askOrders.map((order) => (
                  <div className="book-row" key={order.publicKey.toBase58()}>
                    <div>
                      <strong>{order.account.price.toString()}</strong>
                      <span>
                        {order.account.baseAmount
                          .sub(order.account.filledBaseAmount)
                          .toString()}{" "}
                        base
                      </span>
                    </div>
                    <small>{shortAddress(order.account.maker)}</small>
                  </div>
                ))
              )}
            </div>
          </div>
        </article>

        <article className="panel crank-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Permissionless Crank</p>
              <h2>Execute Match</h2>
            </div>
            <Zap size={18} />
          </div>

          <p className="panel-copy">
            The crank scans the best bid and best ask. If prices cross, it submits
            <code> match_orders </code> and settles directly into the makers&apos; token
            accounts.
          </p>

          <button
            className="accent-button"
            disabled={loading || !market}
            onClick={() => void crankBestMatch()}
            type="button"
          >
            {loading ? "Cranking..." : "Run Crank Engine"}
          </button>

          <div className="architecture-card">
            <p className="eyebrow">Why Flat PDAs</p>
            <ul>
              <li>
                Each order is isolated, so parallel writes do not collide on one giant
                market account.
              </li>
              <li>
                Escrow lives in program-owned vaults instead of an off-chain matching
                server.
              </li>
              <li>
                Crankers only provide compute; they cannot redirect settlement anymore.
              </li>
            </ul>
          </div>
        </article>
      </section>

      <section className="status-panel">
        <p className="eyebrow">Status</p>
        <p>{status}</p>
        {txSignature ? (
          <a
            href={`https://explorer.solana.com/tx/${txSignature}?cluster=devnet`}
            rel="noreferrer"
            target="_blank"
          >
            View transaction <ExternalLink size={14} />
          </a>
        ) : null}
      </section>
    </div>
  );
}

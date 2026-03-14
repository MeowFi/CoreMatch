import type { Metadata } from "next";
import "./globals.css";
import WalletContextProvider from "./components/WalletProvider";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";

export const metadata: Metadata = {
  title: "CoreMatch | On-Chain Order Matching Engine",
  description:
    "Flat-PDA order book on Solana with escrow vaults, permissionless cranking, and a devnet UI.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <WalletContextProvider>{children}</WalletContextProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Smart Contract Error Monitor",
  description:
    "Monitor and analyze failed EVM transactions for any contracts you track—multi-chain, explorer + RPC replay and error decoding.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}

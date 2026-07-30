import type { Metadata } from "next";
import { cause } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI chatbot",
  description: "Streaming AI chat with news, LinkedIn and YouTube tools",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${cause.variable} h-full antialiased`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}

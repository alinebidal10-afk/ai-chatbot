import type { Metadata, Viewport } from "next";
import { cause } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI chatbot",
  description: "Streaming AI chat with news, LinkedIn and YouTube tools",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the layout extend under the home indicator on notched phones; the
  // docked bar pads itself with env(safe-area-inset-bottom) to clear it.
  viewportFit: "cover",
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

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
      <body className="min-h-full">
        {/* Alpha threshold for the mascot WebM: lossy VP9 alpha leaves a
            ~7% residual floor in the "transparent" area which reads as a
            pale rectangle. Maps alpha <=0.21 to 0 and >=0.46 to 1; the
            sRGB interpolation attribute is required or the numbers shift. */}
        <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
          <filter
            id="mascot-alpha"
            x="0"
            y="0"
            width="100%"
            height="100%"
            colorInterpolationFilters="sRGB"
          >
            <feComponentTransfer>
              <feFuncA type="linear" slope="4" intercept="-0.85" />
            </feComponentTransfer>
          </filter>
        </svg>
        {children}
      </body>
    </html>
  );
}

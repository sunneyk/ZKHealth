import type { Metadata } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { NavHeader } from "./components/NavHeader";

const geist = Geist({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono-body", display: "swap" });
const instrumentSerif = Instrument_Serif({
  weight: "400", style: ["normal", "italic"],
  subsets: ["latin"], variable: "--font-serif-body", display: "swap",
});

export const metadata: Metadata = {
  title: "ZKHealth — Private Health Proofs",
  description: "Upload your health data, chat with AI, and generate zero-knowledge proofs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem("zkhealth-theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}else if(window.matchMedia("(prefers-color-scheme:dark)").matches){document.documentElement.setAttribute("data-theme","dark")}}catch(e){}})()` }} />
      </head>
      <body className={`${geist.variable} ${geistMono.variable} ${instrumentSerif.variable}`} suppressHydrationWarning>
        <Providers>
          <NavHeader />
          <main className="max-w-2xl mx-auto px-4 py-8">
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}

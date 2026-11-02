import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
const geistSans=Geist({variable:"--font-geist-sans",subsets:["latin"]});
const geistMono=Geist_Mono({variable:"--font-geist-mono",subsets:["latin"]});
export const metadata:Metadata={title:{default:"SocialBucks — Creator workspace",template:"%s | SocialBucks"},description:"Manage creator campaigns, track engaged views, and follow performance-based earnings."};
export default function RootLayout({children}:LayoutProps<"/">){return <ClerkProvider><html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}><body className="min-h-full">{children}</body></html></ClerkProvider>}
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata = {
  title: 'FFmpeg Studio — Client-side Video & Image Converter',
  description:
    'Convert and compress videos, images and audio directly in your browser with FFmpeg WebAssembly. No uploads, no servers, 100% private.',
};

export const viewport = {
  themeColor: '#09090b',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}


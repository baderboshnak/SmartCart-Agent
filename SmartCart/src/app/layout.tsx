import type { Metadata, Viewport } from 'next';
import { Fraunces, Noto_Sans_Arabic, Noto_Sans_Hebrew, Plus_Jakarta_Sans } from 'next/font/google';
import { messages } from '@/lib/i18n/messages';
import { THEME_STORAGE_KEY } from '@/lib/client/theme';
import './globals.css';

const jakarta = Plus_Jakarta_Sans({ subsets: ['latin'], variable: '--font-jakarta', display: 'swap' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap', axes: ['opsz', 'SOFT'] });
// Catalog product names are Hebrew; customers also chat in Arabic. Browsers only
// download these files when the page shows those scripts.
const hebrew = Noto_Sans_Hebrew({ subsets: ['hebrew'], variable: '--font-hebrew', display: 'swap' });
const arabic = Noto_Sans_Arabic({ subsets: ['arabic'], variable: '--font-arabic', display: 'swap' });

export const metadata: Metadata = {
  title: 'SmartCart · Your grocery assistant',
  description: 'Tell SmartCart what you need. It compares real Shufersal and Rami Levy prices and builds the best complete basket.'
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbfaf5' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1714' }
  ]
};

// Applies a theme the visitor chose before the first paint, so the page never flashes.
const themeScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = messages.en;
  return (
    <html
      lang={locale.lang}
      dir={locale.dir}
      className={`${jakarta.variable} ${fraunces.variable} ${hebrew.variable} ${arabic.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

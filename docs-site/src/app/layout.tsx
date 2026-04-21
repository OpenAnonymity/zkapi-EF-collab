import type { Metadata } from 'next';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';

export const metadata: Metadata = {
  title: {
    default: 'zkAPI — Anonymous prepaid API credits',
    template: '%s — zkAPI',
  },
  description:
    'zkAPI lets users deposit funds on-chain once, then make many anonymous off-chain API requests. Post-quantum where practical, drop-in OpenAI proxy.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen font-sans">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}

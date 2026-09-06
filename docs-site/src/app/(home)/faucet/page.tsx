import type { Metadata } from 'next';
import { FaucetForm } from './faucet-form';

export const metadata: Metadata = {
  title: 'Sepolia faucet',
  description: 'Mint password-protected zkAPI test credits to a Sepolia wallet.',
};

export default function FaucetPage() {
  return (
    <main className="relative flex flex-1 overflow-hidden px-5 py-12 sm:px-8 sm:py-16">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_0%,color-mix(in_oklab,var(--color-fd-primary)_12%,transparent),transparent_42%)]" />
      <div className="mx-auto grid w-full max-w-5xl items-start gap-10 lg:grid-cols-[minmax(0,1fr)_28rem] lg:gap-16">
        <section className="pt-4 lg:pt-12">
          <div className="inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-xs text-fd-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
            Sepolia testnet
          </div>
          <h1 className="mt-6 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Get zkAPI test credits
          </h1>
          <p className="mt-5 max-w-xl text-pretty text-base leading-7 text-fd-muted-foreground sm:text-lg">
            Mint 5 ZKAPI to your wallet, then return to OA Chat and fund a private note with MetaMask.
          </p>

          <dl className="mt-10 grid max-w-xl grid-cols-2 gap-px overflow-hidden rounded-xl border border-fd-border bg-fd-border">
            <div className="bg-fd-card p-4 sm:p-5">
              <dt className="text-xs uppercase tracking-[0.16em] text-fd-muted-foreground">Amount</dt>
              <dd className="mt-2 text-lg font-medium">5 ZKAPI</dd>
            </div>
            <div className="bg-fd-card p-4 sm:p-5">
              <dt className="text-xs uppercase tracking-[0.16em] text-fd-muted-foreground">Network</dt>
              <dd className="mt-2 text-lg font-medium">Sepolia</dd>
            </div>
          </dl>

          <p className="mt-5 max-w-xl text-sm leading-6 text-fd-muted-foreground">
            Test tokens have no monetary value. The password and faucet signing key are handled only by the server and are never included in this page.
          </p>
        </section>

        <FaucetForm />
      </div>
    </main>
  );
}

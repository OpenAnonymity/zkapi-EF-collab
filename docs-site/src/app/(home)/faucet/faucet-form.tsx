'use client';

import { Check, Copy, ExternalLink, LoaderCircle, Wallet } from 'lucide-react';
import { FormEvent, useState } from 'react';

type EthereumProvider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

type FaucetSuccess = {
  amount: string;
  explorerUrl: string;
  recipient: string;
  txHash: string;
};

export function FaucetForm() {
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<FaucetSuccess | null>(null);
  const [copied, setCopied] = useState(false);

  const connectWallet = async () => {
    setError('');
    if (!window.ethereum) {
      setError('MetaMask was not found in this browser. You can paste a wallet address instead.');
      return;
    }
    setConnecting(true);
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      const first = Array.isArray(accounts) ? accounts[0] : null;
      if (typeof first !== 'string') throw new Error('MetaMask did not return an account.');
      setAddress(first);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect MetaMask.');
    } finally {
      setConnecting(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/faucet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: address.trim(), password }),
      });
      const payload = (await response.json()) as FaucetSuccess & { error?: string };
      if (!response.ok) throw new Error(payload.error || 'The faucet request failed.');
      setPassword('');
      setResult(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The faucet request failed.');
    } finally {
      setBusy(false);
    }
  };

  const copyTokenAddress = async () => {
    await navigator.clipboard.writeText('0x7773548bCb3Af5c4Ed1FCDBFE763855338C6822f');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="rounded-2xl border border-fd-border bg-fd-card p-5 shadow-2xl shadow-black/5 sm:p-7">
      <div>
        <h2 className="text-lg font-semibold">Mint to a wallet</h2>
        <p className="mt-1 text-sm text-fd-muted-foreground">Enter the shared faucet password to continue.</p>
      </div>

      <form className="mt-7 space-y-5" onSubmit={submit}>
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <label className="text-sm font-medium" htmlFor="faucet-address">Wallet address</label>
            <button
              className="inline-flex items-center gap-1.5 text-xs font-medium text-fd-primary hover:opacity-75 disabled:opacity-50"
              disabled={busy || connecting}
              onClick={connectWallet}
              type="button"
            >
              {connecting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Wallet className="size-3.5" />}
              Connect MetaMask
            </button>
          </div>
          <input
            autoCapitalize="none"
            autoComplete="off"
            className="h-12 w-full rounded-lg border border-fd-border bg-fd-background px-3 font-mono text-sm outline-none transition focus:border-fd-primary focus:ring-2 focus:ring-fd-primary/15"
            disabled={busy}
            id="faucet-address"
            onChange={(event) => setAddress(event.target.value)}
            placeholder="0x…"
            required
            spellCheck={false}
            value={address}
          />
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium" htmlFor="faucet-password">Faucet password</label>
          <input
            autoComplete="current-password"
            className="h-12 w-full rounded-lg border border-fd-border bg-fd-background px-3 text-sm outline-none transition focus:border-fd-primary focus:ring-2 focus:ring-fd-primary/15"
            disabled={busy}
            id="faucet-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter password"
            required
            type="password"
            value={password}
          />
        </div>

        <button
          className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-fd-primary px-4 text-sm font-semibold text-fd-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-55"
          disabled={busy || !address.trim() || !password}
          type="submit"
        >
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          {busy ? 'Minting on Sepolia…' : 'Mint 5 ZKAPI'}
        </button>
      </form>

      {error && (
        <div aria-live="polite" className="mt-5 rounded-lg border border-red-500/25 bg-red-500/8 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {result && (
        <div aria-live="polite" className="mt-5 rounded-lg border border-emerald-500/25 bg-emerald-500/8 p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-emerald-500 text-white">
              <Check className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold">5 ZKAPI minted</p>
              <p className="mt-1 text-xs leading-5 text-fd-muted-foreground">The transaction is confirmed on Sepolia.</p>
              <a className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-fd-primary hover:underline" href={result.explorerUrl} rel="noreferrer" target="_blank">
                View transaction <ExternalLink className="size-3" />
              </a>
            </div>
          </div>
        </div>
      )}

      <div className="mt-7 border-t border-fd-border pt-5">
        <p className="text-xs text-fd-muted-foreground">ZKAPI token contract</p>
        <button className="mt-1 flex max-w-full items-center gap-2 font-mono text-xs text-fd-foreground hover:text-fd-primary" onClick={copyTokenAddress} type="button">
          <span className="truncate">0x7773548bCb3Af5c4Ed1FCDBFE763855338C6822f</span>
          {copied ? <Check className="size-3.5 shrink-0" /> : <Copy className="size-3.5 shrink-0" />}
        </button>
      </div>
    </section>
  );
}

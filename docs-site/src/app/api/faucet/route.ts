import { NextResponse } from 'next/server';
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  FAUCET_AMOUNT_BASE_UNITS,
  FAUCET_AMOUNT_DISPLAY,
  parseFaucetPrivateKey,
  parseFaucetRequest,
  passwordsMatch,
  SEPOLIA_CHAIN_ID,
  ZKAPI_TOKEN_ADDRESS,
} from '@/lib/faucet-core.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BODY_BYTES = 2_048;
const mintAbi = [
  {
    type: 'function',
    name: 'mint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

let mintQueue: Promise<unknown> = Promise.resolve();

function json(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
    },
  });
}

function enqueueMint<T>(operation: () => Promise<T>): Promise<T> {
  const result = mintQueue.then(operation, operation);
  mintQueue = result.catch(() => undefined);
  return result;
}

async function mintTo(recipient: `0x${string}`) {
  const privateKey = parseFaucetPrivateKey(process.env.ZKAPI_FAUCET_PRIVATE_KEY) as Hex;
  const account = privateKeyToAccount(privateKey);
  const transport = http(process.env.ZKAPI_SEPOLIA_RPC_URL || undefined, {
    timeout: 20_000,
    retryCount: 2,
  });
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ account, chain: sepolia, transport });

  const rpcChainId = await publicClient.getChainId();
  if (rpcChainId !== SEPOLIA_CHAIN_ID) throw new Error('The faucet RPC is not connected to Sepolia.');

  const hash = await walletClient.writeContract({
    address: ZKAPI_TOKEN_ADDRESS,
    abi: mintAbi,
    functionName: 'mint',
    args: [recipient, FAUCET_AMOUNT_BASE_UNITS],
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: 1,
    timeout: 120_000,
  });
  if (receipt.status !== 'success') throw new Error('The Sepolia mint transaction reverted.');
  return hash;
}

export async function POST(request: Request) {
  const configuredPassword = process.env.ZKAPI_FAUCET_PASSWORD;
  if (!configuredPassword || !process.env.ZKAPI_FAUCET_PRIVATE_KEY) {
    return json({ error: 'The faucet is not configured yet.' }, 503);
  }

  const declaredLength = Number(request.headers.get('content-length') || '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: 'The faucet request is too large.' }, 413);
  }

  try {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
      return json({ error: 'The faucet request is too large.' }, 413);
    }
    const { address, password } = parseFaucetRequest(JSON.parse(rawBody));
    if (!passwordsMatch(password, configuredPassword)) {
      return json({ error: 'The faucet password is incorrect.' }, 401);
    }

    const recipient = getAddress(address);
    const txHash = await enqueueMint(() => mintTo(recipient));
    return json({
      amount: FAUCET_AMOUNT_DISPLAY,
      recipient,
      txHash,
      explorerUrl: `https://sepolia.etherscan.io/tx/${txHash}`,
    });
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      return json({ error: 'The faucet request was not valid JSON.' }, 400);
    }
    if (cause instanceof Error && /wallet address|faucet password/.test(cause.message)) {
      return json({ error: cause.message }, 400);
    }
    console.error('Sepolia faucet mint failed:', cause instanceof Error ? cause.message : cause);
    return json({ error: 'The Sepolia mint failed. Please try again.' }, 502);
  }
}

export async function GET() {
  return json({ error: 'Use POST to request test tokens.' }, 405);
}

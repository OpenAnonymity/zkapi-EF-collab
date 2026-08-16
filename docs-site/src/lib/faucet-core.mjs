import { createHash, timingSafeEqual } from 'node:crypto';

export const FAUCET_AMOUNT_BASE_UNITS = 5_000_000n;
export const FAUCET_AMOUNT_DISPLAY = '5 ZKAPI';
export const SEPOLIA_CHAIN_ID = 11_155_111;
export const ZKAPI_TOKEN_ADDRESS = '0x7773548bCb3Af5c4Ed1FCDBFE763855338C6822f';

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function passwordsMatch(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(digest(provided), digest(expected));
}

export function parseFaucetRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Enter a wallet address and faucet password.');
  }
  const address = typeof value.address === 'string' ? value.address.trim() : '';
  const password = typeof value.password === 'string' ? value.password : '';
  if (!ADDRESS_PATTERN.test(address)) throw new Error('Enter a valid Ethereum wallet address.');
  if (!password || password.length > 256) throw new Error('Enter a valid faucet password.');
  return { address, password };
}

export function parseFaucetPrivateKey(value) {
  if (!PRIVATE_KEY_PATTERN.test(value || '')) {
    throw new Error('ZKAPI_FAUCET_PRIVATE_KEY is not configured correctly.');
  }
  return value;
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FAUCET_AMOUNT_BASE_UNITS,
  parseFaucetPrivateKey,
  parseFaucetRequest,
  passwordsMatch,
  SEPOLIA_CHAIN_ID,
  ZKAPI_TOKEN_ADDRESS,
} from '../src/lib/faucet-core.mjs';

test('faucet constants pin the Sepolia deployment and five-token amount', () => {
  assert.equal(SEPOLIA_CHAIN_ID, 11_155_111);
  assert.equal(FAUCET_AMOUNT_BASE_UNITS, 5_000_000n);
  assert.equal(ZKAPI_TOKEN_ADDRESS, '0x7773548bCb3Af5c4Ed1FCDBFE763855338C6822f');
});

test('password comparison accepts only the exact configured secret', () => {
  assert.equal(passwordsMatch('correct horse', 'correct horse'), true);
  assert.equal(passwordsMatch('Correct horse', 'correct horse'), false);
  assert.equal(passwordsMatch('', 'correct horse'), false);
  assert.equal(passwordsMatch('correct horse', ''), false);
});

test('faucet request validation normalizes an address and preserves password bytes', () => {
  assert.deepEqual(
    parseFaucetRequest({
      address: '  0x1111111111111111111111111111111111111111  ',
      password: ' secret ',
    }),
    {
      address: '0x1111111111111111111111111111111111111111',
      password: ' secret ',
    },
  );
});

test('faucet request rejects invalid input', () => {
  assert.throws(() => parseFaucetRequest(null), /wallet address/);
  assert.throws(() => parseFaucetRequest({ address: '0x1234', password: 'secret' }), /valid Ethereum/);
  assert.throws(
    () => parseFaucetRequest({ address: '0x1111111111111111111111111111111111111111', password: '' }),
    /valid faucet password/,
  );
});

test('private-key validation accepts one EVM key and rejects malformed values', () => {
  const key = `0x${'12'.repeat(32)}`;
  assert.equal(parseFaucetPrivateKey(key), key);
  assert.throws(() => parseFaucetPrivateKey('0x1234'), /not configured correctly/);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const wallet = require("./wallet.js");

test("credit amounts round-trip at six decimals", () => {
  assert.equal(wallet.parseTokenAmount("0.10"), 100_000n);
  assert.equal(wallet.parseTokenAmount("2.000001"), 2_000_001n);
  assert.equal(wallet.formatTokenAmount(2_000_001n), "2.000001");
  assert.throws(() => wallet.parseTokenAmount("0.0000001"));
});

test("escape-period labels follow the deployed vault duration", () => {
  assert.equal(wallet.ABI.challengePeriod, "f3f480d9");
  assert.equal(wallet.ABI.legacyChallengePeriod, "c3a079ed");
  assert.equal(wallet.escapePeriodLabel(60), "1-minute");
  assert.equal(wallet.escapePeriodPhrase(60), "1 minute");
  assert.equal(wallet.escapePeriodBadge(60), "1m");
  assert.equal(wallet.escapePeriodPhrase(86_400), "1 day");
  assert.equal(wallet.escapePeriodPhrase(172_800), "2 days");
  assert.equal(wallet.escapePeriodBadge(30), "30s");
});

test("deposit calldata uses the deployed vault signature and 32 static siblings", () => {
  const plan = {
    commitment: "0x2a",
    zero_path: Array.from({ length: 32 }, (_, index) => `0x${(index + 1).toString(16)}`),
  };
  const encoded = wallet.encodeDeposit(plan, 100_000n);
  assert.ok(encoded.startsWith("0xc588341c"));
  assert.equal(encoded.length, 2 + 8 + (34 * 64));
  assert.equal(encoded.slice(10, 74), wallet.abiWord("0x2a"));
  assert.equal(encoded.slice(74, 138), wallet.abiWord(100_000n));
});

test("NoteDeposited receipt parsing returns canonical note id and expiry", () => {
  const vault = "0x590df9abbfb21074016daa486c771ae0af729ee2";
  const receipt = {
    logs: [{
      address: vault.toUpperCase().replace("0X", "0x"),
      topics: [wallet.ABI.noteDeposited, `0x${wallet.abiWord(21n)}`, `0x${wallet.abiWord(42n)}`],
      data: `0x${wallet.abiWord(100_000n)}${wallet.abiWord(1_800_000_000n)}${wallet.abiWord(99n)}`,
    }],
  };
  assert.deepEqual(wallet.parseNoteDeposited(receipt, vault), {
    noteId: 21n,
    commitment: `0x${wallet.abiWord(42n)}`,
    amount: 100_000n,
    expiryTs: 1_800_000_000n,
    newRoot: 99n,
  });
});

function withdrawalPlan(mode = "mutual") {
  return {
    mode,
    public_inputs: {
      protocol_version: 1,
      chain_id: 11_155_111,
      contract_address: "0x590df9abbfb21074016daa486c771ae0af729ee2",
      active_root: "0x11",
      state_signing_key_x: "0x12",
      state_signing_key_y: "0x13",
      clearance_signing_key_x: "0x14",
      clearance_signing_key_y: "0x15",
      note_id: 21,
      final_balance: 1_850_000,
      destination: Array(20).fill(0x22),
      withdrawal_nullifier: "0x16",
      has_clearance: mode === "mutual",
      withdrawal_tag: "0x17",
    },
    siblings: Array.from({ length: 32 }, (_, index) => `0x${(index + 1).toString(16)}`),
    proof: {
      backend: "groth16_bn254",
      proof: Buffer.from(Array.from({ length: 256 }, (_, index) => index)).toString("base64"),
    },
  };
}

test("mutual-close calldata encodes the exact static tuple, dynamic proof, and path", () => {
  const plan = withdrawalPlan("mutual");
  const destination = "0x2222222222222222222222222222222222222222";
  const encoded = wallet.encodeWithdrawal(plan, "mutual", destination, plan.public_inputs.contract_address);
  assert.ok(encoded.startsWith(`0x${wallet.ABI.mutualClose}`));
  assert.equal(encoded.length, 2 + 8 + (56 * 64));
  assert.equal(encoded.slice(10 + (14 * 64), 10 + (15 * 64)), wallet.abiWord(1_504n));
  assert.equal(encoded.slice(10 + (47 * 64), 10 + (48 * 64)), wallet.abiWord(256n));
  assert.equal(encoded.slice(-64), Buffer.from(Array.from({ length: 32 }, (_, index) => index + 224)).toString("hex"));
});

test("escape calldata and finalization selector use deployed signatures", () => {
  const plan = withdrawalPlan("escape");
  const destination = "0x2222222222222222222222222222222222222222";
  assert.ok(wallet.encodeWithdrawal(plan, "escape", destination).startsWith(`0x${wallet.ABI.initiateEscapeWithdrawal}`));
  assert.equal(wallet.encodeFinalizeEscape(21), `0x${wallet.ABI.finalizeEscapeWithdrawal}${wallet.abiWord(21)}`);
});

test("withdrawal encoder rejects destination and clearance substitutions", () => {
  const plan = withdrawalPlan("mutual");
  assert.throws(() => wallet.encodeWithdrawal(plan, "mutual", "0x3333333333333333333333333333333333333333"), /destination/);
  plan.public_inputs.has_clearance = false;
  assert.throws(() => wallet.encodeWithdrawal(plan, "mutual", "0x2222222222222222222222222222222222222222"), /clearance/);
});

test("withdrawal events expose note, destination, balance, and escape deadline", () => {
  const vault = "0x590df9abbfb21074016daa486c771ae0af729ee2";
  const receipt = {
    logs: [{
      address: vault,
      topics: [wallet.ABI.escapeInitiatedEvent, `0x${wallet.abiWord(21n)}`],
      data: `0x${wallet.abiWord(99n)}${wallet.abiWord(1_850_000n)}${wallet.addressWord("0x2222222222222222222222222222222222222222")}${wallet.abiWord(1_900_000_000n)}${wallet.abiWord(101n)}`,
    }],
  };
  assert.deepEqual(wallet.parseWithdrawalReceipt(receipt, vault, "escape"), {
    noteId: 21n,
    finalBalance: 1_850_000n,
    destination: "0x2222222222222222222222222222222222222222",
    challengeDeadline: 1_900_000_000n,
  });
});

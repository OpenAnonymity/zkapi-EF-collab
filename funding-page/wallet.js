(function exposeWalletCodec(root, factory) {
  const codec = factory();
  if (typeof module === "object" && module.exports) module.exports = codec;
  else root.zkapiWallet = codec;
}(typeof globalThis === "object" ? globalThis : this, function createWalletCodec() {
  "use strict";

  const ABI = Object.freeze({
    balanceOf: "70a08231",
    allowance: "dd62ed3e",
    approve: "095ea7b3",
    mint: "40c10f19",
    deposit: "c588341c",
    mutualClose: "7fca9c82",
    initiateEscapeWithdrawal: "9073639b",
    finalizeEscapeWithdrawal: "ff8f5585",
    challengePeriod: "f3f480d9",
    legacyChallengePeriod: "c3a079ed",
    currentRoot: "fdab463d",
    noteDeposited: "0x7c83dba8534bea9e30d6444f9ca6462dc906897f9938d220dbbe4358c1f7a063",
    mutualCloseEvent: "0x1f43fa4711ca18e1d26398f26bf598bd3a62992cdd0e84f055f2bb506e9d7031",
    escapeInitiatedEvent: "0xb0d1eb7131bcf3c6dd53517f6fa90bf7cc94178eb0eb5e0a1f204abe3b839cdf",
    escapeFinalizedEvent: "0x163f2e46c4004f0ed9682e2db8c84efac31310720266b17ea9904ba348c26504",
  });

  function abiWord(value) {
    const hex = typeof value === "string" ? value.replace(/^0x/, "") : BigInt(value).toString(16);
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length > 64) {
      throw new Error("Value cannot be encoded for the vault contract.");
    }
    return hex.padStart(64, "0");
  }

  function addressWord(address) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) {
      throw new Error("MetaMask returned an invalid account address.");
    }
    return abiWord(address);
  }

  function callData(selector, words) {
    return `0x${selector}${words.join("")}`;
  }

  function toBytes32(felt) {
    return `0x${String(felt).replace(/^0x/, "").padStart(64, "0")}`;
  }

  function parseTokenAmount(value) {
    const match = String(value).trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
    if (!match) throw new Error("Enter a positive amount with no more than six decimal places.");
    return BigInt(match[1]) * 1_000_000n + BigInt((match[2] || "").padEnd(6, "0") || "0");
  }

  function formatTokenAmount(value) {
    const whole = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : String(whole);
  }

  function normalizedEscapePeriod(seconds) {
    return Math.max(1, Number(seconds) || 24 * 60 * 60);
  }

  function escapePeriodLabel(seconds) {
    const value = normalizedEscapePeriod(seconds);
    if (value % 86_400 === 0) return `${value / 86_400}-day`;
    if (value % 3_600 === 0) return `${value / 3_600}-hour`;
    if (value % 60 === 0) return `${value / 60}-minute`;
    return `${value}-second`;
  }

  function escapePeriodPhrase(seconds) {
    const value = normalizedEscapePeriod(seconds);
    if (value % 86_400 === 0) {
      const days = value / 86_400;
      return `${days} ${days === 1 ? "day" : "days"}`;
    }
    if (value % 3_600 === 0) {
      const hours = value / 3_600;
      return `${hours} ${hours === 1 ? "hour" : "hours"}`;
    }
    if (value % 60 === 0) {
      const minutes = value / 60;
      return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
    }
    return `${value} ${value === 1 ? "second" : "seconds"}`;
  }

  function escapePeriodBadge(seconds) {
    const value = normalizedEscapePeriod(seconds);
    if (value >= 3_600) return `${Math.round(value / 3_600)}h`;
    if (value >= 60) return `${Math.round(value / 60)}m`;
    return `${value}s`;
  }

  function encodeDeposit(plan, amount) {
    if (!Array.isArray(plan?.zero_path) || plan.zero_path.length !== 32) {
      throw new Error("The daemon returned an invalid 32-level deposit path.");
    }
    return callData(ABI.deposit, [
      abiWord(toBytes32(plan.commitment)),
      abiWord(amount),
      ...plan.zero_path.map((value) => abiWord(value)),
    ]);
  }

  function decodeBase64(value) {
    if (typeof value !== "string" || !value) throw new Error("The daemon returned an empty withdrawal proof.");
    try {
      if (typeof atob === "function") {
        const decoded = atob(value);
        return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
      }
      if (typeof Buffer === "function") return Uint8Array.from(Buffer.from(value, "base64"));
    } catch (_) {
      throw new Error("The daemon returned malformed base64 proof data.");
    }
    throw new Error("This browser cannot decode the withdrawal proof.");
  }

  function bytesHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function destinationHex(value) {
    if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
    if (!Array.isArray(value) || value.length !== 20
        || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new Error("The daemon returned an invalid withdrawal destination.");
    }
    return `0x${bytesHex(value)}`;
  }

  function encodeWithdrawal(plan, expectedMode, expectedDestination, expectedVault) {
    const mode = String(expectedMode || "").toLowerCase();
    if (!['mutual', 'escape'].includes(mode) || plan?.mode !== mode) {
      throw new Error("The daemon returned a different withdrawal mode than requested.");
    }
    if (plan?.proof?.backend !== "groth16_bn254") {
      throw new Error("The daemon returned an unsupported withdrawal proof backend.");
    }
    if (!Array.isArray(plan.siblings) || plan.siblings.length !== 32) {
      throw new Error("The daemon returned an invalid 32-level withdrawal path.");
    }
    const inputs = plan.public_inputs || {};
    const destination = destinationHex(inputs.destination);
    if (destination !== String(expectedDestination || "").toLowerCase()) {
      throw new Error("The proof destination does not match the connected MetaMask account.");
    }
    if (expectedVault && String(inputs.contract_address).toLowerCase() !== String(expectedVault).toLowerCase()) {
      throw new Error("The withdrawal proof is bound to a different vault contract.");
    }
    if (Boolean(inputs.has_clearance) !== (mode === "mutual")) {
      throw new Error("The withdrawal proof has the wrong server-clearance state.");
    }
    const proof = decodeBase64(plan.proof.proof);
    if (proof.length !== 256) {
      throw new Error("The Groth16 withdrawal proof must contain exactly 256 bytes.");
    }

    const tuple = [
      inputs.protocol_version,
      inputs.chain_id,
      inputs.contract_address,
      inputs.active_root,
      inputs.state_signing_key_x,
      inputs.state_signing_key_y,
      inputs.clearance_signing_key_x,
      inputs.clearance_signing_key_y,
      inputs.note_id,
      inputs.final_balance,
      destination,
      inputs.withdrawal_nullifier,
      inputs.has_clearance ? 1 : 0,
      inputs.withdrawal_tag,
    ].map(abiWord);
    // The static tuple occupies 14 words, followed by the bytes offset and
    // the 32-word Merkle path. The dynamic proof therefore starts at word 47.
    const head = [...tuple, abiWord(47n * 32n), ...plan.siblings.map(abiWord)];
    const tail = [abiWord(proof.length), ...Array.from({ length: 8 }, (_, index) => (
      bytesHex(proof.slice(index * 32, (index + 1) * 32))
    ))];
    const selector = mode === "mutual" ? ABI.mutualClose : ABI.initiateEscapeWithdrawal;
    return callData(selector, [...head, ...tail]);
  }

  function encodeFinalizeEscape(noteId) {
    return callData(ABI.finalizeEscapeWithdrawal, [abiWord(noteId)]);
  }

  function parseWithdrawalReceipt(receipt, vaultAddress, mode) {
    const expectedTopic = mode === "mutual" ? ABI.mutualCloseEvent
      : mode === "escape" ? ABI.escapeInitiatedEvent
        : mode === "finalize" ? ABI.escapeFinalizedEvent : null;
    if (!expectedTopic) throw new Error("Unknown withdrawal receipt mode.");
    for (const log of receipt?.logs || []) {
      if (log.address?.toLowerCase() !== vaultAddress.toLowerCase()
          || log.topics?.[0]?.toLowerCase() !== expectedTopic) continue;
      const data = String(log.data || "").replace(/^0x/, "");
      const minimumWords = mode === "escape" ? 5 : 3;
      if (log.topics.length < 2 || data.length < minimumWords * 64) continue;
      const result = {
        noteId: BigInt(log.topics[1]),
        finalBalance: BigInt(`0x${data.slice(64, 128)}`),
        destination: `0x${data.slice(128 + 24, 192)}`.toLowerCase(),
      };
      if (mode === "escape") {
        result.challengeDeadline = BigInt(`0x${data.slice(192, 256)}`);
      }
      return result;
    }
    return null;
  }

  function parseNoteDeposited(receipt, vaultAddress) {
    for (const log of receipt?.logs || []) {
      if (log.address?.toLowerCase() !== vaultAddress.toLowerCase()
          || log.topics?.[0]?.toLowerCase() !== ABI.noteDeposited) continue;
      const data = String(log.data || "").replace(/^0x/, "");
      if (log.topics.length >= 3 && data.length >= 192) {
        return {
          noteId: BigInt(log.topics[1]),
          commitment: log.topics[2],
          amount: BigInt(`0x${data.slice(0, 64)}`),
          expiryTs: BigInt(`0x${data.slice(64, 128)}`),
          newRoot: BigInt(`0x${data.slice(128, 192)}`),
        };
      }
    }
    return null;
  }

  return Object.freeze({
    ABI,
    abiWord,
    addressWord,
    callData,
    encodeDeposit,
    encodeFinalizeEscape,
    encodeWithdrawal,
    escapePeriodBadge,
    escapePeriodLabel,
    escapePeriodPhrase,
    formatTokenAmount,
    parseNoteDeposited,
    parseTokenAmount,
    parseWithdrawalReceipt,
  });
}));

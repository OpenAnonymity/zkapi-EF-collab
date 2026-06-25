const state = {
  overview: null,
  prepare: null,
  preview: null,
  execution: null,
};

const $ = (id) => document.getElementById(id);

const els = {
  // health
  hAuth: $("h-auth"),
  hIndexer: $("h-indexer"),
  hServer: $("h-server"),
  // balance card
  balance: $("balance"),
  balanceAmount: $("balance-amount"),
  balanceUnit: $("balance-unit"),
  balanceMeta: $("balance-meta"),
  balanceNoteId: $("balance-note-id"),
  balanceDeposit: $("balance-deposit"),
  balanceExpiry: $("balance-expiry"),
  // steps
  stepFund: $("step-fund"),
  stepRequest: $("step-request"),
  // prepare
  prepareResult: $("prepare-result"),
  prepSecret: $("prep-secret"),
  prepCommitment: $("prep-commitment"),
  prepNoteId: $("prep-note-id"),
  prepRoot: $("prep-root"),
  castCommands: $("cast-commands"),
  // confirm
  secret: $("secret"),
  noteId: $("note-id"),
  confirmAmount: $("confirm-amount"),
  expiryTs: $("expiry-ts"),
  confirmError: $("confirm-error"),
  metamaskDeposit: $("metamask-deposit"),
  depositStatus: $("deposit-status"),
  metamaskWithdraw: $("metamask-withdraw"),
  withdrawStatus: $("withdraw-status"),
  // chain helpers
  rpcUrl: $("rpc-url"),
  tokenAddress: $("token-address"),
  privateKey: $("private-key"),
  noteTtl: $("note-ttl"),
  // request
  endpointKind: $("endpoint-kind"),
  modelInput: $("model-input"),
  promptInput: $("prompt-input"),
  rawFields: $("raw-fields"),
  rawMethod: $("raw-method"),
  rawPath: $("raw-path"),
  rawBody: $("raw-body"),
  requestResult: $("request-result"),
  // trace
  tracePayloadHash: $("trace-payload-hash"),
  traceNullifier: $("trace-nullifier"),
  traceLeaf: $("trace-leaf"),
  traceSolvency: $("trace-solvency"),
  traceRoot: $("trace-root"),
  traceNextAnchor: $("trace-next-anchor"),
  traceCharge: $("trace-charge"),
  traceXmss: $("trace-xmss"),
  protocolOutput: $("protocol-output"),
  // service details
  svcAuth: $("svc-auth"),
  svcIndexer: $("svc-indexer"),
  svcServer: $("svc-server"),
  svcProof: $("svc-proof"),
  attestationOutput: $("attestation-output"),
};

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function truncate(value, size = 10) {
  if (value == null) return "-";
  if (typeof value !== "string") value = String(value);
  if (value.length <= size * 2 + 3) return value;
  return `${value.slice(0, size)}…${value.slice(-size)}`;
}

function formatExpiry(ts) {
  if (!ts) return "-";
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return String(ts);
  const now = Date.now();
  const diffDays = Math.floor((d.getTime() - now) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "expired";
  if (diffDays < 1) return "today";
  if (diffDays < 30) return `${diffDays}d`;
  return `${Math.floor(diffDays / 30)}mo`;
}

function setHealth(el, online, label) {
  el.classList.remove("online", "offline");
  el.classList.add(online ? "online" : "offline");
  el.textContent = ` ${label || el.textContent.trim()}`;
  // Preserve the dot element order (dot::before is injected by CSS)
  el.title = online ? "online" : "offline";
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(payload.error?.message || response.statusText);
  }
  return payload;
}

function hydrateHelpers() {
  els.rpcUrl.value = localStorage.getItem("zkapi_rpc_url") || "";
  els.tokenAddress.value = localStorage.getItem("zkapi_token_address") || "";
  els.privateKey.value = localStorage.getItem("zkapi_private_key") || "";
  els.noteTtl.value = localStorage.getItem("zkapi_note_ttl") || "2592000";
}

function rememberHelpers() {
  localStorage.setItem("zkapi_rpc_url", els.rpcUrl.value.trim());
  localStorage.setItem("zkapi_token_address", els.tokenAddress.value.trim());
  localStorage.setItem("zkapi_private_key", els.privateKey.value.trim());
  localStorage.setItem("zkapi_note_ttl", els.noteTtl.value.trim());
}

function applyDemoDefaults(funding) {
  if (!funding) return;
  if (!els.rpcUrl.value.trim() && funding.demo_rpc_url) els.rpcUrl.value = funding.demo_rpc_url;
  if (!els.tokenAddress.value.trim() && funding.demo_billing_token_address) els.tokenAddress.value = funding.demo_billing_token_address;
  if (!els.privateKey.value.trim() && funding.demo_private_key) els.privateKey.value = funding.demo_private_key;
  if ((!els.noteTtl.value.trim() || els.noteTtl.value.trim() === "2592000") && funding.demo_note_ttl_seconds) {
    els.noteTtl.value = String(funding.demo_note_ttl_seconds);
  }
}

function renderCommands() {
  if (!state.prepare || !state.overview) {
    els.castCommands.textContent = "—";
    return;
  }
  const rpcUrl = els.rpcUrl.value.trim() || "<rpc-url>";
  const token = els.tokenAddress.value.trim() || "<billing-token>";
  const privateKey = els.privateKey.value.trim() || "<private-key>";
  const noteTtl = els.noteTtl.value.trim() || "<note-ttl-seconds>";
  const vault = state.overview.funding.contract_address;
  const amount = state.prepare.amount;
  const zeroPath = `[${state.prepare.zero_path.join(",")}]`;
  const commitmentBytes32 = `$(printf '0x%064s\\n' "${state.prepare.commitment.slice(2)}" | tr ' ' '0')`;

  els.castCommands.textContent = [
    `# 1. Approve the vault`,
    `cast send ${token} "approve(address,uint256)" \\`,
    `  ${vault} ${amount} \\`,
    `  --rpc-url ${rpcUrl} --private-key ${privateKey}`,
    ``,
    `# 2. Deposit (returns tx hash; read NoteDeposited event for expiry)`,
    `cast send ${vault} "deposit(bytes32,uint128,uint256[32])" \\`,
    `  ${commitmentBytes32} ${amount} '${zeroPath}' \\`,
    `  --rpc-url ${rpcUrl} --private-key ${privateKey}`,
    ``,
    `# 3. Read the expiry timestamp`,
    `cast block latest --field timestamp --rpc-url ${rpcUrl} \\`,
    `  | awk -v ttl=${noteTtl} '{print $1 + ttl}'`,
  ].join("\n");
}

function renderBalance() {
  const note = state.overview?.wallet?.note;
  if (!note) {
    els.balance.classList.add("empty");
    els.balanceAmount.textContent = "No active note";
    els.balanceUnit.classList.add("hidden");
    els.balanceMeta.classList.add("hidden");
    els.stepFund.classList.remove("hidden");
    els.stepRequest.classList.add("hidden");
    return;
  }
  els.balance.classList.remove("empty");
  els.balanceAmount.textContent = note.current_balance.toLocaleString();
  els.balanceUnit.classList.remove("hidden");
  els.balanceMeta.classList.remove("hidden");
  els.balanceNoteId.textContent = `#${note.note_id}`;
  els.balanceDeposit.textContent = note.deposit_amount.toLocaleString();
  els.balanceExpiry.textContent = formatExpiry(note.expiry_ts);
  els.stepFund.classList.add("hidden");
  els.stepRequest.classList.remove("hidden");
}

function renderHealth() {
  const o = state.overview;
  if (!o) return;
  setHealth(els.hAuth, true, "auth");
  setHealth(els.hIndexer, Boolean(o.indexer?.available), "indexer");
  setHealth(els.hServer, Boolean(o.server?.available && o.server?.health), "server");

  els.svcAuth.textContent = `${window.location.origin}/funding`;
  els.svcIndexer.textContent = o.funding?.indexer_url || "-";
  els.svcServer.textContent = o.funding?.protocol_server_url || "-";
  els.svcProof.textContent = o.runtime_proof_backend || "-";
  els.attestationOutput.textContent = o.server?.attestation ? pretty(o.server.attestation) : pretty(o.server || {});
}

function renderPrepare() {
  if (!state.prepare) return;
  els.prepareResult.classList.remove("hidden");
  els.prepSecret.textContent = truncate(state.prepare.secret);
  els.prepCommitment.textContent = truncate(state.prepare.commitment);
  els.prepNoteId.textContent = String(state.prepare.next_note_id);
  els.prepRoot.textContent = truncate(state.prepare.active_root);

  // Populate hidden confirm fields
  els.secret.value = state.prepare.secret;
  els.noteId.value = state.prepare.next_note_id;
  els.confirmAmount.value = state.prepare.amount;

  renderCommands();
}

function renderPreview() {
  if (!state.preview) return;
  const p = state.preview;
  els.tracePayloadHash.textContent = truncate(p.payload_hash);
  els.traceNullifier.textContent = truncate(p.request_nullifier);
  els.traceLeaf.textContent = truncate(p.note_leaf);
  els.traceSolvency.textContent = String(p.solvency_bound);
  els.traceRoot.textContent = truncate(p.active_root);
  els.protocolOutput.textContent = pretty(p);
  // Open the trace drawer so the user sees the result of their preview click
  $("request-trace-details").open = true;
}

function renderExecution() {
  if (!state.execution) return;
  const e = state.execution;
  const resp = e.response;

  // Extract the human text for the response card
  let content = "";
  if (resp) {
    if (resp.choices?.[0]?.message?.content) content = resp.choices[0].message.content;
    else if (resp.output?.[0]?.content?.[0]?.text) content = resp.output[0].content[0].text;
    else if (resp.message?.content) content = resp.message.content;
    else content = pretty(resp);
  }

  const charge = e.protocol_response?.charge_applied;
  const nextAnchor = e.protocol_response?.next_anchor;
  const xmssEpoch = e.protocol_response?.next_state_sig_epoch;

  els.requestResult.classList.remove("empty");
  els.requestResult.innerHTML = `
    <div style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(content)}</div>
    <div class="response-meta">
      <span>charge <strong>${charge ?? "—"}</strong></span>
      <span>next anchor <strong>${truncate(nextAnchor, 6)}</strong></span>
      <span>xmss epoch <strong>${xmssEpoch ?? "—"}</strong></span>
    </div>
  `;

  els.traceCharge.textContent = charge != null ? String(charge) : "-";
  els.traceNextAnchor.textContent = truncate(nextAnchor);
  els.traceXmss.textContent = xmssEpoch != null ? String(xmssEpoch) : "-";
  if (e.protocol_response) {
    els.protocolOutput.textContent = pretty(e.protocol_response);
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildRequestDraft() {
  const kind = els.endpointKind.value;
  const model = els.modelInput.value.trim() || "zkapi-echo";
  const prompt = els.promptInput.value.trim();

  if (kind === "chat") {
    return {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {},
      body: { model, messages: [{ role: "user", content: prompt }] },
    };
  }
  if (kind === "responses") {
    return {
      method: "POST",
      path: "/v1/responses",
      headers: {},
      body: { model, input: prompt },
    };
  }
  if (kind === "ollama") {
    return {
      method: "POST",
      path: "/api/chat",
      headers: {},
      body: { model, messages: [{ role: "user", content: prompt }] },
    };
  }
  let rawBody = {};
  try {
    rawBody = JSON.parse(els.rawBody.value);
  } catch (error) {
    throw new Error(`raw body is not valid JSON: ${error.message}`);
  }
  return {
    method: els.rawMethod.value.trim() || "POST",
    path: els.rawPath.value.trim() || "/v1/chat/completions",
    headers: {},
    body: rawBody,
  };
}

async function refreshOverview() {
  try {
    state.overview = await requestJson("/funding/api/demo");
    applyDemoDefaults(state.overview.funding);
    renderHealth();
    renderBalance();
    renderCommands();
  } catch (error) {
    setHealth(els.hAuth, false, "auth");
  }
}

async function handlePrepare(event) {
  event.preventDefault();
  rememberHelpers();
  const amount = Number($("deposit-amount").value);
  try {
    state.prepare = await requestJson("/funding/api/deposit/prepare", {
      method: "POST",
      body: JSON.stringify({ amount }),
    });
    renderPrepare();
  } catch (error) {
    alert(`Prepare failed: ${error.message}`);
  }
}

async function handleConfirm(event) {
  event.preventDefault();
  els.confirmError.classList.add("hidden");
  const body = {
    secret: els.secret.value.trim(),
    note_id: Number(els.noteId.value),
    amount: Number(els.confirmAmount.value),
    expiry_ts: Number(els.expiryTs.value),
  };
  try {
    await requestJson("/funding/api/deposit/confirm", {
      method: "POST",
      body: JSON.stringify(body),
    });
    await refreshOverview();
  } catch (error) {
    els.confirmError.textContent = error.message;
    els.confirmError.classList.remove("hidden");
  }
}

async function handlePreview() {
  try {
    const draft = buildRequestDraft();
    state.preview = await requestJson("/funding/api/request/preview", {
      method: "POST",
      body: JSON.stringify(draft),
    });
    renderPreview();
  } catch (error) {
    els.requestResult.classList.remove("empty");
    els.requestResult.textContent = `Preview failed: ${error.message}`;
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  try {
    const draft = buildRequestDraft();
    state.execution = await requestJson("/funding/api/request/submit", {
      method: "POST",
      body: JSON.stringify(draft),
    });
    state.preview = state.execution.preview;
    renderPreview();
    renderExecution();
    await refreshOverview();
  } catch (error) {
    els.requestResult.classList.remove("empty");
    els.requestResult.textContent = `Request failed: ${error.message}`;
  }
}

async function handleRecover() {
  try {
    const payload = await requestJson("/funding/api/recover", {
      method: "POST",
      body: JSON.stringify({}),
    });
    els.requestResult.classList.remove("empty");
    els.requestResult.textContent = payload.recovered
      ? `Recovered pending request ${payload.request?.client_request_id ?? ""}`
      : "No pending request to recover.";
    await refreshOverview();
  } catch (error) {
    els.requestResult.classList.remove("empty");
    els.requestResult.textContent = `Recover failed: ${error.message}`;
  }
}

function handleEndpointKindChange() {
  const rawMode = els.endpointKind.value === "raw";
  els.rawFields.classList.toggle("hidden", !rawMode);
}

// ---- Browser-wallet (MetaMask) deposit ------------------------------------

const VAULT_ABI = [
  "function deposit(bytes32 commitment, uint128 amount, uint256[32] siblings)",
  "event NoteDeposited(uint32 indexed noteId, bytes32 indexed commitment, uint128 amount, uint64 expiryTs, uint256 newRoot)",
];
const ERC20_ABI = ["function approve(address spender, uint256 amount) returns (bool)"];
const WITHDRAW_ABI = [
  "function currentRoot() view returns (uint256)",
  "function mutualClose((uint8,uint16,uint64,address,uint256,uint32,uint128,address,uint256,bool,bool,uint32,uint256,uint32,uint256) inputs, bytes proof, uint256[32] siblings)",
];

function setWithdrawStatus(message, isError = false) {
  if (!els.withdrawStatus) return;
  els.withdrawStatus.textContent = message;
  els.withdrawStatus.classList.remove("hidden");
  els.withdrawStatus.classList.toggle("error", isError);
}

// Mutual-close withdrawal through the browser wallet. clientd builds the proof
// (and gets a server clearance signature); MetaMask submits vault.mutualClose,
// which pays the remaining balance to the connected account and the consumed
// amount to the operator.
async function withdrawWithMetaMask() {
  if (typeof ethers === "undefined" || !window.ethereum) {
    setWithdrawStatus("No browser wallet / ethers unavailable.", true);
    return;
  }
  const note = state.overview && state.overview.wallet && state.overview.wallet.note;
  if (!note) {
    setWithdrawStatus("No active note to withdraw.", true);
    return;
  }
  const vault = state.overview.funding.contract_address;
  const wantChain = Number(state.overview.funding.chain_id);
  try {
    setWithdrawStatus("Connecting wallet…");
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== wantChain) {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x" + wantChain.toString(16) }],
      });
    }
    const signer = await provider.getSigner();
    const destination = await signer.getAddress();

    setWithdrawStatus("Requesting clearance + building withdrawal proof…");
    const plan = await requestJson("/funding/api/withdraw", {
      method: "POST",
      body: JSON.stringify({ mode: "mutual", destination }),
    });
    const pi = plan.public_inputs;

    const vaultContract = new ethers.Contract(vault, WITHDRAW_ABI, signer);
    const currentRoot = await vaultContract.currentRoot();
    // Field order matches Types.WithdrawalPublicInputs. The proof blob is empty:
    // the on-chain MockProofAdapter accepts it, while the vault still enforces
    // the signature roots, balance bound, nullifier, and Merkle path.
    const inputs = [
      pi.statement_type,
      pi.protocol_version,
      BigInt(pi.chain_id),
      vault,
      currentRoot,
      pi.note_id,
      BigInt(pi.final_balance),
      destination,
      BigInt(pi.withdrawal_nullifier),
      pi.is_genesis,
      pi.has_clearance,
      pi.state_sig_epoch,
      BigInt(pi.state_sig_root),
      pi.clear_sig_epoch,
      BigInt(pi.clear_sig_root),
    ];
    const siblings = plan.siblings.map((s) => BigInt(s));

    setWithdrawStatus("Submitting mutualClose… confirm in MetaMask.");
    await (await vaultContract.mutualClose(inputs, "0x", siblings)).wait();
    setWithdrawStatus(`Withdrawn: ${pi.final_balance} paid to ${destination}. Note closed.`);
    await refreshOverview();
  } catch (error) {
    setWithdrawStatus(`Withdraw failed: ${error.shortMessage || error.message || error}`, true);
  }
}

function setDepositStatus(message, isError = false) {
  els.depositStatus.textContent = message;
  els.depositStatus.classList.remove("hidden");
  els.depositStatus.classList.toggle("error", isError);
}

// Pad a 0x felt to a 32-byte bytes32 (the contract's commitment type).
function toBytes32(felt) {
  return "0x" + felt.replace(/^0x/, "").padStart(64, "0");
}

async function depositWithMetaMask() {
  if (typeof ethers === "undefined") {
    setDepositStatus("ethers.js failed to load; use the manual chain commands below.", true);
    return;
  }
  if (!window.ethereum) {
    setDepositStatus("No browser wallet detected. Install MetaMask or use the manual commands.", true);
    return;
  }
  if (!state.prepare || !state.overview) {
    setDepositStatus('Click "Generate commitment" first.', true);
    return;
  }
  const token = els.tokenAddress.value.trim();
  if (!token) {
    setDepositStatus("Set the billing token address (advanced chain config).", true);
    return;
  }
  const vault = state.overview.funding.contract_address;
  const wantChain = Number(state.overview.funding.chain_id);
  const amount = BigInt(state.prepare.amount);
  const commitment = toBytes32(state.prepare.commitment);
  const siblings = state.prepare.zero_path.map((s) => BigInt(s));

  try {
    setDepositStatus("Connecting wallet…");
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);

    const net = await provider.getNetwork();
    if (Number(net.chainId) !== wantChain) {
      try {
        await window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: "0x" + wantChain.toString(16) }],
        });
      } catch (switchErr) {
        setDepositStatus(`Switch your wallet to chain ${wantChain} and retry. (${switchErr.message || switchErr})`, true);
        return;
      }
    }

    const signer = await provider.getSigner();
    const erc20 = new ethers.Contract(token, ERC20_ABI, signer);
    setDepositStatus("Approving the vault to pull your deposit… confirm in MetaMask.");
    await (await erc20.approve(vault, amount)).wait();

    const vaultContract = new ethers.Contract(vault, VAULT_ABI, signer);
    setDepositStatus("Submitting deposit… confirm in MetaMask.");
    const receipt = await (await vaultContract.deposit(commitment, amount, siblings)).wait();

    // Read the on-chain NoteDeposited event for the canonical note id + expiry.
    let noteId;
    let expiryTs;
    for (const log of receipt.logs) {
      try {
        const parsed = vaultContract.interface.parseLog(log);
        if (parsed && parsed.name === "NoteDeposited") {
          noteId = Number(parsed.args.noteId);
          expiryTs = Number(parsed.args.expiryTs);
          break;
        }
      } catch (_) {
        // not our event
      }
    }
    if (noteId === undefined) {
      setDepositStatus("Deposit landed, but no NoteDeposited event was found in the receipt.", true);
      return;
    }

    setDepositStatus(`Deposited note #${noteId}. Activating locally…`);
    // Activate the note in clientd. The secret stays on this machine — only the
    // commitment and on-chain values crossed to the wallet/chain.
    await requestJson("/funding/api/deposit/confirm", {
      method: "POST",
      body: JSON.stringify({
        secret: state.prepare.secret,
        note_id: noteId,
        amount: Number(amount),
        expiry_ts: expiryTs,
      }),
    });
    setDepositStatus(`Note #${noteId} is active. Balance updated.`);
    await refreshOverview();
  } catch (error) {
    setDepositStatus(`Deposit failed: ${error.shortMessage || error.message || error}`, true);
  }
}

// Wire up
$("prepare-form").addEventListener("submit", handlePrepare);
$("confirm-form").addEventListener("submit", handleConfirm);
els.metamaskDeposit.addEventListener("click", depositWithMetaMask);
if (els.metamaskWithdraw) els.metamaskWithdraw.addEventListener("click", withdrawWithMetaMask);
$("request-form").addEventListener("submit", handleSubmit);
$("preview-request").addEventListener("click", handlePreview);
$("recover-request").addEventListener("click", handleRecover);
$("refresh-all").addEventListener("click", (e) => { e.preventDefault(); refreshOverview(); });
els.endpointKind.addEventListener("change", handleEndpointKindChange);

for (const el of [els.rpcUrl, els.tokenAddress, els.privateKey, els.noteTtl]) {
  el.addEventListener("input", renderCommands);
}

hydrateHelpers();
handleEndpointKindChange();
refreshOverview();

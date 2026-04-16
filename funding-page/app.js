const statusNode = document.getElementById("wallet-state");
const balanceNode = document.getElementById("wallet-balance");
const prepareOutput = document.getElementById("prepare-output");
const confirmOutput = document.getElementById("confirm-output");

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || response.statusText);
  }
  return payload;
}

function renderJson(node, payload) {
  node.textContent = JSON.stringify(payload, null, 2);
}

async function refreshStatus() {
  try {
    const payload = await requestJson("/funding/api/status");
    statusNode.textContent = payload.has_note ? "Funded" : "Needs funding";
    balanceNode.textContent = payload.note
      ? `${payload.note.current_balance} credits`
      : "No active note";
  } catch (error) {
    statusNode.textContent = "Unavailable";
    balanceNode.textContent = error.message;
  }
}

document.getElementById("refresh-status").addEventListener("click", refreshStatus);

document.getElementById("prepare-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = Number(document.getElementById("deposit-amount").value);
  try {
    const payload = await requestJson("/funding/api/deposit/prepare", {
      method: "POST",
      body: JSON.stringify({ amount }),
    });
    document.getElementById("secret").value = payload.secret;
    document.getElementById("note-id").value = payload.next_note_id;
    document.getElementById("confirm-amount").value = payload.amount;
    renderJson(prepareOutput, payload);
  } catch (error) {
    prepareOutput.textContent = error.message;
  }
});

document.getElementById("confirm-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {
    secret: document.getElementById("secret").value.trim(),
    note_id: Number(document.getElementById("note-id").value),
    amount: Number(document.getElementById("confirm-amount").value),
    expiry_ts: Number(document.getElementById("expiry-ts").value),
  };

  try {
    const payload = await requestJson("/funding/api/deposit/confirm", {
      method: "POST",
      body: JSON.stringify(body),
    });
    renderJson(confirmOutput, payload);
    refreshStatus();
  } catch (error) {
    confirmOutput.textContent = error.message;
  }
});

refreshStatus();

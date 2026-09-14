const BACKEND_URL = "http://localhost:5000"; // TODO: swap to prod URL when deployed

// Same fallback key used by background.js -- keep these two in sync if you
// change one. (A popup-saved key in chrome.storage.sync still overrides
// this, same as it does for corrections -- see the DEFAULT_API_KEY comment
// in background.js for why that matters.)
const DEFAULT_API_KEY = "paste-your-key-here";

const input = document.getElementById("api-key-input");
const status = document.getElementById("status");

chrome.storage.sync.get(["apiKey"], (result) => {
  if (result.apiKey) {
    input.value = result.apiKey;
    status.textContent = "Active on Gmail and Google Docs.";
  } else {
    status.textContent = "No API key set -- suggestions are paused.";
  }
});

document.getElementById("save-btn").addEventListener("click", () => {
  const apiKey = input.value.trim();
  chrome.storage.sync.set({ apiKey }, () => {
    status.textContent = apiKey ? "Saved. Active on Gmail and Google Docs." : "No API key set -- suggestions are paused.";
  });
});

// ---------------------------------------------------------------------------
// Text generation
// ---------------------------------------------------------------------------

const promptInput = document.getElementById("prompt-input");
const generateBtn = document.getElementById("generate-btn");
const generateStatus = document.getElementById("generate-status");
const resultOutput = document.getElementById("result-output");
const copyBtn = document.getElementById("copy-btn");

function getActiveApiKey() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["apiKey"], ({ apiKey }) => {
      resolve(apiKey || DEFAULT_API_KEY);
    });
  });
}

generateBtn.addEventListener("click", async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    generateStatus.textContent = "Type what you want first.";
    return;
  }

  const apiKey = await getActiveApiKey();
  if (!apiKey || apiKey === "paste-your-key-here") {
    generateStatus.textContent = "No API key set -- add one above first.";
    return;
  }

  generateBtn.disabled = true;
  generateStatus.textContent = "Generating...";
  resultOutput.value = "";
  copyBtn.style.display = "none";

  try {
    const response = await fetch(`${BACKEND_URL}/api/ai/generate-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: JSON.stringify({ prompt }),
    });

    if (response.status === 401) {
      generateStatus.textContent = "Invalid API key.";
    } else if (response.status === 402) {
      generateStatus.textContent = "Subscription not active.";
    } else if (response.status === 429) {
      const data = await response.json();
      generateStatus.textContent = `Monthly limit reached (${data.tier || ""} plan).`;
    } else if (!response.ok) {
      generateStatus.textContent = "Something went wrong -- try again.";
    } else {
      const data = await response.json();
      if (data.generated) {
        resultOutput.value = data.generated;
        copyBtn.style.display = "block";
        generateStatus.textContent = data.remaining_requests !== undefined
          ? `Done. ${data.remaining_requests} requests left this month.`
          : "Done.";
      } else {
        generateStatus.textContent = data.error || "No text was generated.";
      }
    }
  } catch (err) {
    console.error("Exelidoc: generate request failed --", err);
    generateStatus.textContent = "Could not reach the server.";
  } finally {
    generateBtn.disabled = false;
  }
});

copyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(resultOutput.value).then(() => {
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 1500);
  });
});
const BACKEND_URL = "https://exelidocv4-5.onrender.com";

const status = document.getElementById("status");
const input = document.getElementById("api-key-input");

chrome.storage.sync.get(["sessionToken"], (result) => {
  if (result.sessionToken) {
    input.value = "Session remembered";
    input.disabled = true;
    status.textContent = "Signed in and remembered on this browser.";
  } else {
    input.value = "";
    input.disabled = false;
    status.textContent = "Sign in once to remember your Exelidoc session.";
  }
});

document.getElementById("save-btn").addEventListener("click", () => {
  const token = input.value.trim();
  if (!token || token === "Session remembered") {
    status.textContent = "Enter a valid session token from your account sign-in.";
    return;
  }

  chrome.storage.sync.set({ sessionToken: token }, () => {
    status.textContent = "Session saved. Exelidoc will remember you.";
    input.value = "Session remembered";
    input.disabled = true;
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

function getActiveSessionToken() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["sessionToken"], ({ sessionToken }) => {
      resolve(sessionToken || "");
    });
  });
}

generateBtn.addEventListener("click", async () => {
  const prompt = promptInput.value.trim();
  if (!prompt) {
    generateStatus.textContent = "Type what you want first.";
    return;
  }

  const sessionToken = await getActiveSessionToken();
  if (!sessionToken) {
    generateStatus.textContent = "No session remembered yet -- sign in first.";
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
        "X-Session-Token": sessionToken,
      },
      body: JSON.stringify({ prompt }),
    });

    if (response.status === 401) {
      generateStatus.textContent = "Invalid session.";
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
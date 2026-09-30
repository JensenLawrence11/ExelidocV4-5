const BACKEND_URL = "https://exelidocv4-5.onrender.com";

const status = document.getElementById("status");
const emailInput = document.getElementById("email-input");
const createAccountBtn = document.getElementById("create-account-btn");
const signOutBtn = document.getElementById("sign-out-btn");

function setSignedIn(email) {
  emailInput.value = email || "";
  emailInput.disabled = Boolean(email);
  createAccountBtn.hidden = Boolean(email);
  signOutBtn.hidden = !email;
  status.textContent = email
    ? `Signed in as ${email}. Your account is remembered in this browser.`
    : "Create an account to use Exelidoc. Free accounts include 50 AI requests per 30 days.";
}

chrome.storage.local.get(["sessionToken", "accountEmail"], (result) => {
  setSignedIn(result.sessionToken ? result.accountEmail : "");
});

createAccountBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim().toLowerCase();
  if (!emailInput.validity.valid || !email) {
    status.textContent = "Enter a valid email address to create your account.";
    return;
  }

  createAccountBtn.disabled = true;
  status.textContent = "Creating your account...";
  try {
    const response = await fetch(`${BACKEND_URL}/api/auth/signup-free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await response.json();

    if (response.status === 409) {
      status.textContent = "An account already exists for this email. Existing-account sign-in is not available in this beta yet.";
      return;
    }
    if (!response.ok || !data.session_token) {
      status.textContent = data.error || "Could not create your account. Try again shortly.";
      return;
    }

    chrome.storage.local.set({ sessionToken: data.session_token, accountEmail: data.email }, () => {
      setSignedIn(data.email);
    });
  } catch (error) {
    console.error("Exelidoc: account signup failed --", error);
    status.textContent = "Could not reach Exelidoc. Try again shortly.";
  } finally {
    createAccountBtn.disabled = false;
  }
});

signOutBtn.addEventListener("click", () => {
  chrome.storage.local.remove(["sessionToken", "accountEmail"], () => {
    setSignedIn("");
    status.textContent = "Signed out.";
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
    chrome.storage.local.get(["sessionToken"], ({ sessionToken }) => {
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
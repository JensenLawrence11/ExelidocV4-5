const BACKEND_URL = "https://exelidocv4-5.onrender.com";

const status = document.getElementById("status");
const emailInput = document.getElementById("email-input");
const createAccountBtn = document.getElementById("create-account-btn");
const signOutBtn = document.getElementById("sign-out-btn");
const plansSection = document.getElementById("plans-section");
const billingStatus = document.getElementById("billing-status");

function setSignedIn(email) {
  emailInput.value = email || "";
  emailInput.disabled = Boolean(email);
  createAccountBtn.hidden = Boolean(email);
  signOutBtn.hidden = !email;
  plansSection.hidden = !email;
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

document.querySelectorAll(".checkout-btn").forEach((button) => {
  button.addEventListener("click", async () => {
    const email = emailInput.value.trim();
    const tier = button.dataset.tier;
    billingStatus.textContent = "Opening secure checkout...";
    document.querySelectorAll(".checkout-btn").forEach((item) => { item.disabled = true; });

    try {
      const response = await fetch(`${BACKEND_URL}/api/stripe/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_email: email, tier }),
      });
      const data = await response.json();

      if (!response.ok || !data.url) {
        billingStatus.textContent = data.error || "Could not start checkout. Try again shortly.";
        return;
      }

      chrome.tabs.create({ url: data.url });
      billingStatus.textContent = "Checkout opened in a new tab.";
    } catch (error) {
      console.error("Exelidoc: checkout request failed --", error);
      billingStatus.textContent = "Could not reach Exelidoc. Try again shortly.";
    } finally {
      document.querySelectorAll(".checkout-btn").forEach((item) => { item.disabled = false; });
    }
  });
});

// TODO: point this at your deployed Flask backend once it's hosted.
const BACKEND_URL = "http://localhost:5000";

async function handleFreeSignup(email, errorEl) {
  const response = await fetch(`${BACKEND_URL}/api/auth/signup-free`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await response.json();
  if (data.api_key) {
    // Free tier has no Stripe redirect -- send them straight to success.html
    // with the key attached directly instead of a session_id.
    window.location.href = `success.html?free_key=${encodeURIComponent(data.api_key)}&email=${encodeURIComponent(data.email)}`;
  } else {
    errorEl.textContent = data.error || "Something went wrong.";
  }
}

async function handlePaidCheckout(email, tier, errorEl) {
  const response = await fetch(`${BACKEND_URL}/api/stripe/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer_email: email, tier }),
  });
  const data = await response.json();
  if (data.url) {
    window.location.href = data.url;
  } else {
    errorEl.textContent = data.error || "Something went wrong.";
  }
}

document.querySelectorAll(".tier-subscribe-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const tier = btn.dataset.tier; // "free" | "pro" | "enterprise"
    const emailInput = document.getElementById("email-input");
    const errorEl = document.getElementById("subscribe-error");
    const email = emailInput.value.trim();

    errorEl.textContent = "";
    if (!email) {
      errorEl.textContent = "Enter your email first.";
      return;
    }

    try {
      if (tier === "free") {
        await handleFreeSignup(email, errorEl);
      } else {
        await handlePaidCheckout(email, tier, errorEl);
      }
    } catch (err) {
      console.error("Signup/checkout failed:", err);
      errorEl.textContent = "Could not reach the server.";
    }
  });
});

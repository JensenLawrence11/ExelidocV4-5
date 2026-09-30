const BACKEND_URL = "https://exelidocv4-5.onrender.com";

async function handlePaidCheckout(email, tier, errorEl) {
  const response = await fetch(`${BACKEND_URL}/api/stripe/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer_email: email, tier }),
  });
  const data = await response.json().catch(() => ({}));
  if (response.ok && data.url) {
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
      btn.disabled = true;
      await handlePaidCheckout(email, tier, errorEl);
    } catch (err) {
      console.error("Signup/checkout failed:", err);
      errorEl.textContent = "Could not reach the server.";
    } finally {
      btn.disabled = false;
    }
  });
});

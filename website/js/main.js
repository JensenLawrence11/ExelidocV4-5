const BACKEND_URL = "https://exelidocv4-5.onrender.com";

function rememberSession(sessionToken, email) {
  localStorage.setItem("exelidoc_session_token", sessionToken);
  localStorage.setItem("exelidoc_email", email || "");
}

async function handleFreeSignup(email, errorEl) {
  const response = await fetch(`${BACKEND_URL}/api/auth/signup-free`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const data = await response.json();
  if (data.session_token) {
    rememberSession(data.session_token, data.email);
    window.location.href = `success.html?session_token=${encodeURIComponent(data.session_token)}&email=${encodeURIComponent(data.email)}`;
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

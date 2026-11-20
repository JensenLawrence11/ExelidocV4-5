document.querySelectorAll(".tier-subscribe-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const errorEl = document.getElementById("subscribe-error");
    errorEl.textContent = "For account security, sign in from the Exelidoc extension and start checkout in Account and plans.";
  });
});

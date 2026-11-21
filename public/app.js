const form = document.querySelector("#survey-form");
const radios = Array.from(document.querySelectorAll('input[name="answer"]'));
const submitButton = document.querySelector("#submit-button");
const submitLabel = document.querySelector("#submit-label");
const status = document.querySelector("#status");
const success = document.querySelector("#success");
const successTitle = document.querySelector("#success-title");
const successText = document.querySelector("#success-text");
const website = document.querySelector("#website");
const voterName = document.querySelector("#voter-name");
const tokenMeta = document.querySelector('meta[name="survey-token"]');
let surveyToken = tokenMeta?.content ?? "";

const ALREADY_MESSAGE = "You have already submitted your response from this device.";
const THANKS_TITLE = "Thank you for participating!";
const MAX_NAME_LENGTH = 80;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SUBMITTED_FLAG = "shams_survey_submitted";

let phase = "idle";
let submittedAnswer = null;

function selectedAnswer() {
  return radios.find((radio) => radio.checked)?.value ?? null;
}

function acceptToken(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) return false;
  surveyToken = value;
  return true;
}

function rememberSubmission(answer) {
  try {
    localStorage.setItem(SUBMITTED_FLAG, answer ?? "yes");
  } catch {}
}

function clearRememberedSubmission() {
  try {
    localStorage.removeItem(SUBMITTED_FLAG);
  } catch {}
}

function hasRememberedSubmission() {
  try {
    return Boolean(localStorage.getItem(SUBMITTED_FLAG));
  } catch {
    return false;
  }
}

async function ensureSurveyToken() {
  if (surveyToken && surveyToken !== "__SURVEY_TOKEN__") return;

  try {
    const response = await fetch("/api/survey/session", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return;
    await acceptToken((await response.json()).token);
  } catch {
    surveyToken = "";
  }
}

function setStatus(message, type = "none") {
  status.textContent = message;
  status.className = "status";

  if (type === "error") {
    status.classList.add("status--error");
    status.setAttribute("role", "alert");
    return;
  }

  status.removeAttribute("role");
  if (type === "info") status.classList.add("status--info");
}

function canSubmit() {
  return Boolean(voterName?.value.trim()) && Boolean(selectedAnswer());
}

function updateSelection() {
  for (const radio of radios) {
    radio.closest(".option")?.classList.toggle("is-selected", radio.checked);
  }

  if (phase !== "idle") return;

  submitButton.disabled = !canSubmit();
  setStatus("");
}

function lockControls(answer) {
  submittedAnswer = answer ?? null;

  for (const radio of radios) {
    radio.disabled = true;
    radio.checked = Boolean(answer) && radio.value === answer;
    radio.closest(".option")?.classList.toggle("is-selected", radio.checked);
  }

  submitButton.disabled = true;
  submitButton.classList.remove("is-loading");
  submitLabel.textContent = "RESPONSE RECORDED";
  if (voterName) voterName.disabled = true;
}

function showSuccess(title, message, answer) {
  phase = "success";
  lockControls(answer);
  form.hidden = true;
  success.hidden = false;
  if (successTitle) successTitle.textContent = title;
  if (successText) successText.textContent = message;
  setStatus("");
  rememberSubmission(answer);
  successTitle?.focus({ preventScroll: true });
}

function showAlreadySubmitted(answer) {
  phase = "locked";
  showSuccess(THANKS_TITLE, ALREADY_MESSAGE, answer);
  phase = "locked";
}

async function checkStatus() {
  try {
    const response = await fetch("/api/survey/status", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      if (hasRememberedSubmission()) showAlreadySubmitted(null);
      return;
    }

    const data = await response.json();
    acceptToken(data.token);
    if (data.submitted) {
      if (phase === "idle") showAlreadySubmitted(data.answer);
      return;
    }

    clearRememberedSubmission();
    if (phase === "idle") {
      submitButton.disabled = !canSubmit();
      setStatus("");
    }
  } catch (error) {
    if (hasRememberedSubmission()) {
      showAlreadySubmitted(null);
      return;
    }

    if (phase === "idle" && !voterName?.value.trim() && !selectedAnswer()) {
      setStatus(
        error instanceof Error
          ? error.message
          : "We could not check your submission status. Please reload the page.",
        "error"
      );
    }
  }
}

for (const radio of radios) {
  radio.addEventListener("change", updateSelection);
}

voterName?.addEventListener("input", updateSelection);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (phase !== "idle") return;

  const cleanName = voterName?.value.trim() ?? "";
  if (!cleanName) {
    setStatus("Please enter your name before submitting.", "error");
    voterName?.focus();
    return;
  }
  if (cleanName.length > MAX_NAME_LENGTH) {
    setStatus(`Please keep your name under ${MAX_NAME_LENGTH} characters.`, "error");
    voterName?.focus();
    return;
  }

  const answer = selectedAnswer();
  if (!answer) {
    setStatus("Please select Yes or No before submitting.", "error");
    return;
  }

  if (!surveyToken || surveyToken === "__SURVEY_TOKEN__") {
    await ensureSurveyToken();
  }
  if (!surveyToken || surveyToken === "__SURVEY_TOKEN__") {
    setStatus("Your survey session has expired. Please reload the page.", "error");
    return;
  }

  phase = "loading";
  submitButton.disabled = true;
  submitButton.classList.add("is-loading");
  submitLabel.textContent = "SUBMITTING...";
  setStatus("");

  try {
    const response = await fetch("/api/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      credentials: "same-origin",
      body: JSON.stringify({
        name: cleanName,
        answer,
        token: surveyToken,
        website: website?.value ?? ""
      })
    });

    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      if (response.status === 409) {
        showAlreadySubmitted(answer);
        return;
      }
      throw new Error(data.message ?? "We could not submit your response. Please try again.");
    }

    showSuccess(THANKS_TITLE, "Your response has been successfully submitted.", answer);
  } catch (error) {
    phase = "idle";
    submitButton.disabled = false;
    submitButton.classList.remove("is-loading");
    submitLabel.textContent = "SUBMIT RESPONSE";
    setStatus(error instanceof Error ? error.message : "We could not submit your response. Please try again.", "error");
  }
});

if (hasRememberedSubmission()) {
  showAlreadySubmitted(null);
} else {
  checkStatus();
}

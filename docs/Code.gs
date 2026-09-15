/**
 * Exelidoc -- Google Docs Add-on
 *
 * Run setConfig() once from this editor (select it in the function
 * dropdown above, click Run) before using the sidebar. It stores the
 * backend URL and API key in this script's own PropertiesService store --
 * separate from the Chrome extension's background.js, since Apps Script
 * runs on Google's servers and can't read files from the browser extension.
 *
 * IMPORTANT: same shared-key caveat as the Chrome extension's
 * DEFAULT_API_KEY -- fine for solo testing, swap to per-user keys before
 * real users touch this.
 */

function setConfig() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('EXELIDOC_BACKEND_URL', 'https://exelidocv4-5.onrender.com');
  props.setProperty('EXELIDOC_API_KEY', 'OPENROUTER_API_KEY');
}

function onHomepage(e) {
  return HtmlService.createTemplateFromFile('Sidebar')
    .evaluate()
    .setTitle('Exelidoc');
}

/**
 * Reads the user's current selection, or falls back to the whole doc if
 * nothing is selected.
 */
function getSelectionOrFullText() {
  const doc = DocumentApp.getActiveDocument();
  const selection = doc.getSelection();

  if (!selection) {
    return { text: doc.getBody().getText(), hasSelection: false };
  }

  const elements = selection.getRangeElements();
  let text = '';
  elements.forEach((el) => {
    const element = el.getElement();
    if (element.editAsText) {
      const textEl = element.editAsText();
      const start = el.isPartial() ? el.getStartOffset() : 0;
      const end = el.isPartial() ? el.getEndOffsetInclusive() : textEl.getText().length - 1;
      text += textEl.getText().substring(start, end + 1);
    }
  });

  return { text, hasSelection: true };
}

/**
 * Calls the same Flask backend the Chrome extension uses --
 * analyze_text / generate_text are unchanged on the backend side.
 */
function callBackend(path, payload) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('EXELIDOC_API_KEY');
  const backendUrl = props.getProperty('EXELIDOC_BACKEND_URL');

  if (!backendUrl || !apiKey) {
    throw new Error('Run setConfig() first (see top of Code.gs)');
  }

  const response = UrlFetchApp.fetch(`${backendUrl}${path}`, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Api-Key': apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  const body = JSON.parse(response.getContentText());

  if (code === 401) throw new Error('invalid_api_key');
  if (code === 402) throw new Error('subscription_inactive');
  if (code >= 400) throw new Error(body.error || 'request_failed');

  return body;
}

/**
 * Called from the sidebar when the user clicks Ask.
 * If there's a selection (or any text in the doc), it's treated as an
 * edit instruction. If the doc is empty, it's treated as a generation
 * prompt instead.
 */
function runInstruction(instruction) {
  const selection = getSelectionOrFullText();

  if (!selection.text.trim()) {
    return callGenerate(instruction);
  }

  const result = callBackend('/api/ai/analyze-text', { text: selection.text, instruction });
  applyEditToSelection(selection, result.corrected);
  return result;
}

function callGenerate(prompt) {
  const result = callBackend('/api/ai/generate-text', { prompt });
  insertAtCursor(result.generated);
  return result;
}

/**
 * Replaces exactly the selected range. Text outside the selection is
 * never touched, so its formatting is preserved. Multi-paragraph
 * selections currently only replace the first range element -- good
 * enough for single-paragraph edits, worth revisiting for larger
 * selections later.
 */
function applyEditToSelection(selection, correctedText) {
  const doc = DocumentApp.getActiveDocument();
  const activeSelection = doc.getSelection();

  if (!activeSelection) {
    doc.getBody().setText(correctedText);
    return;
  }

  const elements = activeSelection.getRangeElements();
  const first = elements[0];
  const element = first.getElement();

  if (!element.editAsText) {
    throw new Error('Selected content is not editable text (e.g. an image or table cell boundary)');
  }

  const textEl = element.editAsText();
  const start = first.isPartial() ? first.getStartOffset() : 0;
  const end = first.isPartial() ? first.getEndOffsetInclusive() : textEl.getText().length - 1;

  textEl.deleteText(start, end);
  textEl.insertText(start, correctedText);
}

function insertAtCursor(text) {
  const doc = DocumentApp.getActiveDocument();
  const cursor = doc.getCursor();
  if (cursor) {
    cursor.insertText(text);
  } else {
    doc.getBody().appendParagraph(text);
  }
}

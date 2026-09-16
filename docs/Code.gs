/**
 * Exelidoc -- Google Docs Add-on
 *
 * Stores only a remembered session token in Apps Script, not a raw API key.
 */

function setConfig() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('EXELIDOC_BACKEND_URL', 'https://exelidocv4-5.onrender.com');
}

function onHomepage(e) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Exelidoc'))
    .addSection(
      CardService.newCardSection()
        .addWidget(
          CardService.newTextInput()
            .setFieldName('instruction')
            .setTitle('What should Exelidoc do?')
            .setHint('Rewrite this, fix grammar, or write something new')
        )
        .addWidget(
          CardService.newButtonSet().addButton(
            CardService.newTextButton()
              .setText('Ask Exelidoc')
              .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
              .setOnClickAction(
                CardService.newAction().setFunctionName('runInstructionAction')
              )
          )
        )
        .addWidget(
          CardService.newTextParagraph().setText(
            'Select text to edit it, or leave the document empty to generate text.'
          )
        )
    )
    .build();
}

function runInstructionAction(e) {
  const instruction = ((e && e.commonEventObject && e.commonEventObject.formInputs)
    ? e.commonEventObject.formInputs.instruction
    : null);
  const value = instruction && instruction.stringInputs && instruction.stringInputs.value
    ? instruction.stringInputs.value[0]
    : '';

  if (!value || !value.trim()) {
    return buildResultCard('Enter an instruction first.');
  }

  try {
    const result = runInstruction(value.trim());
    if (result && result.error) {
      return buildResultCard(`Error: ${result.error}`);
    }
    return buildResultCard('Done. Your document was updated.');
  } catch (error) {
    return buildResultCard(`Error: ${error.message || error}`);
  }
}

function buildResultCard(message) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader().setTitle('Exelidoc'))
    .addSection(
      CardService.newCardSection()
        .addWidget(CardService.newTextParagraph().setText(message))
        .addWidget(
          CardService.newTextButton()
            .setText('Try again')
            .setOnClickAction(CardService.newAction().setFunctionName('onHomepage'))
        )
    )
    .build();
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
  const sessionToken = props.getProperty('EXELIDOC_SESSION_TOKEN');
  const backendUrl = props.getProperty('EXELIDOC_BACKEND_URL');

  if (!backendUrl || !sessionToken) {
    throw new Error('Sign in once to store your Exelidoc session token');
  }

  const response = UrlFetchApp.fetch(`${backendUrl}${path}`, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Session-Token': sessionToken },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const code = response.getResponseCode();
  let body = {};
  const responseText = response.getContentText();
  if (responseText) {
    try {
      body = JSON.parse(responseText);
    } catch (error) {
      body = { error: responseText };
    }
  }

  if (code === 401) throw new Error('invalid_session');
  if (code === 402) throw new Error('subscription_inactive');
  if (code === 429) throw new Error(body.error || 'monthly_limit_reached');
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

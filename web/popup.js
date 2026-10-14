const ext = globalThis.browser ?? globalThis.chrome;
const status = document.getElementById('status');

const strategyCopy = {
  'chrome-downloads': 'This browser will save organized folders with the downloads API.',
  native: 'Safari will ask the Libby Downloader app to write organized folders.',
  'blob-fallback': 'Files will be handed to the browser as individual downloads.',
  '': 'Open an audiobook and click the download button in the player.',
};

function showState(response) {
  if (!response) {
    status.textContent = strategyCopy[''];
    return;
  }
  if (response.phase === 'downloading') {
    status.textContent = `Saving ${response.completed} of ${response.total}. ${
      strategyCopy[response.strategy] || ''
    }`;
    return;
  }
  if (response.phase === 'complete') {
    status.textContent = `Last book: ${response.completed} saved, ${response.failed} failed.`;
    return;
  }
  if (response.phase === 'error') {
    status.textContent = response.detail || 'The last download failed.';
    return;
  }
  status.textContent = strategyCopy[response.strategy] || strategyCopy[''];
}

try {
  const pending = ext.runtime.sendMessage({ type: 'GET_STATE' }, showState);
  if (pending && typeof pending.then === 'function') {
    pending.then(showState).catch(() => {});
  }
} catch {
  showState(null);
}

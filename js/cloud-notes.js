const CloudNotes = (() => {
  function ensureApiAvailable() {
    if (!window.CloudSync || !CloudSync.hasApiUrl()) {
      throw new Error('尚未設定 Cloudflare API');
    }
  }

  async function hashText(text) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(text)
    );
    return Array.from(new Uint8Array(digest))
      .map(part => part.toString(16).padStart(2, '0'))
      .join('');
  }

  function buildSourceKeyFromPath(filePath) {
    return `path:${filePath}`;
  }

  async function buildSourceKeyForUpload(file, content) {
    const hash = await hashText(content);
    return `upload:${file.name}:${hash.slice(0, 24)}`;
  }

  function buildQuestionKey(questionClass, questionSn) {
    return `${questionClass}::${questionSn}`;
  }

  async function loadSourceNotes(sourceKey) {
    ensureApiAvailable();
    return CloudSync.requestJson(`/notes?sourceKey=${encodeURIComponent(sourceKey)}`);
  }

  async function saveQuestionNote(payload) {
    ensureApiAvailable();
    return CloudSync.requestJson('/notes', {
      method: 'PUT',
      body: payload,
    });
  }

  async function uploadQuestionImage(payload) {
    ensureApiAvailable();
    const formData = new FormData();
    formData.append('sourceKey', payload.sourceKey);
    formData.append('questionClass', payload.questionClass);
    formData.append('questionSn', payload.questionSn);
    formData.append('file', payload.file);

    return CloudSync.requestJson('/note-images', {
      method: 'POST',
      formData,
    });
  }

  async function deleteQuestionImage(imageId) {
    ensureApiAvailable();
    return CloudSync.requestJson(`/note-images/${encodeURIComponent(imageId)}`, {
      method: 'DELETE',
    });
  }

  return {
    buildQuestionKey,
    buildSourceKeyFromPath,
    buildSourceKeyForUpload,
    loadSourceNotes,
    saveQuestionNote,
    uploadQuestionImage,
    deleteQuestionImage,
  };
})();

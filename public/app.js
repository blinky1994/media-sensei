const $ = (selector) => document.querySelector(selector);

const elements = {
  dropzone: $('#dropzone'), fileInput: $('#fileInput'), filePanel: $('#filePanel'),
  fileName: $('#fileName'), fileMeta: $('#fileMeta'), removeFile: $('#removeFile'),
  compressButton: $('#compressButton'), progressPanel: $('#progressPanel'),
  progressValue: $('#progressValue'), progressBar: $('#progressBar'),
  progressTitle: $('#progressTitle'), progressEyebrow: $('#progressEyebrow'),
  progressNote: $('#progressNote'), cancelButton: $('#cancelButton'),
  resultPanel: $('#resultPanel'), beforeSize: $('#beforeSize'), afterSize: $('#afterSize'),
  savedPercent: $('#savedPercent'), downloadButton: $('#downloadButton'),
  startOver: $('#startOver'), errorPanel: $('#errorPanel'), errorMessage: $('#errorMessage'),
  tryAgain: $('#tryAgain'), profileFieldset: $('#profileFieldset'),
  formatFieldset: $('#formatFieldset'),
  workerName: $('#workerName'), workerRole: $('#workerRole'),
  workspace: $('#workspace'), modeSwitcher: $('#modeSwitcher'),
  mascotGreeting: $('#mascotGreeting'), mascotRole: $('#mascotRole'),
  workshopTitle: $('#workshopTitle'), compressionFormatText: $('#compressionFormatText'),
  profileStep: $('#profileStep'), balancedHint: $('#balancedHint'), errorTitle: $('#errorTitle'),
  dropTitle: $('#dropTitle'), dropHint: $('#dropHint'), dropFormatNote: $('#dropFormatNote'),
};

let selectedFile = null;
let xhr = null;
let pollTimer = null;
let activeJob = null;
let activeActor = 'momo';
let activeMode = 'compress';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '--';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function extension(name) {
  return (name.split('.').pop() || 'VIDEO').toUpperCase().slice(0, 5);
}

function sourceFormat(name) {
  return (name.split('.').pop() || '').toLowerCase();
}

function configureFileForMode() {
  if (!selectedFile) return true;
  const source = sourceFormat(selectedFile.name);
  const formatInputs = [...document.querySelectorAll('input[name="format"]')];

  formatInputs.forEach((input) => {
    const unavailable = activeMode === 'convert' && input.value === source;
    input.disabled = unavailable;
    input.closest('.format-option').classList.toggle('unavailable', unavailable);
  });

  if (activeMode === 'compress') {
    if (!['mp4', 'webm', 'mov'].includes(source)) {
      fail('Momo can preserve MP4, WebM, or MOV. Switch to Convert for MKV, AVI, and M4V files.');
      return false;
    }
    const matchingFormat = formatInputs.find((input) => input.value === source);
    matchingFormat.checked = true;
    elements.compressionFormatText.textContent = `Momo will keep ${source.toUpperCase()} and focus only on making the file smaller.`;
  } else {
    const checked = formatInputs.find((input) => input.checked);
    if (!checked || checked.disabled) formatInputs.find((input) => !input.disabled).checked = true;
  }
  return true;
}

function setMode(mode) {
  activeMode = mode;
  activeActor = mode === 'compress' ? 'momo' : 'kapa';
  document.body.dataset.mode = mode;
  elements.workspace.dataset.mode = mode;
  elements.fileInput.accept = mode === 'compress'
    ? 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov'
    : 'video/*,.mkv';
  elements.mascotGreeting.textContent = mode === 'compress' ? "Hi, I'm Momo!" : "Hi, I'm Kapa!";
  elements.mascotRole.textContent = mode === 'compress' ? 'your compression sensei' : 'your conversion sensei';
  elements.workshopTitle.textContent = mode === 'compress' ? "momo's compression nook" : "kapa's conversion nook";
  elements.profileStep.textContent = mode === 'compress' ? '1' : '2';
  elements.balancedHint.textContent = mode === 'compress' ? "Momo's favorite" : "Kapa's favorite";
  elements.compressButton.querySelector('span').textContent = mode === 'compress' ? 'Let Momo shrink it' : 'Let Kapa convert it';
  elements.dropTitle.textContent = mode === 'compress' ? 'Drop a video for Momo' : 'Drop a video for Kapa';
  elements.dropHint.innerHTML = mode === 'compress'
    ? 'Same format, just smaller · or <span>pick one from your files</span>'
    : 'Choose a new format · or <span>pick one from your files</span>';
  elements.dropFormatNote.textContent = mode === 'compress'
    ? 'MP4 · MOV · WEBM  /  UP TO 20 GB'
    : 'MP4 · MOV · MKV · WEBM · AVI · M4V  /  UP TO 20 GB';
  if (selectedFile && configureFileForMode()) show('filePanel');
}

function show(view) {
  [elements.dropzone, elements.filePanel, elements.progressPanel, elements.resultPanel, elements.errorPanel]
    .forEach((el) => el.classList.add('hidden'));
  elements[view].classList.remove('hidden');
  elements.workspace.classList.toggle('busy', view === 'progressPanel' || view === 'resultPanel');
}

function chooseFile(file) {
  if (!file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(file.name)) {
    elements.errorMessage.textContent = 'Please choose an MP4, MOV, MKV, WebM, AVI or M4V video.';
    show('errorPanel');
    return;
  }
  selectedFile = file;
  elements.fileName.textContent = file.name;
  elements.fileMeta.textContent = `${formatBytes(file.size)}  /  ${extension(file.name)}`;
  $('.file-badge').textContent = extension(file.name);
  if (configureFileForMode()) show('filePanel');
}

function setProgress(value) {
  const amount = Math.max(0, Math.min(100, Math.round(value)));
  elements.progressValue.textContent = `${amount}%`;
  elements.progressBar.style.width = `${amount}%`;
  elements.progressPanel.style.setProperty('--progress', `${amount}%`);
}

function reset() {
  if (xhr) xhr.abort();
  clearTimeout(pollTimer);
  selectedFile = null;
  xhr = null;
  activeJob = null;
  elements.fileInput.value = '';
  setProgress(0);
  show('dropzone');
}

function fail(message) {
  clearTimeout(pollTimer);
  elements.errorTitle.textContent = `Oops, ${activeMode === 'compress' ? 'Momo' : 'Kapa'} hit a little snag.`;
  elements.errorMessage.textContent = message || 'Please check the video and try again.';
  show('errorPanel');
}

function finish(job) {
  activeJob = job.id;
  elements.beforeSize.textContent = formatBytes(job.inputSize);
  elements.afterSize.textContent = formatBytes(job.outputSize);
  const saved = Math.max(0, Math.round((1 - job.outputSize / job.inputSize) * 100));
  elements.savedPercent.textContent = `${saved}%`;
  elements.downloadButton.href = `/api/jobs/${job.id}/download`;
  elements.downloadButton.download = job.outputName;
  elements.downloadButton.querySelector('span').textContent = `Download your ${job.format.toUpperCase()}`;
  elements.resultPanel.dataset.actor = activeActor;
  show('resultPanel');
}

async function poll(jobId) {
  try {
    const response = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error);
    if (job.state === 'done') return finish(job);
    if (job.state === 'error') return fail(job.error);
    elements.progressPanel.classList.remove('uploading');
    elements.progressPanel.classList.add('transcoding');
    if (activeActor === 'kapa') {
      elements.progressEyebrow.textContent = "KAPA'S FORMAT-SWAP QUEST ✦";
      elements.progressTitle.textContent = 'Kapa is converting every frame';
      elements.progressNote.textContent = 'Dials are turning and pixels are finding new homes.';
    } else {
      elements.progressEyebrow.textContent = "MOMO'S COMPRESSION QUEST ✦";
      elements.progressTitle.textContent = 'Momo is making every frame cozier';
      elements.progressNote.textContent = 'The compressor is humming along nicely.';
    }
    setProgress(job.progress);
    pollTimer = setTimeout(() => poll(jobId), 800);
  } catch (error) {
    fail(error.message || 'Lost contact with the converter.');
  }
}

function compress() {
  if (!selectedFile) return;
  const profile = document.querySelector('input[name="profile"]:checked').value;
  const format = document.querySelector('input[name="format"]:checked').value;
  activeActor = activeMode === 'compress' ? 'momo' : 'kapa';
  elements.progressPanel.dataset.actor = activeActor;
  elements.workerName.textContent = activeActor === 'momo' ? 'MOMO' : 'KAPA';
  elements.workerRole.textContent = activeActor === 'momo' ? 'COMPRESSION CREW' : 'CONVERSION CREW';
  show('progressPanel');
  elements.progressPanel.classList.remove('transcoding');
  elements.progressPanel.classList.add('uploading');
  elements.progressEyebrow.textContent = 'LOADING THE WORKSHOP...';
  elements.progressTitle.textContent = `${activeActor === 'momo' ? 'Momo' : 'Kapa'} is getting everything ready`;
  elements.progressNote.textContent = 'Keep this little nook open while the adventure runs.';
  setProgress(0);

  xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/jobs?profile=${encodeURIComponent(profile)}&format=${encodeURIComponent(format)}`);
  xhr.setRequestHeader('Content-Type', selectedFile.type || 'application/octet-stream');
  xhr.setRequestHeader('X-File-Name', encodeURIComponent(selectedFile.name));
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) setProgress((event.loaded / event.total) * 100);
  };
  xhr.onload = () => {
    let body = {};
    try { body = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status !== 201) return fail(body.error || 'The upload could not be completed.');
    activeJob = body.id;
    setProgress(1);
    poll(body.id);
  };
  xhr.onerror = () => fail('The upload was interrupted. Please try again.');
  xhr.send(selectedFile);
}

elements.dropzone.addEventListener('click', () => elements.fileInput.click());
elements.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); elements.fileInput.click(); }
});
elements.fileInput.addEventListener('change', () => chooseFile(elements.fileInput.files[0]));
['dragenter', 'dragover'].forEach((name) => elements.dropzone.addEventListener(name, (event) => {
  event.preventDefault(); elements.dropzone.classList.add('dragging');
}));
['dragleave', 'drop'].forEach((name) => elements.dropzone.addEventListener(name, (event) => {
  event.preventDefault(); elements.dropzone.classList.remove('dragging');
}));
elements.dropzone.addEventListener('drop', (event) => chooseFile(event.dataTransfer.files[0]));
document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', () => {
  if (input.checked) setMode(input.value);
}));
elements.removeFile.addEventListener('click', reset);
elements.compressButton.addEventListener('click', compress);
elements.startOver.addEventListener('click', reset);
elements.tryAgain.addEventListener('click', () => {
  if (!selectedFile) return reset();
  if (configureFileForMode()) show('filePanel');
});
elements.cancelButton.addEventListener('click', async () => {
  if (xhr && xhr.readyState !== 4) xhr.abort();
  if (activeJob) await fetch(`/api/jobs/${activeJob}`, { method: 'DELETE' }).catch(() => {});
  reset();
});

setMode('compress');

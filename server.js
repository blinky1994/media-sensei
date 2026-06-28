const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');

const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORK_DIR = path.join(__dirname, '.media-compress-work');
const MAX_BYTES = 20 * 1024 * 1024 * 1024;
const JOB_TTL = 6 * 60 * 60 * 1000;

const jobs = new Map();

const profiles = {
  maximum: { h264Crf: '31', vp9Crf: '42', preset: 'medium', audio: '80k', maxWidth: 1280 },
  balanced: { h264Crf: '26', vp9Crf: '34', preset: 'medium', audio: '112k', maxWidth: 1920 },
  quality: { h264Crf: '22', vp9Crf: '28', preset: 'slow', audio: '160k', maxWidth: 3840 },
};

const formats = {
  mp4: { extension: 'mp4', mime: 'video/mp4', videoCodec: 'libx264', audioCodec: 'aac' },
  webm: { extension: 'webm', mime: 'video/webm', videoCodec: 'libvpx-vp9', audioCodec: 'libopus' },
  mov: { extension: 'mov', mime: 'video/quicktime', videoCodec: 'libx264', audioCodec: 'aac' },
};

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function safeName(value) {
  let decoded = value || 'video.mp4';
  try { decoded = decodeURIComponent(decoded); } catch {}
  const base = path.basename(decoded).replace(/[^a-zA-Z0-9._ -]/g, '_');
  return base.slice(0, 120) || 'video.mp4';
}

function publicJob(job) {
  return {
    id: job.id,
    state: job.state,
    progress: job.progress,
    inputSize: job.inputSize,
    outputSize: job.outputSize || null,
    originalName: job.originalName,
    outputName: job.outputName,
    format: job.format,
    error: job.error || null,
  };
}

async function removeJob(id) {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

function startCompression(job, profileName) {
  const profile = profiles[profileName] || profiles.balanced;
  const format = formats[job.format];
  job.state = 'compressing';
  job.progress = 1;
  let durationSeconds = 0;
  let stderrTail = '';
  const scale = `scale=trunc(min(${profile.maxWidth}\\,iw)/2)*2:-2`;
  const videoArgs = format.videoCodec === 'libvpx-vp9'
    ? ['-c:v', format.videoCodec, '-crf', profile.vp9Crf, '-b:v', '0', '-deadline', 'good', '-cpu-used', '2']
    : ['-c:v', format.videoCodec, '-preset', profile.preset, '-crf', profile.h264Crf];
  const containerArgs = job.format === 'webm' ? [] : ['-movflags', '+faststart'];
  const args = [
    '-y', '-i', job.inputPath,
    '-map_metadata', '-1',
    '-vf', scale,
    ...videoArgs,
    '-pix_fmt', 'yuv420p',
    ...containerArgs,
    '-c:a', format.audioCodec, '-b:a', profile.audio,
    job.outputPath,
  ];

  const process = spawn(ffmpegPath, args, { windowsHide: true });
  job.process = process;

  process.stderr.setEncoding('utf8');
  process.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-6000);
    if (!durationSeconds) {
      const duration = stderrTail.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (duration) durationSeconds = Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]);
    }
    const times = [...chunk.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    if (durationSeconds && times.length) {
      const t = times[times.length - 1];
      const current = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
      job.progress = Math.max(job.progress, Math.min(99, Math.round((current / durationSeconds) * 100)));
    }
  });

  process.on('error', (error) => {
    job.state = 'error';
    job.error = `Could not start the converter: ${error.message}`;
  });

  process.on('close', async (code) => {
    job.process = null;
    if (code === 0) {
      const stat = await fsp.stat(job.outputPath).catch(() => null);
      if (stat) {
        job.outputSize = stat.size;
        job.progress = 100;
        job.state = 'done';
        return;
      }
    }
    job.state = 'error';
    job.error = 'Compression failed. The file may be damaged or use an unsupported codec.';
    console.error(`FFmpeg failed for job ${job.id}:\n${stderrTail}`);
  });
}

async function createJob(req, res, url) {
  const size = Number(req.headers['content-length'] || 0);
  const originalName = safeName(req.headers['x-file-name']);
  const profile = url.searchParams.get('profile') || 'balanced';
  const formatName = url.searchParams.get('format') || 'mp4';
  if (!profiles[profile]) return sendJson(res, 400, { error: 'Unknown compression profile.' });
  if (!formats[formatName]) return sendJson(res, 400, { error: 'Unknown output format.' });
  if (!size) return sendJson(res, 411, { error: 'The file size is required.' });
  if (size > MAX_BYTES) return sendJson(res, 413, { error: 'Files larger than 20 GB are not supported.' });

  const id = randomUUID();
  const dir = path.join(WORK_DIR, id);
  await fsp.mkdir(dir, { recursive: true });
  const ext = path.extname(originalName) || '.mp4';
  const stem = path.basename(originalName, ext);
  const inputPath = path.join(dir, `input${ext}`);
  const outputName = `${stem}-media-sensei.${formats[formatName].extension}`;
  const outputPath = path.join(dir, `converted.${formats[formatName].extension}`);
  const output = fs.createWriteStream(inputPath, { flags: 'wx' });

  let received = 0;
  let failed = false;
  const discardPartialUpload = async () => {
    if (failed) return;
    failed = true;
    output.destroy();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_BYTES && !failed) {
      discardPartialUpload();
      req.destroy(new Error('File too large'));
    }
  });
  req.on('aborted', discardPartialUpload);
  req.on('error', discardPartialUpload);
  req.pipe(output);

  output.on('error', async () => {
    failed = true;
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (!res.headersSent) sendJson(res, 500, { error: 'Could not save the uploaded file.' });
  });

  output.on('finish', () => {
    if (failed) return;
    const job = {
      id, dir, inputPath, outputPath, originalName, outputName, format: formatName,
      inputSize: received, outputSize: null, state: 'queued', progress: 0,
      createdAt: Date.now(), process: null,
    };
    jobs.set(id, job);
    sendJson(res, 201, publicJob(job));
    startCompression(job, profile);
  });
}

async function serveFile(res, filePath, headers = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return sendJson(res, 404, { error: 'File not found.' });
  res.writeHead(200, { 'Content-Length': stat.size, ...headers });
  fs.createReadStream(filePath).pipe(res);
}

async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'POST' && url.pathname === '/api/jobs') return createJob(req, res, url);

  const match = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+)(?:\/(download))?$/);
  if (match) {
    const job = jobs.get(match[1]);
    if (!job) return sendJson(res, 404, { error: 'This conversion job has expired.' });
    if (req.method === 'GET' && match[2] === 'download') {
      if (job.state !== 'done') return sendJson(res, 409, { error: 'The video is not ready yet.' });
      return serveFile(res, job.outputPath, {
        'Content-Type': formats[job.format].mime,
        'Content-Disposition': `attachment; filename="${job.outputName.replace(/"/g, '')}"`,
      });
    }
    if (req.method === 'GET' && !match[2]) return sendJson(res, 200, publicJob(job));
    if (req.method === 'DELETE' && !match[2]) {
      if (job.process) job.process.kill();
      await removeJob(job.id);
      res.writeHead(204).end();
      return;
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 404, { error: 'Not found.' });
  const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) return sendJson(res, 403, { error: 'Forbidden.' });
  return serveFile(res, filePath, {
    'Content-Type': mime[path.extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
}

async function main() {
  await fsp.mkdir(WORK_DIR, { recursive: true });
  const stale = await fsp.readdir(WORK_DIR).catch(() => []);
  await Promise.all(stale.map((entry) => fsp.rm(path.join(WORK_DIR, entry), { recursive: true, force: true })));
  setInterval(() => {
    for (const job of jobs.values()) if (Date.now() - job.createdAt > JOB_TTL) removeJob(job.id);
  }, 15 * 60 * 1000).unref();
  http.createServer((req, res) => handler(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong.' });
  })).listen(PORT, HOST, () => console.log(`Media Sensei is running at http://${HOST}:${PORT}`));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

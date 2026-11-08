/* Pure helpers: MIME types, formatting, command parsing, probe parsing, errors. */

export const INPUT_PLACEHOLDER = 'input_file';

export const MIME_TYPES = {
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  ogv: 'video/ogg',
  '3gp': 'video/3gpp',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  amr: 'audio/amr',
  // image
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ico: 'image/x-icon',
};

export const getExt = (name = '') => {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toLowerCase() : '';
};

export const baseName = (name = 'file') =>
  name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').slice(0, 60) || 'file';

export const getMime = (name) => MIME_TYPES[getExt(name)] || 'application/octet-stream';

export const kindFromMime = (mime = '') => {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  return 'file';
};

export const kindFromFile = (file) => {
  if (!file) return null;
  const byType = kindFromMime(file.type);
  return byType !== 'file' ? byType : kindFromMime(getMime(file.name));
};

/* ------------------------------- Formatting ------------------------------- */

export const formatBytes = (bytes) => {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
};

/** 83.4 -> "1:23", 3723 -> "1:02:03" */
export const formatClock = (sec) => {
  if (sec == null || !Number.isFinite(sec)) return '';
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = Math.floor(s % 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
};

/** "1:23" | "83" | "1:02:03.5" -> seconds (number) or null */
export const parseClock = (str) => {
  if (str == null) return null;
  const t = String(str).trim();
  if (!t) return null;
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return NaN;
  return t.split(':').reduce((acc, part) => acc * 60 + parseFloat(part), 0);
};

export const formatEta = (sec) => {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 10) return 'a few seconds left';
  if (sec < 60) return `about ${Math.round(sec / 5) * 5} seconds left`;
  const m = Math.round(sec / 60);
  return `about ${m} minute${m > 1 ? 's' : ''} left`;
};

/* ---------------------------- Command parsing ----------------------------- */

/** Shell-like tokenizer that respects single and double quotes around whole tokens. */
export const tokenize = (cmd) => {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
};

/**
 * Turns a command string into an FFmpeg argument array.
 * - strips a leading "ffmpeg"
 * - replaces `input_file` with the real virtual-FS input path
 * - detects (or falls back to) the output filename
 */
export const buildArgs = (command, inputPath) => {
  let tokens = tokenize(String(command || '').trim());
  if (tokens[0]?.toLowerCase() === 'ffmpeg') tokens = tokens.slice(1);

  tokens = tokens.map((t) => (t === INPUT_PLACEHOLDER ? inputPath : t));
  if (!tokens.includes('-i')) tokens = ['-i', inputPath, ...tokens];

  const last = tokens[tokens.length - 1];
  const prev = tokens[tokens.length - 2];
  const looksLikeOutput =
    last && !last.startsWith('-') && last !== inputPath && prev !== '-i' && getExt(last) !== '';

  let outputName;
  if (looksLikeOutput) {
    outputName = last.split('/').pop().replace(/[^\w.\-]/g, '_');
    tokens[tokens.length - 1] = outputName;
  } else {
    outputName = 'output.mp4';
    tokens.push(outputName);
  }

  if (`/${outputName}` === inputPath || outputName === inputPath) {
    outputName = `out_${outputName}`;
    tokens[tokens.length - 1] = outputName;
  }

  // Always allow overwriting inside the virtual FS (never prompts).
  if (!tokens.includes('-y')) tokens.unshift('-y');

  return { args: tokens, outputName };
};

/* ------------------------------ Probe parsing ----------------------------- */

const toSeconds = (h, m, s) => +h * 3600 + +m * 60 + parseFloat(s);

/** Parses the stderr of `ffmpeg -i file` into a friendly info object. */
export const parseProbe = (lines) => {
  const text = lines.join('\n');
  const info = { duration: null, width: null, height: null, vcodec: null, acodec: null, hasVideo: false, hasAudio: false };

  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (d) {
    const sec = toSeconds(d[1], d[2], d[3]);
    if (sec > 0.05) info.duration = sec;
  }

  for (const line of lines) {
    const v = /Stream #\d+:\d+.*?: Video: ([\w-]+)/.exec(line);
    if (v && !/attached pic/i.test(line) && !info.hasVideo) {
      info.hasVideo = true;
      info.vcodec = v[1];
      const size = /\s(\d{2,5})x(\d{2,5})(?=[\s,\]])/.exec(line);
      if (size) {
        info.width = +size[1];
        info.height = +size[2];
      }
    }
    const a = /Stream #\d+:\d+.*?: Audio: ([\w-]+)/.exec(line);
    if (a && !info.hasAudio) {
      info.hasAudio = true;
      info.acodec = a[1];
    }
  }

  // Phone videos: honour rotation metadata (FFmpeg auto-rotates on encode).
  const rot = /rotation of (-?\d+(?:\.\d+)?)/.exec(text) || /rotate\s*:\s*(-?\d+)/.exec(text);
  if (rot && Math.abs(Math.round(+rot[1])) % 180 === 90 && info.width) {
    [info.width, info.height] = [info.height, info.width];
  }

  return info;
};

/** Parses "time=00:00:05.12" from an FFmpeg progress log line. */
export const parseLogTime = (line) => {
  const m = /time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  return m ? toSeconds(m[1], m[2], m[3]) : null;
};

/* --------------------------------- Errors --------------------------------- */

export const friendlyError = (raw = '', logs = []) => {
  const text = `${raw}\n${logs.slice(-40).join('\n')}`;
  const rules = [
    [/out of memory|OOM|Cannot enlarge memory|memory access out of bounds|Array buffer allocation failed/i,
      'Your browser ran out of memory. Try a smaller file, a lower resolution, or a shorter clip.'],
    [/moov atom not found|Invalid data found|could not find codec parameters|End of file/i,
      'This file seems damaged or its format isn\u2019t supported.'],
    [/Unknown encoder|Encoder .* not found|Unknown decoder|Decoder .* not found/i,
      'This format isn\u2019t supported in the browser version of FFmpeg. Try a different output format.'],
    [/does not contain any stream|matches no streams|Output file is empty/i,
      'The file doesn\u2019t contain the audio or video needed for this action.'],
    [/No such filter|Error parsing|Unrecognized option|Invalid argument|Option not found|Error opening output/i,
      'The FFmpeg command has an error. Check the advanced command and try again.'],
  ];
  for (const [re, msg] of rules) if (re.test(text)) return msg;
  return 'Something went wrong while converting. Open \u201cTechnical details\u201d below for the full log.';
};


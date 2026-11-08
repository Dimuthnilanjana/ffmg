/*
 * Task catalogue. Every task:
 *  - has a plain-language name + description for non-technical users
 *  - declares simple options (rendered automatically by the UI)
 *  - builds the FFmpeg arguments itself, so users never need to know FFmpeg
 */
import { baseName, getExt, parseClock } from './media';

/* --------------------------------- Helpers -------------------------------- */

const X264_FAST = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];
const WEB_READY = ['-movflags', '+faststart'];

/** Containers we can safely stream-copy video into, with a matching audio codec. */
const sameContainer = (file) => {
  const ext = getExt(file.name);
  if (['mp4', 'm4v', 'mov'].includes(ext)) return { ext, acodec: ['-c:a', 'aac', '-b:a', '160k'], extra: WEB_READY };
  if (ext === 'mkv') return { ext, acodec: ['-c:a', 'aac', '-b:a', '160k'], extra: [] };
  if (ext === 'webm') return { ext, acodec: ['-c:a', 'libopus', '-b:a', '128k'], extra: [] };
  return null;
};

const timeOrNull = (v) => {
  const s = parseClock(v);
  return Number.isFinite(s) ? s : null;
};

/** -ss / -t arguments plus resulting duration, from start/end option strings. */
const trimArgs = (o, info) => {
  const start = timeOrNull(o.start) ?? 0;
  const end = timeOrNull(o.end);
  const pre = start > 0 ? ['-ss', start.toFixed(3)] : [];
  let dur = null;
  if (end != null && end > start) dur = end - start;
  const post = dur != null ? ['-t', dur.toFixed(3)] : [];
  const total = info?.duration;
  const expected = dur ?? (total ? Math.max(0, total - start) : null);
  return { pre, post, expected, start, end };
};

const validateTrim = (o, info) => {
  const s = parseClock(o.start);
  const e = parseClock(o.end);
  if (Number.isNaN(s)) return 'Start time should look like 0:15 or 1:02:30.';
  if (Number.isNaN(e)) return 'End time should look like 0:45 or 1:02:30.';
  if (s != null && e != null && e <= s) return 'End time must be after the start time.';
  if (info?.duration && s != null && s >= info.duration) return 'Start time is after the end of the file.';
  return null;
};

/** atempo only accepts 0.5–2.0 per filter, so chain them. */
const atempoChain = (speed) => {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  parts.push(`atempo=${+s.toFixed(4)}`);
  return parts.join(',');
};

const ROTATE_FILTERS = {
  right: 'transpose=1',
  left: 'transpose=2',
  '180': 'transpose=1,transpose=1',
  hflip: 'hflip',
  vflip: 'vflip',
};

const ROTATE_OPTION = {
  key: 'rotate',
  type: 'choice',
  label: 'How should it turn?',
  default: 'right',
  options: [
    { value: 'right', label: '↻ 90° right' },
    { value: 'left', label: '↺ 90° left' },
    { value: '180', label: '⟳ Upside down' },
    { value: 'hflip', label: '⇋ Mirror' },
    { value: 'vflip', label: '⇵ Flip vertical' },
  ],
};

const AUDIO_FORMATS = {
  mp3: { label: 'MP3', hint: 'Plays everywhere', args: (br) => ['-c:a', 'libmp3lame', '-b:a', `${br}k`] },
  m4a: { label: 'M4A', hint: 'Apple / iPhone', args: (br) => ['-c:a', 'aac', '-b:a', `${br}k`] },
  wav: { label: 'WAV', hint: 'Uncompressed', args: () => ['-c:a', 'pcm_s16le'] },
  ogg: { label: 'OGG', hint: 'Open format', args: (br) => ['-c:a', 'libvorbis', '-b:a', `${br}k`] },
  flac: { label: 'FLAC', hint: 'Lossless', args: () => ['-c:a', 'flac'] },
};

const AUDIO_FORMAT_OPTION = {
  key: 'format',
  type: 'choice',
  label: 'Audio format',
  default: 'mp3',
  options: Object.entries(AUDIO_FORMATS).map(([value, f]) => ({ value, label: f.label, hint: f.hint })),
};

const AUDIO_QUALITY_OPTION = {
  key: 'bitrate',
  type: 'choice',
  label: 'Sound quality',
  default: '192',
  showIf: (o) => !['wav', 'flac'].includes(o.format),
  options: [
    { value: '96', label: 'Small file', hint: '96 kbps · voice' },
    { value: '128', label: 'Good', hint: '128 kbps' },
    { value: '192', label: 'Great', hint: '192 kbps · music' },
    { value: '320', label: 'Best', hint: '320 kbps' },
  ],
};

const TRIM_OPTIONS = [
  { key: 'start', type: 'time', label: 'Start at', placeholder: '0:00', default: '' },
  { key: 'end', type: 'time', label: 'End at', placeholder: 'end of file', default: '' },
];

const audioOut = (o, file, suffix) => {
  const fmt = AUDIO_FORMATS[o.format] ? o.format : 'mp3';
  return {
    codec: AUDIO_FORMATS[fmt].args(o.bitrate || 192),
    ext: fmt,
    name: `${baseName(file.name)}${suffix}.${fmt}`,
  };
};

/** Same audio format as the input if we can encode it, otherwise MP3. */
const sameAudioFormat = (file) => {
  const ext = getExt(file.name);
  if (ext === 'aac') return 'm4a';
  return AUDIO_FORMATS[ext] ? ext : 'mp3';
};

const IMAGE_FORMATS = {
  jpg: { label: 'JPG', hint: 'Photos · small', args: (q) => ['-q:v', String(Math.round(31 - (q / 100) * 29))] },
  png: { label: 'PNG', hint: 'Sharp · keeps transparency', args: () => ['-compression_level', '9'] },
  webp: { label: 'WEBP', hint: 'Modern web · smallest', args: (q) => ['-c:v', 'libwebp', '-quality', String(q)] },
  bmp: { label: 'BMP', hint: 'Uncompressed', args: () => [] },
  gif: { label: 'GIF', hint: 'Old-school web', args: () => [] },
  ico: { label: 'ICO', hint: 'Website icon', args: () => ['-vf', 'scale=256:256:force_original_aspect_ratio=decrease'] },
};

const sameImageFormat = (file) => {
  const ext = getExt(file.name);
  if (ext === 'jpeg') return 'jpg';
  return IMAGE_FORMATS[ext] && ext !== 'ico' ? ext : 'png';
};

const QUALITY_SLIDER = {
  key: 'quality',
  type: 'range',
  label: 'Quality',
  min: 10,
  max: 100,
  step: 5,
  default: 80,
  unit: '%',
  help: 'Lower = smaller file. 75–85% looks great for most photos.',
};

/* ---------------------------------- Tasks --------------------------------- */

export const TASKS = [
  /* ================================ VIDEO ================================ */
  {
    id: 'compress-video',
    kinds: ['video'],
    icon: '🗜️',
    title: 'Make video smaller',
    description: 'Shrink the file size for WhatsApp, email or uploads.',
    popular: true,
    options: [
      {
        key: 'goal',
        type: 'choice',
        label: 'What matters most?',
        default: 'balanced',
        options: [
          { value: 'quality', label: 'Best quality', hint: 'A bit smaller' },
          { value: 'balanced', label: 'Balanced', hint: 'Recommended' },
          { value: 'small', label: 'Smallest file', hint: 'Lower quality' },
          { value: 'size', label: 'Exact size', hint: 'Pick a size in MB' },
        ],
      },
      {
        key: 'targetMB',
        type: 'number',
        label: 'Target size',
        unit: 'MB',
        min: 1,
        max: 4000,
        default: 16,
        help: 'WhatsApp ≈ 16 MB · Gmail ≈ 25 MB · Discord ≈ 10 MB',
        showIf: (o) => o.goal === 'size',
      },
      {
        key: 'maxHeight',
        type: 'select',
        label: 'Maximum resolution',
        default: '0',
        options: [
          { value: '0', label: 'Keep original' },
          { value: '1080', label: '1080p (Full HD)' },
          { value: '720', label: '720p (HD) — great for phones' },
          { value: '480', label: '480p (SD)' },
          { value: '360', label: '360p (very small)' },
        ],
      },
      { key: 'mute', type: 'toggle', label: 'Remove sound', default: false },
    ],
    validate: (o, info) => {
      if (o.goal === 'size') {
        if (!(+o.targetMB > 0)) return 'Enter a target size in MB.';
        if (!info?.duration) return 'Couldn\u2019t read the video length, so an exact size isn\u2019t possible. Choose another option.';
        const kbps = ((+o.targetMB * 8192) / info.duration) - (o.mute ? 0 : 96);
        if (kbps < 80) return 'That size is too small for this video\u2019s length. Try a bigger size or trim the video first.';
      }
      return null;
    },
    build: ({ o, info, file, input }) => {
      const preset = { quality: { crf: 23, ab: 160 }, balanced: { crf: 28, ab: 128 }, small: { crf: 32, ab: 96 } }[o.goal];
      const vf = [];
      const h = +o.maxHeight;
      if (h && (!info?.height || info.height > h)) vf.push(`scale=-2:${h}`);

      let rate;
      if (o.goal === 'size') {
        const audioK = o.mute ? 0 : 96;
        const videoK = Math.floor(((+o.targetMB * 8192) / info.duration) * 0.96 - audioK);
        rate = ['-b:v', `${videoK}k`, '-maxrate', `${Math.round(videoK * 1.3)}k`, '-bufsize', `${videoK * 2}k`];
      } else {
        rate = ['-crf', String(preset.crf)];
      }
      const audio = o.mute ? ['-an'] : ['-c:a', 'aac', '-b:a', `${o.goal === 'size' ? 96 : preset.ab}k`];
      return {
        args: ['-i', input, ...(vf.length ? ['-vf', vf.join(',')] : []), ...X264_FAST, ...rate, ...audio, ...WEB_READY, 'out.mp4'],
        outputName: 'out.mp4',
        downloadName: `${baseName(file.name)}_small.mp4`,
      };
    },
  },
  {
    id: 'convert-video',
    kinds: ['video'],
    icon: '🔄',
    title: 'Convert video format',
    description: 'Change to MP4, WebM, MOV, MKV or AVI.',
    popular: true,
    options: [
      {
        key: 'format',
        type: 'choice',
        label: 'Convert to',
        default: 'mp4',
        options: [
          { value: 'mp4', label: 'MP4', hint: 'Works everywhere' },
          { value: 'webm', label: 'WebM', hint: 'For websites' },
          { value: 'mov', label: 'MOV', hint: 'Apple / iMovie' },
          { value: 'mkv', label: 'MKV', hint: 'Media players' },
          { value: 'avi', label: 'AVI', hint: 'Older devices' },
        ],
      },
      {
        key: 'quick',
        type: 'toggle',
        label: 'Quick mode',
        help: 'Copies the video without re-encoding — nearly instant and no quality loss, but may fail for some files. Turn off if it fails.',
        default: false,
        showIf: (o) => ['mp4', 'mov', 'mkv'].includes(o.format),
      },
    ],
    build: ({ o, file, input }) => {
      const f = o.format;
      let codec;
      if (o.quick && ['mp4', 'mov', 'mkv'].includes(f)) codec = ['-c', 'copy'];
      else if (f === 'webm') codec = ['-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '10', '-b:v', '2M', '-c:a', 'libvorbis', '-b:a', '128k'];
      else if (f === 'avi') codec = ['-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame', '-b:a', '160k'];
      else codec = [...X264_FAST, '-crf', '23', '-c:a', 'aac', '-b:a', '160k'];
      const extra = ['mp4', 'mov'].includes(f) ? WEB_READY : [];
      return {
        args: ['-i', input, ...codec, ...extra, `out.${f}`],
        outputName: `out.${f}`,
        downloadName: `${baseName(file.name)}.${f}`,
      };
    },
  },
  {
    id: 'trim-video',
    kinds: ['video'],
    icon: '✂️',
    title: 'Cut / trim video',
    description: 'Keep only the part you need.',
    popular: true,
    usesTimeline: true,
    options: [
      ...TRIM_OPTIONS,
      {
        key: 'quick',
        type: 'toggle',
        label: 'Instant cut',
        help: 'Much faster and keeps original quality, but the cut may be a second or two off.',
        default: false,
      },
    ],
    validate: validateTrim,
    build: ({ o, info, file, input }) => {
      const { pre, post, expected } = trimArgs(o, info);
      const same = sameContainer(file);
      if (o.quick && same) {
        return {
          args: [...pre, '-i', input, ...post, '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...same.extra, `out.${same.ext}`],
          outputName: `out.${same.ext}`,
          downloadName: `${baseName(file.name)}_cut.${same.ext}`,
          expectedDuration: expected,
        };
      }
      return {
        args: [...pre, '-i', input, ...post, ...X264_FAST, '-crf', '22', '-c:a', 'aac', '-b:a', '160k', ...WEB_READY, 'out.mp4'],
        outputName: 'out.mp4',
        downloadName: `${baseName(file.name)}_cut.mp4`,
        expectedDuration: expected,
      };
    },
  },
  {
    id: 'extract-audio',
    kinds: ['video'],
    icon: '🎵',
    title: 'Get audio from video',
    description: 'Save the sound as MP3, M4A, WAV and more.',
    popular: true,
    requiresAudio: true,
    options: [AUDIO_FORMAT_OPTION, AUDIO_QUALITY_OPTION],
    build: ({ o, file, input }) => {
      const out = audioOut(o, file, '_audio');
      return {
        args: ['-i', input, '-vn', ...out.codec, `out.${out.ext}`],
        outputName: `out.${out.ext}`,
        downloadName: out.name,
      };
    },
  },
  {
    id: 'resize-video',
    kinds: ['video'],
    icon: '📐',
    title: 'Change video resolution',
    description: 'Resize to 1080p, 720p, 480p and more.',
    options: [
      {
        key: 'height',
        type: 'choice',
        label: 'New resolution',
        default: '720',
        options: [
          { value: '1080', label: '1080p', hint: 'Full HD' },
          { value: '720', label: '720p', hint: 'HD' },
          { value: '480', label: '480p', hint: 'SD' },
          { value: '360', label: '360p', hint: 'Small' },
          { value: '240', label: '240p', hint: 'Tiny' },
        ],
      },
    ],
    validate: (o, info) =>
      info?.height && +o.height >= info.height
        ? `Your video is already ${info.height}p. Pick a smaller size (making it bigger won\u2019t add detail).`
        : null,
    build: ({ o, file, input }) => ({
      args: ['-i', input, '-vf', `scale=-2:${o.height}`, ...X264_FAST, '-crf', '23', '-c:a', 'aac', '-b:a', '128k', ...WEB_READY, 'out.mp4'],
      outputName: 'out.mp4',
      downloadName: `${baseName(file.name)}_${o.height}p.mp4`,
    }),
  },
  {
    id: 'video-to-gif',
    kinds: ['video'],
    icon: '🎞️',
    title: 'Turn video into GIF',
    description: 'Create a looping animated GIF.',
    usesTimeline: true,
    options: [
      { key: 'start', type: 'time', label: 'Start at', placeholder: '0:00', default: '' },
      {
        key: 'length',
        type: 'range',
        label: 'Length',
        min: 1,
        max: 20,
        step: 1,
        default: 5,
        unit: 's',
        help: 'GIFs get big quickly — keep them short.',
      },
      {
        key: 'width',
        type: 'choice',
        label: 'Size',
        default: '480',
        options: [
          { value: '320', label: 'Small', hint: '320 px' },
          { value: '480', label: 'Medium', hint: '480 px' },
          { value: '640', label: 'Large', hint: '640 px' },
        ],
      },
      {
        key: 'fps',
        type: 'choice',
        label: 'Smoothness',
        default: '12',
        options: [
          { value: '8', label: 'Low', hint: 'Smallest' },
          { value: '12', label: 'Normal' },
          { value: '20', label: 'Smooth', hint: 'Larger' },
        ],
      },
    ],
    validate: (o, info) => {
      const s = parseClock(o.start);
      if (Number.isNaN(s)) return 'Start time should look like 0:15.';
      if (info?.duration && s != null && s >= info.duration) return 'Start time is after the end of the video.';
      return null;
    },
    build: ({ o, file, input }) => {
      const start = timeOrNull(o.start) ?? 0;
      const vf = `fps=${o.fps},scale=${o.width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`;
      return {
        args: [...(start ? ['-ss', start.toFixed(3)] : []), '-t', String(o.length), '-i', input, '-vf', vf, '-loop', '0', 'out.gif'],
        outputName: 'out.gif',
        downloadName: `${baseName(file.name)}.gif`,
        expectedDuration: +o.length,
      };
    },
  },
  {
    id: 'mute-video',
    kinds: ['video'],
    icon: '🔇',
    title: 'Remove sound',
    description: 'Make the video silent. Very fast.',
    requiresAudio: true,
    options: [],
    build: ({ file, input }) => {
      const same = sameContainer(file);
      if (same) {
        return {
          args: ['-i', input, '-c:v', 'copy', '-an', ...same.extra, `out.${same.ext}`],
          outputName: `out.${same.ext}`,
          downloadName: `${baseName(file.name)}_silent.${same.ext}`,
        };
      }
      return {
        args: ['-i', input, '-an', ...X264_FAST, '-crf', '23', ...WEB_READY, 'out.mp4'],
        outputName: 'out.mp4',
        downloadName: `${baseName(file.name)}_silent.mp4`,
      };
    },
  },
  {
    id: 'rotate-video',
    kinds: ['video'],
    icon: '🔃',
    title: 'Rotate or flip video',
    description: 'Fix sideways or upside-down videos.',
    options: [ROTATE_OPTION],
    build: ({ o, file, input }) => ({
      args: ['-i', input, '-vf', ROTATE_FILTERS[o.rotate], ...X264_FAST, '-crf', '22', '-c:a', 'aac', '-b:a', '160k', ...WEB_READY, 'out.mp4'],
      outputName: 'out.mp4',
      downloadName: `${baseName(file.name)}_rotated.mp4`,
    }),
  },
  {
    id: 'speed-video',
    kinds: ['video'],
    icon: '⏩',
    title: 'Speed up or slow down',
    description: 'Make a time-lapse or slow-motion clip.',
    options: [
      {
        key: 'speed',
        type: 'choice',
        label: 'New speed',
        default: '2',
        options: [
          { value: '0.25', label: '0.25×', hint: 'Very slow' },
          { value: '0.5', label: '0.5×', hint: 'Slow-mo' },
          { value: '1.5', label: '1.5×' },
          { value: '2', label: '2×', hint: 'Fast' },
          { value: '4', label: '4×', hint: 'Very fast' },
          { value: '8', label: '8×', hint: 'Time-lapse' },
        ],
      },
      { key: 'mute', type: 'toggle', label: 'Remove sound', default: false },
    ],
    build: ({ o, info, file, input }) => {
      const s = +o.speed;
      const audio = o.mute || !info?.hasAudio ? ['-an'] : ['-af', atempoChain(s), '-c:a', 'aac', '-b:a', '128k'];
      return {
        args: ['-i', input, '-vf', `setpts=PTS/${s}`, ...audio, ...X264_FAST, '-crf', '23', ...WEB_READY, 'out.mp4'],
        outputName: 'out.mp4',
        downloadName: `${baseName(file.name)}_${o.speed}x.mp4`,
        expectedDuration: info?.duration ? info.duration / s : null,
      };
    },
  },
  {
    id: 'volume-video',
    kinds: ['video'],
    icon: '🔊',
    title: 'Make video louder or quieter',
    description: 'Boost or lower the volume.',
    requiresAudio: true,
    options: [
      {
        key: 'volume',
        type: 'choice',
        label: 'Volume',
        default: '2',
        options: [
          { value: '0.25', label: '25%', hint: 'Much quieter' },
          { value: '0.5', label: '50%', hint: 'Quieter' },
          { value: '1.5', label: '150%', hint: 'Louder' },
          { value: '2', label: '200%', hint: 'Much louder' },
          { value: '3', label: '300%', hint: 'Max boost' },
        ],
      },
    ],
    build: ({ o, file, input }) => {
      const same = sameContainer(file);
      const af = ['-af', `volume=${o.volume}`];
      if (same) {
        return {
          args: ['-i', input, '-c:v', 'copy', ...af, ...same.acodec, ...same.extra, `out.${same.ext}`],
          outputName: `out.${same.ext}`,
          downloadName: `${baseName(file.name)}_volume.${same.ext}`,
        };
      }
      return {
        args: ['-i', input, ...af, ...X264_FAST, '-crf', '23', '-c:a', 'aac', '-b:a', '160k', ...WEB_READY, 'out.mp4'],
        outputName: 'out.mp4',
        downloadName: `${baseName(file.name)}_volume.mp4`,
      };
    },
  },
  {
    id: 'screenshot',
    kinds: ['video'],
    icon: '📸',
    title: 'Save a still picture',
    description: 'Grab a frame from the video as an image.',
    usesTimeline: true,
    options: [
      { key: 'at', type: 'time', label: 'Take picture at', placeholder: '0:00', default: '' },
      {
        key: 'format',
        type: 'choice',
        label: 'Image format',
        default: 'jpg',
        options: [
          { value: 'jpg', label: 'JPG', hint: 'Smaller' },
          { value: 'png', label: 'PNG', hint: 'Sharpest' },
          { value: 'webp', label: 'WEBP', hint: 'Modern' },
        ],
      },
    ],
    validate: (o, info) => {
      const s = parseClock(o.at);
      if (Number.isNaN(s)) return 'Time should look like 0:15.';
      if (info?.duration && s != null && s >= info.duration) return 'That time is after the end of the video.';
      return null;
    },
    build: ({ o, file, input }) => {
      const at = timeOrNull(o.at) ?? 0;
      const f = o.format;
      return {
        args: [...(at ? ['-ss', at.toFixed(3)] : []), '-i', input, '-frames:v', '1', ...IMAGE_FORMATS[f].args(92), `out.${f}`],
        outputName: `out.${f}`,
        downloadName: `${baseName(file.name)}_frame.${f}`,
      };
    },
  },

  /* ================================ AUDIO ================================ */
  {
    id: 'convert-audio',
    kinds: ['audio'],
    icon: '🔄',
    title: 'Convert audio format',
    description: 'Change to MP3, M4A, WAV, OGG or FLAC.',
    popular: true,
    options: [AUDIO_FORMAT_OPTION, AUDIO_QUALITY_OPTION],
    build: ({ o, file, input }) => {
      const out = audioOut(o, file, '');
      return {
        args: ['-i', input, '-vn', ...out.codec, `out.${out.ext}`],
        outputName: `out.${out.ext}`,
        downloadName: out.name,
      };
    },
  },
  {
    id: 'compress-audio',
    kinds: ['audio'],
    icon: '🗜️',
    title: 'Make audio smaller',
    description: 'Reduce file size for sharing.',
    popular: true,
    options: [
      {
        key: 'level',
        type: 'choice',
        label: 'How small?',
        default: '96',
        options: [
          { value: '128', label: 'A little', hint: 'Music OK' },
          { value: '96', label: 'Balanced', hint: 'Recommended' },
          { value: '64', label: 'A lot', hint: 'Voice / podcasts' },
          { value: '32', label: 'Maximum', hint: 'Voice only' },
        ],
      },
      { key: 'mono', type: 'toggle', label: 'Mono (single channel)', help: 'Halves the size. Perfect for speech.', default: false },
    ],
    build: ({ o, file, input }) => ({
      args: ['-i', input, '-vn', ...(o.mono ? ['-ac', '1'] : []), '-c:a', 'libmp3lame', '-b:a', `${o.level}k`, 'out.mp3'],
      outputName: 'out.mp3',
      downloadName: `${baseName(file.name)}_small.mp3`,
    }),
  },
  {
    id: 'trim-audio',
    kinds: ['audio'],
    icon: '✂️',
    title: 'Cut / trim audio',
    description: 'Make a ringtone or keep just one part.',
    popular: true,
    usesTimeline: true,
    options: [
      ...TRIM_OPTIONS,
      { key: 'fade', type: 'toggle', label: 'Smooth fade in & out', default: true },
    ],
    validate: validateTrim,
    build: ({ o, info, file, input }) => {
      const { pre, post, expected } = trimArgs(o, info);
      const fmt = sameAudioFormat(file);
      const af = [];
      if (o.fade && expected) {
        const f = Math.min(1.5, expected / 4);
        af.push(`afade=t=in:d=${f.toFixed(2)}`, `afade=t=out:st=${(expected - f).toFixed(2)}:d=${f.toFixed(2)}`);
      }
      return {
        args: [...pre, '-i', input, ...post, '-vn', ...(af.length ? ['-af', af.join(',')] : []), ...AUDIO_FORMATS[fmt].args(192), `out.${fmt}`],
        outputName: `out.${fmt}`,
        downloadName: `${baseName(file.name)}_cut.${fmt}`,
        expectedDuration: expected,
      };
    },
  },
  {
    id: 'volume-audio',
    kinds: ['audio'],
    icon: '🔊',
    title: 'Louder or quieter',
    description: 'Change the volume of your audio.',
    options: [
      {
        key: 'volume',
        type: 'choice',
        label: 'Volume',
        default: '2',
        options: [
          { value: '0.25', label: '25%', hint: 'Much quieter' },
          { value: '0.5', label: '50%', hint: 'Quieter' },
          { value: '1.5', label: '150%', hint: 'Louder' },
          { value: '2', label: '200%', hint: 'Much louder' },
          { value: '3', label: '300%', hint: 'Max boost' },
        ],
      },
    ],
    build: ({ o, file, input }) => {
      const fmt = sameAudioFormat(file);
      return {
        args: ['-i', input, '-vn', '-af', `volume=${o.volume}`, ...AUDIO_FORMATS[fmt].args(192), `out.${fmt}`],
        outputName: `out.${fmt}`,
        downloadName: `${baseName(file.name)}_volume.${fmt}`,
      };
    },
  },
  {
    id: 'speed-audio',
    kinds: ['audio'],
    icon: '⏩',
    title: 'Speed up or slow down',
    description: 'Change playback speed without chipmunk voices.',
    options: [
      {
        key: 'speed',
        type: 'choice',
        label: 'New speed',
        default: '1.5',
        options: [
          { value: '0.5', label: '0.5×' },
          { value: '0.75', label: '0.75×' },
          { value: '1.25', label: '1.25×' },
          { value: '1.5', label: '1.5×' },
          { value: '2', label: '2×' },
        ],
      },
    ],
    build: ({ o, info, file, input }) => {
      const fmt = sameAudioFormat(file);
      return {
        args: ['-i', input, '-vn', '-af', atempoChain(+o.speed), ...AUDIO_FORMATS[fmt].args(192), `out.${fmt}`],
        outputName: `out.${fmt}`,
        downloadName: `${baseName(file.name)}_${o.speed}x.${fmt}`,
        expectedDuration: info?.duration ? info.duration / +o.speed : null,
      };
    },
  },

  /* ================================ IMAGE ================================ */
  {
    id: 'convert-image',
    kinds: ['image'],
    icon: '🔄',
    title: 'Convert image format',
    description: 'Change to JPG, PNG, WEBP, GIF, BMP or ICO.',
    popular: true,
    options: [
      {
        key: 'format',
        type: 'choice',
        label: 'Convert to',
        default: 'jpg',
        options: Object.entries(IMAGE_FORMATS).map(([value, f]) => ({ value, label: f.label, hint: f.hint })),
      },
      { ...QUALITY_SLIDER, showIf: (o) => ['jpg', 'webp'].includes(o.format) },
    ],
    build: ({ o, file, input }) => {
      const f = o.format;
      // Keep animation when converting an animated GIF to GIF/WEBP.
      const animated = getExt(file.name) === 'gif' && ['gif', 'webp'].includes(f);
      const frames = animated ? ['-loop', '0'] : ['-frames:v', '1'];
      return {
        args: ['-i', input, ...IMAGE_FORMATS[f].args(+o.quality), ...frames, `out.${f}`],
        outputName: `out.${f}`,
        downloadName: `${baseName(file.name)}.${f}`,
      };
    },
  },
  {
    id: 'compress-image',
    kinds: ['image'],
    icon: '🗜️',
    title: 'Make image smaller',
    description: 'Reduce file size while keeping it looking good.',
    popular: true,
    options: [
      { ...QUALITY_SLIDER, default: 70 },
      {
        key: 'maxWidth',
        type: 'select',
        label: 'Maximum width',
        default: '0',
        options: [
          { value: '0', label: 'Keep original size' },
          { value: '2560', label: '2560 px (large screens)' },
          { value: '1920', label: '1920 px (Full HD)' },
          { value: '1280', label: '1280 px (web)' },
          { value: '800', label: '800 px (small)' },
        ],
      },
      {
        key: 'format',
        type: 'choice',
        label: 'Save as',
        default: 'jpg',
        options: [
          { value: 'jpg', label: 'JPG', hint: 'Works everywhere' },
          { value: 'webp', label: 'WEBP', hint: 'Even smaller' },
        ],
      },
    ],
    build: ({ o, info, file, input }) => {
      const f = o.format;
      const w = +o.maxWidth;
      const vf = w && (!info?.width || info.width > w) ? ['-vf', `scale=${w}:-2`] : [];
      return {
        args: ['-i', input, ...vf, ...IMAGE_FORMATS[f].args(+o.quality), '-frames:v', '1', `out.${f}`],
        outputName: `out.${f}`,
        downloadName: `${baseName(file.name)}_small.${f}`,
      };
    },
  },
  {
    id: 'resize-image',
    kinds: ['image'],
    icon: '📐',
    title: 'Resize image',
    description: 'Change width and height.',
    popular: true,
    options: [
      {
        key: 'mode',
        type: 'choice',
        label: 'Resize by',
        default: 'percent',
        options: [
          { value: 'percent', label: 'Percentage' },
          { value: 'width', label: 'Width' },
          { value: 'exact', label: 'Exact size' },
        ],
      },
      {
        key: 'percent',
        type: 'choice',
        label: 'New size',
        default: '50',
        showIf: (o) => o.mode === 'percent',
        options: [
          { value: '25', label: '25%' },
          { value: '50', label: '50%' },
          { value: '75', label: '75%' },
          { value: '150', label: '150%' },
          { value: '200', label: '200%' },
        ],
      },
      { key: 'width', type: 'number', label: 'Width', unit: 'px', min: 1, max: 10000, default: 500, showIf: (o) => o.mode !== 'percent', help: '' },
      { key: 'height', type: 'number', label: 'Height', unit: 'px', min: 1, max: 10000, default: 500, showIf: (o) => o.mode === 'exact' },
      {
        key: 'fit',
        type: 'choice',
        label: 'If the shape is different',
        default: 'pad',
        showIf: (o) => o.mode === 'exact',
        options: [
          { value: 'pad', label: 'Fit inside', hint: 'Add borders' },
          { value: 'crop', label: 'Fill & crop', hint: 'Trim edges' },
          { value: 'stretch', label: 'Stretch' },
        ],
      },
    ],
    validate: (o) => {
      if (o.mode !== 'percent' && !(+o.width > 0)) return 'Enter a width in pixels.';
      if (o.mode === 'exact' && !(+o.height > 0)) return 'Enter a height in pixels.';
      return null;
    },
    build: ({ o, file, input }) => {
      const W = Math.round(+o.width);
      const H = Math.round(+o.height);
      let vf;
      if (o.mode === 'percent') vf = `scale=iw*${+o.percent / 100}:-1:flags=lanczos`;
      else if (o.mode === 'width') vf = `scale=${W}:-1:flags=lanczos`;
      else if (o.fit === 'crop') vf = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`;
      else if (o.fit === 'pad') vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=white`;
      else vf = `scale=${W}:${H}:flags=lanczos`;
      const f = sameImageFormat(file);
      return {
        args: ['-i', input, '-vf', vf, ...IMAGE_FORMATS[f].args(90), '-frames:v', '1', `out.${f}`],
        outputName: `out.${f}`,
        downloadName: `${baseName(file.name)}_resized.${f}`,
      };
    },
  },
  {
    id: 'rotate-image',
    kinds: ['image'],
    icon: '🔃',
    title: 'Rotate or flip image',
    description: 'Turn or mirror your picture.',
    options: [ROTATE_OPTION],
    build: ({ o, file, input }) => {
      const f = sameImageFormat(file);
      return {
        args: ['-i', input, '-vf', ROTATE_FILTERS[o.rotate], ...IMAGE_FORMATS[f].args(92), '-frames:v', '1', `out.${f}`],
        outputName: `out.${f}`,
        downloadName: `${baseName(file.name)}_rotated.${f}`,
      };
    },
  },
  {
    id: 'gif-to-video',
    kinds: ['image'],
    when: (file) => getExt(file.name) === 'gif',
    icon: '🎬',
    title: 'Turn GIF into video',
    description: 'MP4 is up to 10× smaller than GIF.',
    popular: true,
    options: [],
    build: ({ file, input }) => ({
      args: ['-i', input, '-vf', `scale=trunc(iw/2)*2:trunc(ih/2)*2`, ...X264_FAST, '-crf', '23', '-an', ...WEB_READY, 'out.mp4'],
      outputName: 'out.mp4',
      downloadName: `${baseName(file.name)}.mp4`,
    }),
  },

  /* =============================== ADVANCED =============================== */
  {
    id: 'custom',
    kinds: ['video', 'audio', 'image', 'file'],
    icon: '⌨️',
    title: 'Advanced: custom command',
    description: 'For FFmpeg experts. Write your own command.',
    advanced: true,
    options: [],
  },
];

/** Original quick presets, available in the Advanced task. */
export const COMMAND_PRESETS = [
  { id: 'video-compress-mute', label: 'Video · Compress & Remove Audio', command: '-i input_file -an -c:v libx264 -crf 28 -preset veryfast output.mp4' },
  { id: 'video-720p', label: 'Video · Resize to 720p HD', command: '-i input_file -vf scale=-2:720 -c:v libx264 -crf 23 -preset veryfast -c:a aac output.mp4' },
  { id: 'audio-mp3', label: 'Audio · Extract to MP3', command: '-i input_file -vn -ab 128k output.mp3' },
  { id: 'image-png', label: 'Image · Convert format (PNG)', command: '-i input_file output.png' },
  { id: 'image-resize', label: 'Image · Resize width to 500px', command: '-i input_file -vf scale=500:-1 output.jpg' },
];

export const tasksFor = (kind, file) =>
  TASKS.filter((t) => t.kinds.includes(kind || 'file') && (!t.when || (file && t.when(file))));

export const defaultOptions = (task) =>
  Object.fromEntries((task?.options || []).map((opt) => [opt.key, opt.default]));


'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getExt, parseLogTime, parseProbe } from './media';

// Single-threaded core: no SharedArrayBuffer / COOP+COEP headers needed,
// so it runs on any static host (Vercel, Netlify, GitHub Pages...).
const CORE_VERSION = '0.12.10';
const CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`;
const MOUNT_DIR = '/input';

/**
 * Owns the FFmpeg instance: loading (with download progress), probing files,
 * running jobs with accurate progress/ETA, cancelling and self-healing.
 */
export function useFFmpeg() {
  const ffmpegRef = useRef(null);
  const utilRef = useRef(null);
  const blobUrlsRef = useRef(null); // cached core blob URLs → instant reloads
  const startedRef = useRef(false);
  const jobRef = useRef(null); // { logs: [], expected, onProgress }
  const busyRef = useRef(Promise.resolve());

  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [logs, setLogs] = useState([]);

  /* --------------------------------- Load -------------------------------- */

  const load = useCallback(async () => {
    setStatus('loading');
    setLoadError('');
    try {
      // Dynamic imports keep FFmpeg completely out of SSR / the server bundle.
      const [{ FFmpeg }, util] = await Promise.all([import('@ffmpeg/ffmpeg'), import('@ffmpeg/util')]);
      utilRef.current = util;

      if (!blobUrlsRef.current) {
        const received = { js: 0, wasm: 0 };
        const totals = { js: 0, wasm: 32 * 1024 * 1024 }; // wasm size estimate until headers arrive
        const report = (key) => ({ total, received: got }) => {
          if (total > 0) totals[key] = total;
          received[key] = got;
          const p = (received.js + received.wasm) / (totals.js + totals.wasm || 1);
          setLoadProgress(Math.min(0.99, p));
        };
        const [coreURL, wasmURL] = await Promise.all([
          util.toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, 'text/javascript', true, report('js')),
          util.toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, 'application/wasm', true, report('wasm')),
        ]);
        blobUrlsRef.current = { coreURL, wasmURL };
      }

      const ffmpeg = new FFmpeg();
      ffmpeg.on('log', ({ message }) => {
        const job = jobRef.current;
        if (!job) return;
        job.logs.push(message);
        if (job.logs.length > 2000) job.logs.splice(0, 1000);
        if (job.expected) {
          const t = parseLogTime(message);
          if (t != null) job.onProgress?.(Math.min(0.995, t / job.expected));
        }
      });
      ffmpeg.on('progress', ({ progress }) => {
        const job = jobRef.current;
        // Only trust FFmpeg's own progress when we don't know the duration.
        if (job && !job.expected && Number.isFinite(progress) && progress > 0 && progress <= 1) {
          job.onProgress?.(Math.min(0.995, progress));
        }
      });

      await ffmpeg.load(blobUrlsRef.current);
      ffmpegRef.current = ffmpeg;
      setLoadProgress(1);
      setStatus('ready');
    } catch (err) {
      console.error(err);
      blobUrlsRef.current = null;
      setLoadError(err?.message || String(err));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (startedRef.current) return; // React Strict Mode guard
    startedRef.current = true;
    load();
  }, [load]);

  /* ------------------------------ Internals ------------------------------ */

  /** Serialises all FFmpeg operations (the worker can only do one at a time). */
  const enqueue = useCallback((fn) => {
    const next = busyRef.current.then(fn, fn);
    busyRef.current = next.catch(() => {});
    return next;
  }, []);

  /**
   * Makes the file visible to FFmpeg. WORKERFS reads the File lazily
   * (zero-copy) — far less memory than copying the whole file into WASM.
   */
  const attach = async (ffmpeg, file) => {
    const ext = getExt(file.name) || 'bin';
    const name = `input.${ext}`; // safe name: no spaces, colons or unicode
    try {
      await ffmpeg.createDir(MOUNT_DIR).catch(() => {});
      const safeFile = new File([file], name, { type: file.type });
      await ffmpeg.mount('WORKERFS', { files: [safeFile] }, MOUNT_DIR);
      return { path: `${MOUNT_DIR}/${name}`, mounted: true };
    } catch {
      await ffmpeg.writeFile(name, await utilRef.current.fetchFile(file));
      return { path: name, mounted: false };
    }
  };

  const detach = async (ffmpeg, attached) => {
    if (!attached) return;
    if (attached.mounted) {
      await ffmpeg.unmount(MOUNT_DIR).catch(() => {});
      await ffmpeg.deleteDir(MOUNT_DIR).catch(() => {});
    } else {
      await ffmpeg.deleteFile(attached.path).catch(() => {});
    }
  };

  const reload = useCallback(async () => {
    try {
      ffmpegRef.current?.terminate();
    } catch {
      /* already gone */
    }
    ffmpegRef.current = null;
    await load();
  }, [load]);

  /* --------------------------------- API --------------------------------- */

  /** Reads duration, resolution and audio/video streams of a file. */
  const probe = useCallback(
    (file) =>
      enqueue(async () => {
        const ffmpeg = ffmpegRef.current;
        if (!ffmpeg) return null;
        const job = { logs: [] };
        jobRef.current = job;
        let attached;
        try {
          attached = await attach(ffmpeg, file);
          await ffmpeg.exec(['-hide_banner', '-i', attached.path]); // exits 1 (no output) — expected
          return parseProbe(job.logs);
        } catch {
          return null;
        } finally {
          jobRef.current = null;
          await detach(ffmpeg, attached);
        }
      }),
    [enqueue],
  );

  /**
   * Runs an FFmpeg job.
   * @param {object} p
   * @param {File} p.file
   * @param {(inputPath: string) => {args: string[], outputName: string, expectedDuration?: number}} p.build
   * @param {(progress: number) => void} [p.onProgress]
   * @returns {Promise<{data: Uint8Array, outputName: string, logs: string[]}>}
   */
  const run = useCallback(
    ({ file, build, onProgress }) =>
      enqueue(async () => {
        const ffmpeg = ffmpegRef.current;
        if (!ffmpeg) throw new Error('FFmpeg is not ready yet.');
        let attached;
        let outputName;
        const job = { logs: [], expected: null, onProgress };
        jobRef.current = job;
        setLogs([]);
        try {
          attached = await attach(ffmpeg, file);
          const built = build(attached.path);
          outputName = built.outputName;
          job.expected = built.expectedDuration > 0 ? built.expectedDuration : null;
          job.logs.push(`$ ffmpeg ${built.args.join(' ')}`);

          const code = await ffmpeg.exec(built.args);
          if (code !== 0) {
            const err = new Error(`FFmpeg exited with code ${code}`);
            err.logs = job.logs;
            throw err;
          }
          const data = await ffmpeg.readFile(outputName);
          if (!data?.length) {
            const err = new Error('Output file is empty');
            err.logs = job.logs;
            throw err;
          }
          onProgress?.(1);
          return { data, outputName, logs: job.logs };
        } catch (err) {
          err.logs = err.logs || job.logs;
          err.cancelled = !!job.cancelled;
          // A crashed/OOM worker is unusable — start a fresh one in the background.
          if (!job.cancelled && !/exited with code|Output file is empty/.test(err.message || '')) reload();
          throw err;
        } finally {
          setLogs([...job.logs]);
          jobRef.current = null;
          if (ffmpegRef.current === ffmpeg) {
            await detach(ffmpeg, attached);
            if (outputName) await ffmpeg.deleteFile(outputName).catch(() => {});
          }
        }
      }),
    [enqueue, reload],
  );

  /** Stops the current job immediately. */
  const cancel = useCallback(async () => {
    const job = jobRef.current;
    jobRef.current = null;
    if (job) {
      job.cancelled = true;
      setLogs([...job.logs, '— Cancelled —']);
    }
    busyRef.current = Promise.resolve();
    await reload();
  }, [reload]);

  return { status, loadProgress, loadError, logs, retry: load, probe, run, cancel };
}

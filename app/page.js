'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OptionsForm from '@/components/OptionsForm';
import { Icon, Spinner, Steps } from '@/components/ui';
import { useFFmpeg } from '@/lib/useFFmpeg';
import {
  baseName,
  buildArgs,
  formatBytes,
  formatClock,
  formatEta,
  friendlyError,
  getExt,
  getMime,
  kindFromFile,
  kindFromMime,
} from '@/lib/media';
import { COMMAND_PRESETS, defaultOptions, tasksFor } from '@/lib/tools';

const APP_TITLE = 'FFmpeg Studio — Free Online Video, Audio & Image Converter';
const KIND_LABEL = { video: 'Video', audio: 'Audio', image: 'Image', file: 'File' };
const BIG_FILE = 1.5 * 1024 * 1024 * 1024;

export default function Home() {
  const engine = useFFmpeg();
  const ready = engine.status === 'ready';

  /* --------------------------------- State -------------------------------- */
  const [file, setFile] = useState(null);
  const [fileUrl, setFileUrl] = useState('');
  const [info, setInfo] = useState(null);
  const [probing, setProbing] = useState(false);
  const [mediaDuration, setMediaDuration] = useState(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [dragging, setDragging] = useState(false);

  const [taskId, setTaskId] = useState(null);
  const [opts, setOpts] = useState({});
  const [showAllTasks, setShowAllTasks] = useState(false);
  const [command, setCommand] = useState(COMMAND_PRESETS[0].command);
  const [presetId, setPresetId] = useState(COMMAND_PRESETS[0].id);

  const [phase, setPhase] = useState('idle'); // idle | working | done
  const [progress, setProgress] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [showLogs, setShowLogs] = useState(false);

  const previewRef = useRef(null);
  const inputRef = useRef(null);
  const progressRef = useRef(0);

  const kind = kindFromFile(file);
  const tasks = useMemo(() => (file ? tasksFor(kind, file) : []), [file, kind]);
  const task = tasks.find((t) => t.id === taskId) || null;
  const duration = info?.duration ?? mediaDuration ?? null;
  const fullInfo = useMemo(() => (info || mediaDuration ? { ...(info || {}), duration } : null), [info, mediaDuration, duration]);
  const working = phase === 'working';
  const step = !file ? 1 : phase === 'done' ? 3 : 2;

  /* ------------------------------ File handling ---------------------------- */

  const pickTask = useCallback((t) => {
    setTaskId(t?.id ?? null);
    setOpts(defaultOptions(t));
    setError('');
  }, []);

  const handleFile = useCallback(
    (f) => {
      if (!f || working) return;
      setFile(f);
      setInfo(null);
      setMediaDuration(null);
      setPreviewFailed(false);
      setResult(null);
      setPhase('idle');
      setProgress(0);
      setError('');
      setShowAllTasks(false);
      const available = tasksFor(kindFromFile(f), f);
      pickTask(available.find((t) => t.popular) || available[0]);
    },
    [working, pickTask],
  );

  // Object URL for the preview
  useEffect(() => {
    if (!file) return undefined;
    const url = URL.createObjectURL(file);
    setFileUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Probe the file once the engine is ready (duration, resolution, audio…)
  useEffect(() => {
    if (!file || !ready) return undefined;
    let alive = true;
    setProbing(true);
    engine.probe(file).then((res) => {
      if (!alive) return;
      setInfo(res);
      setProbing(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, ready]);

  // Free result memory
  useEffect(() => () => result?.url && URL.revokeObjectURL(result.url), [result]);

  // Paste an image/file from the clipboard
  useEffect(() => {
    const onPaste = (e) => {
      const f = e.clipboardData?.files?.[0];
      if (f) handleFile(f);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [handleFile]);

  // Warn before closing the tab mid-conversion + show progress in the tab title
  useEffect(() => {
    if (!working) {
      document.title = phase === 'done' ? '✅ Done · FFmpeg Studio' : APP_TITLE;
      return undefined;
    }
    const onUnload = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    const start = Date.now();
    const id = setInterval(() => {
      setElapsed((Date.now() - start) / 1000);
      document.title = `${Math.round(progressRef.current * 100)}% · Converting…`;
    }, 500);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      clearInterval(id);
    };
  }, [working, phase]);

  const reset = () => {
    setFile(null);
    setFileUrl('');
    setInfo(null);
    setResult(null);
    setPhase('idle');
    setProgress(0);
    setError('');
    setTaskId(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  /* -------------------------------- Running -------------------------------- */

  const validation = useMemo(() => {
    if (!task) return 'Choose what you want to do.';
    if (task.id === 'custom') return command.trim() ? null : 'Type an FFmpeg command.';
    if (task.requiresAudio && info && !info.hasAudio) return 'This file has no sound.';
    return task.validate ? task.validate(opts, fullInfo) : null;
  }, [task, opts, fullInfo, info, command]);

  const start = async () => {
    if (!file || !task || validation || !ready) return;
    setPhase('working');
    setProgress(0);
    progressRef.current = 0;
    setElapsed(0);
    setError('');
    setResult(null);
    setShowLogs(false);

    let downloadName = '';
    const build = (input) => {
      if (task.id === 'custom') {
        const built = buildArgs(command, input);
        downloadName = `${baseName(file.name)}_converted.${getExt(built.outputName) || 'mp4'}`;
        return { ...built, expectedDuration: duration };
      }
      const built = task.build({ o: opts, info: fullInfo, file, input });
      downloadName = built.downloadName;
      return { expectedDuration: duration, ...built };
    };

    try {
      const { data } = await engine.run({
        file,
        build,
        onProgress: (p) => {
          if (p - progressRef.current > 0.002 || p === 1) {
            progressRef.current = p;
            setProgress(p);
          }
        },
      });
      const mime = getMime(downloadName);
      const blob = new Blob([data], { type: mime });
      setResult({ url: URL.createObjectURL(blob), blob, name: downloadName, mime, kind: kindFromMime(mime), size: blob.size });
      setPhase('done');
    } catch (err) {
      setPhase('idle');
      setProgress(0);
      if (err?.cancelled) return;
      console.error(err);
      setError(friendlyError(err?.message, err?.logs));
    }
  };

  const cancel = async () => {
    await engine.cancel();
    setPhase('idle');
    setProgress(0);
  };

  const download = () => {
    if (!result) return;
    const a = document.createElement('a');
    a.href = result.url;
    a.download = result.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const canShare =
    typeof navigator !== 'undefined' &&
    !!result &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [new File([result.blob], result.name, { type: result.mime })] });

  const share = async () => {
    try {
      await navigator.share({ files: [new File([result.blob], result.name, { type: result.mime })], title: result.name });
    } catch {
      /* user cancelled */
    }
  };

  const continueWithResult = () => {
    if (!result) return;
    handleFile(new File([result.blob], result.name, { type: result.mime }));
  };

  /* --------------------------------- Derived ------------------------------- */

  const visibleTasks = useMemo(() => {
    const basic = tasks.filter((t) => !t.advanced);
    const popular = basic.filter((t) => t.popular);
    if (showAllTasks || popular.length === 0) return tasks;
    const list = [...popular];
    if (task && !list.includes(task)) list.push(task);
    return list;
  }, [tasks, showAllTasks, task]);
  const hiddenCount = tasks.length - visibleTasks.length;

  const eta = progress > 0.03 && elapsed > 2 ? (elapsed / progress) * (1 - progress) : null;
  const savings = result && file?.size ? Math.round((1 - result.size / file.size) * 100) : null;
  const canTimeline = kind === 'video' || kind === 'audio';
  const getCurrentTime = canTimeline && !previewFailed ? () => previewRef.current?.currentTime || 0 : null;

  /* --------------------------------- Render -------------------------------- */

  return (
    <main className="relative min-h-screen overflow-hidden">
      {/* Background glows */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 h-[480px] w-[880px] -translate-x-1/2 animate-glow-pulse rounded-full bg-gradient-to-r from-indigo-600/30 via-violet-600/25 to-fuchsia-600/30 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-[360px] w-[360px] rounded-full bg-cyan-500/10 blur-3xl" />
      </div>

      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
        {/* Top bar */}
        <nav className="mb-10 flex items-center justify-between gap-4">
          <button type="button" onClick={reset} disabled={working} className="flex items-center gap-2 text-left">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-fuchsia-500 text-white shadow-lg shadow-indigo-500/30">
              <Icon name="bolt" className="h-5 w-5" />
            </span>
            <span className="text-lg font-bold tracking-tight">
              FFmpeg <span className="bg-gradient-to-r from-indigo-400 to-fuchsia-400 bg-clip-text text-transparent">Studio</span>
            </span>
          </button>
          <EngineBadge engine={engine} />
        </nav>

        {!file && (
          <header className="mb-8 text-center">
            <h1 className="bg-gradient-to-br from-white via-zinc-200 to-zinc-500 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-5xl">
              Convert & compress any file.
              <br className="hidden sm:block" /> Right in your browser.
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-sm text-zinc-400 sm:text-base">
              Videos, music and photos — make them smaller, change the format, cut, resize or rotate. Free, no sign-up, and
              your files never leave your device.
            </p>
          </header>
        )}

        <Steps current={step} />

        {/* ------------------------------ Step 1 ------------------------------ */}
        {!file && (
          <section className="mx-auto max-w-3xl">
            <label
              htmlFor="file-input"
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                handleFile(e.dataTransfer.files?.[0]);
              }}
              className={`group card flex cursor-pointer flex-col items-center justify-center gap-4 border-2 border-dashed px-6 py-16 text-center transition sm:py-20 ${
                dragging ? 'border-indigo-400 bg-indigo-500/10' : 'border-white/15 hover:border-indigo-500/50 hover:bg-indigo-500/5'
              }`}
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/25 to-fuchsia-500/25 text-indigo-200 ring-1 ring-white/10 transition group-hover:scale-105">
                <Icon name="upload" className="h-8 w-8" />
              </span>
              <span className="btn-primary pointer-events-none px-8 py-3.5 text-base">Choose a file</span>
              <span className="text-sm text-zinc-400">or drag & drop it here · you can also paste (Ctrl/⌘ + V)</span>
              <span className="mt-2 flex flex-wrap justify-center gap-1.5 text-[11px] text-zinc-500">
                {['MP4', 'MOV', 'WEBM', 'MKV', 'AVI', 'MP3', 'WAV', 'M4A', 'JPG', 'PNG', 'WEBP', 'GIF', 'HEIC*'].map((f) => (
                  <span key={f} className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5">
                    {f}
                  </span>
                ))}
              </span>
            </label>

            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[
                ['shield', '100% private', 'Files are processed on your device. Nothing is uploaded.'],
                ['bolt', 'Free & unlimited', 'No sign-up, no watermarks, no daily limits.'],
                ['check', 'Easy to use', 'Pick a file, choose what to do, download. Done.'],
              ].map(([icon, title, text]) => (
                <div key={title} className="flex gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-4">
                  <Icon name={icon} className="mt-0.5 h-5 w-5 shrink-0 text-indigo-300" />
                  <div>
                    <p className="text-sm font-semibold text-zinc-200">{title}</p>
                    <p className="text-xs text-zinc-500">{text}</p>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-center text-[11px] text-zinc-600">*HEIC support depends on your browser.</p>
          </section>
        )}

        <input
          id="file-input"
          ref={inputRef}
          type="file"
          accept="video/*,audio/*,image/*,.mkv,.avi,.flv,.wmv,.m4a,.flac,.opus"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />

        {/* --------------------------- Step 2 & 3 --------------------------- */}
        {file && (
          <div className="grid gap-6 lg:grid-cols-5">
            {/* Left: file + preview */}
            <section className="card flex flex-col gap-4 lg:col-span-2 lg:self-start">
              <div className="flex items-center justify-between gap-3">
                <span className="label mb-0">Your {KIND_LABEL[kind].toLowerCase()}</span>
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  disabled={working}
                  className="text-xs font-medium text-indigo-300 hover:text-indigo-200 disabled:opacity-40"
                >
                  Change file
                </button>
              </div>

              <div className="flex min-h-[180px] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/40">
                {previewFailed || kind === 'file' ? (
                  <div className="p-8 text-center">
                    <p className="font-mono text-2xl uppercase text-zinc-500">.{getExt(file.name) || '?'}</p>
                    <p className="mt-2 text-xs text-zinc-500">
                      Your browser can&apos;t preview this format, but it can still be converted.
                    </p>
                  </div>
                ) : kind === 'video' ? (
                  <video
                    key={fileUrl}
                    ref={previewRef}
                    src={fileUrl}
                    controls
                    playsInline
                    preload="metadata"
                    className="max-h-[320px] w-full"
                    onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setMediaDuration(e.currentTarget.duration)}
                    onError={() => setPreviewFailed(true)}
                  />
                ) : kind === 'audio' ? (
                  <div className="w-full p-6">
                    <div className="mb-4 text-center text-5xl">🎵</div>
                    <audio
                      key={fileUrl}
                      ref={previewRef}
                      src={fileUrl}
                      controls
                      preload="metadata"
                      className="w-full"
                      onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setMediaDuration(e.currentTarget.duration)}
                      onError={() => setPreviewFailed(true)}
                    />
                  </div>
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={fileUrl} alt="Your file" className="max-h-[320px] w-auto object-contain" onError={() => setPreviewFailed(true)} />
                )}
              </div>

              <div>
                <p className="truncate text-sm font-medium text-zinc-100" title={file.name}>
                  {file.name}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                  <Chip>{formatBytes(file.size)}</Chip>
                  {duration ? <Chip>{formatClock(duration)}</Chip> : null}
                  {info?.width ? <Chip>{`${info.width}×${info.height}`}</Chip> : null}
                  {kind === 'video' && info && <Chip>{info.hasAudio ? '🔊 Has sound' : '🔇 No sound'}</Chip>}
                  {probing && (
                    <Chip>
                      <Spinner className="h-3 w-3" /> Reading file…
                    </Chip>
                  )}
                </div>
              </div>

              {file.size > BIG_FILE && (
                <Notice tone="warn">
                  This is a very large file. Browser processing may be slow or run out of memory. If it fails, try trimming it
                  first or use a smaller file.
                </Notice>
              )}
            </section>

            {/* Right: steps */}
            <section className="card lg:col-span-3">
              {phase === 'done' && result ? (
                <ResultPanel
                  result={result}
                  file={file}
                  savings={savings}
                  elapsed={elapsed}
                  onDownload={download}
                  onShare={canShare ? share : null}
                  onAgain={() => {
                    setPhase('idle');
                    setResult(null);
                  }}
                  onContinue={continueWithResult}
                  onReset={reset}
                />
              ) : working ? (
                <ProgressPanel progress={progress} elapsed={elapsed} eta={eta} task={task} onCancel={cancel} />
              ) : (
                <div className="space-y-6">
                  {/* Task picker */}
                  <div>
                    <h2 className="mb-3 text-base font-semibold text-zinc-100">What do you want to do?</h2>
                    {kind === 'file' && (
                      <Notice tone="warn">
                        We couldn&apos;t recognise this file type. You can still try the advanced custom command.
                      </Notice>
                    )}
                    <div className="grid gap-2 sm:grid-cols-2">
                      {visibleTasks.map((t) => {
                        const active = t.id === taskId;
                        const noAudio = t.requiresAudio && info && !info.hasAudio;
                        return (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => pickTask(t)}
                            className={`flex items-start gap-3 rounded-xl border p-3 text-left transition ${
                              active
                                ? 'border-indigo-400/60 bg-indigo-500/15 ring-2 ring-indigo-500/30'
                                : 'border-white/10 bg-zinc-950/40 hover:border-white/20 hover:bg-white/5'
                            } ${noAudio ? 'opacity-50' : ''}`}
                          >
                            <span className="text-xl leading-none" aria-hidden="true">
                              {t.icon}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-sm font-semibold text-zinc-100">{t.title}</span>
                              <span className="block text-xs text-zinc-500">{noAudio ? 'This file has no sound' : t.description}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {(hiddenCount > 0 || showAllTasks) && (
                      <button
                        type="button"
                        onClick={() => setShowAllTasks((s) => !s)}
                        className="mt-3 flex w-full items-center justify-center gap-1 rounded-xl py-2 text-sm font-medium text-indigo-300 transition hover:bg-white/5"
                      >
                        {showAllTasks ? 'Show fewer options' : `Show ${hiddenCount} more option${hiddenCount > 1 ? 's' : ''}`}
                        <Icon name="chevron" className={`h-4 w-4 transition ${showAllTasks ? 'rotate-180' : ''}`} />
                      </button>
                    )}
                  </div>

                  {/* Options */}
                  {task && task.id !== 'custom' && task.options.length > 0 && (
                    <div className="border-t border-white/10 pt-6">
                      <h3 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-300">
                        <span aria-hidden="true">{task.icon}</span> {task.title} — settings
                      </h3>
                      {task.usesTimeline && getCurrentTime && (
                        <p className="mb-4 rounded-lg bg-white/5 px-3 py-2 text-xs text-zinc-400">
                          💡 Tip: play the preview on the left and press <b>Use current</b> at the exact moment you want.
                        </p>
                      )}
                      <OptionsForm
                        options={task.options}
                        values={opts}
                        onChange={setOpts}
                        getCurrentTime={task.usesTimeline ? getCurrentTime : null}
                        duration={duration}
                      />
                    </div>
                  )}

                  {task?.id === 'custom' && (
                    <AdvancedPanel
                      command={command}
                      setCommand={setCommand}
                      presetId={presetId}
                      setPresetId={setPresetId}
                      file={file}
                    />
                  )}

                  {/* Action */}
                  <div className="border-t border-white/10 pt-6">
                    {error && (
                      <div className="mb-4">
                        <Notice tone="error">{error}</Notice>
                      </div>
                    )}
                    {validation && task && <p className="mb-3 text-sm text-amber-300/90">{validation}</p>}
                    <button
                      type="button"
                      onClick={start}
                      disabled={!ready || !!validation}
                      className="btn-primary w-full py-4 text-base"
                    >
                      {ready ? (
                        <>
                          <Icon name="bolt" className="h-5 w-5" /> {task?.id === 'custom' ? 'Run command' : `Start · ${task?.title || ''}`}
                        </>
                      ) : engine.status === 'error' ? (
                        'Engine failed to load — use Retry at the top'
                      ) : (
                        <>
                          <Spinner className="h-5 w-5" /> Getting ready… {Math.round(engine.loadProgress * 100)}%
                        </>
                      )}
                    </button>
                    <p className="mt-2 text-center text-xs text-zinc-600">Processing happens on your device. Keep this tab open.</p>
                  </div>
                </div>
              )}
            </section>
          </div>
        )}

        {/* Technical details */}
        {file && engine.logs.length > 0 && (
          <section className="card mt-6 p-0">
            <button
              type="button"
              onClick={() => setShowLogs((s) => !s)}
              className="flex w-full items-center justify-between px-6 py-4 text-left"
            >
              <span className="flex items-center gap-2 text-sm font-medium text-zinc-400">
                <Icon name="terminal" className="h-4 w-4" /> Technical details
              </span>
              <Icon name="chevron" className={`h-4 w-4 text-zinc-500 transition ${showLogs ? 'rotate-180' : ''}`} />
            </button>
            {showLogs && (
              <pre className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-all border-t border-white/10 bg-black/40 px-6 py-4 font-mono text-[11px] leading-relaxed text-zinc-400">
                {engine.logs.join('\n')}
              </pre>
            )}
          </section>
        )}

        <footer className="mt-12 text-center text-xs text-zinc-600">
          Powered by{' '}
          <a href="https://ffmpegwasm.netlify.app" target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-white">
            ffmpeg.wasm
          </a>{' '}
          · No uploads · No servers · Free forever
        </footer>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*                               Sub-components                               */
/* -------------------------------------------------------------------------- */

function Chip({ children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-zinc-400">
      {children}
    </span>
  );
}

function Notice({ tone = 'info', children }) {
  const styles = {
    info: 'border-indigo-500/20 bg-indigo-500/10 text-indigo-200',
    warn: 'border-amber-500/20 bg-amber-500/10 text-amber-200',
    error: 'border-red-500/20 bg-red-500/10 text-red-200',
  };
  return (
    <div className={`flex gap-2 rounded-xl border px-4 py-3 text-sm ${styles[tone]}`}>
      <Icon name={tone === 'info' ? 'check' : 'warn'} className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function EngineBadge({ engine }) {
  if (engine.status === 'ready') {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">
        <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400" /> Ready
      </span>
    );
  }
  if (engine.status === 'error') {
    return (
      <button
        type="button"
        onClick={engine.retry}
        title={engine.loadError}
        className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/20"
      >
        <Icon name="refresh" className="h-3.5 w-3.5" /> Couldn&apos;t load — Retry
      </button>
    );
  }
  const pct = Math.round(engine.loadProgress * 100);
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-zinc-300"
      title="Downloading the converter (about 31 MB, only the first time)"
    >
      <Spinner className="h-3.5 w-3.5 text-indigo-300" />
      {pct < 99 ? `Preparing converter ${pct}%` : 'Starting…'}
    </span>
  );
}

function ProgressPanel({ progress, elapsed, eta, task, onCancel }) {
  const pct = Math.round(progress * 100);
  const r = 54;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex flex-col items-center py-8 text-center">
      <div className="relative h-36 w-36">
        <svg className="h-full w-full -rotate-90" viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={r} stroke="currentColor" strokeWidth="8" fill="none" className="text-white/5" />
          <circle
            cx="60"
            cy="60"
            r={r}
            strokeWidth="8"
            fill="none"
            stroke="url(#grad)"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - Math.max(progress, 0.01))}
            className="transition-[stroke-dashoffset] duration-500"
          />
          <defs>
            <linearGradient id="grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#6366f1" />
              <stop offset="100%" stopColor="#d946ef" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold tabular-nums">{pct}%</span>
        </div>
      </div>
      <h2 className="mt-6 text-lg font-semibold text-zinc-100">
        {task?.icon} {task?.id === 'custom' ? 'Running your command…' : `${task?.title}…`}
      </h2>
      <p className="mt-1 text-sm text-zinc-400">
        {eta ? formatEta(eta) : pct === 0 ? 'Starting up…' : 'Working on it…'} · {formatClock(elapsed)} elapsed
      </p>
      <p className="mt-4 max-w-sm text-xs text-zinc-500">
        Everything runs on your device, so speed depends on your computer. Please keep this tab open.
      </p>
      <button type="button" onClick={onCancel} className="btn-ghost mt-6">
        <Icon name="x" className="h-4 w-4" /> Cancel
      </button>
    </div>
  );
}

function ResultPanel({ result, file, savings, elapsed, onDownload, onShare, onAgain, onContinue, onReset }) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30">
          <Icon name="check" className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Your file is ready!</h2>
          <p className="text-xs text-zinc-500">Finished in {formatClock(elapsed) || '0:00'}</p>
        </div>
      </div>

      <div className="flex min-h-[200px] items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/40">
        {result.kind === 'video' && <video src={result.url} controls playsInline className="max-h-[360px] w-full" />}
        {result.kind === 'image' && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={result.url} alt={result.name} className="max-h-[360px] w-auto object-contain" />
        )}
        {result.kind === 'audio' && (
          <div className="w-full p-6">
            <div className="mb-4 text-center text-5xl">🎵</div>
            <audio src={result.url} controls className="w-full" />
          </div>
        )}
        {result.kind === 'file' && <p className="p-6 text-sm text-zinc-400">Preview isn&apos;t available for this format.</p>}
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-white/5 p-2.5">
          <dt className="text-[10px] uppercase tracking-wider text-zinc-500">Before</dt>
          <dd className="text-sm font-semibold">{formatBytes(file.size)}</dd>
        </div>
        <div className="rounded-lg bg-white/5 p-2.5">
          <dt className="text-[10px] uppercase tracking-wider text-zinc-500">After</dt>
          <dd className="text-sm font-semibold">{formatBytes(result.size)}</dd>
        </div>
        <div className="rounded-lg bg-white/5 p-2.5">
          <dt className="text-[10px] uppercase tracking-wider text-zinc-500">{savings >= 0 ? 'Saved' : 'Larger by'}</dt>
          <dd className={`text-sm font-semibold ${savings > 0 ? 'text-emerald-400' : savings < 0 ? 'text-amber-400' : ''}`}>
            {savings === null ? '—' : `${Math.abs(savings)}%`}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" className="btn-primary flex-1 py-4 text-base" onClick={onDownload}>
          <Icon name="download" className="h-5 w-5" /> Download File
        </button>
        {onShare && (
          <button type="button" className="btn-ghost py-4" onClick={onShare}>
            <Icon name="share" className="h-5 w-5" /> Share
          </button>
        )}
      </div>
      <p className="-mt-2 truncate text-center font-mono text-xs text-zinc-500">{result.name}</p>

      <div className="grid gap-2 border-t border-white/10 pt-5 sm:grid-cols-3">
        <button type="button" className="btn-ghost text-xs" onClick={onAgain}>
          <Icon name="back" className="h-4 w-4" /> Try other settings
        </button>
        <button type="button" className="btn-ghost text-xs" onClick={onContinue} title="Use the result as the new input file">
          <Icon name="arrow" className="h-4 w-4" /> Edit this result
        </button>
        <button type="button" className="btn-ghost text-xs" onClick={onReset}>
          <Icon name="upload" className="h-4 w-4" /> New file
        </button>
      </div>
    </div>
  );
}

function AdvancedPanel({ command, setCommand, presetId, setPresetId, file }) {
  const parsed = useMemo(() => buildArgs(command, `input.${getExt(file.name) || 'bin'}`), [command, file]);
  return (
    <div className="space-y-4 border-t border-white/10 pt-6">
      <div>
        <label htmlFor="preset" className="mb-2 block text-sm font-medium text-zinc-200">
          Quick presets
        </label>
        <select
          id="preset"
          className="input"
          value={presetId}
          onChange={(e) => {
            const p = COMMAND_PRESETS.find((x) => x.id === e.target.value);
            setPresetId(e.target.value);
            if (p) setCommand(p.command);
          }}
        >
          {COMMAND_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom" disabled>
            Custom command
          </option>
        </select>
      </div>
      <div>
        <label htmlFor="command" className="mb-2 block text-sm font-medium text-zinc-200">
          FFmpeg arguments
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute left-4 top-3 font-mono text-sm text-indigo-400">ffmpeg</span>
          <textarea
            id="command"
            rows={3}
            spellCheck={false}
            className="input resize-y pl-[4.6rem] font-mono leading-relaxed"
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              const match = COMMAND_PRESETS.find((p) => p.command === e.target.value);
              setPresetId(match ? match.id : 'custom');
            }}
            placeholder="-i input_file -c:v libx264 -crf 28 output.mp4"
          />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Use <code className="rounded bg-white/5 px-1.5 py-0.5 text-indigo-300">input_file</code> for your file. The last
          argument is the output — detected:{' '}
          <code className="rounded bg-white/5 px-1.5 py-0.5 text-fuchsia-300">{parsed.outputName}</code>
        </p>
      </div>
    </div>
  );
}

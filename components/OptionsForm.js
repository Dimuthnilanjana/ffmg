'use client';

import { formatClock } from '@/lib/media';
import { Icon } from './ui';

/**
 * Renders a task's option schema as friendly controls.
 * Supported types: choice | select | toggle | range | number | time
 */
export default function OptionsForm({ options, values, onChange, disabled, getCurrentTime, duration }) {
  const visible = options.filter((opt) => !opt.showIf || opt.showIf(values));
  if (!visible.length) return null;

  const set = (key, value) => onChange({ ...values, [key]: value });

  return (
    <div className="space-y-5">
      {visible.map((opt) => (
        <div key={opt.key}>
          {opt.type !== 'toggle' && (
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <label htmlFor={`opt-${opt.key}`} className="text-sm font-medium text-zinc-200">
                {opt.label}
              </label>
              {opt.type === 'range' && (
                <span className="font-mono text-sm text-indigo-300">
                  {values[opt.key]}
                  {opt.unit}
                </span>
              )}
            </div>
          )}

          {opt.type === 'choice' && (
            <div role="radiogroup" aria-label={opt.label} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {opt.options.map((c) => {
                const active = String(values[opt.key]) === String(c.value);
                return (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={disabled}
                    onClick={() => set(opt.key, c.value)}
                    className={`rounded-xl border px-3 py-2.5 text-left transition disabled:opacity-50 ${
                      active
                        ? 'border-indigo-400/60 bg-indigo-500/15 ring-2 ring-indigo-500/30'
                        : 'border-white/10 bg-zinc-950/40 hover:border-white/20 hover:bg-white/5'
                    }`}
                  >
                    <span className={`block text-sm font-semibold ${active ? 'text-white' : 'text-zinc-200'}`}>{c.label}</span>
                    {c.hint && <span className="block text-[11px] leading-tight text-zinc-500">{c.hint}</span>}
                  </button>
                );
              })}
            </div>
          )}

          {opt.type === 'select' && (
            <select
              id={`opt-${opt.key}`}
              className="input"
              value={values[opt.key]}
              disabled={disabled}
              onChange={(e) => set(opt.key, e.target.value)}
            >
              {opt.options.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          )}

          {opt.type === 'toggle' && (
            <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-white/10 bg-zinc-950/40 px-4 py-3">
              <span>
                <span className="block text-sm font-medium text-zinc-200">{opt.label}</span>
                {opt.help && <span className="mt-0.5 block text-xs text-zinc-500">{opt.help}</span>}
              </span>
              <span className="relative mt-0.5 inline-flex shrink-0">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={!!values[opt.key]}
                  disabled={disabled}
                  onChange={(e) => set(opt.key, e.target.checked)}
                />
                <span className="h-6 w-11 rounded-full bg-zinc-700 transition peer-checked:bg-indigo-500 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-400" />
                <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
              </span>
            </label>
          )}

          {opt.type === 'range' && (
            <input
              id={`opt-${opt.key}`}
              type="range"
              min={opt.min}
              max={opt.max}
              step={opt.step}
              value={values[opt.key]}
              disabled={disabled}
              onChange={(e) => set(opt.key, +e.target.value)}
              className="w-full accent-indigo-500"
            />
          )}

          {opt.type === 'number' && (
            <div className="relative">
              <input
                id={`opt-${opt.key}`}
                type="number"
                inputMode="decimal"
                min={opt.min}
                max={opt.max}
                className="input pr-14"
                value={values[opt.key]}
                disabled={disabled}
                onChange={(e) => set(opt.key, e.target.value)}
              />
              {opt.unit && (
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-zinc-500">{opt.unit}</span>
              )}
            </div>
          )}

          {opt.type === 'time' && (
            <div className="flex gap-2">
              <input
                id={`opt-${opt.key}`}
                type="text"
                inputMode="decimal"
                className="input font-mono"
                placeholder={opt.placeholder}
                value={values[opt.key]}
                disabled={disabled}
                onChange={(e) => set(opt.key, e.target.value)}
              />
              {getCurrentTime && (
                <button
                  type="button"
                  className="btn-ghost shrink-0 whitespace-nowrap px-3"
                  disabled={disabled}
                  onClick={() => set(opt.key, formatClock(getCurrentTime()))}
                  title="Use the current position of the preview player"
                >
                  <Icon name="clock" className="h-4 w-4" />
                  <span className="hidden sm:inline">Use current</span>
                </button>
              )}
            </div>
          )}

          {opt.type !== 'toggle' && opt.help && <p className="mt-1.5 text-xs text-zinc-500">{opt.help}</p>}
          {opt.type === 'time' && duration ? (
            <p className="mt-1.5 text-xs text-zinc-600">Format: minutes:seconds (e.g. 1:05). Total length {formatClock(duration)}.</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}


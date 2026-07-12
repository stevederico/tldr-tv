import { useEffect, useState } from 'react';

/** Visual variant of a toast. */
type ToastVariant = 'default' | 'error' | 'success';

/** Options accepted when pushing a toast. */
interface ToastOptions {
  /** Visual variant (default: 'default'). */
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms; 0 disables auto-dismiss (default: 5000). */
  duration?: number;
}

/** A live toast item in the queue. */
interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

/** Internal queue event broadcast to subscribed Toasters. */
type ToastEvent =
  | { type: 'add'; item: ToastItem }
  | { type: 'remove'; id: number };

type ToastListener = (event: ToastEvent) => void;

/** Signature of the `toast()` function plus its `.error` / `.success` helpers. */
interface ToastFn {
  (message: string, options?: ToastOptions): number;
  error: (message: string, options?: ToastOptions) => number;
  success: (message: string, options?: ToastOptions) => number;
}

const listeners = new Set<ToastListener>();
let nextId = 1;

/**
 * Push a transient toast notification. Returns the toast id so the caller
 * can dismiss it early via dismissToast(id).
 *
 * @param message - Plain-text message shown in the toast body.
 * @param options - Variant + duration options.
 * @returns toast id
 */
function toastImpl(message: string, options: ToastOptions = {}): number {
  const id = nextId++;
  const item: ToastItem = {
    id,
    message,
    variant: options.variant || 'default',
    duration: options.duration ?? 5000,
  };
  listeners.forEach(fn => fn({ type: 'add', item }));
  if (item.duration > 0) {
    setTimeout(() => listeners.forEach(fn => fn({ type: 'remove', id })), item.duration);
  }
  return id;
}

export const toast: ToastFn = Object.assign(toastImpl, {
  error: (message: string, options: ToastOptions = {}) =>
    toastImpl(message, { ...options, variant: 'error' }),
  success: (message: string, options: ToastOptions = {}) =>
    toastImpl(message, { ...options, variant: 'success' }),
});

/**
 * Dismiss a toast immediately by id (returned from toast()).
 * @param id - Toast id to remove.
 */
export function dismissToast(id: number): void {
  listeners.forEach(fn => fn({ type: 'remove', id }));
}

/**
 * Mount once near the app root. Subscribes to the toast queue and renders
 * a stack of toasts in the bottom-right corner.
 */
export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const fn: ToastListener = (event) => {
      if (event.type === 'add') {
        setItems(xs => [...xs, event.item]);
      } else {
        setItems(xs => xs.filter(x => x.id !== event.id));
      }
    };
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      aria-label="Notifications"
      className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none"
    >
      {items.map(item => (
        <div
          key={item.id}
          role={item.variant === 'error' ? 'alert' : 'status'}
          aria-live={item.variant === 'error' ? 'assertive' : 'polite'}
          className={
            'pointer-events-auto min-w-[260px] max-w-[420px] rounded-lg border px-4 py-3 text-sm shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 ' +
            (item.variant === 'error'
              ? 'bg-destructive text-destructive-foreground border-destructive'
              : 'bg-card text-foreground border-border')
          }
        >
          {item.message}
        </div>
      ))}
    </div>
  );
}

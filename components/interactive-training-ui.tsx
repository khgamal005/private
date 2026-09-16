'use client';

import React, {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
} from 'react';
import styles from './interactive-training.module.css';

type ClassValue = string | false | null | undefined;
export function cx(...values: ClassValue[]) {
  return values.filter(Boolean).join(' ').split(/\s+/).filter(Boolean)
    .map(token => styles[token] || token).join(' ');
}

type TabsState = { value: string; setValue: (value: string) => void; id: string; dir: string };
const TabsContext = createContext<TabsState | null>(null);
function useTabs() {
  const context = useContext(TabsContext);
  if (!context) throw new Error('Tabs components must be inside Tabs.');
  return context;
}
type TabsProps = React.HTMLAttributes<HTMLDivElement> & {
  value?: string; defaultValue?: string; onValueChange?: (value: string) => void;
};
export function Tabs({ value, defaultValue = '', onValueChange, dir = 'rtl', className, children, ...props }: TabsProps) {
  const [internal, setInternal] = useState(defaultValue);
  const id = useId();
  const setValue = (next: string) => {
    if (value === undefined) setInternal(next);
    onValueChange?.(next);
  };
  return <TabsContext.Provider value={{ value: value ?? internal, setValue, id, dir }}>
    <div {...props} dir={dir} className={cx(className)}>{children}</div>
  </TabsContext.Provider>;
}
export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} role="tablist" aria-orientation="horizontal" className={cx('tab-list', className)} />;
}
export function TabsTrigger({ value, className, onClick, onKeyDown, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { value: string }) {
  const tabs = useTabs();
  const selected = tabs.value === value;
  return <button {...props} type="button" role="tab" id={`${tabs.id}-tab-${encodeURIComponent(value)}`}
    aria-controls={`${tabs.id}-panel-${encodeURIComponent(value)}`} aria-selected={selected}
    tabIndex={selected ? 0 : -1} data-state={selected ? 'active' : 'inactive'}
    className={cx('tab-trigger', selected && 'active', className)}
    onClick={event => { onClick?.(event); if (!event.defaultPrevented) tabs.setValue(value); }}
    onKeyDown={event => {
      onKeyDown?.(event);
      if (event.defaultPrevented || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const list = event.currentTarget.closest('[role="tablist"]');
      if (!list) return;
      const items = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
      if (!items.length) return;
      event.preventDefault();
      const index = items.indexOf(event.currentTarget);
      const direction = event.key === 'ArrowRight' ? (tabs.dir === 'rtl' ? -1 : 1) : (tabs.dir === 'rtl' ? 1 : -1);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + direction + items.length) % items.length;
      items[next].focus();
      items[next].click();
    }} />;
}
export function TabsContent({ value, className, ...props }: React.HTMLAttributes<HTMLDivElement> & { value: string }) {
  const tabs = useTabs();
  return <div {...props} role="tabpanel" tabIndex={0} id={`${tabs.id}-panel-${encodeURIComponent(value)}`}
    aria-labelledby={`${tabs.id}-tab-${encodeURIComponent(value)}`} hidden={tabs.value !== value}
    className={cx('tab-content', className)} />;
}

type DialogState = { open: boolean; onOpenChange: (value: boolean) => void; id: string; alert: boolean };
const DialogContext = createContext<DialogState | null>(null);
function useDialog() {
  const context = useContext(DialogContext);
  if (!context) throw new Error('Dialog components must be inside Dialog.');
  return context;
}
type DialogProps = { open: boolean; onOpenChange: (value: boolean) => void; children: React.ReactNode };
export function Dialog({ open, onOpenChange, children }: DialogProps) {
  const id = useId();
  return <DialogContext.Provider value={{ open, onOpenChange, id, alert: false }}>{children}</DialogContext.Provider>;
}
export function AlertDialog({ open, onOpenChange, children }: DialogProps) {
  const id = useId();
  return <DialogContext.Provider value={{ open, onOpenChange, id, alert: true }}>{children}</DialogContext.Provider>;
}
export function DialogContent({ className, children, onClick, onCancel, onClose, ...props }: React.DialogHTMLAttributes<HTMLDialogElement>) {
  const dialog = useDialog();
  const element = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const pointerStartedOutside = useRef(false);
  useEffect(() => {
    const node = element.current;
    if (!node || !dialog.open) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!node.open) node.showModal();
    return () => {
      if (node.open) node.close();
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    };
  }, [dialog.open]);
  if (!dialog.open) return null;
  const isOutside = (event: React.MouseEvent<HTMLDialogElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  return <dialog {...props} ref={element} dir={props.dir || 'rtl'} role={dialog.alert ? 'alertdialog' : 'dialog'}
    aria-modal="true" aria-labelledby={`${dialog.id}-title`} aria-describedby={`${dialog.id}-description`}
    className={cx('dialog-shell', className)}
    onMouseDown={event => { props.onMouseDown?.(event); pointerStartedOutside.current = event.target === event.currentTarget && isOutside(event); }}
    onClick={event => {
      onClick?.(event);
      if (!event.defaultPrevented && pointerStartedOutside.current && event.target === event.currentTarget && isOutside(event)) dialog.onOpenChange(false);
      pointerStartedOutside.current = false;
    }}
    onCancel={event => { onCancel?.(event); event.preventDefault(); dialog.onOpenChange(false); }}
    onClose={event => { onClose?.(event); }}>
    {children}
    {!dialog.alert && <button type="button" className={cx('dialog-close')} aria-label="إغلاق النافذة" onClick={() => dialog.onOpenChange(false)}><X size={19} /></button>}
  </dialog>;
}
export const AlertDialogContent = DialogContent;
export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx('dialog-header', className)} />;
}
export const AlertDialogHeader = DialogHeader;
export function DialogTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  const dialog = useDialog();
  return <h2 {...props} id={`${dialog.id}-title`} className={cx('dialog-title', className)} />;
}
export const AlertDialogTitle = DialogTitle;
export function DialogDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  const dialog = useDialog();
  return <p {...props} id={`${dialog.id}-description`} className={cx('dialog-description', className)} />;
}
export const AlertDialogDescription = DialogDescription;
export function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx('dialog-footer', className)} />;
}
export function AlertDialogCancel({ className, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const dialog = useDialog();
  return <button {...props} type="button" className={cx('btn', className)} onClick={event => {
    onClick?.(event); if (!event.defaultPrevented) dialog.onOpenChange(false);
  }} />;
}
export function AlertDialogAction({ className, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const dialog = useDialog();
  return <button {...props} type="button" className={cx('btn', 'primary', className)} onClick={event => {
    onClick?.(event); if (!event.defaultPrevented) dialog.onOpenChange(false);
  }} />;
}

export function Progress({ value = 0, className, ...props }: React.HTMLAttributes<HTMLDivElement> & { value?: number }) {
  const percent = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
  return <div {...props} role="progressbar" aria-label={props['aria-label'] || 'نسبة الإنجاز'} aria-valuemin={0} aria-valuemax={100}
    aria-valuenow={Math.round(percent)} className={cx('progress', className)}>
    <div className={cx('progress-indicator')} style={{ width: `${percent}%` }} />
  </div>;
}
type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'onChange'> & {
  checked?: boolean | 'indeterminate'; onCheckedChange?: (value: boolean) => void;
};
export function Checkbox({ checked = false, onCheckedChange, className, ...props }: CheckboxProps) {
  const element = useRef<HTMLInputElement>(null);
  useEffect(() => { if (element.current) element.current.indeterminate = checked === 'indeterminate'; }, [checked]);
  return <input {...props} ref={element} type="checkbox" checked={checked === true} className={cx('checkbox', className)}
    onChange={event => onCheckedChange?.(event.target.checked)} />;
}
export function Switch({ checked = false, onCheckedChange, className, ...props }: Omit<CheckboxProps, 'checked'> & { checked?: boolean }) {
  return <input {...props} type="checkbox" role="switch" checked={checked} className={cx('switch', className)}
    onChange={event => onCheckedChange?.(event.target.checked)} />;
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <div className={cx('table-wrap')}><table {...props} className={cx(className)} /></div>;
}
export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} className={cx(className)} />;
}
export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} className={cx(className)} />;
}
export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return <tr {...props} className={cx(className)} />;
}
export function TableHead({ className, scope = 'col', ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th {...props} scope={scope} className={cx(className)} />;
}
export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td {...props} className={cx(className)} />;
}

type ToastEntry = { id: number; message: string; kind: 'success' | 'error' | 'info' };
export function useToasts() {
  const [entries, setEntries] = useState<ToastEntry[]>([]);
  const sequence = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => { timers.current.forEach(clearTimeout); timers.current.clear(); }, []);
  const dismiss = useCallback((id: number) => setEntries(current => current.filter(entry => entry.id !== id)), []);
  const add = useCallback((kind: ToastEntry['kind'], message: string) => {
    const id = ++sequence.current;
    setEntries(current => [...current.slice(-3), { id, message, kind }]);
    const timer = setTimeout(() => { dismiss(id); timers.current.delete(timer); }, 4000);
    timers.current.add(timer);
  }, [dismiss]);
  const toast = useMemo(() => ({
    success: (message: string) => add('success', message),
    error: (message: string) => add('error', message),
    info: (message: string) => add('info', message),
  }), [add]);
  const renderEntries = (kind: 'error' | 'other') => entries.filter(entry => (entry.kind === 'error') === (kind === 'error')).map(entry =>
    <div key={entry.id} className={cx('toast', entry.kind === 'error' && 'toast-error')}>
      {entry.kind === 'success' ? <CheckCircle2 size={18} /> : entry.kind === 'error' ? <Info size={18} /> : <Bell size={18} />}
      <span>{entry.message}</span><button type="button" aria-label="إغلاق التنبيه" onClick={() => dismiss(entry.id)}><X size={15} /></button>
    </div>);
  const toaster = <div className={cx('toast-stack')} dir="rtl">
    <div role="status" aria-live="polite" aria-atomic="false">{renderEntries('other')}</div>
    <div role="alert" aria-live="assertive" aria-atomic="false">{renderEntries('error')}</div>
  </div>;
  return { toast, toaster };
}

type IconProps = React.SVGProps<SVGSVGElement> & { size?: number | string };
function icon(content: React.ReactNode) {
  return function TrainingIcon({ size = 24, className, strokeWidth = 1.8, ...props }: IconProps) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden={props['aria-label'] ? undefined : true}
      role={props['aria-label'] ? 'img' : undefined} focusable="false" {...props} className={cx(className)}>{content}</svg>;
  };
}
export const GraduationCap = icon(<><path d="m2 9 10-5 10 5-10 5Z" /><path d="M6 11v6c4 3 8 3 12 0v-6M22 9v7" /></>);
export const LayoutDashboard = icon(<><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /></>);
export const BookOpen = icon(<><path d="M12 5v15M3 4c3-1 6-1 9 1 3-2 6-2 9-1v15c-3-1-6-1-9 1-3-2-6-2-9-1Z" /></>);
export const Route = icon(<><circle cx="5" cy="5" r="2" /><circle cx="19" cy="19" r="2" /><path d="M7 5h9a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h9" /></>);
export const Users = icon(<><circle cx="9" cy="8" r="3" /><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5v1" /></>);
export const CalendarDays = icon(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h1m3 0h1m3 0h1M7 17h1m3 0h1m3 0h1" /></>);
export const ClipboardCheck = icon(<><rect x="5" y="5" width="14" height="16" rx="2" /><rect x="8" y="3" width="8" height="4" rx="1" /><path d="m8 14 3 3 5-6" /></>);
export const MessageSquare = icon(<path d="M5 3h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8l-5 3V5a2 2 0 0 1 2-2Z" />);
export const ShieldCheck = icon(<><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z" /><path d="m8 12 3 3 5-6" /></>);
export const Settings = icon(<><path d="m10 3-.5 3-2 .8-2.5-1.4-2 3.4L5.3 11v2L3 15.2l2 3.4 2.5-1.4 2 .8.5 3h4l.5-3 2-.8 2.5 1.4 2-3.4-2.3-2.2v-2L21 8.8l-2-3.4-2.5 1.4-2-.8-.5-3Z" /><circle cx="12" cy="12" r="3" /></>);
export const Sparkles = icon(<><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM4 2v4M2 4h4M20 18v4m-2-2h4" /></>);
export const Plus = icon(<path d="M12 4v16M4 12h16" />);
export const ArrowLeft = icon(<path d="M20 12H4m7-7-7 7 7 7" />);
export const ChevronLeft = icon(<path d="m15 5-7 7 7 7" />);
export const ChevronDown = icon(<path d="m5 8 7 7 7-7" />);
export const Check = icon(<path d="m4 12 5 5L20 6" />);
export const Clock = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l4 2" /></>);
export const Video = icon(<><rect x="2" y="5" width="14" height="14" rx="2" /><path d="m16 10 6-4v12l-6-4" /></>);
export const FileText = icon(<><path d="M14 2H5v20h14V7Zm0 0v5h5M8 12h8M8 16h8" /></>);
export const Search = icon(<><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6" /></>);
export const Bell = icon(<><path d="M5 17h14l-2-4V9A5 5 0 0 0 7 9v4Zm5 3a2 2 0 0 0 4 0M12 2v2" /></>);
export const HelpCircle = icon(<><circle cx="12" cy="12" r="9" /><path d="M9 9a3 3 0 1 1 5 2c-1 1-2 1-2 3m0 3h.01" /></>);
export const Layers = icon(<><path d="m2 7 10-5 10 5-10 5Zm0 5 10 5 10-5M2 17l10 5 10-5" /></>);
export const BarChart3 = icon(<path d="M3 3v18h18M7 16v-5m5 5V6m5 10v-8" />);
export const Target = icon(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>);
export const Award = icon(<><circle cx="12" cy="8" r="6" /><path d="m8 13-2 9 6-3 6 3-2-9" /></>);
export const Lock = icon(<><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V6a4 4 0 0 1 8 0v4M12 15v2" /></>);
export const CheckCircle2 = icon(<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 6-6" /></>);
export const Download = icon(<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" /></>);
export const ExternalLink = icon(<><path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7" /></>);
export const Play = icon(<path d="m7 3 14 9-14 9Z" />);
export const Send = icon(<path d="m22 2-7 20-4-9-9-4Zm0 0L11 13" />);
export const Star = icon(<path d="m12 2 3 6.5 7 1-5 5 1.2 7-6.2-3.3L5.8 21l1.2-6.5-5-5 7-1Z" />);
export const ListChecks = icon(<path d="m2 6 2 2 3-4m3 2h12M2 13l2 2 3-4m3 2h12M3 20h1m6 0h12" />);
export const Brain = icon(<><path d="M12 4a3 3 0 0 0-6-1A4 4 0 0 0 3 9a4 4 0 0 0 0 7 4 4 0 0 0 6 5 3 3 0 0 0 3-3Zm0 0a3 3 0 0 1 6-1 4 4 0 0 1 3 6 4 4 0 0 1 0 7 4 4 0 0 1-6 5 3 3 0 0 1-3-3M6 9l3 2m-3 6 3-2m9-6-3 2m3 6-3-2" /></>);
export const RefreshCw = icon(<><path d="M20 8a9 9 0 0 0-15-3L2 8m0-6v6h6m-4 8a9 9 0 0 0 15 3l3-3m0 6v-6h-6" /></>);
export const Info = icon(<><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>);
export const X = icon(<path d="m5 5 14 14M19 5 5 19" />);
export const Monitor = icon(<><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M12 17v4M7 21h10" /></>);
export const UserCheck = icon(<><circle cx="8" cy="7" r="4" /><path d="M1 21v-3a7 7 0 0 1 14 0v3m1-10 2 2 4-5" /></>);
export const SlidersHorizontal = icon(<><path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10M7 3v6m6 0v6M7 15v6" /></>);
export const PanelRightClose = icon(<><rect x="2" y="3" width="20" height="18" rx="2" /><path d="M16 3v18m-9-5 4-4-4-4" /></>);
export const TrendingUp = icon(<path d="m3 17 6-6 4 4 8-10m-6 0h6v6" />);
export const Briefcase = icon(<><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M8 7V3h8v4M2 12l10 4 10-4M12 13v4" /></>);
export const Database = icon(<><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0" /></>);

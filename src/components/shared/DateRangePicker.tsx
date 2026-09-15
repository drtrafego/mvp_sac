"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

function formatLabelDate(d: Date): string {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function subDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isSameMonth(d1: Date, d2: Date): boolean {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth();
}

function isSameDay(d1: Date | null, d2: Date | null): boolean {
  if (!d1 || !d2) return false;
  return (
    d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate()
  );
}

function isWithinInterval(d: Date, start: Date, end: Date): boolean {
  const t = d.getTime();
  const s = startOfDay(start).getTime();
  const e = startOfDay(end).getTime();
  return t >= s && t <= e;
}

function isBefore(d1: Date, d2: Date): boolean {
  return startOfDay(d1).getTime() < startOfDay(d2).getTime();
}

function getMonthDays(month: Date): Date[] {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const startDayOfWeek = firstDay.getDay(); // 0 = Domingo
  const startDate = new Date(month.getFullYear(), month.getMonth(), 1 - startDayOfWeek);

  const days: Date[] = [];
  for (let i = 0; i < 42; i++) {
    days.push(new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i));
  }
  return days;
}

interface Props {
  from?: string; // 'yyyy-MM-dd'
  to?: string;
}

type Preset = { label: string; days?: number; thisMonth?: boolean; all?: boolean };

const PRESETS: Preset[] = [
  { label: "Hoje", days: 0 },
  { label: "Últimos 7 dias", days: 6 },
  { label: "Últimos 30 dias", days: 29 },
  { label: "Últimos 60 dias", days: 59 },
  { label: "Este mês", thisMonth: true },
  { label: "Tudo", all: true },
];

function MonthGrid({
  month,
  from,
  to,
  onPick,
}: {
  month: Date;
  from: Date | null;
  to: Date | null;
  onPick: (d: Date) => void;
}) {
  const days = getMonthDays(month);
  const weekDays = ["D", "S", "T", "Q", "Q", "S", "S"];
  const monthName = month.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });

  return (
    <div className="w-full max-w-[280px] sm:w-56">
      <p className="text-center text-sm font-medium text-zinc-200 capitalize mb-2">
        {monthName}
      </p>
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {weekDays.map((w, i) => (
          <span key={i} className="text-center text-[10px] text-zinc-500">{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {days.map((d) => {
          const inMonth = isSameMonth(d, month);
          const isFrom = from && isSameDay(d, from);
          const isTo = to && isSameDay(d, to);
          const inRange =
            from && to && isWithinInterval(d, from, to);
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onPick(d)}
              className={[
                "h-7 text-xs rounded-md transition-colors cursor-pointer",
                inMonth ? "text-zinc-200" : "text-zinc-600",
                isFrom || isTo
                  ? "bg-indigo-500 text-white font-semibold"
                  : inRange
                  ? "bg-indigo-500/20 text-indigo-200"
                  : "hover:bg-zinc-700",
              ].join(" ")}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DateRangePicker({ from, to }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialFrom = from ? parseISO(from) : subDays(startOfDay(new Date()), 29);
  const initialTo = to ? parseISO(to) : startOfDay(new Date());

  const [open, setOpen] = useState(false);
  const [selFrom, setSelFrom] = useState<Date | null>(initialFrom);
  const [selTo, setSelTo] = useState<Date | null>(initialTo);
  const [leftMonth, setLeftMonth] = useState<Date>(startOfMonth(initialFrom));

  const pick = (d: Date) => {
    if (!selFrom || (selFrom && selTo)) {
      setSelFrom(d);
      setSelTo(null);
    } else if (isBefore(d, selFrom)) {
      setSelTo(selFrom);
      setSelFrom(d);
    } else {
      setSelTo(d);
    }
  };

  const apply = (f: Date, t: Date) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("from", fmtISO(f));
    params.set("to", fmtISO(t));
    params.delete("month");
    params.delete("year");
    params.delete("period");
    router.push(`${pathname}?${params.toString()}`);
    setOpen(false);
  };

  const applyPreset = (p: Preset) => {
    const today = startOfDay(new Date());
    let f: Date;
    let t: Date = today;
    if (p.all) {
      f = new Date(2020, 0, 1);
    } else if (p.thisMonth) {
      f = startOfMonth(today);
      t = endOfMonth(today);
    } else {
      f = subDays(today, p.days ?? 0);
    }
    setSelFrom(f);
    setSelTo(t);
    setLeftMonth(startOfMonth(f));
    apply(f, t);
  };

  const label =
    from && to
      ? `${formatLabelDate(parseISO(from))} — ${formatLabelDate(parseISO(to))}`
      : "Selecionar período";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 h-10 sm:h-auto text-sm text-zinc-200 hover:bg-zinc-700 transition-colors cursor-pointer"
      >
        <CalendarIcon className="h-4 w-4 text-zinc-400" />
        {label}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-24 overflow-y-auto overflow-x-hidden"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="flex flex-col sm:flex-row max-w-[92vw] rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
            {/* Presets */}
            <div className="flex flex-row sm:flex-col flex-wrap gap-1 border-b sm:border-b-0 sm:border-r border-zinc-800 p-3 sm:w-40">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="text-left text-sm text-zinc-300 rounded-md px-2 py-1.5 hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
            </div>

            {/* Calendários */}
            <div className="p-3">
              <div className="flex items-center justify-between mb-2">
                <button type="button" onClick={() => setLeftMonth((m) => addMonths(m, -1))}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 cursor-pointer">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => setLeftMonth((m) => addMonths(m, 1))}
                  className="p-1 rounded hover:bg-zinc-800 text-zinc-400 cursor-pointer">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="flex gap-4">
                <MonthGrid month={leftMonth} from={selFrom} to={selTo} onPick={pick} />
                <div className="hidden sm:block">
                  <MonthGrid month={addMonths(leftMonth, 1)} from={selFrom} to={selTo} onPick={pick} />
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t border-zinc-800">
                <button type="button" onClick={() => setOpen(false)}
                  className="text-sm text-zinc-400 px-3 py-1.5 rounded-lg hover:bg-zinc-800 cursor-pointer">
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={!selFrom || !selTo}
                  onClick={() => selFrom && selTo && apply(selFrom, selTo)}
                  className="text-sm bg-indigo-500 text-white px-4 py-1.5 rounded-lg hover:bg-indigo-600 disabled:opacity-40 cursor-pointer font-medium"
                >
                  Aplicar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

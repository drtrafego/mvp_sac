"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  addMonths,
  subDays,
  startOfDay,
  isSameMonth,
  isSameDay,
  isWithinInterval,
  isBefore,
} from "date-fns";
import { ptBR } from "date-fns/locale";
import { Calendar as CalendarIcon, ChevronLeft, ChevronRight } from "lucide-react";

const fmtISO = (d: Date) => format(d, "yyyy-MM-dd");
const parseISO = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};

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
  const gridStart = startOfWeek(startOfMonth(month), { weekStartsOn: 0 });
  const gridEnd = endOfWeek(endOfMonth(month), { weekStartsOn: 0 });
  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const weekDays = ["D", "S", "T", "Q", "Q", "S", "S"];

  return (
    <div className="w-full max-w-[280px] sm:w-56">
      <p className="text-center text-sm font-semibold text-fg capitalize mb-2">
        {format(month, "MMMM yyyy", { locale: ptBR })}
      </p>
      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {weekDays.map((w, i) => (
          <span key={i} className="text-center text-[10px] text-fg-subtle font-medium">{w}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {days.map((d) => {
          const inMonth = isSameMonth(d, month);
          const isFrom = from && isSameDay(d, from);
          const isTo = to && isSameDay(d, to);
          const inRange =
            from && to && isWithinInterval(d, { start: from, end: to });
          return (
            <button
              key={d.toISOString()}
              type="button"
              onClick={() => onPick(d)}
              className={[
                "h-7 text-xs rounded-md transition-colors cursor-pointer",
                inMonth ? "text-fg" : "text-fg-faint opacity-40",
                isFrom || isTo
                  ? "bg-brand-solid text-white font-bold"
                  : inRange
                  ? "bg-brand-glow text-brand-ink font-medium"
                  : "hover:bg-surface-raised",
              ].join(" ")}
            >
              {format(d, "d")}
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

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [selFrom, setSelFrom] = useState<Date | null>(initialFrom);
  const [selTo, setSelTo] = useState<Date | null>(initialTo);
  const [leftMonth, setLeftMonth] = useState<Date>(startOfMonth(initialFrom));

  useEffect(() => {
    setMounted(true);
  }, []);

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
      ? `${format(parseISO(from), "dd/MM/yy")} — ${format(parseISO(to), "dd/MM/yy")}`
      : "Selecionar período";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-line-subtle bg-surface-panel px-3 py-2 h-10 sm:h-auto text-sm text-fg hover:bg-surface-raised transition-colors cursor-pointer shadow-xs"
      >
        <CalendarIcon className="h-4 w-4 text-fg-subtle" />
        <span className="font-medium">{label}</span>
      </button>

      {mounted &&
        open &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/75 backdrop-blur-xs p-4 pt-20 sm:pt-24 overflow-y-auto overflow-x-hidden"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setOpen(false);
            }}
          >
            <div className="flex flex-col sm:flex-row max-w-[92vw] rounded-2xl border border-line-subtle bg-surface-overlay shadow-2xl animate-in fade-in zoom-in-95 duration-150">
              {/* Presets */}
              <div className="flex flex-row sm:flex-col flex-wrap gap-1 border-b sm:border-b-0 sm:border-r border-line-subtle p-3 sm:w-40 bg-surface-panel">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => applyPreset(p)}
                    className="text-left text-sm text-fg-muted hover:text-fg rounded-lg px-2.5 py-1.5 hover:bg-surface-raised transition-colors cursor-pointer font-medium"
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Calendários */}
              <div className="p-4 bg-surface-overlay">
                <div className="flex items-center justify-between mb-3">
                  <button
                    type="button"
                    onClick={() => setLeftMonth((m) => addMonths(m, -1))}
                    className="p-1.5 rounded-lg hover:bg-surface-raised text-fg-subtle hover:text-fg transition-colors cursor-pointer"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setLeftMonth((m) => addMonths(m, 1))}
                    className="p-1.5 rounded-lg hover:bg-surface-raised text-fg-subtle hover:text-fg transition-colors cursor-pointer"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex gap-4">
                  <MonthGrid month={leftMonth} from={selFrom} to={selTo} onPick={pick} />
                  <div className="hidden sm:block">
                    <MonthGrid
                      month={addMonths(leftMonth, 1)}
                      from={selFrom}
                      to={selTo}
                      onPick={pick}
                    />
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2 mt-4 pt-3 border-t border-line-subtle">
                  <button
                    type="button"
                    onClick={() => setOpen(false)}
                    className="text-sm text-fg-subtle hover:text-fg px-3 py-1.5 rounded-lg hover:bg-surface-raised transition-colors cursor-pointer font-medium"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={!selFrom || !selTo}
                    onClick={() => selFrom && selTo && apply(selFrom, selTo)}
                    className="text-sm bg-brand-solid text-on-accent px-4 py-1.5 rounded-lg hover:bg-brand-solid/90 disabled:opacity-40 cursor-pointer font-bold shadow-xs transition-colors"
                  >
                    Aplicar
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

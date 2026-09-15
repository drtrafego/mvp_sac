"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import DateRangePicker from "@/components/shared/DateRangePicker";

const MONTHS = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
];

type Props = {
  from: string;
  to: string;
  children?: React.ReactNode;
};

export default function PeriodBar({ from, to, children }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const fromD = new Date(from + "T12:00:00");

  const goMonth = (delta: number) => {
    const d = new Date(fromD.getFullYear(), fromD.getMonth() + delta, 1);
    const inicio = new Date(d.getFullYear(), d.getMonth(), 1);
    const fim = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    const iso = (x: Date) =>
      `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    const params = new URLSearchParams(searchParams ? searchParams.toString() : "");
    params.set("from", iso(inicio));
    params.set("to", iso(fim));
    params.delete("month");
    params.delete("year");
    params.delete("period");
    router.push(`${pathname}?${params.toString()}`);
  };

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Navegador Mês a Mês */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => goMonth(-1)}
            className="text-zinc-400 hover:text-zinc-200 flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center bg-zinc-800 rounded-lg hover:bg-zinc-700 transition-colors cursor-pointer"
            title="Mês anterior"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-semibold text-zinc-200 min-w-[120px] text-center">
            {MONTHS[fromD.getMonth()]} {fromD.getFullYear()}
          </span>
          <button
            onClick={() => goMonth(1)}
            className="text-zinc-400 hover:text-zinc-200 flex h-10 w-10 sm:h-8 sm:w-8 items-center justify-center bg-zinc-800 rounded-lg hover:bg-zinc-700 transition-colors cursor-pointer"
            title="Próximo mês"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        {/* Modal de Calendário Duplo e Presets */}
        <DateRangePicker from={from} to={to} />
      </div>

      {children && <div className="sm:ml-auto">{children}</div>}
    </div>
  );
}

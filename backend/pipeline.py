"""Regras de pipeline independentes de transporte e banco."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

DEFAULT_STAGES = (
    "novo_contato",
    "em_atendimento",
    "qualificado",
    "agendado",
    "fechado",
)


@dataclass(frozen=True)
class PipelineEngine:
    stages: Sequence[str] = DEFAULT_STAGES

    def __post_init__(self) -> None:
        clean = tuple(stage.strip() for stage in self.stages)
        if not clean or any(not stage for stage in clean) or len(set(clean)) != len(clean):
            raise ValueError("etapas do pipeline devem ser unicas e nao vazias")
        object.__setattr__(self, "stages", clean)

    def rank(self, stage: str) -> int:
        try:
            return self.stages.index(stage)
        except ValueError as exc:
            raise ValueError(f"etapa desconhecida: {stage}") from exc

    def resolve(self, current: str, requested: str) -> str:
        """Automacao somente avanca; nunca regride um card."""
        return requested if self.rank(requested) > self.rank(current) else current

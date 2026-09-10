"""Resolução local de segredos sem colocar credenciais no ambiente/process list."""
from __future__ import annotations

import os
import re
import stat
from pathlib import Path


class DirectorySecretResolver:
    """Resolve refs opacas em arquivos regulares privados dentro de um diretório.

    A ref aceita somente segmentos simples (ex.: ``tenant-a/meta-signature``).
    Symlinks, arquivos grandes e permissões de grupo/outros são recusados.
    """

    _REF = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$")

    def __init__(self, root: str | Path, *, max_bytes: int = 65_536) -> None:
        self.root = Path(root).resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("diretorio de segredos invalido")
        self.max_bytes = max_bytes

    def resolve(self, secret_ref: str) -> str:
        if not self._REF.fullmatch(secret_ref) or ".." in secret_ref.split("/"):
            raise LookupError("referencia de segredo invalida")
        candidate = self.root.joinpath(*secret_ref.split("/"))
        try:
            resolved = candidate.resolve(strict=True)
            if resolved != candidate or not resolved.is_relative_to(self.root):
                raise LookupError("symlink em referencia de segredo")
            info = candidate.lstat()
            if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                raise LookupError("segredo deve ser arquivo regular")
            if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
                raise LookupError("permissoes inseguras no segredo")
            if info.st_size < 1 or info.st_size > self.max_bytes:
                raise LookupError("tamanho de segredo invalido")
            # O_NOFOLLOW fecha a troca para symlink entre lstat e open.
            descriptor = os.open(candidate, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                opened = os.fstat(descriptor)
                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                    raise LookupError("segredo alterado durante leitura")
                value = os.read(descriptor, self.max_bytes + 1).decode("utf-8").strip()
            finally:
                os.close(descriptor)
        except (OSError, UnicodeError) as exc:
            raise LookupError("segredo indisponivel") from exc
        if not value or len(value.encode()) > self.max_bytes:
            raise LookupError("segredo vazio ou grande demais")
        return value
